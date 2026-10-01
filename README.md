# simkl-mcp — Simkl Agent Plugin

[Simkl API](https://api.simkl.org) (AUTH V2) as an [Agent Plugins 1.0](https://agent-plugins.org) package: skill + **zero-dependency** stdio MCP server.

**Status:** prepared for publishing (MIT). Plugin name everywhere: `simkl-mcp`.


Rate limits are **first-class** in the server (pacing, classify, `simkl_rate_limit_status`). See `RATE_LIMITS.md`.  
Library-mutating tools enforce **two-phase confirmation gates**: the first call returns a preview of the real payload plus a single-use, 5-minute `confirmToken` bound to that payload; the second call must echo it (plus `userConfirmed` / `deleteConfirmed` / `massEditConfirmed` / `revokeConfirmed` as listed).

## Layout

```
simkl-mcp/
  plugin.json
  mcp.json
  run-mcp.sh              # resolves its own dir, sources .env.local if present
  README.md
  CHANGELOG.md
  LICENSE                 # MIT
  RESEARCH.md
  RATE_LIMITS.md
  openapi.json            # snapshot from api.simkl.org/openapi.json (not packed by default)
  .env.local.example      # variable names only
  .gitignore              # ignores .env.local
  scripts/
    pack.sh               # allow-list tarball (no .env.local, no openapi.json)
  server/
    package.json          # type:module, no dependencies
    index.js              # MCP + https client + limits + gates
    limits-selftest.js    # classifier / NY-midnight / helper unit checks
    gates-selftest.js     # offline stdio tests: gates, scope, device flow, timeouts (dummy creds)
  skills/
    simkl/
      SKILL.md
```

## First run

1. Register a Simkl developer app at https://simkl.com/settings/developer/ of type **TV, devices & command line** (device flow; redirect URI blank or a dummy value).
2. `cp .env.local.example .env.local` and set `SIMKL_CLIENT_ID` (public id; names only in docs). The file is gitignored; keep it `chmod 600`.
3. Call `simkl_device_start` with a `scope` chosen from the tools you need: `media:read media:write` if you will write (history/ratings/lists/scrobble/playback delete). The default is read-only (`media:read`); with a known read-only scope every write returns `MISSING_WRITE_SCOPE` locally.
4. Open `verification_uri_complete` in a browser and approve.
5. Call `simkl_device_poll` (no arguments; the server holds `device_code`) once per `interval` until it returns `ok:true`. Tokens and scope are persisted to `.env.local` (`SIMKL_ACCESS_TOKEN`, `SIMKL_REFRESH_TOKEN`, `SIMKL_SCOPE`; mode 600) and are **never** shown in tool output.
6. Check the granted `scope` in the poll result; re-run the flow with a wider scope if it is too narrow.
7. Confirm with `simkl_get_settings`.

**If `SIMKL_CLIENT_ID` is missing**, every API tool returns `MISSING_CLIENT_ID` (locally, before any network call). Register the app, set the variable in `.env.local` (or the client environment), restart the MCP server, retry.

**Which clients load this plugin**

| Client | Loads it? |
|--------|-----------|
| Agent Plugins 1.0 clients that load plugin skills + `mcp.json` | Yes |
| Any MCP client (run `./run-mcp.sh` or `node server/index.js` over stdio) | Yes |

## Auth (AUTH V2)

1. Register a **V2** app at https://simkl.com/settings/developer/  
   Prefer **TV, devices & command line** for this MCP (device flow), or paste tokens after external auth.  
   Browser authorize redirect is **not** implemented here.
2. Put secrets in `.env.local` (gitignored) or the process environment:

```bash
export SIMKL_CLIENT_ID='…'           # public; required
export SIMKL_ACCESS_TOKEN='simkl_at_…'  # optional until device flow / paste
export SIMKL_REFRESH_TOKEN='simkl_rt_…' # optional
# export SIMKL_CLIENT_SECRET='…'     # server apps only
export SIMKL_APP_NAME='simkl-mcp'    # default
export SIMKL_APP_VERSION='0.1.2'     # default
```

Device flow tools: `simkl_device_start` → show `verification_uri_complete` to the user → `simkl_device_poll` (no arguments) once per `interval`. On success the server persists tokens + scope itself; `device_code` and tokens never appear in tool output. `simkl_device_poll` and `simkl_token_refresh` return only `{ok, scope, expires_in, refresh_token_present, persisted}`.  
Revoke: `simkl_oauth_revoke` (gated) clears access/refresh/scope from memory + `.env.local` only when the revoked token is the local one; keeps `CLIENT_ID`.

### Where tokens are stored

`$PLUGIN_DATA/.env.local` when the `PLUGIN_DATA` environment variable is set (survives plugin updates), else `<plugin root>/.env.local`. Writes are atomic (temp file + rename, mode 600) and values are validated against `[A-Za-z0-9._~-]+` before being written, because `run-mcp.sh` `source`s the file. `run-mcp.sh` loads the plugin-root file, then the `PLUGIN_DATA` file (later wins).

### Device-flow state file

While a device-code login is pending, `.device-flow.json` (in `$PLUGIN_DATA`, else the plugin root) holds the **`device_code` in plaintext** so a poll can survive a server restart. It is written with mode `0600` (temp file + rename) and is **deleted on success or expiry/denial**. It is gitignored and never part of the packed tarball; do not copy or share it while a login is pending.

### Test-only environment overrides

| Variable | Purpose |
|----------|---------|
| `SIMKL_API_BASE` | Replace `https://api.simkl.com` (https, or http on loopback only) — used by `gates-selftest.js` to point at a local mock. Not for normal use. |
| `SIMKL_HTTP_TIMEOUT_MS` | Whole-request timeout (default 30000; min 50) |
| `SIMKL_MAX_RESPONSE_BYTES` | Response size cap (default 10 MB) |

## Wire into a client

`mcp.json` runs the plugin-relative `./run-mcp.sh` (resolves its own directory, sources `.env.local`, then `node index.js`). Clients resolve `./` against the plugin root.

Or point any MCP client at the server by absolute path to wherever you installed the plugin (`<plugin-root>` below):

```json
{
  "command": "node",
  "args": ["<plugin-root>/server/index.js"],
  "env": {
    "SIMKL_CLIENT_ID": "${SIMKL_CLIENT_ID}",
    "SIMKL_ACCESS_TOKEN": "${SIMKL_ACCESS_TOKEN}",
    "SIMKL_REFRESH_TOKEN": "${SIMKL_REFRESH_TOKEN}"
  }
}
```

### Local prove

Prove the server directly. Run these from your checkout of the plugin root:

```bash
cd path/to/simkl-mcp   # your plugin root
node --check server/index.js
node server/limits-selftest.js
node server/gates-selftest.js   # offline: dummy creds, temp PLUGIN_DATA, local mock server

# NDJSON smoke: initialize + tools/list
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node server/index.js

# Content-Length LF smoke (reply is Content-Length-framed; NDJSON input gets NDJSON replies)
BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
printf 'Content-Length: %s\n\n%s' "${#BODY}" "$BODY" | node server/index.js
```

Without tokens, `simkl_rate_limit_status` still returns local state. Catalog GETs need `SIMKL_CLIENT_ID` only. Every other API tool sends Bearer (see the Auth column below).

## Tools (43)

Auth column = what `server/index.js` sends. **none** = no `Authorization` header (client_id query param only); **Bearer** = `Authorization: Bearer $SIMKL_ACCESS_TOKEN`.

| Name | Auth | Notes |
|------|------|-------|
| `simkl_rate_limit_status` | none | Local limiter state (no HTTP) |
| `simkl_get_settings` | Bearer | `GET /users/settings` |
| `simkl_get_activities` | Bearer | Sync gate |
| `simkl_get_all_items` | Bearer | After activities |
| `simkl_get_playback` | Bearer | Paused sessions; optional `type` |
| `simkl_get_ratings` | Bearer | `GET /sync/ratings/{type}/{rating}` |
| `simkl_watched` | Bearer | Lookup POST (`items[]`); **not** a mutation |
| `simkl_search_id` | Bearer | Prefer redirect when possible |
| `simkl_redirect` | Bearer | Returns `Location` |
| `simkl_search_text` | Bearer | |
| `simkl_search_file` | Bearer | Filename match |
| `simkl_search_random` | Bearer | Random pick |
| `simkl_get_movie` / `_tv` / `_anime` | none | Cloudflare-cached catalog |
| `simkl_get_tv_episodes` / `_anime_episodes` | none | Cloudflare-cached catalog |
| `simkl_get_movies_genres` / `_tv_genres` / `_anime_genres` | Bearer | OpenAPI says clientId-only; live V2 needs token |
| `simkl_get_anime_airing` / `_tv_airing` | Bearer | Prefer CDN calendar for traffic |
| `simkl_get_trending` | none | CDN `data.simkl.in` |
| `simkl_get_calendar` | none | CDN calendar (rate-exempt) |
| `simkl_get_changes` | Bearer | Catalog change feed |
| `simkl_get_list` / `_user_lists` | Bearer | Custom lists (PRO/VIP beta) |
| `simkl_get_user_stats` | Bearer | Live stats |
| `simkl_get_recently_watched_background` | Bearer | Docs say public; V2 needs token |
| `simkl_add_to_list` | Bearer | Write; two-phase gate: `confirmToken` + `userConfirmed` (+ mass) |
| `simkl_add_history` | Bearer | Write; two-phase gate: `confirmToken` + `userConfirmed` (+ mass) |
| `simkl_remove_history` | Bearer | Destructive; `confirmToken` + user + `deleteConfirmed` (+ mass) |
| `simkl_add_ratings` | Bearer | Write; two-phase gate: `confirmToken` + `userConfirmed` (+ mass) |
| `simkl_remove_ratings` | Bearer | Destructive; `confirmToken` + user + `deleteConfirmed` (+ mass) |
| `simkl_delete_playback` | Bearer | Destructive; `confirmToken` + user + `deleteConfirmed` |
| `simkl_scrobble_start` / `_pause` / `_stop` / `_checkin` | Bearer | Write; `confirmToken` + `userConfirmed` (preview names title+action) |
| `simkl_device_start` | none | Device flow; returns user_code/URIs only (device_code kept server-side) |
| `simkl_device_poll` | none | One poll / call; no args; persists tokens; returns no tokens |
| `simkl_token_refresh` | none | Refresh token in form body; non-rotating; returns no tokens |
| `simkl_oauth_revoke` | none | Destructive; `confirmToken` + user + `revokeConfirmed`; token in form body; clears local tokens only if the revoked token is the local one |

Skipped OpenAPI surfaces (see `RESEARCH.md`): browser `/oauth2/authorize`, V1 PIN, `/best`, premieres, DVD discover.

## Known limitations

- **S12 — pagination metadata not surfaced.** Paged tools return the API body as-is; the server does not surface page counts or pagination headers. Pass `page`/`limit` yourself and stop on a short/empty page.
- **S13 — redirect follow:** `simkl_redirect` has no `follow` argument (it was ignored in earlier builds and has been removed); it returns the 301 `Location` only.
- **Huge libraries:** `simkl_get_all_items` can return `RESPONSE_TOO_LARGE` when the response exceeds the cap (default 10 MB, `SIMKL_MAX_RESPONSE_BYTES`). Call `simkl_get_activities` first and then fetch with `date_from` set to the changed timestamp instead of pulling the whole library.
- **`debugLimit`** (testing aid that forces a 429) is accepted on read tools only; write, scrobble and delete tools do not accept it.

## Stdio framing

The server **mirrors the client's framing** (tested, see `CHANGELOG.md`):

| Input | Reply |
|-------|-------|
| NDJSON (one JSON object per line; MCP stdio spec; what most MCP clients send) | NDJSON: JSON + `\n` |
| `Content-Length: N` + `\n\n` (LF-only header terminator) | `Content-Length: N\n\n` + body |
| `Content-Length: N` + `\r\n\r\n` (CRLF) | `Content-Length: N\n\n` + body (reply header always uses LF) |

Framing is decided per message, so mixed input is answered message-by-message. Logs go to stderr only.

## Tool annotations

Every tool carries MCP `annotations`: read-only tools `{readOnlyHint:true}`; non-destructive writes (add history/ratings/list, scrobble, device/token helpers) `{readOnlyHint:false, destructiveHint:false}`; `simkl_remove_history`, `simkl_remove_ratings`, `simkl_delete_playback`, `simkl_oauth_revoke` `{readOnlyHint:false, destructiveHint:true}`.

## Packing (local only)

```bash
scripts/pack.sh        # -> ../simkl-mcp-0.1.2.tgz from an explicit allow-list
```

Allow-list: `plugin.json mcp.json run-mcp.sh README.md RATE_LIMITS.md RESEARCH.md LICENSE CHANGELOG.md .env.local.example server/ skills/`. `.env.local` and `openapi.json` are excluded (`--with-openapi` adds the latter). Nothing is published or uploaded.

## Requirements

- Node ≥ 18
- No npm dependencies

## Security

- Never commit `.env.local` / tokens / `client_secret`.
- GitHub secret scanning revokes leaked `simkl_at_` / `simkl_rt_` credentials.
- Agents must show the user the preview and get a yes before passing `confirmToken` or any confirm flag; the server refuses otherwise.
- Tool output never contains access/refresh tokens or `device_code`.
