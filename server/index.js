#!/usr/bin/env node
/**
 * Simkl — zero-dep stdio MCP server (AUTH V2 first)
 * Base: https://api.simkl.com
 * CDN:  https://data.simkl.in
 * Protocol: MCP over stdio
 *   - Inbound: NDJSON lines (MCP spec), OR Content-Length with \n\n or \r\n\r\n
 *   - Outbound mirrors inbound: NDJSON -> NDJSON (JSON + \n);
 *     Content-Length (LF or CRLF) -> Content-Length: N\n\n + body (LF terminator)
 * Logs → stderr only; stdout = JSON-RPC only.
 *
 * Rate limits are first-class (see RATE_LIMITS.md / RESEARCH.md).
 */

import https from "node:https";
import http from "node:http";
import process from "node:process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL, URLSearchParams } from "node:url";

// SIMKL_API_BASE is a TEST-ONLY override (e.g. a local mock). Non-https is accepted only for loopback hosts.
function resolveApiBase() {
  const o = process.env.SIMKL_API_BASE && String(process.env.SIMKL_API_BASE).trim();
  if (!o) return "https://api.simkl.com";
  try {
    const u = new URL(o);
    const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return o.replace(/\/+$/, "");
  } catch (_) {}
  process.stderr.write("simkl: ignoring invalid SIMKL_API_BASE (https or loopback http only)\n");
  return "https://api.simkl.com";
}
const API_BASE = resolveApiBase();
const CDN_BASE = "https://data.simkl.in";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "simkl-mcp", version: "0.1.2" };

const PER_SECOND_WAIT_MS = 1200;
const WRITE_LOCK_WAIT_MS = 3500;
const POST_GAP_MS = 1050;
const GET_MIN_GAP_MS = 105; // ~10 GET/sec
const DAILY_RETRY_CAP_MS = 180_000;
const PER_SECOND_MAX_RETRIES = 3;
const HTTP_TIMEOUT_MS_DEFAULT = 30_000;
const MAX_RESPONSE_BYTES_DEFAULT = 10 * 1024 * 1024; // 10 MB
const QUEUE_JOB_GUARD_MS = 150_000; // a single queued job can never hold the serial queue longer than this
function httpTimeoutMs() {
  const n = Number(process.env.SIMKL_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 50 ? n : HTTP_TIMEOUT_MS_DEFAULT; // env override is for tests
}
function maxResponseBytes() {
  const n = Number(process.env.SIMKL_MAX_RESPONSE_BYTES);
  return Number.isFinite(n) && n >= 1024 ? n : MAX_RESPONSE_BYTES_DEFAULT; // env override is for tests
}

// ---------------------------------------------------------------------------
// Logging (stderr only)
// ---------------------------------------------------------------------------
function log(...args) {
  process.stderr.write(args.map(String).join(" ") + "\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Config / env
// ---------------------------------------------------------------------------
function appName() {
  return (process.env.SIMKL_APP_NAME || "simkl-mcp").trim() || "simkl-mcp";
}
function appVersion() {
  return (process.env.SIMKL_APP_VERSION || "0.1.2").trim() || "0.1.2";
}
function clientId() {
  const v = process.env.SIMKL_CLIENT_ID;
  return v && String(v).trim() ? String(v).trim() : null;
}
function accessToken() {
  const v = process.env.SIMKL_ACCESS_TOKEN;
  return v && String(v).trim() ? String(v).trim() : null;
}

// ---------------------------------------------------------------------------
// Token storage (.env.local) -- PLUGIN_DATA aware, atomic, shell-safe
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_VALUE_RE = /^[A-Za-z0-9._~-]+$/; // run-mcp.sh `source`s the file: no shell metacharacters
const SCOPE_VALUE_RE = /^[A-Za-z0-9:_.-]+( [A-Za-z0-9:_.-]+)*$/;
const PERSIST_KEYS = {
  SIMKL_ACCESS_TOKEN: TOKEN_VALUE_RE,
  SIMKL_REFRESH_TOKEN: TOKEN_VALUE_RE,
  SIMKL_SCOPE: SCOPE_VALUE_RE,
};

/** Directory holding .env.local: $PLUGIN_DATA when set (survives plugin updates), else the plugin root. */
function dataDir() {
  const d = process.env.PLUGIN_DATA;
  return d && String(d).trim() ? path.resolve(String(d).trim()) : PLUGIN_ROOT;
}
function envLocalPath() {
  return path.join(dataDir(), ".env.local");
}
/** Files that may hold tokens: the data-dir file plus the legacy plugin-root file. */
function envLocalCandidates() {
  const a = envLocalPath();
  const b = path.join(PLUGIN_ROOT, ".env.local");
  return a === b ? [a] : [a, b];
}
function keyLineRe(key) {
  return new RegExp("^\\s*(?:export\\s+)?" + key + "\\s*=");
}

/** Atomic write: temp file (0600) in the same dir, then rename. */
function writeFileAtomic600(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.env.local.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {}
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

/**
 * Update SIMKL_* keys in .env.local without logging values. A null/empty value removes the key.
 * Values are validated (shell-safe) BEFORE anything is written. Returns true if written.
 */
function persistTokensToEnvLocal(updates) {
  const entries = Object.entries(updates || {});
  if (!entries.length) return false;
  for (const [key, value] of entries) {
    const re = PERSIST_KEYS[key];
    if (!re) {
      log("simkl: refusing to persist unknown key:", key);
      return false;
    }
    if (value != null && String(value).trim() !== "" && !re.test(String(value).trim())) {
      log("simkl: refusing to persist", key, "(value has characters unsafe for a sourced env file)");
      return false;
    }
  }
  const file = envLocalPath();
  let lines = [];
  try {
    if (fs.existsSync(file)) lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch (err) {
    log("simkl: could not read .env.local for persist:", err && err.message ? err.message : err);
    return false;
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of entries) {
    const re = keyLineRe(key);
    lines = lines.filter((L) => !re.test(L));
    const v = value == null ? "" : String(value).trim();
    if (v !== "") lines.push(key === "SIMKL_SCOPE" ? `${key}='${v}'` : `${key}=${v}`);
  }
  try {
    writeFileAtomic600(file, lines.join("\n") + "\n");
    log("simkl: persisted keys to .env.local:", entries.map(([k]) => k).join(", "));
    return true;
  } catch (err) {
    log("simkl: could not write .env.local:", err && err.message ? err.message : err);
    return false;
  }
}

/** Remove access/refresh tokens + scope from env and every .env.local candidate (keeps CLIENT_ID). */
function clearTokensFromEnvLocal() {
  delete process.env.SIMKL_ACCESS_TOKEN;
  delete process.env.SIMKL_REFRESH_TOKEN;
  delete process.env.SIMKL_SCOPE;
  const res = ["SIMKL_ACCESS_TOKEN", "SIMKL_REFRESH_TOKEN", "SIMKL_SCOPE"].map(keyLineRe);
  let ok = true;
  for (const file of envLocalCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      let lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const before = lines.length;
      lines = lines.filter((L) => !res.some((re) => re.test(L)));
      writeFileAtomic600(file, lines.length ? lines.join("\n") + "\n" : "");
      log("simkl: cleared token/scope lines from .env.local (removed", before - lines.length, "line(s); CLIENT_ID kept)");
    } catch (err) {
      ok = false;
      log("simkl: could not clear .env.local:", err && err.message ? err.message : err);
    }
  }
  return ok;
}

// ---- scope awareness -------------------------------------------------------
function normalizeScope(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/[,\s]+/g, " ");
  return s && SCOPE_VALUE_RE.test(s) ? s : null;
}
/** {known, scope, hasWrite}. Unknown when no SIMKL_SCOPE or it carries no media:* scope (e.g. legacy "public"). */
function scopeStatus() {
  const s = normalizeScope(process.env.SIMKL_SCOPE || "");
  if (!s) return { known: false, scope: null, hasWrite: false };
  const parts = s.split(" ");
  const known = parts.some((p) => p.startsWith("media:"));
  return { known, scope: s, hasWrite: parts.includes("media:write") };
}

function refreshToken() {
  const v = process.env.SIMKL_REFRESH_TOKEN;
  return v && String(v).trim() ? String(v).trim() : null;
}
function clientSecret() {
  const v = process.env.SIMKL_CLIENT_SECRET;
  return v && String(v).trim() ? String(v).trim() : null;
}
function userAgent() {
  return `${appName()}/${appVersion()}`;
}

function requireClientId() {
  const id = clientId();
  if (!id) {
    const err = new Error(
      "SIMKL_CLIENT_ID is not set. Register a V2 app at https://simkl.com/settings/developer/ (prefer “TV, devices & command line” for this MCP), then export SIMKL_CLIENT_ID."
    );
    err.code = "MISSING_CLIENT_ID";
    throw err;
  }
  return id;
}

function requireAccessToken() {
  const tok = accessToken();
  if (!tok) {
    const err = new Error(
      "SIMKL_ACCESS_TOKEN is not set. Use simkl_device_start + simkl_device_poll, or paste a V2 Bearer token (simkl_at_…) into .env.local / the environment."
    );
    err.code = "MISSING_ACCESS_TOKEN";
    throw err;
  }
  return tok;
}

// ---------------------------------------------------------------------------
// America/New_York midnight (no luxon — Intl + iterative UTC guess)
// Docs: quota resets at next midnight America/New_York.
// https://api.simkl.org/resources/rate-limits.md
// ---------------------------------------------------------------------------
function nyParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  // Some engines report midnight as hour "24"
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** Convert a wall-clock time in America/New_York to a UTC Date. */
function nyWallToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  let utcMs = Date.UTC(year, month - 1, day, hour + 5, minute, second); // EST guess
  for (let i = 0; i < 4; i++) {
    const got = nyParts(new Date(utcMs));
    const gotAsUtc = Date.UTC(
      got.year,
      got.month - 1,
      got.day,
      got.hour,
      got.minute,
      got.second
    );
    const wantAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = wantAsUtc - gotAsUtc;
    if (delta === 0) break;
    utcMs += delta;
  }
  return new Date(utcMs);
}

function nextNyMidnight(from = new Date()) {
  const p = nyParts(from);
  // If already exactly midnight, next reset is tomorrow
  let y = p.year;
  let m = p.month;
  let d = p.day;
  if (p.hour === 0 && p.minute === 0 && p.second === 0) {
    // still move to "next" calendar midnight after this instant
  }
  // Always take tomorrow's 00:00 in NY relative to current NY calendar date
  // when we are past midnight (i.e. almost always).
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  // Use UTC date arithmetic on Y/M/D numbers carefully via Date.UTC overflow
  const ty = tomorrow.getUTCFullYear();
  const tm = tomorrow.getUTCMonth() + 1;
  const td = tomorrow.getUTCDate();
  // If current NY time is exactly 00:00:00, "next" is still that instant only
  // if from is before it — we always want the upcoming reset, so if any time
  // has elapsed today, reset is tomorrow 00:00 NY.
  let target = nyWallToUtc(ty, tm, td, 0, 0, 0);
  if (target.getTime() <= from.getTime()) {
    const dayAfter = new Date(Date.UTC(ty, tm - 1, td + 1));
    target = nyWallToUtc(
      dayAfter.getUTCFullYear(),
      dayAfter.getUTCMonth() + 1,
      dayAfter.getUTCDate(),
      0,
      0,
      0
    );
  }
  // Special case: if we're before today's midnight somehow (clock skew), prefer today
  const todayMidnight = nyWallToUtc(y, m, d, 0, 0, 0);
  if (todayMidnight.getTime() > from.getTime()) {
    return todayMidnight;
  }
  return target;
}

function resetsInfo(from = new Date()) {
  const resetsAt = nextNyMidnight(from);
  const resetsInSeconds = Math.max(
    0,
    Math.round((resetsAt.getTime() - from.getTime()) / 1000)
  );
  return {
    resetsAtIso: resetsAt.toISOString(),
    resetsInSeconds,
  };
}

// ---------------------------------------------------------------------------
// Rate-limit state + classifier
// Port of the author's simkl_limits.py classify_simkl_response
// Docs: https://api.simkl.org/resources/rate-limits.md
// ---------------------------------------------------------------------------
const limitState = {
  limit: null, // N/A until headers seen
  remaining: null,
  headersSeen: false,
  lastKind: null,
  lastError: null,
  dailyStopped: false,
  dailyStoppedUntil: null,
  lastRetryAfter: null,
};

/** True while a daily quota stop is in force; self-clears once the NY-midnight reset has passed. */
function dailyStopActive(now = Date.now()) {
  if (limitState.dailyStopped && limitState.dailyStoppedUntil != null && now >= limitState.dailyStoppedUntil) {
    limitState.dailyStopped = false;
    limitState.dailyStoppedUntil = null;
    limitState.lastKind = null;
    limitState.lastError = null;
  }
  return limitState.dailyStopped;
}

export function classifySimklResponse(status, body, headers = {}) {
  const code = Number(status) || 0;
  let err = "";
  let desc = "";
  if (body && typeof body === "object" && !Array.isArray(body)) {
    err = String(body.error || "").trim().toLowerCase();
    desc = String(body.error_description || body.message || "");
  }
  const retryRaw =
    headers["retry-after"] ||
    headers["Retry-After"] ||
    (typeof headers.get === "function" ? headers.get("retry-after") : null);
  let retryS = 0;
  if (retryRaw != null && retryRaw !== "") {
    const n = Number(retryRaw);
    if (Number.isFinite(n)) retryS = n;
  }

  // 400 RATE_LIMIT / rate_limit → write lock (NOT daily)
  if (code === 400 && err === "rate_limit") {
    return {
      kind: "write_lock",
      waitMs: WRITE_LOCK_WAIT_MS,
      stopService: false,
      error: err || "rate_limit",
      retryAfter: retryS || null,
    };
  }

  if (code === 429 && (err === "user_limit_exceeded" || err === "app_limit_exceeded")) {
    const waitMs = retryS
      ? Math.min(DAILY_RETRY_CAP_MS, Math.max(retryS * 1000, 30_000))
      : DAILY_RETRY_CAP_MS;
    return {
      kind: err === "user_limit_exceeded" ? "daily_user" : "daily_app",
      waitMs,
      stopService: true,
      error: err,
      retryAfter: retryS || null,
    };
  }

  if (code === 429) {
    // per-second — IGNORE Retry-After (it carries daily reset)
    return {
      kind: "per_second",
      waitMs: PER_SECOND_WAIT_MS,
      stopService: false,
      error: err || "rate_limit",
      retryAfter: null,
    };
  }

  if (code === 401 && err === "user_token_required") {
    return {
      kind: "user_token_required",
      waitMs: 0,
      stopService: false,
      error: err,
      retryAfter: null,
    };
  }

  return {
    kind: "ok",
    waitMs: 0,
    stopService: false,
    error: err || null,
    retryAfter: null,
  };
}

function updateLimitHeaders(headers) {
  if (!headers) return;
  const lim =
    headers["x-ratelimit-limit"] ??
    headers["X-RateLimit-Limit"];
  const rem =
    headers["x-ratelimit-remaining"] ??
    headers["X-RateLimit-Remaining"];
  // Absence is N/A, not zero (first request after new token may omit them)
  if (lim != null && lim !== "") {
    const n = Number(lim);
    if (Number.isFinite(n)) {
      limitState.limit = n;
      limitState.headersSeen = true;
    }
  }
  if (rem != null && rem !== "") {
    const n = Number(rem);
    if (Number.isFinite(n)) {
      limitState.remaining = n;
      limitState.headersSeen = true;
    }
  }
}

function rateLimitStatusPayload() {
  const { resetsAtIso, resetsInSeconds } = resetsInfo();
  return {
    limit: limitState.limit, // null = N/A
    remaining: limitState.remaining, // null = N/A
    resetsAtIso,
    resetsInSeconds,
    lastKind: limitState.lastKind,
    lastError: limitState.lastError,
    headersSeen: limitState.headersSeen,
    dailyStopped: dailyStopActive(),
    lastRetryAfter: limitState.lastRetryAfter,
    pacing: {
      postGapMs: POST_GAP_MS,
      getMinGapMs: GET_MIN_GAP_MS,
      perSecondRetries: PER_SECOND_MAX_RETRIES,
    },
  };
}

// ---------------------------------------------------------------------------
// Serial queue + POST gap for non-exempt requests
// ---------------------------------------------------------------------------
let queueTail = Promise.resolve();
let lastPostAt = 0;
let lastCountedGetAt = 0;

function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  // The tail advances when the job settles OR after QUEUE_JOB_GUARD_MS, so one stalled job can never
  // block every other tool forever (individual HTTP requests also have their own 30s timeout).
  queueTail = new Promise((resolve) => {
    const guard = setTimeout(resolve, QUEUE_JOB_GUARD_MS);
    if (guard.unref) guard.unref();
    const done = () => {
      clearTimeout(guard);
      resolve();
    };
    run.then(done, done);
  });
  return run;
}

/**
 * Paths that must NOT send Authorization (Cloudflare edge — Auth busts cache).
 * Also exempt from pacing / quota tracking.
 */
function isCatalogNoAuthPath(pathname) {
  // Catalog detail + episode lists only — NEVER Auth (Cloudflare edge).
  // Exclude reserved first segments that are NOT ids: airing, genres, best, premieres.
  // /movies/{id}, /tv/{id}, /anime/{id}, /tv/episodes/{id}, /anime/episodes/{id}
  const reserved = new Set(["airing", "genres", "best", "premieres", "episodes"]);
  const one = pathname.match(/^\/(movies|tv|anime)\/([^/]+)\/?$/);
  if (one && !reserved.has(one[2])) return true;
  return (
    /^\/tv\/episodes\/[^/]+\/?$/.test(pathname) ||
    /^\/anime\/episodes\/[^/]+\/?$/.test(pathname)
  );
}

function isCdnHost(hostname) {
  return hostname === "data.simkl.in";
}

function isRateExempt(url) {
  if (isCdnHost(url.hostname)) return true;
  if (isCatalogNoAuthPath(url.pathname)) return true;
  // /redirect is Cloudflare-cached / quota-exempt per rate-limits.md, but AUTH V2
  // still requires a user token (auth-v2 overview). Treat as rate-exempt when called.
  if (url.pathname === "/redirect" || url.pathname === "/redirect/") return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function rawRequest(method, url, { headers, body, form } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const hdrs = { ...headers };
    if (form) {
      payload = typeof form === "string" ? form : new URLSearchParams(form).toString();
      hdrs["Content-Type"] = "application/x-www-form-urlencoded";
      hdrs["Content-Length"] = Buffer.byteLength(payload);
    } else if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = Buffer.byteLength(payload);
    }
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const timeoutMs = httpTimeoutMs();
    const capBytes = maxResponseBytes();
    const controller = new AbortController();
    let settled = false;
    let timer = null;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const fail = (code, message) => {
      const err = new Error(message);
      err.code = code;
      finish(reject, err);
      controller.abort();
    };
    // Whole-request deadline (connect + headers + body), not just socket idle time.
    timer = setTimeout(() => fail("TIMEOUT", `HTTP request timed out after ${timeoutMs} ms`), timeoutMs);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: hdrs,
      signal: controller.signal,
    };
    const req = lib.request(options, (res) => {
      const chunks = [];
      let total = 0;
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > capBytes) {
        res.destroy();
        return fail("RESPONSE_TOO_LARGE", `Response too large (content-length ${declared} > cap ${capBytes} bytes)`);
      }
      res.on("data", (c) => {
        total += c.length;
        if (total > capBytes) {
          res.destroy();
          return fail("RESPONSE_TOO_LARGE", `Response exceeded cap of ${capBytes} bytes`);
        }
        chunks.push(c);
      });
      res.on("error", (e) => finish(reject, e));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
        }
        // Normalize header keys to lowercase for lookups
        const headersLower = {};
        for (const [k, v] of Object.entries(res.headers || {})) {
          headersLower[String(k).toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        }
        finish(resolve, {
          status: res.statusCode || 0,
          headers: headersLower,
          body: parsed,
          text,
          location: headersLower.location || null,
        });
      });
    });
    req.on("error", (e) => {
      if (!settled && e && e.name === "AbortError") return; // already rejected via fail()
      finish(reject, e);
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function refreshAccessToken() {
  const rt = refreshToken();
  const cid = clientId();
  if (!rt || !cid) {
    return { ok: false, error: "No SIMKL_REFRESH_TOKEN or SIMKL_CLIENT_ID for refresh" };
  }
  const form = {
    grant_type: "refresh_token",
    client_id: cid,
    refresh_token: rt,
  };
  const secret = clientSecret();
  if (secret) form.client_secret = secret;

  const url = new URL(`${API_BASE}/oauth2/token`);
  url.searchParams.set("client_id", cid);
  url.searchParams.set("app-name", appName());
  url.searchParams.set("app-version", appVersion());

  let result;
  try {
    result = await rawRequest("POST", url, {
      headers: { Accept: "application/json", "User-Agent": userAgent() },
      form,
    });
  } catch (err) {
    log("simkl: token refresh request failed:", err && err.code ? err.code : "error");
    return { ok: false, error: err && err.code ? err.code : "REQUEST_FAILED" };
  }
  if (result.status >= 200 && result.status < 300 && result.body && result.body.access_token) {
    const b = result.body;
    process.env.SIMKL_ACCESS_TOKEN = b.access_token;
    // Non-rotating refresh: same string returned; still accept if present
    if (b.refresh_token) process.env.SIMKL_REFRESH_TOKEN = b.refresh_token;
    const scope = normalizeScope(b.scope);
    if (scope) process.env.SIMKL_SCOPE = scope;
    const persisted = persistTokensToEnvLocal({
      SIMKL_ACCESS_TOKEN: b.access_token,
      ...(b.refresh_token ? { SIMKL_REFRESH_TOKEN: b.refresh_token } : {}),
      ...(scope ? { SIMKL_SCOPE: scope } : {}),
    });
    log(
      persisted
        ? "simkl: access token refreshed and persisted to .env.local"
        : "simkl: access token refreshed in-memory only (.env.local persist failed or skipped)"
    );
    return {
      ok: true,
      persisted,
      scope: scope || null,
      expires_in: b.expires_in ?? null,
      refresh_token_present: Boolean(b.refresh_token || process.env.SIMKL_REFRESH_TOKEN),
    };
  }
  // Never log the raw body (could echo credentials); error code only.
  const code = result.body && typeof result.body === "object" ? String(result.body.error || "") : "";
  log("simkl: token refresh failed: HTTP", result.status, code);
  return {
    ok: false,
    status: result.status,
    error: code || null,
    error_description:
      result.body && typeof result.body === "object" && typeof result.body.error_description === "string"
        ? result.body.error_description.slice(0, 300)
        : null,
  };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.requireAuth] — need Bearer
 * @param {boolean} [opts.forceNoAuth] — never send Authorization (catalog)
 * @param {boolean} [opts.rateExempt] — skip pacing/quota tracking
 * @param {'user'|'app'|null} [opts.debugLimit]
 * @param {boolean} [opts.allowRefresh] — try refresh on 401
 * @param {boolean} [opts.followRedirect] — for /redirect
 */
async function simklRequest(method, pathOrUrl, opts = {}) {
  const {
    query = {},
    body,
    form,
    requireAuth = false,
    forceNoAuth = false,
    rateExempt: rateExemptOpt,
    debugLimit = null,
    allowRefresh = true,
    followRedirect = false,
    maxRedirects = 5,
  } = opts;

  const cid = requireClientId();

  const url = new URL(
    pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE}${pathOrUrl}`
  );
  // Required query params on every call
  url.searchParams.set("client_id", cid);
  url.searchParams.set("app-name", appName());
  url.searchParams.set("app-version", appVersion());
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  if (debugLimit === "user" || debugLimit === "app") {
    url.searchParams.set("debug_limit", debugLimit);
  }

  const exempt =
    rateExemptOpt != null
      ? rateExemptOpt
      : forceNoAuth || isRateExempt(url);

  const doSend = async (didRefresh) => {
    const headers = {
      Accept: "application/json",
      "User-Agent": userAgent(),
    };
    const noAuth = forceNoAuth || isCatalogNoAuthPath(url.pathname) || isCdnHost(url.hostname);
    if (!noAuth && requireAuth) {
      headers.Authorization = `Bearer ${requireAccessToken()}`;
    } else if (!noAuth && accessToken() && requireAuth !== false && opts.sendAuthIfPresent) {
      headers.Authorization = `Bearer ${accessToken()}`;
    }

    // When requireAuth is true we already attached. When false explicitly and not forceNoAuth,
    // still omit Auth unless caller asked sendAuthIfPresent.
    // Catalog paths: never Auth.

    if (!exempt && dailyStopActive()) {
      const info = rateLimitStatusPayload();
      return {
        status: 429,
        headers: {},
        body: {
          error: limitState.lastError || "user_limit_exceeded",
          message: "Local gate: daily quota previously exceeded this session. Wait until NY midnight reset.",
          rateLimit: info,
        },
        text: "",
        location: null,
        classified: {
          kind: limitState.lastKind || "daily_user",
          waitMs: 0,
          stopService: true,
          error: limitState.lastError,
        },
        localGate: true,
      };
    }

    // Pacing for counted requests
    if (!exempt) {
      const m = method.toUpperCase();
      if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
        const since = Date.now() - lastPostAt;
        if (since < POST_GAP_MS) await sleep(POST_GAP_MS - since);
      } else if (m === "GET") {
        const since = Date.now() - lastCountedGetAt;
        if (since < GET_MIN_GAP_MS) await sleep(GET_MIN_GAP_MS - since);
      }
    }

    let result = await rawRequest(method, url, { headers, body, form });

    if (!exempt) {
      const m = method.toUpperCase();
      if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
        lastPostAt = Date.now();
      } else if (m === "GET") {
        lastCountedGetAt = Date.now();
      }
      updateLimitHeaders(result.headers);
    }

    // Optional redirect follow (for /redirect Location)
    if (
      followRedirect &&
      (result.status === 301 || result.status === 302 || result.status === 303 || result.status === 307 || result.status === 308) &&
      result.location &&
      maxRedirects > 0
    ) {
      const next = new URL(result.location, url);
      // Return location metadata rather than chasing onto simkl.com HTML by default
      // Caller can set followRedirectBody to actually GET the next URL.
      if (opts.followRedirectBody) {
        return simklRequest("GET", next.toString(), {
          ...opts,
          followRedirect: true,
          maxRedirects: maxRedirects - 1,
          requireAuth: false,
          forceNoAuth: isCatalogNoAuthPath(next.pathname) || isCdnHost(next.hostname),
        });
      }
      return {
        ...result,
        redirectLocation: result.location,
      };
    }

    let classified = classifySimklResponse(result.status, result.body, result.headers);
    limitState.lastKind = classified.kind;
    limitState.lastError = classified.error;
    if (classified.retryAfter != null) limitState.lastRetryAfter = classified.retryAfter;

    // Auto-refresh once on 401 if a Bearer was actually sent (token rejected/expired) and we hold a refresh
    // token. Decided by "was Authorization sent", not by the error string: an expired Bearer may also come
    // back as user_token_required.
    if (
      allowRefresh &&
      !didRefresh &&
      result.status === 401 &&
      Boolean(headers.Authorization) &&
      refreshToken()
    ) {
      const ref = await refreshAccessToken();
      if (ref.ok) {
        return doSend(true);
      }
    }

    return { ...result, classified };
  };

  const runWithRetries = async () => {
    let attempt = 0;
    while (true) {
      const result = await doSend(false);
      const kind = result.classified && result.classified.kind;

      if (kind === "per_second" && attempt < PER_SECOND_MAX_RETRIES) {
        const wait = (result.classified && result.classified.waitMs) || PER_SECOND_WAIT_MS;
        log(
          `simkl: per_second 429; wait ${wait}ms (attempt ${attempt + 1}/${PER_SECOND_MAX_RETRIES})`
        );
        await sleep(wait);
        attempt += 1;
        continue;
      }

      if (kind === "write_lock" && attempt < PER_SECOND_MAX_RETRIES) {
        const wait = (result.classified && result.classified.waitMs) || WRITE_LOCK_WAIT_MS;
        log(`simkl: write_lock 400; wait ${wait}ms (attempt ${attempt + 1})`);
        await sleep(wait);
        attempt += 1;
        continue;
      }

      if (kind === "daily_user" || kind === "daily_app") {
        limitState.dailyStopped = true;
        limitState.dailyStoppedUntil = nextNyMidnight().getTime(); // cleared after NY midnight
        // Do NOT auto-retry daily quota
      }

      return result;
    }
  };

  if (exempt) {
    // Still serialize lightly to avoid stampeding; no gap tracking
    return enqueue(() => runWithRetries());
  }
  return enqueue(() => runWithRetries());
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------
function toolResult(data, { isError = false } = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text", text }],
    isError: isError || undefined,
  };
}

function httpErrorResult(result) {
  const payload = {
    status: result.status,
    body: result.body ?? result.text,
    classified: result.classified || null,
    rateLimit: rateLimitStatusPayload(),
  };
  if (result.redirectLocation) payload.redirectLocation = result.redirectLocation;
  if (result.location) payload.location = result.location;
  return toolResult(payload, { isError: true });
}

async function callApi(method, path, opts = {}) {
  try {
    const result = await simklRequest(method, path, opts);
    if (result.status === 204) {
      return toolResult({ ok: true, status: 204 });
    }
    // Redirect success for /redirect when not following body
    if (
      (result.status === 301 || result.status === 302) &&
      (result.redirectLocation || result.location)
    ) {
      return toolResult({
        status: result.status,
        location: result.redirectLocation || result.location,
        body: result.body,
      });
    }
    if (result.status >= 200 && result.status < 300) {
      return toolResult(result.body);
    }
    return httpErrorResult(result);
  } catch (err) {
    if (err && (err.code === "MISSING_CLIENT_ID" || err.code === "MISSING_ACCESS_TOKEN")) {
      return toolResult(err.message, { isError: true });
    }
    const code = err && err.code && /^[A-Z_]+$/.test(String(err.code)) ? `${err.code}: ` : "";
    return toolResult(
      `Request failed: ${code}${err && err.message ? err.message : String(err)}`,
      { isError: true }
    );
  }
}

function pickDebugLimit(args = {}) {
  if (args.debugLimit === "user" || args.debugLimit === "app") return args.debugLimit;
  return null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "simkl_rate_limit_status",
    annotations: { readOnlyHint: true },
    description:
      "Local AUTH V2 rate-limit state: limit, remaining, resetsAtIso (next America/New_York midnight), resetsInSeconds, lastKind, lastError, headersSeen. Does not call the API.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "simkl_get_settings",
    annotations: { readOnlyHint: true },
    description: "GET /users/settings — authenticated user settings. Requires Bearer.",
    inputSchema: {
      type: "object",
      properties: {
        debugLimit: { type: "string", enum: ["user", "app"], description: "Testing only — forces a 429" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_activities",
    annotations: { readOnlyHint: true },
    description:
      "GET /sync/activities — cheap sync gate. ALWAYS call before simkl_get_all_items; skip unchanged buckets. Requires Bearer.",
    inputSchema: {
      type: "object",
      properties: {
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_all_items",
    annotations: { readOnlyHint: true },
    description:
      "GET /sync/all-items/{type}/{status}. type: movies|shows|anime|all. status defaults to all (watching|plantowatch|hold|completed|dropped|all). Optional date_from (ISO). Call simkl_get_activities first. Requires Bearer. Expensive — do not poll.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["movies", "shows", "anime", "all"] },
        status: {
          type: "string",
          enum: ["watching", "plantowatch", "hold", "completed", "dropped", "all"],
        },
        date_from: { type: "string", description: "ISO datetime lower bound" },
        extended: {
          type: "string",
          enum: ["full", "full_anime_seasons", "simkl_ids_only", "ids_only"],
        },
        next_watch_info: { type: "string", enum: ["yes"] },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_search_id",
    annotations: { readOnlyHint: true },
    description:
      "GET /search/id — resolve by external IDs (imdb, tmdb, tvdb, mal, anilist, …). Prefer simkl_redirect for cheap Simkl-ID resolve when you only need the id. Requires Bearer on AUTH V2.",
    inputSchema: {
      type: "object",
      properties: {
        imdb: { type: "string" },
        tmdb: { type: ["string", "integer"] },
        tvdb: { type: ["string", "integer"] },
        mal: { type: ["string", "integer"] },
        anilist: { type: ["string", "integer"] },
        anidb: { type: ["string", "integer"] },
        kitsu: { type: ["string", "integer"] },
        simkl: { type: ["string", "integer"] },
        type: { type: "string", enum: ["show", "movie"] },
        title: { type: "string" },
        year: { type: "integer" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_redirect",
    annotations: { readOnlyHint: true },
    description:
      "GET /redirect — returns 301 Location with resolved Simkl URL/id (prefer over search/id for cheap resolve). AUTH V2 requires Bearer. Quota-exempt per rate-limits docs. Returns the 301 Location only; redirects are never followed.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", enum: ["simkl", "trailer", "twitter", "watched"], default: "simkl" },
        imdb: { type: "string" },
        tmdb: { type: ["string", "integer"] },
        tvdb: { type: ["string", "integer"] },
        mal: { type: ["string", "integer"] },
        anilist: { type: ["string", "integer"] },
        anidb: { type: ["string", "integer"] },
        type: { type: "string", enum: ["show", "tv", "movie", "anime"] },
        title: { type: "string" },
        year: { type: "integer" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_search_text",
    annotations: { readOnlyHint: true },
    description:
      "GET /search/{type}?q=… — text search. type: tv|anime|movie. Requires Bearer on AUTH V2. Optional limit, extended (simple|full).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["tv", "anime", "movie"] },
        q: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        extended: { type: "string", enum: ["simple", "full"] },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["type", "q"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_movie",
    annotations: { readOnlyHint: true },
    description:
      "GET /movies/{id} — Cloudflare-cached catalog. NO Authorization (Auth busts edge cache). Needs client_id only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "integer"], description: "Simkl movie id" },
        extended: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_tv",
    annotations: { readOnlyHint: true },
    description:
      "GET /tv/{id} — Cloudflare-cached catalog. NO Authorization. Needs client_id only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "integer"] },
        extended: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_anime",
    annotations: { readOnlyHint: true },
    description:
      "GET /anime/{id} — Cloudflare-cached catalog. NO Authorization. Needs client_id only.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "integer"] },
        extended: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_tv_episodes",
    annotations: { readOnlyHint: true },
    description:
      "GET /tv/episodes/{id} — Cloudflare-cached. NO Authorization.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "integer"], description: "Simkl show id" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_anime_episodes",
    annotations: { readOnlyHint: true },
    description:
      "GET /anime/episodes/{id} — Cloudflare-cached. NO Authorization.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: ["string", "integer"], description: "Simkl anime id" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_trending",
    annotations: { readOnlyHint: true },
    description:
      "GET CDN https://data.simkl.in/discover/trending/… — no Bearer, quota-exempt. Params: category (combined|movies|tv|anime), timeframe (today|week|month), size (100|500). Default combined/today/100. Attribution: include “Simkl” + “Trending” in UI titles.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["combined", "movies", "tv", "anime"],
          default: "combined",
        },
        timeframe: {
          type: "string",
          enum: ["today", "week", "month"],
          default: "today",
        },
        size: { type: "integer", enum: [100, 500], default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_add_to_list",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /sync/add-to-list — move items into a watchlist status (to). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed (+ massEditConfirmed when ≥10 counted). Never parallelize. Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          enum: ["watching", "plantowatch", "hold", "completed", "dropped"],
        },
        movies: { type: "array", items: { type: "object" } },
        shows: { type: "array", items: { type: "object" } },
        anime: { type: "array", items: { type: "object" } },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user said yes to the preview (needed with confirmToken).",
        },
        massEditConfirmed: {
          type: "boolean",
          description: "Needed with confirmToken when counted items (incl. nested episodes) ≥ 10.",
        },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_add_history",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /sync/history — mark watched. Items may nest seasons[].episodes[]; nested episodes count toward the mass-edit threshold; a show without seasons counts as a mass edit. TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed (+ massEditConfirmed). Serialize writes (≥1.05s). Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        movies: { type: "array", items: { type: "object" } },
        shows: { type: "array", items: { type: "object" } },
        anime: { type: "array", items: { type: "object" } },
        episodes: { type: "array", items: { type: "object" } },
        skip_auto_watching: { type: "string", enum: ["yes"] },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user said yes to the preview (needed with confirmToken).",
        },
        massEditConfirmed: {
          type: "boolean",
          description: "Needed with confirmToken when counted items (incl. nested episodes) ≥ 10.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_remove_history",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "DESTRUCTIVE WRITE: POST /sync/history/remove — un-watch / remove history (a show without seasons removes ALL its history). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed + deleteConfirmed (+ massEditConfirmed). Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        movies: { type: "array", items: { type: "object" } },
        shows: { type: "array", items: { type: "object" } },
        anime: { type: "array", items: { type: "object" } },
        episodes: { type: "array", items: { type: "object" } },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user said yes to the preview (needed with confirmToken).",
        },
        deleteConfirmed: {
          type: "boolean",
          description:
            "REQUIRED true for deletes/un-watch after the user explicitly confirms the destructive action.",
        },
        massEditConfirmed: {
          type: "boolean",
          description: "Needed with confirmToken when counted items (incl. nested episodes) ≥ 10.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_add_ratings",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /sync/ratings — set 1–10 ratings (each item needs ids/title and integer rating). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed (+ massEditConfirmed). Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        movies: { type: "array", items: { type: "object" } },
        shows: { type: "array", items: { type: "object" } },
        anime: { type: "array", items: { type: "object" } },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user said yes to the preview (needed with confirmToken).",
        },
        massEditConfirmed: {
          type: "boolean",
          description: "Needed with confirmToken when counted items (incl. nested episodes) ≥ 10.",
        },
      },
      additionalProperties: false,
    },
  },
  // ----- Sync extras -----
  {
    name: "simkl_get_playback",
    annotations: { readOnlyHint: true },
    description:
      "GET /sync/playback or /sync/playback/{type} — paused playback sessions (Continue Watching). Optional type: movies|episodes. Query: limit, hide_watched, date_from, date_to. Requires Bearer. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["movies", "episodes"] },
        limit: { type: "number" },
        hide_watched: { type: "string", enum: ["true", "false"], default: "true" },
        date_from: { type: "string" },
        date_to: { type: "string" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_delete_playback",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "DESTRUCTIVE: DELETE /sync/playback/{id} — remove a paused playback session (id: positive integer from simkl_get_playback). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed + deleteConfirmed. Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Playback session id from GET /sync/playback" },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user explicitly confirmed (needed with confirmToken).",
        },
        deleteConfirmed: {
          type: "boolean",
          description: "Set true only after the user explicitly confirmed (needed with confirmToken).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_remove_ratings",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "DESTRUCTIVE WRITE: POST /sync/ratings/remove — clear ratings (does NOT remove from watchlist). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed + deleteConfirmed (+ massEditConfirmed). Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        movies: { type: "array", items: { type: "object" } },
        shows: { type: "array", items: { type: "object" } },
        anime: { type: "array", items: { type: "object" } },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user explicitly confirmed (needed with confirmToken).",
        },
        deleteConfirmed: {
          type: "boolean",
          description: "Set true only after the user explicitly confirmed (needed with confirmToken).",
        },
        massEditConfirmed: {
          type: "boolean",
          description: "Needed with confirmToken when counted items (incl. nested episodes) ≥ 10.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_watched",
    annotations: { readOnlyHint: true },
    description:
      "POST /sync/watched — lookup watched status for known items (NOT a library mutation). Body is an array of id objects (pass as items[]). Optional query extended: counters,episodes,specials. Requires Bearer. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "WatchedLookupRequest — array of { type?, season?, episode?, …ids }",
          items: { type: "object" },
        },
        extended: {
          type: "string",
          description: "Comma-separated: counters, episodes, specials",
        },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_ratings",
    annotations: { readOnlyHint: true },
    description:
      "GET /sync/ratings/{type}/{rating} — user's own rated items. type: movies|shows|anime. rating: 1–10 or CSV e.g. 8,9,10 or 1,2,3,4,5,6,7,8,9,10 for all. Optional date_from. Requires Bearer. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["movies", "shows", "anime"] },
        rating: {
          type: "string",
          description: "Single 1–10 or comma-separated list (e.g. 8,9,10)",
        },
        date_from: { type: "string" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["type", "rating"],
      additionalProperties: false,
    },
  },
  // ----- Scrobble -----
  {
    name: "simkl_scrobble_start",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /scrobble/start — begin/resume watching session. Body: progress + movie OR show+episode OR anime[+episode]. Optional allow_rewatch=yes|no. TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flag: userConfirmed. Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        progress: { type: "number", description: "0–100 playback percent" },
        movie: { type: "object" },
        show: { type: "object" },
        anime: { type: "object" },
        episode: { type: "object" },
        allow_rewatch: { type: "string", enum: ["yes", "no"] },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: {
          type: "boolean",
          description: "Set true only after the user explicitly confirmed (needed with confirmToken).",
        },
      },
      required: ["progress"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_scrobble_pause",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /scrobble/pause — save resumable progress (Continue Watching). Same body as start. TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flag: userConfirmed. Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        progress: { type: "number" },
        movie: { type: "object" },
        show: { type: "object" },
        anime: { type: "object" },
        episode: { type: "object" },
        allow_rewatch: { type: "string", enum: ["yes", "no"] },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: { type: "boolean" },
      },
      required: ["progress"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_scrobble_stop",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /scrobble/stop — end session (≥80 marks watched; <80 saves pause). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flag: userConfirmed. Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        progress: { type: "number" },
        movie: { type: "object" },
        show: { type: "object" },
        anime: { type: "object" },
        episode: { type: "object" },
        allow_rewatch: { type: "string", enum: ["yes", "no"] },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: { type: "boolean" },
      },
      required: ["progress"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_scrobble_checkin",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "WRITE: POST /scrobble/checkin — check-in (progress optional/ignored). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flag: userConfirmed. Requires Bearer + media:write.",
    inputSchema: {
      type: "object",
      properties: {
        progress: { type: "number" },
        movie: { type: "object" },
        show: { type: "object" },
        anime: { type: "object" },
        episode: { type: "object" },
        allow_rewatch: { type: "string", enum: ["yes", "no"] },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  // ----- Lists -----
  {
    name: "simkl_get_list",
    annotations: { readOnlyHint: true },
    description:
      "GET /lists/{id} — custom list detail (PRO/VIP beta). Query: limit, page, direction, sort, extended=full. Requires Bearer. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Custom list id" },
        limit: { type: "integer" },
        page: { type: "integer" },
        direction: { type: "string", enum: ["asc", "desc"] },
        sort: { type: "string" },
        extended: { type: "string", enum: ["full"] },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_user_lists",
    annotations: { readOnlyHint: true },
    description:
      "GET /lists/user/{userId} — a user's custom lists (PRO/VIP beta). Query: limit, page, direction, sort, followed=true, collaborants=true. Requires Bearer. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        limit: { type: "integer" },
        page: { type: "integer" },
        direction: { type: "string", enum: ["asc", "desc"] },
        sort: {
          type: "string",
          enum: ["updated", "created", "name", "likes", "followers", "items", "popularity"],
        },
        followed: { type: "string", enum: ["true"] },
        collaborants: { type: "string", enum: ["true"] },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  // ----- Users / stats -----
  {
    name: "simkl_get_user_stats",
    annotations: { readOnlyHint: true },
    description:
      "GET /users/{user_id}/stats — live watch statistics. Use numeric user_id from simkl_get_settings for self. Requires Bearer. No confirm gate. Expensive — avoid polling.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "integer" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_recently_watched_background",
    annotations: { readOnlyHint: true },
    description:
      "GET /users/recently-watched-background/{user_id} — last-watched metadata (or redirect when image=poster|fanart). AUTH V2 needs Bearer despite OpenAPI “public” note. Private profiles → 404. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "integer" },
        image: { type: "string", enum: ["poster", "fanart"] },
      },
      required: ["user_id"],
      additionalProperties: false,
    },
  },
  // ----- Search extras -----
  {
    name: "simkl_search_file",
    annotations: { readOnlyHint: true },
    description:
      "POST /search/file — identify a video by filename (scrobbler helper). Body: file (required), optional part, hash, process. Requires Bearer on V2. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        part: { type: "integer" },
        hash: { type: "string" },
        process: { type: "string" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "simkl_search_random",
    annotations: { readOnlyHint: true },
    description:
      "POST /search/random — random pick (What should I watch?). Filters as query: service, type, genre, rating_from/to, rank_limit, year_from/to, limit, country. Requires Bearer on V2. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["simkl", "netflix", "crunchy", "hulu"] },
        type: { type: "string", enum: ["movie", "tv", "anime"] },
        genre: { type: "string" },
        rating_from: { type: "integer" },
        rating_to: { type: "integer" },
        rank_limit: { type: "integer" },
        year_from: { type: "integer" },
        year_to: { type: "integer" },
        limit: { type: "integer" },
        country: { type: "string" },
        debugLimit: { type: "string", enum: ["user", "app"] },
      },
      additionalProperties: false,
    },
  },
  // ----- Catalog genres / airing -----
  {
    name: "simkl_get_movies_genres",
    annotations: { readOnlyHint: true },
    description:
      "GET /movies/genres/{genre}/{type}/{country}/{year}/{sort} — genre browse (thin V1 cards; not ideal for 10-foot TV UIs). type path must be literal movies. Defaults: genre=all, type=movies, country=all, year=all, sort=rank. AUTH V2 requires Bearer (OpenAPI lists clientId-only; V2 apps still need user token). No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        genre: { type: "string", default: "all" },
        type: { type: "string", enum: ["movies"], default: "movies" },
        country: { type: "string", default: "all" },
        year: { type: "string", default: "all" },
        sort: {
          type: "string",
          enum: [
            "popular-this-week",
            "popular-this-month",
            "popular-all-time",
            "rank",
            "release-date",
            "voted",
            "watched",
          ],
          default: "rank",
        },
        page: { type: "integer" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_tv_genres",
    annotations: { readOnlyHint: true },
    description:
      "GET /tv/genres/{genre}/{type}/{country}/{network}/{year}/{sort} — TV genre browse (thin V1). Defaults all/all/all/all/rank. AUTH V2 requires Bearer (OpenAPI lists clientId-only; V2 apps still need user token). No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        genre: { type: "string", default: "all" },
        type: { type: "string", enum: ["all", "series", "mini-series", "specials"], default: "all" },
        country: { type: "string", default: "all" },
        network: { type: "string", default: "all" },
        year: { type: "string", default: "all" },
        sort: {
          type: "string",
          enum: [
            "popular-this-week",
            "popular-this-month",
            "popular-all-time",
            "rank",
            "release-date",
            "voted",
            "watched",
          ],
          default: "rank",
        },
        page: { type: "integer" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_anime_genres",
    annotations: { readOnlyHint: true },
    description:
      "GET /anime/genres/{genre}/{type}/{network}/{year}/{sort} — anime genre browse (thin V1). Defaults all/all/all/rank. AUTH V2 requires Bearer (OpenAPI lists clientId-only; V2 apps still need user token). No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        genre: { type: "string", default: "all" },
        type: {
          type: "string",
          enum: ["all", "tv", "movies", "ovas", "onas", "specials", "music"],
          default: "all",
        },
        network: { type: "string", default: "all" },
        year: { type: "string", default: "all" },
        sort: {
          type: "string",
          enum: [
            "popular-this-week",
            "popular-this-month",
            "popular-all-time",
            "rank",
            "release-date",
            "voted",
            "watched",
          ],
          default: "rank",
        },
        page: { type: "integer" },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_anime_airing",
    annotations: { readOnlyHint: true },
    description:
      "GET /anime/airing — anime airing today/tomorrow/date. Query: date, sort=time|rank|popularity. AUTH V2 needs Bearer. Prefer CDN calendar for high traffic. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD or omit for default window" },
        sort: { type: "string", enum: ["time", "rank", "popularity"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_get_tv_airing",
    annotations: { readOnlyHint: true },
    description:
      "GET /tv/airing — TV airing today/tomorrow/date. Query: date, sort=time|rank|popularity. AUTH V2 needs Bearer. Prefer CDN calendar for high traffic. No confirm gate. (No movies airing path in OpenAPI.)",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string" },
        sort: { type: "string", enum: ["time", "rank", "popularity"] },
      },
      additionalProperties: false,
    },
  },
  // ----- CDN calendar -----
  {
    name: "simkl_get_calendar",
    annotations: { readOnlyHint: true },
    description:
      "CDN GET https://data.simkl.in/calendar/… — rolling 33-day (/calendar/{type}.json) or monthly archive (/calendar/{year}/{month}/{type}.json). type: tv|anime|movie_release. No Auth, quota-exempt like trending. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["tv", "anime", "movie_release"] },
        year: { type: "integer", description: "If set with month → monthly archive" },
        month: { type: "integer", description: "1–12; with year → monthly archive" },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  // ----- Auth revoke -----
  {
    name: "simkl_oauth_revoke",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "DESTRUCTIVE: POST /oauth2/revoke — invalidate access or refresh token (revoking one revokes the grant). TWO-PHASE GATE: the first call returns a preview + single-use confirmToken and sends nothing; show the preview to the user, and only after they say yes call again with the same arguments + confirmToken + the named flags. Flags: userConfirmed + revokeConfirmed. Clears local in-memory + .env.local tokens ONLY if the revoked token is the local one (keeps CLIENT_ID). Optional token arg; defaults to current access then refresh.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to revoke; default SIMKL_ACCESS_TOKEN then SIMKL_REFRESH_TOKEN",
        },
        token_type_hint: {
          type: "string",
          enum: ["access_token", "refresh_token"],
        },
        confirmToken: { type: "string", description: "Single-use token from the preview response (first call without it). Pass ONLY after the user says yes to the preview; bound to this exact payload, expires in 5 minutes." },
        userConfirmed: { type: "boolean" },
        revokeConfirmed: {
          type: "boolean",
          description: "Set true only after the user explicitly confirmed (needed with confirmToken).",
        },
      },
      additionalProperties: false,
    },
  },
  // ----- Misc -----
  {
    name: "simkl_get_changes",
    annotations: { readOnlyHint: true },
    description:
      "GET /changes — catalog IDs changed in last N days (capped 14). Query: date_from (YYYY-MM-DD), type CSV anime,shows,movies. AUTH V2 needs Bearer. No confirm gate.",
    inputSchema: {
      type: "object",
      properties: {
        date_from: { type: "string" },
        type: {
          type: "string",
          description: "CSV of anime,shows,movies (default anime,shows,movies)",
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: "simkl_device_start",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "POST /oauth2/device — start AUTH V2 device flow. Returns user_code, verification_uri(_complete), interval, expires_in. The device_code stays server-side (never returned). Show the URL to the user, then call simkl_device_poll (no arguments) once per interval. Pass scope 'media:read media:write' if you will write.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["media:read", "media:read media:write"],
          description: "Default media:read if omitted. Use 'media:read media:write' if syncing/writes are needed (otherwise every write returns MISSING_WRITE_SCOPE).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_device_poll",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "One poll of POST /oauth2/token for the device flow started by simkl_device_start (device_code is held server-side; no arguments needed). On success persists tokens + scope to .env.local and returns ONLY {ok, scope, expires_in, refresh_token_present, persisted}; tokens are never returned. Otherwise authorization_pending / slow_down / expired_token. ONE poll per call — wait `interval` seconds between calls.",
    inputSchema: {
      type: "object",
      properties: {
        device_code: {
          type: "string",
          description: "Deprecated/optional (backwards compat only). Ignored in favour of the server-held code unless none is held; never echoed.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "simkl_token_refresh",
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      "POST /oauth2/token grant_type=refresh_token now. Refresh is non-rotating. Updates in-memory + .env.local tokens and scope. Returns ONLY {ok, scope, expires_in, refresh_token_present, persisted}; tokens are never returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];


// ---------------------------------------------------------------------------
// Input validation helpers (path params, schema, write payloads)
// ---------------------------------------------------------------------------
class ArgError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || null;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Positive safe integer (number, or canonical decimal string when allowString). */
function positiveInt(name, v, allowString = false) {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  if (allowString && typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v)) return Number(v);
  throw new ArgError("INVALID_INPUT", `${name} must be a positive integer.`);
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Catalog/list id for a path segment: positive integer or strict slug. Never '.', '..', '/', '?', '#', '%'. */
function pathId(name, v) {
  if (typeof v === "number") return String(positiveInt(name, v));
  if (typeof v === "string") {
    if (/^[0-9]+$/.test(v)) return String(positiveInt(name, v, true));
    if (SLUG_RE.test(v)) return v;
  }
  throw new ArgError(
    "INVALID_INPUT",
    `${name} must be a positive integer or a slug (letters, digits, '-', '_'); '.', '..', '/', '?', '#' are rejected.`
  );
}

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Free-form path segment (genre, country, network, year, sort...). */
function ratingPath(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10) return String(v);
  if (typeof v === "string" && /^(10|[1-9])(,(10|[1-9]))*$/.test(v)) return v;
  throw new ArgError("INVALID_INPUT", "rating must be 1-10 or a comma-separated list such as 8,9,10.");
}
function calendarYear(v) {
  const n = positiveInt("year", v);
  if (n < 1900 || n > 2200) throw new ArgError("INVALID_INPUT", "year must be 1900-2200.");
  return n;
}
function calendarMonth(v) {
  const n = positiveInt("month", v);
  if (n > 12) throw new ArgError("INVALID_INPUT", "month must be 1-12.");
  return n;
}
function pathSegment(name, v) {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s === "string" && SEGMENT_RE.test(s)) return s;
  throw new ArgError(
    "INVALID_INPUT",
    `${name} must match ${SEGMENT_RE} (letters, digits, '-', '_'); '.', '..', '/', '?', '#' are rejected.`
  );
}

function typeOk(t, v) {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "integer":
      return Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return isPlainObject(v);
    case "array":
      return Array.isArray(v);
    default:
      return true;
  }
}

/** Basic inputSchema enforcement: required, type, enum, minimum/maximum, array item type. */
function validateArgs(tool, args) {
  const schema = tool.inputSchema || {};
  const errors = [];
  if (!isPlainObject(args)) {
    return ["arguments must be an object"];
  }
  for (const req of schema.required || []) {
    if (args[req] === undefined || args[req] === null) errors.push(`missing required argument: ${req}`);
  }
  const isWrite = Boolean(WRITE_SPECS[tool.name]);
  for (const [k, v] of Object.entries(args)) {
    const def = schema.properties && schema.properties[k];
    if (!def) {
      continue; // unknown arguments are ignored (never forwarded: bodies are built field by field)
    }
    if (v === undefined || v === null) continue;
    // Item arrays on write tools are validated in depth by the write builder (INVALID_INPUT / EMPTY_WRITE).
    if (isWrite && ["movies", "shows", "anime", "episodes"].includes(k)) continue;
    const types = def.type ? (Array.isArray(def.type) ? def.type : [def.type]) : null;
    if (types && !types.some((t) => typeOk(t, v))) {
      errors.push(`${k} must be of type ${types.join("|")}`);
      continue;
    }
    if (def.enum && !def.enum.includes(v)) errors.push(`${k} must be one of: ${def.enum.join(", ")}`);
    if (typeof v === "number") {
      if (def.minimum != null && v < def.minimum) errors.push(`${k} must be >= ${def.minimum}`);
      if (def.maximum != null && v > def.maximum) errors.push(`${k} must be <= ${def.maximum}`);
    }
    if (Array.isArray(v) && def.items && def.items.type) {
      const it = Array.isArray(def.items.type) ? def.items.type : [def.items.type];
      v.forEach((x, i) => {
        if (!it.some((t) => typeOk(t, x))) errors.push(`${k}[${i}] must be of type ${it.join("|")}`);
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Write payloads: validate, count (incl. nested episodes), preview, hash
// ---------------------------------------------------------------------------

/** Mass-edit threshold: agents must get an extra explicit ack at/above this (counted over nested leaves). */
const MASS_EDIT_THRESHOLD = 10;
/** A whole show / whole season with no explicit episode list can't be counted: treat as a mass edit. */
const UNBOUNDED_WEIGHT = MASS_EDIT_THRESHOLD;
const PREVIEW_MAX_ITEMS = 10;

const DESTRUCTIVE_TOOLS = new Set([
  "simkl_remove_history",
  "simkl_remove_ratings",
  "simkl_delete_playback",
]);
const REVOKE_TOOLS = new Set(["simkl_oauth_revoke"]);
const SCROBBLE_TOOLS = new Set([
  "simkl_scrobble_start",
  "simkl_scrobble_pause",
  "simkl_scrobble_stop",
  "simkl_scrobble_checkin",
]);

const WRITE_SPECS = {
  simkl_add_to_list: { method: "POST", path: "/sync/add-to-list", keys: ["movies", "shows", "anime"], label: "Move to list" },
  simkl_add_history: { method: "POST", path: "/sync/history", keys: ["movies", "shows", "anime", "episodes"], history: true, label: "Mark watched" },
  simkl_remove_history: { method: "POST", path: "/sync/history/remove", keys: ["movies", "shows", "anime", "episodes"], history: true, label: "REMOVE watch history" },
  simkl_add_ratings: { method: "POST", path: "/sync/ratings", keys: ["movies", "shows", "anime"], rating: true, label: "Set ratings" },
  simkl_remove_ratings: { method: "POST", path: "/sync/ratings/remove", keys: ["movies", "shows", "anime"], label: "REMOVE ratings" },
};

function trunc(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function hasIds(ids) {
  return (
    isPlainObject(ids) &&
    Object.values(ids).some(
      (v) => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v))
    )
  );
}
function itemIdentified(it) {
  return hasIds(it.ids) || (typeof it.title === "string" && it.title.trim() !== "");
}
function idsString(ids) {
  if (!isPlainObject(ids)) return "";
  return Object.entries(ids)
    .filter(([, v]) => (typeof v === "string" && v) || typeof v === "number")
    .slice(0, 3)
    .map(([k, v]) => `${trunc(k, 12)}:${trunc(v, 40)}`)
    .join(" ");
}
function itemLabel(it) {
  const title = typeof it.title === "string" && it.title ? trunc(it.title, 80) : "(untitled)";
  const year = Number.isInteger(it.year) ? ` (${it.year})` : "";
  const ids = idsString(it.ids);
  return `${title}${year}${ids ? ` [${ids}]` : ""}`;
}

const KNOWN_ITEM_FIELDS = new Set(["title", "year", "ids", "rating", "rated_at", "watched_at", "seasons", "to", "season", "number", "show"]);

/**
 * Validate one array of items; returns {weight, lines, whole}. Throws ArgError(INVALID_INPUT).
 * Weight counts nested episode leaves (seasons[].episodes[]).
 */
function validateItemArray(key, arr, spec) {
  if (!Array.isArray(arr)) {
    throw new ArgError("INVALID_INPUT", `${key} must be an array of objects (got ${arr === null ? "null" : typeof arr}).`);
  }
  let weight = 0;
  let whole = 0;
  const lines = [];
  arr.forEach((it, i) => {
    const at = `${key}[${i}]`;
    if (!isPlainObject(it)) throw new ArgError("INVALID_INPUT", `${at} must be an object with ids or title.`);
    const identified =
      key === "episodes"
        ? itemIdentified(it) || (isPlainObject(it.show) && itemIdentified(it.show))
        : itemIdentified(it);
    if (!identified) {
      throw new ArgError(
        "INVALID_INPUT",
        `${at} must carry a non-empty ids object or a title (empty items such as {} are rejected).`
      );
    }
    if (spec.rating && (!Number.isInteger(it.rating) || it.rating < 1 || it.rating > 10)) {
      throw new ArgError("INVALID_INPUT", `${at}.rating must be an integer 1-10.`);
    }
    let w = 1;
    let detail = "";
    if (it.seasons !== undefined) {
      if (!spec.history || (key !== "shows" && key !== "anime")) {
        throw new ArgError("INVALID_INPUT", `${at}.seasons is only supported on shows/anime items of simkl_add_history / simkl_remove_history.`);
      }
      if (!Array.isArray(it.seasons) || it.seasons.length === 0) {
        throw new ArgError("INVALID_INPUT", `${at}.seasons must be a non-empty array (omit it to target the whole show).`);
      }
      w = 0;
      const parts = [];
      it.seasons.forEach((s, si) => {
        const sat = `${at}.seasons[${si}]`;
        if (!isPlainObject(s) || !Number.isInteger(s.number) || s.number < 0) {
          throw new ArgError("INVALID_INPUT", `${sat}.number must be an integer >= 0.`);
        }
        if (s.episodes === undefined) {
          w += UNBOUNDED_WEIGHT;
          whole += 1;
          parts.push(`S${s.number}: ENTIRE SEASON`);
          return;
        }
        if (!Array.isArray(s.episodes) || s.episodes.length === 0) {
          throw new ArgError("INVALID_INPUT", `${sat}.episodes must be a non-empty array (omit it to target the whole season).`);
        }
        s.episodes.forEach((e, ei) => {
          const eat = `${sat}.episodes[${ei}]`;
          if (!isPlainObject(e) || !((Number.isInteger(e.number) && e.number >= 1) || hasIds(e.ids))) {
            throw new ArgError("INVALID_INPUT", `${eat} needs an integer number >= 1 or ids.`);
          }
        });
        w += s.episodes.length;
        const nums = s.episodes.map((e) => (Number.isInteger(e.number) ? e.number : "?")).slice(0, 12);
        parts.push(`S${s.number}: E${nums.join(",E")}${s.episodes.length > 12 ? ` …(+${s.episodes.length - 12})` : ""}`);
      });
      detail = ` — ${parts.slice(0, 6).join("; ")}${parts.length > 6 ? "; …" : ""}`;
    } else if (spec.history && (key === "shows" || key === "anime")) {
      w = UNBOUNDED_WEIGHT;
      whole += 1;
      detail = " — ENTIRE SHOW (all seasons/episodes)";
    }
    if (key === "episodes" && (it.season !== undefined || it.number !== undefined)) {
      detail += ` — S${it.season ?? "?"}E${it.number ?? "?"}`;
    }
    const extra = Object.keys(it).filter((k) => !KNOWN_ITEM_FIELDS.has(k));
    const rating = spec.rating ? ` → rating ${it.rating}` : "";
    lines.push(
      `${key}: ${itemLabel(key === "episodes" && !itemIdentified(it) ? it.show : it)}${rating}${detail}${
        extra.length ? ` (extra fields: ${extra.slice(0, 5).join(",")})` : ""
      }`
    );
    weight += w;
  });
  return { weight, lines, whole };
}

/** Build + validate a library write. Returns {method, path, body, query, count, preview, hashInput}. Throws ArgError. */
function buildLibraryWrite(toolName, args) {
  const spec = WRITE_SPECS[toolName];
  const body = {};
  const byType = {};
  let count = 0;
  let wholeEntries = 0;
  let allLines = [];
  for (const k of ["movies", "shows", "anime", "episodes"]) {
    if (args[k] === undefined || args[k] === null) continue;
    if (!spec.keys.includes(k)) {
      throw new ArgError("INVALID_INPUT", `${toolName} does not accept '${k}' (accepted: ${spec.keys.join(", ")}).`);
    }
    const r = validateItemArray(k, args[k], spec);
    body[k] = args[k];
    byType[k] = args[k].length;
    count += r.weight;
    wholeEntries += r.whole;
    allLines = allLines.concat(r.lines);
  }
  if (toolName === "simkl_add_to_list") {
    if (!["watching", "plantowatch", "hold", "completed", "dropped"].includes(args.to)) {
      throw new ArgError("INVALID_INPUT", "to must be one of watching|plantowatch|hold|completed|dropped.");
    }
    body.to = args.to;
  }
  const topLevel = Object.values(byType).reduce((a, b) => a + b, 0);
  if (topLevel === 0) {
    throw new ArgError(
      "EMPTY_WRITE",
      "Refusing write: no non-empty movies/shows/anime" +
        (spec.keys.includes("episodes") ? "/episodes" : "") +
        " arrays. Build the batch first, then confirm with the user."
    );
  }
  const query = {};
  if (toolName === "simkl_add_history" && args.skip_auto_watching) query.skip_auto_watching = args.skip_auto_watching;
  const preview = {
    action: spec.label + (args.to ? ` '${args.to}'` : ""),
    endpoint: `${spec.method} ${spec.path}`,
    ...(args.to ? { targetStatus: args.to } : {}),
    countedItems: count,
    topLevelItems: topLevel,
    byType,
    ...(wholeEntries ? { wholeShowOrSeasonEntries: wholeEntries, note: "Whole shows/seasons without an explicit episode list are counted as a mass edit." } : {}),
    items: allLines.slice(0, PREVIEW_MAX_ITEMS),
    ...(allLines.length > PREVIEW_MAX_ITEMS ? { moreItems: allLines.length - PREVIEW_MAX_ITEMS } : {}),
    ...(Object.keys(query).length ? { query } : {}),
  };
  return { method: spec.method, path: spec.path, body, query, count, preview, hashInput: { body, query } };
}

function buildScrobble(toolName, args) {
  const action = toolName.replace("simkl_scrobble_", "");
  const kinds = ["movie", "show", "anime"].filter((k) => args[k] !== undefined && args[k] !== null);
  if (kinds.length === 0) {
    throw new ArgError("EMPTY_WRITE", "Refusing scrobble: provide movie OR show OR anime (with ids or title). Build the body first, then confirm with the user.");
  }
  if (kinds.length > 1) throw new ArgError("INVALID_INPUT", `Provide exactly one of movie/show/anime (got ${kinds.join("+")}).`);
  const kind = kinds[0];
  if (!isPlainObject(args[kind]) || !itemIdentified(args[kind])) {
    throw new ArgError("EMPTY_WRITE", `${kind} must be an object with a non-empty ids object or title.`);
  }
  if (args.episode !== undefined && args.episode !== null) {
    if (kind === "movie") throw new ArgError("INVALID_INPUT", "episode is not valid with movie.");
    if (!isPlainObject(args.episode) || Object.keys(args.episode).length === 0) {
      throw new ArgError("INVALID_INPUT", "episode must be a non-empty object (e.g. {season, number}).");
    }
  }
  if (args.progress != null && (args.progress < 0 || args.progress > 100)) {
    throw new ArgError("INVALID_INPUT", "progress must be between 0 and 100.");
  }
  if (action !== "checkin" && args.progress == null) {
    throw new ArgError("INVALID_INPUT", "progress (0-100) is required for start/pause/stop.");
  }
  const body = {};
  if (args.progress != null) body.progress = args.progress;
  body[kind] = args[kind];
  if (args.episode) body.episode = args.episode;
  const query = {};
  if (args.allow_rewatch) query.allow_rewatch = args.allow_rewatch;
  const ep = args.episode ? ` ${trunc(JSON.stringify(args.episode), 80)}` : "";
  const preview = {
    action: `Scrobble ${action}`,
    endpoint: `POST /scrobble/${action}`,
    target: `${kind}: ${itemLabel(args[kind])}${ep}`,
    ...(args.progress != null ? { progress: args.progress } : {}),
    ...(action === "stop" && args.progress != null ? { effect: args.progress >= 80 ? "marks as watched (>=80)" : "saves a pause (<80)" } : {}),
    ...(Object.keys(query).length ? { query } : {}),
  };
  return { method: "POST", path: `/scrobble/${action}`, body, query, count: 1, preview, hashInput: { body, query } };
}

function buildDeletePlayback(args) {
  const id = positiveInt("id", args.id);
  return {
    method: "DELETE",
    path: `/sync/playback/${id}`,
    body: undefined,
    query: {},
    count: 1,
    preview: { action: "DELETE playback session", endpoint: `DELETE /sync/playback/${id}`, playbackId: id },
    hashInput: { id },
  };
}

function buildRevoke(args) {
  const custom = args.token && String(args.token).trim();
  const token = custom || accessToken() || refreshToken();
  if (!token) {
    throw new ArgError("NO_TOKEN", "No token to revoke. Pass token, or set SIMKL_ACCESS_TOKEN / SIMKL_REFRESH_TOKEN.");
  }
  const clearsLocal = token === accessToken() || token === refreshToken();
  const which = custom
    ? clearsLocal
      ? "the supplied token (it IS the local token)"
      : "a supplied token (NOT the local one)"
    : token === accessToken()
      ? "the local access token"
      : "the local refresh token";
  return {
    method: "POST",
    path: "/oauth2/revoke",
    count: 1,
    token,
    clearsLocal,
    preview: {
      action: "REVOKE Simkl OAuth grant",
      endpoint: "POST /oauth2/revoke",
      revokes: which,
      note: "Revoking either token of a pair revokes the whole grant.",
      localTokensCleared: clearsLocal
        ? "yes (in-memory + .env.local access/refresh/scope; CLIENT_ID kept)"
        : "no (supplied token differs from the local tokens)",
      ...(args.token_type_hint ? { token_type_hint: args.token_type_hint } : {}),
    },
    hashInput: { tokenSha256: sha256(token), hint: args.token_type_hint || null },
  };
}

function buildWrite(toolName, args) {
  if (WRITE_SPECS[toolName]) return buildLibraryWrite(toolName, args);
  if (SCROBBLE_TOOLS.has(toolName)) return buildScrobble(toolName, args);
  if (toolName === "simkl_delete_playback") return buildDeletePlayback(args);
  if (toolName === "simkl_oauth_revoke") return buildRevoke(args);
  throw new ArgError("INVALID_INPUT", `Not a write tool: ${toolName}`);
}

// ---------------------------------------------------------------------------
// Scope check (S1)
// ---------------------------------------------------------------------------
function checkWriteScope(toolName) {
  const s = scopeStatus();
  if (s.known && !s.hasWrite) {
    return {
      block: {
        error: "MISSING_WRITE_SCOPE",
        tool: toolName,
        grantedScope: s.scope,
        message: "The stored Simkl token does not include media:write, so this write would fail or silently no-op. Nothing was sent.",
        upgradeSteps: [
          "Call simkl_device_start with scope 'media:read media:write'.",
          "Have the user open verification_uri_complete and approve the wider scope.",
          "Call simkl_device_poll (once per interval) until it returns ok:true; tokens and scope are persisted.",
          "Check the returned scope includes media:write, then retry this write.",
        ],
      },
    };
  }
  return {
    note: s.known
      ? null
      : "Granted scope is unknown (no SIMKL_SCOPE stored; pre-existing or pasted token). The write is allowed, but if it is rejected or ignored, re-run simkl_device_start with scope 'media:read media:write'.",
  };
}

// ---------------------------------------------------------------------------
// Two-phase confirmation (S5/S6)
// ---------------------------------------------------------------------------
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const CONFIRM_MAX_TOKENS = 200;
/** confirmToken -> {hash, tool, expires} (in-memory, single-use) */
const confirmTokens = new Map();

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  const j = JSON.stringify(v);
  return j === undefined ? "null" : j;
}
function payloadHash(toolName, hashInput) {
  return sha256(toolName + "\n" + stableStringify(hashInput));
}
function pruneConfirmTokens() {
  const now = Date.now();
  for (const [t, e] of confirmTokens) if (e.expires <= now) confirmTokens.delete(t);
  while (confirmTokens.size >= CONFIRM_MAX_TOKENS) confirmTokens.delete(confirmTokens.keys().next().value);
}
function issueConfirmToken(toolName, hash) {
  pruneConfirmTokens();
  for (const [t, e] of confirmTokens) if (e.hash === hash) confirmTokens.delete(t); // one live token per payload
  const token = "ct_" + crypto.randomBytes(16).toString("hex");
  confirmTokens.set(token, { hash, tool: toolName, expires: Date.now() + CONFIRM_TTL_MS });
  return token;
}

function requiredFlagsFor(toolName, isMass) {
  const f = ["userConfirmed"];
  if (DESTRUCTIVE_TOOLS.has(toolName)) f.push("deleteConfirmed");
  if (REVOKE_TOOLS.has(toolName)) f.push("revokeConfirmed");
  if (isMass) f.push("massEditConfirmed");
  return f;
}

/**
 * Two-phase gate. Phase 1 (no confirmToken): returns WRITE_CONFIRMATION_REQUIRED with a preview and a
 * single-use confirmToken bound to tool + exact payload. Phase 2: the token must be echoed, plus the named
 * flags. Returns an error object, or null when the write may proceed (token consumed).
 */
function confirmGate(toolName, args, built, scopeNote) {
  const isRemove = DESTRUCTIVE_TOOLS.has(toolName);
  const isRevoke = REVOKE_TOOLS.has(toolName);
  const isScrobble = SCROBBLE_TOOLS.has(toolName);
  const count = built.count;
  const isMass = !isScrobble && !isRevoke && toolName !== "simkl_delete_playback" && count >= MASS_EDIT_THRESHOLD;
  const hash = payloadHash(toolName, built.hashInput);
  const flags = requiredFlagsFor(toolName, isMass);
  const common = { tool: toolName, itemCount: count, massEdit: isMass, massEditThreshold: MASS_EDIT_THRESHOLD, destructive: isRemove, revoke: isRevoke, scrobble: isScrobble };

  const given = args.confirmToken;
  if (typeof given !== "string" || given === "") {
    const token = issueConfirmToken(toolName, hash);
    return {
      error: "WRITE_CONFIRMATION_REQUIRED",
      ...common,
      preview: built.preview,
      ...(scopeNote ? { scopeNote } : {}),
      confirmToken: token,
      confirmTokenExpiresInSeconds: Math.round(CONFIRM_TTL_MS / 1000),
      requiredFlagsOnConfirm: flags,
      message:
        "Nothing was sent. This is a preview built from the exact payload. Show it to the user and ask. Only after they say yes, call this tool again with the SAME arguments plus confirmToken and the listed flags set to true. The token is single-use, expires, and is bound to this exact payload.",
      askUser: [
        `Present the preview: ${built.preview.action}${built.preview.endpoint ? ` (${built.preview.endpoint})` : ""}, ${count} item(s) counted.`,
        isRemove || isRevoke ? "This is destructive and cannot be undone from this tool." : null,
        isMass ? `Mass edit (>=${MASS_EDIT_THRESHOLD} counted): get an explicit acknowledgement of the batch size.` : null,
        "Do not pass confirmToken or any *Confirmed flag until the user answers yes in chat.",
      ].filter(Boolean),
    };
  }

  const entry = confirmTokens.get(given);
  let reason = null;
  if (!entry) reason = "unknown, expired or already used";
  else if (entry.expires <= Date.now()) {
    confirmTokens.delete(given);
    reason = "expired";
  } else if (entry.tool !== toolName || entry.hash !== hash) reason = "does not match this tool + payload (payload changed since the preview)";
  if (reason) {
    return {
      error: "CONFIRM_TOKEN_INVALID",
      ...common,
      reason,
      message: "Refusing write: confirmToken is invalid. Nothing was sent. Call again WITHOUT confirmToken to get a fresh preview, and re-confirm with the user.",
    };
  }

  if (args.userConfirmed !== true) {
    return {
      error: "WRITE_CONFIRMATION_REQUIRED",
      ...common,
      requiredFlagsOnConfirm: flags,
      message: "Refusing write: userConfirmed must be true (boolean) alongside the valid confirmToken. Only set it after the user explicitly said yes.",
    };
  }
  if (isRevoke && args.revokeConfirmed !== true) {
    return {
      error: "REVOKE_CONFIRMATION_REQUIRED",
      ...common,
      message: "Refusing revoke: set revokeConfirmed:true only after the user explicitly confirms the tokens will stop working.",
    };
  }
  if (isRemove && args.deleteConfirmed !== true) {
    return {
      error: "DELETE_CONFIRMATION_REQUIRED",
      ...common,
      message: "Refusing destructive write: set deleteConfirmed:true only after the user explicitly confirms the delete/remove.",
    };
  }
  if (isMass && args.massEditConfirmed !== true) {
    return {
      error: "MASS_EDIT_CONFIRMATION_REQUIRED",
      ...common,
      message: `Refusing mass edit (${count} counted >= ${MASS_EDIT_THRESHOLD}): set massEditConfirmed:true after the user acknowledges the batch size.`,
    };
  }
  confirmTokens.delete(given); // single use
  return null;
}

/**
 * Validate + scope-check + confirm-gate a write tool.
 * Returns {block} (toolResult error payload) or {built} (ready to send).
 */
function prepareWrite(toolName, args = {}) {
  let built;
  try {
    built = buildWrite(toolName, args);
  } catch (err) {
    if (err instanceof ArgError) {
      return { block: { error: err.code, tool: toolName, message: err.message, ...(err.extra || {}) } };
    }
    throw err;
  }
  let scopeNote = null;
  if (!REVOKE_TOOLS.has(toolName)) {
    const sc = checkWriteScope(toolName);
    if (sc.block) return { block: sc.block };
    scopeNote = sc.note;
  }
  const blocked = confirmGate(toolName, args, built, scopeNote);
  if (blocked) return { block: blocked };
  return { built, scopeNote };
}


const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Run a confirmed library write / scrobble / playback delete through the two-phase gate, then send it. */
async function runWrite(name, args, debugLimit) {
  const prep = prepareWrite(name, args);
  if (prep.block) return toolResult(prep.block, { isError: true });
  const { built, scopeNote } = prep;
  const res = await callApi(built.method, built.path, {
    requireAuth: true,
    ...(built.body !== undefined ? { body: built.body } : {}),
    query: built.query,
    debugLimit,
  });
  if (scopeNote && res && Array.isArray(res.content)) res.content.push({ type: "text", text: `Note: ${scopeNote}` });
  return res;
}

async function handleToolCall(name, args = {}) {
  if (args === null || args === undefined) args = {};
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return toolResult(`Unknown tool: ${name}`, { isError: true });
  const problems = validateArgs(tool, args);
  if (problems.length) {
    return toolResult(
      { error: "INVALID_ARGS", tool: name, message: `Invalid arguments: ${problems.join("; ")}`, problems },
      { isError: true }
    );
  }
  try {
    return await dispatchTool(name, args);
  } catch (err) {
    if (err instanceof ArgError) {
      return toolResult({ error: err.code, tool: name, message: err.message }, { isError: true });
    }
    throw err;
  }
}

async function dispatchTool(name, args) {
  const debugLimit = pickDebugLimit(args);

  switch (name) {
    case "simkl_rate_limit_status":
      return toolResult(rateLimitStatusPayload());

    case "simkl_get_settings":
      return callApi("GET", "/users/settings", {
        requireAuth: true,
        debugLimit,
      });

    case "simkl_get_activities":
      return callApi("GET", "/sync/activities", {
        requireAuth: true,
        debugLimit,
      });

    case "simkl_get_all_items": {
      const type = args.type || "all";
      const status = args.status || "all";
      const query = {};
      if (args.date_from) query.date_from = args.date_from;
      if (args.extended) query.extended = args.extended;
      if (args.next_watch_info) query.next_watch_info = args.next_watch_info;
      return callApi(
        "GET",
        `/sync/all-items/${pathSegment("type", type)}/${pathSegment("status", status)}`,
        { requireAuth: true, query, debugLimit }
      );
    }

    case "simkl_search_id": {
      const query = {};
      for (const k of [
        "imdb",
        "tmdb",
        "tvdb",
        "mal",
        "anilist",
        "anidb",
        "kitsu",
        "simkl",
        "type",
        "title",
        "year",
      ]) {
        if (args[k] != null && args[k] !== "") query[k] = args[k];
      }
      return callApi("GET", "/search/id", { requireAuth: true, query, debugLimit });
    }

    case "simkl_redirect": {
      const query = { to: args.to || "simkl" };
      for (const k of [
        "imdb",
        "tmdb",
        "tvdb",
        "mal",
        "anilist",
        "anidb",
        "type",
        "title",
        "year",
      ]) {
        if (args[k] != null && args[k] !== "") query[k] = args[k];
      }
      return callApi("GET", "/redirect", {
        requireAuth: true,
        rateExempt: true,
        followRedirect: false,
        query,
        debugLimit,
      });
    }

    case "simkl_search_text":
      return callApi("GET", `/search/${pathSegment("type", args.type)}`, {
        requireAuth: true,
        query: {
          q: args.q,
          limit: args.limit,
          extended: args.extended,
        },
        debugLimit,
      });

    case "simkl_get_movie":
      return callApi("GET", `/movies/${pathId("id", args.id)}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
        query: args.extended ? { extended: args.extended } : {},
      });

    case "simkl_get_tv":
      return callApi("GET", `/tv/${pathId("id", args.id)}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
        query: args.extended ? { extended: args.extended } : {},
      });

    case "simkl_get_anime":
      return callApi("GET", `/anime/${pathId("id", args.id)}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
        query: args.extended ? { extended: args.extended } : {},
      });

    case "simkl_get_tv_episodes":
      return callApi("GET", `/tv/episodes/${pathId("id", args.id)}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
      });

    case "simkl_get_anime_episodes":
      return callApi("GET", `/anime/episodes/${pathId("id", args.id)}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
      });

    case "simkl_get_trending": {
      const category = args.category || "combined";
      const timeframe = args.timeframe || "today";
      const size = args.size === 500 ? 500 : 100;
      const file = `${timeframe}_${size}.json`;
      const path =
        category === "combined"
          ? `/discover/trending/${file}`
          : `/discover/trending/${category}/${file}`;
      return callApi("GET", `${CDN_BASE}${path}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
      });
    }

    case "simkl_add_to_list":
    case "simkl_add_history":
    case "simkl_remove_history":
    case "simkl_add_ratings":
    case "simkl_remove_ratings":
    case "simkl_delete_playback":
      return runWrite(name, args, null); // debugLimit is not offered on write tools

    case "simkl_get_playback": {
      const query = {};
      if (args.limit != null) query.limit = args.limit;
      if (args.hide_watched != null) query.hide_watched = args.hide_watched;
      if (args.date_from) query.date_from = args.date_from;
      if (args.date_to) query.date_to = args.date_to;
      const apiPath =
        args.type === "movies" || args.type === "episodes"
          ? `/sync/playback/${pathSegment("type", args.type)}`
          : "/sync/playback";
      return callApi("GET", apiPath, { requireAuth: true, query, debugLimit });
    }

    case "simkl_watched": {
      if (!Array.isArray(args.items)) {
        return toolResult(
          {
            error: "INVALID_ARGS",
            message: "simkl_watched requires items: [] (OpenAPI WatchedLookupRequest is a JSON array body).",
          },
          { isError: true }
        );
      }
      const query = {};
      if (args.extended) query.extended = args.extended;
      return callApi("POST", "/sync/watched", {
        requireAuth: true,
        body: args.items,
        query,
        debugLimit,
      });
    }

    case "simkl_get_ratings":
      return callApi(
        "GET",
        `/sync/ratings/${pathSegment("type", args.type)}/${ratingPath(args.rating)}`,
        {
          requireAuth: true,
          query: args.date_from ? { date_from: args.date_from } : {},
          debugLimit,
        }
      );

    case "simkl_scrobble_start":
    case "simkl_scrobble_pause":
    case "simkl_scrobble_stop":
    case "simkl_scrobble_checkin":
      return runWrite(name, args, null); // debugLimit is not offered on write tools

    case "simkl_get_list": {
      const query = {};
      if (args.limit != null) query.limit = args.limit;
      if (args.page != null) query.page = args.page;
      if (args.direction) query.direction = args.direction;
      if (args.sort) query.sort = args.sort;
      if (args.extended) query.extended = args.extended;
      return callApi("GET", `/lists/${pathId("id", args.id)}`, {
        requireAuth: true,
        query,
        debugLimit,
      });
    }

    case "simkl_get_user_lists": {
      const query = {};
      if (args.limit != null) query.limit = args.limit;
      if (args.page != null) query.page = args.page;
      if (args.direction) query.direction = args.direction;
      if (args.sort) query.sort = args.sort;
      if (args.followed) query.followed = args.followed;
      if (args.collaborants) query.collaborants = args.collaborants;
      return callApi("GET", `/lists/user/${positiveInt("userId", args.userId)}`, {
        requireAuth: true,
        query,
        debugLimit,
      });
    }

    case "simkl_get_user_stats":
      return callApi("GET", `/users/${positiveInt("user_id", args.user_id)}/stats`, {
        requireAuth: true,
        debugLimit,
      });

    case "simkl_get_recently_watched_background": {
      const query = {};
      if (args.image) query.image = args.image;
      return callApi(
        "GET",
        `/users/recently-watched-background/${positiveInt("user_id", args.user_id)}`,
        {
          requireAuth: true,
          followRedirect: false,
          query,
          debugLimit,
        }
      );
    }

    case "simkl_search_file": {
      const body = { file: args.file };
      if (args.part != null) body.part = args.part;
      if (args.hash) body.hash = args.hash;
      if (args.process) body.process = args.process;
      return callApi("POST", "/search/file", {
        requireAuth: true,
        body,
        debugLimit,
      });
    }

    case "simkl_search_random": {
      const query = {};
      for (const k of [
        "service",
        "type",
        "genre",
        "rating_from",
        "rating_to",
        "rank_limit",
        "year_from",
        "year_to",
        "limit",
        "country",
      ]) {
        if (args[k] != null && args[k] !== "") query[k] = args[k];
      }
      return callApi("POST", "/search/random", {
        requireAuth: true,
        body: {},
        query,
        debugLimit,
      });
    }

    case "simkl_get_movies_genres": {
      const genre = args.genre || "all";
      const type = args.type || "movies";
      const country = args.country || "all";
      const year = args.year || "all";
      const sort = args.sort || "rank";
      const query = {};
      if (args.page != null) query.page = args.page;
      if (args.limit != null) query.limit = args.limit;
      return callApi(
        "GET",
        `/movies/genres/${pathSegment("genre", genre)}/${pathSegment("type", type)}/${pathSegment("country", country)}/${pathSegment("year", year)}/${pathSegment("sort", sort)}`,
        { requireAuth: true, query, debugLimit }
      );
    }

    case "simkl_get_tv_genres": {
      const genre = args.genre || "all";
      const type = args.type || "all";
      const country = args.country || "all";
      const network = args.network || "all";
      const year = args.year || "all";
      const sort = args.sort || "rank";
      const query = {};
      if (args.page != null) query.page = args.page;
      if (args.limit != null) query.limit = args.limit;
      return callApi(
        "GET",
        `/tv/genres/${pathSegment("genre", genre)}/${pathSegment("type", type)}/${pathSegment("country", country)}/${pathSegment("network", network)}/${pathSegment("year", year)}/${pathSegment("sort", sort)}`,
        { requireAuth: true, query, debugLimit }
      );
    }

    case "simkl_get_anime_genres": {
      const genre = args.genre || "all";
      const type = args.type || "all";
      const network = args.network || "all";
      const year = args.year || "all";
      const sort = args.sort || "rank";
      const query = {};
      if (args.page != null) query.page = args.page;
      if (args.limit != null) query.limit = args.limit;
      return callApi(
        "GET",
        `/anime/genres/${pathSegment("genre", genre)}/${pathSegment("type", type)}/${pathSegment("network", network)}/${pathSegment("year", year)}/${pathSegment("sort", sort)}`,
        { requireAuth: true, query, debugLimit }
      );
    }

    case "simkl_get_anime_airing": {
      const query = {};
      if (args.date) query.date = args.date;
      if (args.sort) query.sort = args.sort;
      return callApi("GET", "/anime/airing", {
        requireAuth: true,
        query,
        debugLimit,
      });
    }

    case "simkl_get_tv_airing": {
      const query = {};
      if (args.date) query.date = args.date;
      if (args.sort) query.sort = args.sort;
      return callApi("GET", "/tv/airing", {
        requireAuth: true,
        query,
        debugLimit,
      });
    }

    case "simkl_get_calendar": {
      const type = args.type;
      let cdnPath;
      if (args.year != null && args.month != null) {
        cdnPath = `/calendar/${calendarYear(args.year)}/${calendarMonth(args.month)}/${pathSegment("type", type)}.json`;
      } else {
        cdnPath = `/calendar/${pathSegment("type", type)}.json`;
      }
      return callApi("GET", `${CDN_BASE}${cdnPath}`, {
        forceNoAuth: true,
        rateExempt: true,
        requireAuth: false,
      });
    }

    case "simkl_oauth_revoke": {
      try {
        const cid = requireClientId();
        const prep = prepareWrite("simkl_oauth_revoke", args);
        if (prep.block) return toolResult(prep.block, { isError: true });
        const { built } = prep;
        const form = { token: built.token };
        if (args.token_type_hint) form.token_type_hint = args.token_type_hint;
        const secret = clientSecret();
        if (secret) form.client_secret = secret;
        const url = new URL(`${API_BASE}/oauth2/revoke`);
        url.searchParams.set("client_id", cid);
        url.searchParams.set("app-name", appName());
        url.searchParams.set("app-version", appVersion());
        const result = await rawRequest("POST", url, {
          headers: { Accept: "application/json", "User-Agent": userAgent() },
          form,
        });
        // RFC 7009: always 200 even if token unknown. Clear local credentials only if the revoked token WAS the local one.
        if (result.status >= 200 && result.status < 300) {
          const cleared = built.clearsLocal ? clearTokensFromEnvLocal() : false;
          return toolResult({
            ok: true,
            status: result.status,
            localTokensCleared: built.clearsLocal ? cleared : false,
            message: built.clearsLocal
              ? "Revoke request accepted. Access/refresh/scope cleared from process env and .env.local. CLIENT_ID kept. Re-auth via device flow before further user calls."
              : "Revoke request accepted for the supplied token. It differs from the local tokens, so local credentials were NOT touched.",
          });
        }
        return httpErrorResult(result);
      } catch (err) {
        if (err && err.code === "MISSING_CLIENT_ID") return toolResult(err.message, { isError: true });
        return toolResult(`Request failed: ${err && err.code ? err.code : "error"}`, { isError: true });
      }
    }

    case "simkl_get_changes": {
      const query = {};
      if (args.date_from) query.date_from = args.date_from;
      if (args.type) query.type = args.type;
      return callApi("GET", "/changes", {
        requireAuth: true,
        query,
        debugLimit,
      });
    }


    case "simkl_device_start":
      return deviceStart(args);

    case "simkl_device_poll":
      return devicePoll(args);

    case "simkl_token_refresh":
      return tokenRefreshTool();

    default:
      return toolResult(`Unknown tool: ${name}`, { isError: true });
  }
}

// ---------------------------------------------------------------------------
// Device flow (device_code never leaves the server) + token tools
// ---------------------------------------------------------------------------
/** user_code -> {device_code, expiresAt, interval, nextPollAt, scope}. Mirrored to a 0600 state file. */
const deviceFlows = new Map();
let deviceFlowLatest = null; // user_code of the most recent start

function deviceStatePath() {
  return path.join(dataDir(), ".device-flow.json");
}
function saveDeviceState() {
  try {
    const obj = {};
    for (const [k, v] of deviceFlows) obj[k] = v;
    if (deviceFlows.size === 0) {
      try {
        fs.unlinkSync(deviceStatePath());
      } catch (_) {}
      return;
    }
    const file = deviceStatePath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.device-flow.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ latest: deviceFlowLatest, flows: obj }), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {}
  } catch (err) {
    log("simkl: could not save device-flow state:", err && err.message ? err.message : err);
  }
}
let deviceStateLoaded = false;
function loadDeviceState() {
  if (deviceStateLoaded) return;
  deviceStateLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(deviceStatePath(), "utf8"));
    for (const [k, v] of Object.entries(raw.flows || {})) {
      if (v && typeof v.device_code === "string" && v.expiresAt > Date.now()) deviceFlows.set(k, v);
    }
    if (raw.latest && deviceFlows.has(raw.latest)) deviceFlowLatest = raw.latest;
  } catch (_) {}
}
function pruneDeviceFlows() {
  const now = Date.now();
  for (const [k, v] of deviceFlows) if (v.expiresAt <= now) deviceFlows.delete(k);
  if (deviceFlowLatest && !deviceFlows.has(deviceFlowLatest)) deviceFlowLatest = null;
}

function oauthErrorText(err) {
  if (err && err.code === "MISSING_CLIENT_ID") return err.message;
  return `Request failed: ${err && err.code ? err.code : "error"}`;
}

const DEVICE_SCOPES = ["media:read", "media:read media:write"];

async function deviceStart(args) {
  try {
    const cid = requireClientId();
    let scope;
    if (args.scope !== undefined) {
      const n = typeof args.scope === "string" ? args.scope.trim().replace(/\s+/g, " ") : "";
      if (!DEVICE_SCOPES.includes(n)) {
        return toolResult(
          { error: "INVALID_INPUT", message: `scope must be exactly one of: ${DEVICE_SCOPES.map((x) => `'${x}'`).join(" | ")}.` },
          { isError: true }
        );
      }
      scope = n;
    }
    const form = { client_id: cid };
    if (scope) form.scope = scope;
    const url = new URL(`${API_BASE}/oauth2/device`);
    url.searchParams.set("client_id", cid);
    url.searchParams.set("app-name", appName());
    url.searchParams.set("app-version", appVersion());
    const result = await rawRequest("POST", url, {
      headers: { Accept: "application/json", "User-Agent": userAgent() },
      form,
    });
    const b = result.body;
    if (result.status >= 200 && result.status < 300 && b && typeof b.device_code === "string" && b.user_code) {
      loadDeviceState();
      pruneDeviceFlows();
      const interval = Number.isFinite(Number(b.interval)) && Number(b.interval) > 0 ? Number(b.interval) : 5;
      const expiresIn = Number.isFinite(Number(b.expires_in)) && Number(b.expires_in) > 0 ? Number(b.expires_in) : 900;
      const userCode = String(b.user_code);
      deviceFlows.set(userCode, {
        device_code: b.device_code,
        expiresAt: Date.now() + expiresIn * 1000,
        interval,
        nextPollAt: Date.now() + interval * 1000,
        scope: scope || "media:read",
      });
      deviceFlowLatest = userCode;
      saveDeviceState();
      return toolResult({
        user_code: userCode,
        verification_uri: b.verification_uri,
        verification_uri_complete: b.verification_uri_complete,
        expires_in: expiresIn,
        interval,
        requested_scope: scope || "media:read",
        _hint:
          "Show verification_uri_complete (or verification_uri + user_code) to the user. Then call simkl_device_poll with NO arguments once every `interval` seconds; the device code is held server-side.",
      });
    }
    return httpErrorResult({ status: result.status, body: safeOauthError(result.body), classified: null });
  } catch (err) {
    return toolResult(oauthErrorText(err), { isError: true });
  }
}

/** Reduce an OAuth error body to non-secret fields. */
function safeOauthError(body) {
  if (!body || typeof body !== "object") return null;
  const o = {};
  if (typeof body.error === "string") o.error = body.error.slice(0, 80);
  if (typeof body.error_description === "string") o.error_description = body.error_description.slice(0, 300);
  return o;
}

async function devicePoll(args) {
  try {
    const cid = requireClientId();
    loadDeviceState();
    pruneDeviceFlows();
    let flowKey = deviceFlowLatest;
    let flow = flowKey ? deviceFlows.get(flowKey) : null;
    if (!flow && typeof args.device_code === "string" && args.device_code) {
      // Backwards compat only: a caller-supplied code is used when none is held. Never echoed.
      flowKey = "__supplied__";
      flow = { device_code: args.device_code, expiresAt: Date.now() + 600_000, interval: 5, nextPollAt: 0, scope: null };
    }
    if (!flow) {
      return toolResult(
        {
          ok: false,
          error: "NO_DEVICE_FLOW",
          message: "No active device flow (none started, or it expired). Call simkl_device_start first.",
        },
        { isError: true }
      );
    }
    const now = Date.now();
    if (now < flow.nextPollAt) {
      return toolResult({
        ok: false,
        error: "poll_too_soon",
        retry_in_seconds: Math.ceil((flow.nextPollAt - now) / 1000),
        _hint: "Local interval guard: no request was sent. Wait, then call simkl_device_poll again.",
      });
    }
    const form = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: cid,
      device_code: flow.device_code,
    };
    const secret = clientSecret();
    if (secret) form.client_secret = secret;
    const url = new URL(`${API_BASE}/oauth2/token`);
    url.searchParams.set("client_id", cid);
    url.searchParams.set("app-name", appName());
    url.searchParams.set("app-version", appVersion());
    flow.nextPollAt = Date.now() + flow.interval * 1000;
    const result = await rawRequest("POST", url, {
      headers: { Accept: "application/json", "User-Agent": userAgent() },
      form,
    });
    const b = result.body;
    if (result.status >= 200 && result.status < 300 && b && typeof b.access_token === "string" && b.access_token) {
      process.env.SIMKL_ACCESS_TOKEN = b.access_token;
      if (b.refresh_token) process.env.SIMKL_REFRESH_TOKEN = b.refresh_token;
      const scope = normalizeScope(b.scope);
      if (scope) process.env.SIMKL_SCOPE = scope;
      else delete process.env.SIMKL_SCOPE;
      const persisted = persistTokensToEnvLocal({
        SIMKL_ACCESS_TOKEN: b.access_token,
        ...(b.refresh_token ? { SIMKL_REFRESH_TOKEN: b.refresh_token } : {}),
        SIMKL_SCOPE: scope || null,
      });
      if (flowKey !== "__supplied__") deviceFlows.delete(flowKey);
      if (deviceFlowLatest === flowKey) deviceFlowLatest = null;
      saveDeviceState();
      const st = scopeStatus();
      const out = {
        ok: true,
        scope: scope || null,
        expires_in: b.expires_in ?? null,
        refresh_token_present: Boolean(b.refresh_token),
        persisted,
      };
      const notes = [];
      if (!persisted) notes.push("Tokens are held in memory only and will be lost on restart: .env.local could not be written.");
      if (flow.scope && flow.scope.includes("media:write") && st.known && !st.hasWrite) {
        notes.push("Granted scope is narrower than requested (no media:write); writes will return MISSING_WRITE_SCOPE.");
      }
      if (!st.known) notes.push("The token response carried no recognisable media:* scope; scope is treated as unknown.");
      if (notes.length) out.notes = notes;
      return toolResult(out);
    }
    const errCode = b && typeof b === "object" ? b.error : null;
    if (errCode === "expired_token" || errCode === "access_denied") {
      if (flowKey !== "__supplied__") deviceFlows.delete(flowKey);
      if (deviceFlowLatest === flowKey) deviceFlowLatest = null;
      saveDeviceState();
    } else if (errCode === "slow_down") {
      flow.interval += 5;
      flow.nextPollAt = Date.now() + flow.interval * 1000;
      saveDeviceState();
    }
    const pending = errCode === "authorization_pending" || errCode === "slow_down";
    return toolResult(
      {
        ok: false,
        status: result.status,
        ...(safeOauthError(b) || {}),
        ...(pending ? { interval: flow.interval } : {}),
        _hint:
          errCode === "authorization_pending"
            ? "Still waiting for approval; call simkl_device_poll again after `interval` seconds."
            : errCode === "slow_down"
              ? "Polled too fast; the interval was increased by 5s. Wait, then poll again."
              : errCode === "expired_token"
                ? "Device code expired; call simkl_device_start again."
                : undefined,
      },
      { isError: result.status >= 400 && !pending }
    );
  } catch (err) {
    return toolResult(oauthErrorText(err), { isError: true });
  }
}

async function tokenRefreshTool() {
  try {
    requireClientId();
    if (!refreshToken()) {
      return toolResult(
        "SIMKL_REFRESH_TOKEN is not set. Complete device flow (simkl_device_start + simkl_device_poll) or paste simkl_rt_… into the environment.",
        { isError: true }
      );
    }
    const ref = await refreshAccessToken();
    if (ref.ok) {
      return toolResult({
        ok: true,
        scope: ref.scope ?? (scopeStatus().scope || null),
        expires_in: ref.expires_in,
        refresh_token_present: ref.refresh_token_present,
        persisted: ref.persisted,
      });
    }
    return toolResult(
      { ok: false, status: ref.status ?? null, error: ref.error ?? null, error_description: ref.error_description ?? null },
      { isError: true }
    );
  } catch (err) {
    return toolResult(oauthErrorText(err), { isError: true });
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC / stdio framing
// Outbound mirrors inbound framing: NDJSON in -> NDJSON out; Content-Length in -> Content-Length (LF) out
// ---------------------------------------------------------------------------
// framing: "ndjson" (one JSON object + "\n") or "cl" (Content-Length: N\n\n + body).
// Replies mirror the framing of the request that triggered them.
function sendMessage(msg, framing = "ndjson") {
  const payload = Buffer.from(JSON.stringify(msg), "utf8");
  if (framing === "cl") {
    fs.writeSync(1, Buffer.from(`Content-Length: ${payload.length}\n\n`, "utf8"));
    fs.writeSync(1, payload);
  } else {
    fs.writeSync(1, Buffer.concat([payload, Buffer.from("\n")]));
  }
}

async function handleMessage(msg, framing = "ndjson") {
  if (!msg || typeof msg !== "object") return;

  const sendResult = (id, result) =>
    sendMessage({ jsonrpc: "2.0", id, result }, framing);
  const sendError = (id, code, message, data) => {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    sendMessage({ jsonrpc: "2.0", id, error }, framing);
  };

  if (msg.method && msg.id === undefined) {
    if (msg.method === "notifications/initialized") {
      log("simkl: initialized");
    }
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
        break;

      case "ping":
        sendResult(id, {});
        break;

      case "tools/list":
        sendResult(id, { tools: TOOLS });
        break;

      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (!name) {
          sendError(id, -32602, "Missing tool name");
          break;
        }
        const result = await handleToolCall(name, args);
        sendResult(id, result);
        break;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log("simkl: handler error:", err && err.message ? err.message : err);
    sendError(id, -32603, err && err.message ? err.message : "Internal error");
  }
}

function findHeaderEnd(buf) {
  const crlf = buf.indexOf("\r\n\r\n");
  if (crlf !== -1) return { index: crlf, sepLen: 4 };
  const lf = buf.indexOf("\n\n");
  if (lf !== -1) return { index: lf, sepLen: 2 };
  return null;
}

let inflight = 0;
function track(promise) {
  inflight += 1;
  Promise.resolve(promise)
    .catch((e) => log("simkl: message error:", e.message || e))
    .finally(() => {
      inflight -= 1;
      if (stdinEnded && inflight === 0) process.exit(0);
    });
}
let stdinEnded = false;

function startStdio() {
  let buffer = Buffer.alloc(0);
  let contentLength = null;

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (contentLength === null) {
        // Only treat the buffer as a Content-Length header block if it starts with one;
        // otherwise a blank line between NDJSON messages would be swallowed as a "header".
        const startsCL = /^\s*Content-Length:/i.test(buffer.slice(0, 32).toString("utf8"));
        const hdr = startsCL ? findHeaderEnd(buffer) : null;
        if (hdr) {
          const header = buffer.slice(0, hdr.index).toString("utf8");
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (match) {
            contentLength = parseInt(match[1], 10);
            buffer = buffer.slice(hdr.index + hdr.sepLen);
          } else {
            buffer = buffer.slice(hdr.index + hdr.sepLen);
            continue;
          }
        } else {
          const nl = buffer.indexOf("\n");
          if (nl === -1) {
            const trimmed = buffer.toString("utf8").trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
              try {
                const msg = JSON.parse(trimmed);
                buffer = Buffer.alloc(0);
                track(handleMessage(msg, "ndjson"));
                continue;
              } catch {
                break;
              }
            }
            break;
          }
          const line = buffer.slice(0, nl).toString("utf8").replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          if (/^Content-Length:/i.test(line)) {
            buffer = Buffer.concat([Buffer.from(line + "\n"), buffer]);
            break;
          }
          try {
            const msg = JSON.parse(line);
            track(handleMessage(msg, "ndjson"));
          } catch (e) {
            log("simkl: bad NDJSON line:", e.message || e);
          }
          continue;
        }
      }

      if (contentLength !== null) {
        if (buffer.length < contentLength) break;
        const body = buffer.slice(0, contentLength).toString("utf8");
        buffer = buffer.slice(contentLength);
        contentLength = null;
        try {
          const msg = JSON.parse(body);
          track(handleMessage(msg, "cl"));
        } catch (e) {
          log("simkl: bad JSON body:", e.message || e);
        }
        continue;
      }

      break;
    }
  });

  process.stdin.on("end", () => {
    stdinEnded = true;
    if (inflight === 0) process.exit(0);
  });

  process.stdin.resume();
}

// Self-test hook when imported / run with SIMKL_SELFTEST=1
async function runSelftest() {
  const cases = [
    {
      name: "per_second",
      status: 429,
      body: { error: "rate_limit" },
      headers: { "retry-after": "45000" },
      expect: "per_second",
    },
    {
      name: "daily_user",
      status: 429,
      body: { error: "user_limit_exceeded" },
      headers: { "retry-after": "100" },
      expect: "daily_user",
    },
    {
      name: "daily_app",
      status: 429,
      body: { error: "app_limit_exceeded" },
      headers: { "retry-after": "50" },
      expect: "daily_app",
    },
    {
      name: "write_lock",
      status: 400,
      body: { error: "rate_limit", error_description: "request in progress" },
      headers: {},
      expect: "write_lock",
    },
    {
      name: "write_lock_RATE_LIMIT",
      status: 400,
      body: { error: "RATE_LIMIT" },
      headers: {},
      expect: "write_lock",
    },
    {
      name: "user_token_required",
      status: 401,
      body: { error: "user_token_required" },
      headers: {},
      expect: "user_token_required",
    },
    {
      name: "ok",
      status: 200,
      body: { all: "fine" },
      headers: { "x-ratelimit-remaining": "10" },
      expect: "ok",
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = classifySimklResponse(c.status, c.body, c.headers);
    const ok = got.kind === c.expect;
    if (!ok) {
      failed += 1;
      log(`FAIL ${c.name}: expected ${c.expect} got ${got.kind}`);
    } else {
      log(`PASS ${c.name} kind=${got.kind} waitMs=${got.waitMs}`);
    }
  }
  // Unit checks for helpers (offline)
  const unit = (name, cond) => {
    if (cond) log(`PASS ${name}`);
    else {
      failed += 1;
      log(`FAIL ${name}`);
    }
  };
  {
    limitState.dailyStopped = true;
    limitState.dailyStoppedUntil = Date.now() + 60_000;
    unit("dailyStopped holds before reset", dailyStopActive() === true);
    unit("dailyStopped clears after reset time", dailyStopActive(Date.now() + 61_000) === false && limitState.dailyStoppedUntil === null);
    limitState.dailyStopped = false;
  }
  {
    const throws = (f) => {
      try {
        f();
        return false;
      } catch (e) {
        return e instanceof ArgError;
      }
    };
    unit("pathId rejects . and ..", throws(() => pathId("id", ".")) && throws(() => pathId("id", "..")));
    unit("pathId rejects / ? # %", ["a/b", "a?b", "a#b", "%2e%2e", ""].every((v) => throws(() => pathId("id", v))));
    unit("pathId accepts int + slug", pathId("id", 123) === "123" && pathId("id", "attack-on-titan") === "attack-on-titan");
    unit("positiveInt rejects 0/-1/1.5/'1'", [0, -1, 1.5, "1", "..", null].every((v) => throws(() => positiveInt("id", v))));
    unit("normalizeScope", normalizeScope("media:read, media:write") === "media:read media:write" && normalizeScope("a;b") === null);
    unit("token regex refuses metacharacters", !TOKEN_VALUE_RE.test("abc;rm -rf") && !TOKEN_VALUE_RE.test("a b") && TOKEN_VALUE_RE.test("simkl_at_AbC-1.2~3"));
    unit("keyLineRe matches export + spaces", keyLineRe("SIMKL_ACCESS_TOKEN").test("export SIMKL_ACCESS_TOKEN='x'") && keyLineRe("SIMKL_ACCESS_TOKEN").test("SIMKL_ACCESS_TOKEN=x") && !keyLineRe("SIMKL_ACCESS_TOKEN").test("# SIMKL_ACCESS_TOKEN=x"));
    const nested = buildWrite("simkl_add_history", { shows: [{ ids: { simkl: 1 }, seasons: [{ number: 1, episodes: Array.from({ length: 11 }, (_, i) => ({ number: i + 1 })) }] }] });
    unit("nested episodes counted", nested.count === 11);
    unit("shows:[{}] rejected", throws(() => buildWrite("simkl_add_history", { shows: [{}] })));
    const h1 = payloadHash("t", { a: 1, b: [1, 2] });
    unit("payload hash is order-stable and payload-bound", h1 === payloadHash("t", { b: [1, 2], a: 1 }) && h1 !== payloadHash("t", { a: 2, b: [1, 2] }) && h1 !== payloadHash("u", { a: 1, b: [1, 2] }));
  }
  // NY midnight sanity
  const info = resetsInfo(new Date("2026-09-24T10:00:00Z"));
  log("resetsAtIso sample:", info.resetsAtIso, "in", info.resetsInSeconds, "s");
  if (!info.resetsAtIso || info.resetsInSeconds < 0) {
    failed += 1;
    log("FAIL resetsInfo");
  } else {
    log("PASS resetsInfo");
  }
  process.exit(failed ? 1 : 0);
}

if (process.env.SIMKL_SELFTEST === "1") {
  runSelftest();
} else {
  log("simkl-mcp: starting (stdio)");
  startStdio();
}
