# Changelog

## 0.1.2

Publish-prep release (plugin name unified as `simkl-mcp`).

- Plugin name is now `simkl-mcp` in `plugin.json`, `server/package.json`, README and SKILL.md (tool names are unchanged).
- **S13:** removed the unused `follow` argument from `simkl_redirect` (redirects were never followed); `simkl_redirect` returns the 301 `Location` only.
- `debugLimit` removed from the schemas of write/scrobble/delete tools (and no longer forwarded for them); still available on read tools.
- Docs: Known limitations (S12 pagination metadata not surfaced; S13), `RESPONSE_TOO_LARGE` guidance for `simkl_get_all_items`, `.device-flow.json` plaintext/0600/delete-on-finish note, prominent "ask the user between phase 1 and phase 2" banner in SKILL.md.
- Removed personal names and local paths from docs and tool descriptions (the confirmation-gate refusal field is now `askUser[]`).

## 0.1.1

Security/hardening release from the 2026-10-01 review.

- **B1 (blocker):** `simkl_device_poll` and `simkl_token_refresh` no longer return the OAuth response body; they return only `{ok, scope, expires_in, refresh_token_present, persisted}` (`access_token_prefix` removed). `simkl_device_start` keeps `device_code` server-side (memory + 0600 state file) and returns only `user_code`, `verification_uri(_complete)`, `expires_in`, `interval`; `simkl_device_poll` needs no arguments (optional `device_code` kept for compat, never echoed) and enforces `interval` locally. `device_poll` now persists tokens to `.env.local`. README/SKILL contradictions fixed.
- **S1:** `SIMKL_SCOPE` stored on login/refresh. All writes and scrobbles return `MISSING_WRITE_SCOPE` (with upgrade steps) when the known scope lacks `media:write`; unknown scope is allowed with a note. `device_start` validates the scope enum.
- **S5/S6:** two-phase write gate. First call returns a preview built from the real payload plus a single-use 5-minute `confirmToken` bound to a hash of tool + payload; second call must echo it. Named flags remain required on confirm but are removed from schema `required` lists.
- **S7:** nested seasons/episodes validated and counted for the mass-edit threshold (≥10 over leaves; a whole show/season counts as a mass edit); `shows:[{}]`, empty and non-array values rejected (`EMPTY_WRITE` / `INVALID_INPUT`); only fields that are actually sent are accepted per tool.
- **S8:** path params must be positive integers or strict slugs (`.`, `..`, `/`, `?`, `#`, `%` rejected); `delete_playback` id must be a positive integer.
- **S11:** 30s whole-request timeout via `AbortController`, 10 MB response cap, serial queue guarded so a stalled job cannot block it forever.
- **S2:** 401 refresh now keys on "Authorization was sent", not on the error string. **S3:** `PLUGIN_DATA` support (fallback: plugin root), atomic temp+rename writes, token values validated against `[A-Za-z0-9._~-]+`, clear matches `export KEY=`. **S4:** revoke with a custom token no longer wipes local tokens. **S9:** basic `inputSchema` enforcement (required, type, enum, min/max). **S10:** `dailyStopped` clears after NY midnight.
- **S14:** `plugin.json` conforms to the closed Agent Plugins 1.0 manifest (top-level `mcpServers`/`skills` removed). **S15:** `RESEARCH.md` is packed. **S16:** real gate tests (`server/gates-selftest.js`) plus extra unit checks in `limits-selftest.js`. **S17:** `RESEARCH.md` genre-auth note corrected. **S18:** SKILL.md gains a "Do not use for" line.
- Test-only env overrides: `SIMKL_API_BASE` (https or loopback http), `SIMKL_HTTP_TIMEOUT_MS`, `SIMKL_MAX_RESPONSE_BYTES`.
- Failed-refresh logs no longer include the raw response body.

## 0.1.0

Initial local release.

- Zero-dependency stdio MCP server (`server/index.js`) with 43 tools covering Simkl AUTH V2: sync, search, catalog, ratings, playback, lists, stats, scrobble, device-flow auth.
- Rate limits first-class: pacing, 429/write-lock classification, `simkl_rate_limit_status`, `RATE_LIMITS.md`.
- Hard confirmation gates on every write/delete/revoke (`userConfirmed`, `deleteConfirmed`, `massEditConfirmed`, `revokeConfirmed`; `EMPTY_WRITE` guard).
- MCP tool annotations on every tool (`readOnlyHint` / `destructiveHint`).
- Authorization rules documented per tool and matching the code (catalog detail/episodes, CDN and OAuth helpers send none; everything else sends Bearer).
- Stdio framing mirrors the client: NDJSON in -> NDJSON out; Content-Length (LF or CRLF header terminator) in -> Content-Length out.
- Plugin packaging: `mcp.json` uses plugin-relative `./run-mcp.sh`; `LICENSE` (MIT); `.env.local.example`; `scripts/pack.sh` allow-list tarball (excludes `.env.local` and `openapi.json`).
- `SKILL.md` and README "First run" instructions.
