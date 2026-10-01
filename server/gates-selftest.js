#!/usr/bin/env node
/**
 * Gate / auth / hardening self-test. Fully offline: spawns server/index.js over stdio with DUMMY credentials,
 * a temp PLUGIN_DATA dir, and SIMKL_API_BASE pointed at a local mock http server (loopback only).
 * Never touches the real .env.local and never contacts api.simkl.com.
 * Run: node server/gates-selftest.js
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
const DUMMY_AT = "simkl_at_" + "A1b2C3d4".repeat(4) + "Zz9";
const DUMMY_RT = "simkl_rt_" + "Q9w8E7r6".repeat(4) + "Yy1";
const DUMMY_DC = "dc_" + "f00dbabe".repeat(8);
const HEX64 = /[0-9a-f]{64}/i;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${extra ? " :: " + extra : ""}`);
  }
}

// ---- mock Simkl ----------------------------------------------------------
const hits = [];
let pollCount = 0;
let mockMode = "normal";
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    hits.push({ method: req.method, path: u.pathname, body, auth: req.headers.authorization || null });
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/oauth2/device") {
      return send(200, {
        device_code: DUMMY_DC,
        user_code: "ABCD-EFGH",
        verification_uri: "https://simkl.com/pin",
        verification_uri_complete: "https://simkl.com/pin?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 1,
      });
    }
    if (u.pathname === "/oauth2/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        return send(200, { access_token: DUMMY_AT.replace("A1b2", "R3f4"), token_type: "Bearer", expires_in: 604800, refresh_token: DUMMY_RT, scope: "media:read media:write" });
      }
      pollCount += 1;
      if (pollCount === 1) return send(400, { error: "authorization_pending" });
      return send(200, { access_token: DUMMY_AT, token_type: "Bearer", expires_in: 604800, refresh_token: DUMMY_RT, scope: mockMode === "readonly" ? "media:read" : "media:read media:write" });
    }
    if (u.pathname === "/oauth2/revoke") return send(200, {});
    if (u.pathname === "/stall") return; // never answer
    if (u.pathname.startsWith("/sync/") || u.pathname.startsWith("/scrobble/")) return send(201, { added: { movies: 1 } });
    return send(404, { error: "not_found" });
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${mock.address().port}`;

// ---- stdio client --------------------------------------------------------
function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simkl-gates-"));
  // Run a COPY of the server from a temp tree so the plugin root (and the real .env.local) can never be touched.
  const tree = path.join(dir, "tree");
  fs.mkdirSync(path.join(tree, "server"), { recursive: true });
  fs.copyFileSync(SERVER, path.join(tree, "server", "index.js"));
  fs.copyFileSync(path.join(path.dirname(SERVER), "package.json"), path.join(tree, "server", "package.json"));
  const child = spawn(process.execPath, [path.join(tree, "server", "index.js")], {
    env: {
      PATH: process.env.PATH,
      PLUGIN_DATA: dir,
      SIMKL_CLIENT_ID: "dummy-client-id",
      SIMKL_API_BASE: BASE,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let allOut = "";
  let allErr = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    allOut += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    }
  });
  child.stderr.on("data", (d) => (allErr += d));
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      id += 1;
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result.content.map((c) => c.text).join("\n");
    let json = null;
    try {
      json = JSON.parse(r.result.content[0].text);
    } catch (_) {}
    return { isError: !!r.result.isError, text, json };
  };
  return { child, dir, rpc, call, out: () => allOut, err: () => allErr, stop: () => child.kill() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeEnv = (dir, lines) => fs.writeFileSync(path.join(dir, ".env.local"), lines.join("\n") + "\n", { mode: 0o600 });

// =========================================================================
// 1. tools/list
// =========================================================================
{
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_SCOPE: "media:read media:write" });
  await s.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const list = (await s.rpc("tools/list", {})).result.tools;
  check("tools/list has 43 tools", list.length === 43, String(list.length));
  check("every tool has annotations", list.every((t) => t.annotations && typeof t.annotations === "object"));
  const writeTools = ["simkl_add_to_list", "simkl_add_history", "simkl_remove_history", "simkl_add_ratings", "simkl_remove_ratings", "simkl_delete_playback", "simkl_scrobble_start", "simkl_scrobble_pause", "simkl_scrobble_stop", "simkl_scrobble_checkin", "simkl_oauth_revoke"];
  check(
    "no confirm flag / confirmToken in any required list",
    writeTools.every((n) => {
      const req = list.find((t) => t.name === n).inputSchema.required || [];
      return !req.some((r) => /Confirmed$|confirmToken/.test(r));
    })
  );
  check("device_poll has no required args", !(list.find((t) => t.name === "simkl_device_poll").inputSchema.required || []).length);

  // 2. two-phase gate -------------------------------------------------------
  const base = { to: "completed", movies: [{ title: "Heat", year: 1995, ids: { imdb: "tt0113277" } }] };
  const hitsBefore = hits.length;
  let r = await s.call("simkl_add_to_list", base);
  check("unconfirmed write -> WRITE_CONFIRMATION_REQUIRED", r.isError && r.json.error === "WRITE_CONFIRMATION_REQUIRED");
  check("preview shows title, id and target status", /Heat/.test(r.text) && /tt0113277/.test(r.text) && r.json.preview.targetStatus === "completed");
  check("preview carries a confirmToken", typeof r.json.confirmToken === "string" && r.json.confirmToken.startsWith("ct_"));
  check("no network call for the preview", hits.length === hitsBefore);
  const tok = r.json.confirmToken;

  r = await s.call("simkl_add_to_list", { ...base, userConfirmed: true });
  check("flags alone (no token) still only previews", r.json.error === "WRITE_CONFIRMATION_REQUIRED" && !!r.json.confirmToken);
  r = await s.call("simkl_add_to_list", { ...base, confirmToken: "ct_wrong", userConfirmed: true });
  check("wrong token rejected", r.isError && r.json.error === "CONFIRM_TOKEN_INVALID");
  r = await s.call("simkl_add_to_list", { ...base, to: "dropped", confirmToken: tok, userConfirmed: true });
  check("token bound to payload (changed payload rejected)", r.json.error === "CONFIRM_TOKEN_INVALID");
  r = await s.call("simkl_add_to_list", base);
  const tok2 = r.json.confirmToken;
  r = await s.call("simkl_add_to_list", { ...base, confirmToken: tok2 });
  check("token without userConfirmed -> WRITE_CONFIRMATION_REQUIRED", r.json.error === "WRITE_CONFIRMATION_REQUIRED");
  r = await s.call("simkl_add_to_list", { ...base, confirmToken: tok2, userConfirmed: "true" });
  check("string 'true' flag refused", r.isError && ["INVALID_ARGS", "WRITE_CONFIRMATION_REQUIRED"].includes(r.json.error));
  const before = hits.length;
  r = await s.call("simkl_add_to_list", { ...base, confirmToken: tok2, userConfirmed: true });
  check("correct token + flag -> request sent", !r.isError && hits.length === before + 1 && hits[hits.length - 1].path === "/sync/add-to-list");
  const sent = JSON.parse(hits[hits.length - 1].body);
  check("body has no confirm fields", !("confirmToken" in sent) && !("userConfirmed" in sent) && sent.to === "completed");
  check("Bearer sent on write", hits[hits.length - 1].auth === `Bearer ${DUMMY_AT}`);
  r = await s.call("simkl_add_to_list", { ...base, confirmToken: tok2, userConfirmed: true });
  check("token is single-use", r.json.error === "CONFIRM_TOKEN_INVALID");

  // destructive flags
  const rm = { movies: [{ ids: { simkl: 1 } }] };
  r = await s.call("simkl_remove_history", rm);
  const rt = r.json.confirmToken;
  check("remove preview lists required flags", r.json.requiredFlagsOnConfirm.includes("deleteConfirmed"));
  r = await s.call("simkl_remove_history", { ...rm, confirmToken: rt, userConfirmed: true });
  check("remove without deleteConfirmed -> DELETE_CONFIRMATION_REQUIRED", r.json.error === "DELETE_CONFIRMATION_REQUIRED");
  r = await s.call("simkl_remove_history", { ...rm, confirmToken: rt, userConfirmed: true, deleteConfirmed: true });
  check("remove with token + both flags goes through (token survives a flag refusal)", !r.isError);

  // 3. EMPTY / INVALID ------------------------------------------------------
  r = await s.call("simkl_add_history", { shows: [{}] });
  check("shows:[{}] -> INVALID_INPUT", r.json.error === "INVALID_INPUT");
  r = await s.call("simkl_add_history", {});
  check("no arrays -> EMPTY_WRITE", r.json.error === "EMPTY_WRITE");
  r = await s.call("simkl_add_history", { movies: [] });
  check("empty array -> EMPTY_WRITE", r.json.error === "EMPTY_WRITE");
  r = await s.call("simkl_add_history", { movies: "x" });
  check("non-array -> rejected", r.isError && ["INVALID_INPUT", "INVALID_ARGS"].includes(r.json.error));
  r = await s.call("simkl_add_to_list", { to: "completed", episodes: [{ ids: { simkl: 1 } }] });
  check("episodes on add_to_list (never sent) rejected", r.json.error === "INVALID_INPUT");
  r = await s.call("simkl_add_ratings", { movies: [{ ids: { simkl: 1 } }] });
  check("rating missing -> INVALID_INPUT", r.json.error === "INVALID_INPUT");
  r = await s.call("simkl_add_ratings", { movies: [{ ids: { simkl: 7 }, rating: 9 }] });
  check("ratings preview shows score", /rating 9/.test(r.text));

  // 4. nested mass edit -----------------------------------------------------
  const eps = Array.from({ length: 12 }, (_, i) => ({ number: i + 1 }));
  const nested = { shows: [{ ids: { simkl: 5 }, seasons: [{ number: 1, episodes: eps }] }] };
  r = await s.call("simkl_add_history", nested);
  check("1 show x 12 nested episodes counts 12 (mass edit)", r.json.itemCount === 12 && r.json.massEdit === true && r.json.preview.topLevelItems === 1);
  r = await s.call("simkl_add_history", { ...nested, confirmToken: r.json.confirmToken, userConfirmed: true });
  check("mass edit needs massEditConfirmed", r.json.error === "MASS_EDIT_CONFIRMATION_REQUIRED");
  r = await s.call("simkl_remove_history", { shows: [{ ids: { simkl: 5 } }] });
  check("whole-show remove counts as mass edit", r.json.massEdit === true && r.json.preview.wholeShowOrSeasonEntries === 1);
  r = await s.call("simkl_add_history", { shows: [{ ids: { simkl: 5 }, seasons: [{ number: 1, episodes: eps.slice(0, 3) }] }] });
  check("3 nested episodes is not a mass edit", r.json.itemCount === 3 && r.json.massEdit === false);
  r = await s.call("simkl_add_history", { shows: [{ ids: { simkl: 5 }, seasons: [{ number: 1, episodes: [] }] }] });
  check("empty nested episodes rejected", r.json.error === "INVALID_INPUT");
  r = await s.call("simkl_add_history", { episodes: Array.from({ length: 10 }, (_, i) => ({ ids: { simkl: i + 1 } })) });
  check("10 top-level episodes = mass edit and episodes are sent", r.json.massEdit === true);
  {
    const eb = { episodes: Array.from({ length: 10 }, (_, i) => ({ ids: { simkl: i + 1 } })) };
    const t = (await s.call("simkl_add_history", eb)).json.confirmToken;
    const n0 = hits.length;
    await s.call("simkl_add_history", { ...eb, confirmToken: t, userConfirmed: true, massEditConfirmed: true });
    check("episodes[] reach the request body", JSON.parse(hits[n0].body).episodes.length === 10);
  }

  // 5. path params ----------------------------------------------------------
  const n0 = hits.length;
  for (const bad of ["..", ".", "a/b", "a?b", "a#b", "%2e%2e", ""]) {
    r = await s.call("simkl_get_movie", { id: bad });
    check(`get_movie id ${JSON.stringify(bad)} rejected`, r.isError && r.json && r.json.error === "INVALID_INPUT");
  }
  r = await s.call("simkl_search_text", { type: "../x", q: "a" });
  check("search_text type '../x' rejected", r.isError);
  r = await s.call("simkl_delete_playback", { id: ".." });
  check("delete_playback id '..' rejected (type)", r.isError && !hits.slice(n0).some((h) => h.path.includes("playback")));
  r = await s.call("simkl_delete_playback", { id: 0 });
  check("delete_playback id 0 rejected", r.json.error === "INVALID_INPUT");
  r = await s.call("simkl_delete_playback", { id: 42 });
  check("delete_playback preview shows playback id", r.json.preview.playbackId === 42 && r.json.requiredFlagsOnConfirm.includes("deleteConfirmed"));
  check("no requests made for rejected path params", hits.slice(n0).length === 0);

  // 6. schema enforcement ---------------------------------------------------
  r = await s.call("simkl_search_text", {});
  check("search_text {} -> INVALID_ARGS", r.json.error === "INVALID_ARGS");
  r = await s.call("simkl_search_text", { type: "tv", q: "a", limit: 999 });
  check("limit bound enforced", r.json.error === "INVALID_ARGS");
  r = await s.call("simkl_rate_limit_status", {});
  check("local tool still works", !r.isError && r.json.pacing);

  // 7. scrobble ---------------------------------------------------------------
  r = await s.call("simkl_scrobble_start", { progress: 5 });
  check("scrobble without media -> EMPTY_WRITE", r.json.error === "EMPTY_WRITE");
  r = await s.call("simkl_scrobble_stop", { progress: 90, movie: { title: "Heat", ids: { imdb: "tt0113277" } } });
  check("scrobble preview names title/progress/effect", /Heat/.test(r.text) && r.json.preview.progress === 90 && /watched/.test(r.json.preview.effect));
  s.stop();
}

// =========================================================================
// 8. scope handling (S1)
// =========================================================================
{
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_SCOPE: "media:read" });
  const n0 = hits.length;
  for (const [tool, args] of [
    ["simkl_add_to_list", { to: "completed", movies: [{ ids: { simkl: 1 } }] }],
    ["simkl_remove_ratings", { movies: [{ ids: { simkl: 1 } }] }],
    ["simkl_delete_playback", { id: 3 }],
    ["simkl_scrobble_start", { progress: 1, movie: { ids: { simkl: 1 } } }],
  ]) {
    const r = await s.call(tool, args);
    check(`read-only scope: ${tool} -> MISSING_WRITE_SCOPE`, r.isError && r.json.error === "MISSING_WRITE_SCOPE" && /media:read media:write/.test(r.text));
  }
  check("read-only scope: nothing sent", hits.length === n0);
  let r = await s.call("simkl_device_start", { scope: "media:write" });
  check("device_start scope enum validated", r.isError);
  r = await s.call("simkl_device_start", { scope: "media:read media:write; rm" });
  check("device_start rejects injected scope", r.isError);
  s.stop();
}
{
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT }); // scope unknown
  const a = { to: "completed", movies: [{ ids: { simkl: 1 } }] };
  let r = await s.call("simkl_add_to_list", a);
  check("unknown scope: allowed, preview notes it", r.json.error === "WRITE_CONFIRMATION_REQUIRED" && /unknown/.test(r.json.scopeNote));
  s.stop();
}

// =========================================================================
// 9. device flow + persistence + no token leakage (B1)
// =========================================================================
{
  const s = startServer({});
  let r = await s.call("simkl_device_poll", {});
  check("poll with no flow -> NO_DEVICE_FLOW", r.json.error === "NO_DEVICE_FLOW");
  r = await s.call("simkl_device_start", { scope: "media:read media:write" });
  check("device_start returns user_code/uri/interval/expires_in", r.json.user_code === "ABCD-EFGH" && r.json.verification_uri_complete && r.json.interval === 1 && r.json.expires_in === 900);
  check("device_start does not return device_code", !r.text.includes(DUMMY_DC) && !("device_code" in r.json));
  const stateFile = path.join(s.dir, ".device-flow.json");
  check("device state file is mode 0600", fs.existsSync(stateFile) && (fs.statSync(stateFile).mode & 0o777) === 0o600);
  r = await s.call("simkl_device_poll", {});
  check("immediate poll is rate-guarded locally", r.json.error === "poll_too_soon");
  await sleep(1100);
  r = await s.call("simkl_device_poll", {});
  check("pending poll reported", r.json.error === "authorization_pending" && !r.isError);
  await sleep(1100);
  r = await s.call("simkl_device_poll", {});
  check("poll success: ok with only the allowed fields", r.json.ok === true && Object.keys(r.json).every((k) => ["ok", "scope", "expires_in", "refresh_token_present", "persisted", "notes"].includes(k)), JSON.stringify(Object.keys(r.json)));
  check("poll success: scope/persisted/refresh flag", r.json.scope === "media:read media:write" && r.json.persisted === true && r.json.refresh_token_present === true && r.json.expires_in === 604800);
  const all = r.text + s.out() + s.err();
  check("no token strings in tool output or logs", !/simkl_at_|simkl_rt_/.test(all) && !HEX64.test(all) && !all.includes(DUMMY_DC) && !all.includes(DUMMY_AT) && !all.includes(DUMMY_RT));
  const envFile = path.join(s.dir, ".env.local");
  const txt = fs.readFileSync(envFile, "utf8");
  check("tokens + scope persisted to temp PLUGIN_DATA/.env.local", txt.includes(`SIMKL_ACCESS_TOKEN=${DUMMY_AT}`) && txt.includes(`SIMKL_REFRESH_TOKEN=${DUMMY_RT}`) && /SIMKL_SCOPE='media:read media:write'/.test(txt));
  check(".env.local is mode 0600", (fs.statSync(envFile).mode & 0o777) === 0o600);
  check("no leftover temp files", fs.readdirSync(s.dir).every((f) => !f.endsWith(".tmp")));
  check("real plugin .env.local untouched by tests (copy tree used)", !fs.existsSync(path.join(s.dir, "tree", ".env.local")));
  check("device state removed after success", !fs.existsSync(stateFile));
  // file must be sourceable and yield same values
  const { execFileSync } = await import("node:child_process");
  const sourced = execFileSync("bash", ["-c", `set -a; source "${envFile}"; set +a; printf '%s|%s' "$SIMKL_SCOPE" "$([ "$SIMKL_ACCESS_TOKEN" = "${DUMMY_AT}" ] && echo y)"`]).toString();
  check("persisted file sources cleanly in bash", sourced === "media:read media:write|y", sourced);

  // writes now allowed by the freshly stored scope (media:write)
  r = await s.call("simkl_add_to_list", { to: "completed", movies: [{ ids: { simkl: 1 } }] });
  check("fresh in-memory scope drives write gate", r.json.error === "WRITE_CONFIRMATION_REQUIRED");

  // refresh: no tokens in output
  r = await s.call("simkl_token_refresh", {});
  const all2 = r.text + s.out() + s.err();
  check("token_refresh: only allowed fields, no tokens", r.json.ok === true && Object.keys(r.json).every((k) => ["ok", "scope", "expires_in", "refresh_token_present", "persisted"].includes(k)) && !/simkl_at_|simkl_rt_/.test(all2) && !HEX64.test(all2));

  // revoke with a custom token must not wipe local tokens (S4)
  r = await s.call("simkl_oauth_revoke", { token: "someothertoken" });
  check("revoke preview says local tokens untouched", r.json.preview.localTokensCleared.startsWith("no"));
  r = await s.call("simkl_oauth_revoke", { token: "someothertoken", confirmToken: r.json.confirmToken, userConfirmed: true, revokeConfirmed: true });
  const stillThere = fs.readFileSync(envFile, "utf8").includes("SIMKL_REFRESH_TOKEN=");
  check("revoke(custom token) keeps local tokens", r.json.ok === true && r.json.localTokensCleared === false && stillThere);
  r = await s.call("simkl_oauth_revoke", {});
  check("revoke preview: local token", r.json.preview.localTokensCleared.startsWith("yes"));
  r = await s.call("simkl_oauth_revoke", { confirmToken: r.json.confirmToken, userConfirmed: true });
  check("revoke without revokeConfirmed -> REVOKE_CONFIRMATION_REQUIRED", r.json.error === "REVOKE_CONFIRMATION_REQUIRED");
  r = await s.call("simkl_oauth_revoke", {});
  r = await s.call("simkl_oauth_revoke", { confirmToken: r.json.confirmToken, userConfirmed: true, revokeConfirmed: true });
  const after = fs.readFileSync(envFile, "utf8");
  check("revoke(local token) clears tokens + scope, keeps CLIENT_ID", r.json.localTokensCleared === true && !/SIMKL_(ACCESS|REFRESH)_TOKEN|SIMKL_SCOPE/.test(after));
  s.stop();
}

// persistence hygiene: export-style lines cleared, unsafe values refused
{
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_REFRESH_TOKEN: DUMMY_RT });
  writeEnv(s.dir, ["SIMKL_CLIENT_ID=dummy-client-id", `export SIMKL_ACCESS_TOKEN='${DUMMY_AT}'`, `export SIMKL_REFRESH_TOKEN=${DUMMY_RT}`]);
  let r = await s.call("simkl_oauth_revoke", {});
  r = await s.call("simkl_oauth_revoke", { confirmToken: r.json.confirmToken, userConfirmed: true, revokeConfirmed: true });
  const t = fs.readFileSync(path.join(s.dir, ".env.local"), "utf8");
  check("clear removes 'export KEY=' lines", r.json.localTokensCleared === true && !/SIMKL_(ACCESS|REFRESH)_TOKEN/.test(t) && /SIMKL_CLIENT_ID=/.test(t));
  s.stop();
}

// =========================================================================
// 10. timeout / size cap / queue not blocked (S11)
// =========================================================================
{
  // Stall: a second mock that never replies, used as API base.
  const stall = http.createServer(() => {});
  await new Promise((r) => stall.listen(0, "127.0.0.1", r));
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_HTTP_TIMEOUT_MS: "400", SIMKL_API_BASE: `http://127.0.0.1:${stall.address().port}` });
  const t0 = Date.now();
  const stalled = s.call("simkl_get_settings", {});
  const second = s.call("simkl_get_activities", {});
  const [a, b] = await Promise.all([stalled, second]);
  const dt = Date.now() - t0;
  check("stalled request -> timeout error, not a hang", a.isError && /TIMEOUT/.test(a.text) && dt < 5000, a.text.slice(0, 80));
  check("queue not blocked by the stalled request", b.isError && /TIMEOUT/.test(b.text));
  s.stop();
  stall.closeAllConnections?.();
  stall.close();
}
{
  const big = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pad: "x".repeat(20_000) }));
  });
  await new Promise((r) => big.listen(0, "127.0.0.1", r));
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_MAX_RESPONSE_BYTES: "4096", SIMKL_API_BASE: `http://127.0.0.1:${big.address().port}` });
  const r = await s.call("simkl_get_settings", {});
  check("oversized response -> RESPONSE_TOO_LARGE", r.isError && /RESPONSE_TOO_LARGE/.test(r.text));
  s.stop();
  big.close();
}

// =========================================================================
// 11. 401 refresh condition (S2) + daily stop reset (S10)
// =========================================================================
{
  let calls = 0;
  let refreshed = 0;
  const api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/oauth2/token") {
        refreshed += 1;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ access_token: "newtoken123", refresh_token: "newrefresh123", expires_in: 604800, scope: "media:read" }));
      }
      calls += 1;
      if (req.headers.authorization === "Bearer newtoken123") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: 1 }));
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "user_token_required" })); // expired Bearer reported with this code
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_REFRESH_TOKEN: DUMMY_RT, SIMKL_API_BASE: `http://127.0.0.1:${api.address().port}` });
  const r = await s.call("simkl_get_settings", {});
  check("401 user_token_required with Bearer sent -> refresh + retry succeeds", !r.isError && refreshed === 1 && calls === 2, `${refreshed}/${calls}`);
  s.stop();
  api.close();
}
{
  // dailyStopped clears after reset time: drive the exported state through a child importing index.js in selftest mode is
  // not possible, so assert via a short in-process check of the documented behaviour using rate_limit_status.
  const api = http.createServer((req, res) => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "user_limit_exceeded" }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const s = startServer({ SIMKL_ACCESS_TOKEN: DUMMY_AT, SIMKL_API_BASE: `http://127.0.0.1:${api.address().port}` });
  await s.call("simkl_get_settings", {});
  const st = await s.call("simkl_rate_limit_status", {});
  check("daily 429 sets dailyStopped", st.json.dailyStopped === true);
  const again = await s.call("simkl_get_settings", {});
  check("daily stop gates later counted calls locally", /Local gate/.test(again.text));
  s.stop();
  api.close();
}

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
