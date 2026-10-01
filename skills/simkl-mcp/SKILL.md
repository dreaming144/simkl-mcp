---
name: simkl-mcp
description: >
  Use when the user asks about Simkl library sync, watch history, ratings, watchlists,
  scrobble/playback, custom lists, stats, catalog lookups (movies/TV/anime), genres,
  airing/calendar, trending, or Simkl AUTH V2 / rate limits.
  Prefer these MCP tools over guessing library state. Rate limits are first-class.
  Library-mutating tools enforce hard two-phase confirmation gates in the server.
  Do not use for: non-Simkl services (Trakt, MyAnimeList, AniList, Letterboxd, TMDB-only lookups),
  finding streaming/download sources, bulk library migration or mass edits without explicit
  per-batch confirmation, or anything needing the browser OAuth redirect flow (not implemented).
---

# Simkl (AUTH V2) — `simkl-mcp`

> **ALWAYS ASK THE USER BETWEEN PHASE 1 AND PHASE 2.** Every gated write (history, ratings, lists, scrobble, playback delete, revoke) is two calls: phase 1 returns a preview and a `confirmToken` and sends nothing; show that preview to the user and **wait for an explicit yes in chat** before phase 2. Never pass `confirmToken` or any `*Confirmed` flag in the same turn you got the preview, and never on your own initiative.

Docs: https://api.simkl.org · Limits: see plugin `RATE_LIMITS.md`.

## Auth

- Env: `SIMKL_CLIENT_ID` (required), `SIMKL_ACCESS_TOKEN` (`simkl_at_…`), optional `SIMKL_REFRESH_TOKEN` (`simkl_rt_…`).
- Headless: `simkl_device_start` (pass `scope: "media:read media:write"` if you will write) → show the user `verification_uri_complete` → `simkl_device_poll` (no arguments) **once per `interval`**. Do not busy-loop. The server keeps `device_code` to itself and, on success, **persists tokens + scope to `.env.local` (mode 600)** — they are never returned in tool output.
- Scope: the granted scope is stored as `SIMKL_SCOPE`. Every write/scrobble returns `MISSING_WRITE_SCOPE` (with upgrade steps) if the known scope lacks `media:write`; if the scope is unknown the write is allowed with a note. Check `scope` in the poll result before writing.
- Or paste tokens after external auth. Do **not** implement browser redirect in this MCP.
- Revoke: `simkl_oauth_revoke` (two-phase gate) clears in-memory + `.env.local` access/refresh/scope only when the revoked token is the local one; keeps `CLIENT_ID`.
- Register V2 app at https://simkl.com/settings/developer/ — prefer **TV, devices & command line**.

### Authorization header — one rule per tool (source of truth: `server/index.js`)

| Class | Tools | `Authorization` |
|-------|-------|-----------------|
| Local | `simkl_rate_limit_status` | none (no HTTP call) |
| Catalog detail / episodes | `simkl_get_movie`, `simkl_get_tv`, `simkl_get_anime`, `simkl_get_tv_episodes`, `simkl_get_anime_episodes` | **never** (client_id query param only; Cloudflare edge cache) |
| CDN | `simkl_get_trending`, `simkl_get_calendar` | **never** (`data.simkl.in`, client_id only) |
| OAuth helpers | `simkl_device_start`, `simkl_device_poll`, `simkl_token_refresh`, `simkl_oauth_revoke` | **never** (credentials travel in the form body / client_id) |
| Everything else (31 tools) | sync, search, redirect, playback, ratings, lists, stats, genres, airing, changes, recently-watched-background, all writes and scrobbles | **always** `Bearer SIMKL_ACCESS_TOKEN` (fails locally with `MISSING_ACCESS_TOKEN` if unset) |

Genres, airing, `/changes` and recently-watched-background are Bearer even though the OpenAPI lists them as clientId-only: live AUTH V2 returns `401 user_token_required` without a token.

## First run

1. Register a Simkl developer app at https://simkl.com/settings/developer/ of type **TV, devices & command line** (device flow; redirect URI blank or a dummy value).
2. Copy `.env.local.example` to `.env.local` and set `SIMKL_CLIENT_ID` (names only here; never paste values into chat or logs).
3. Call `simkl_device_start` with a `scope` chosen from the tools you need: `media:read media:write` if you will write (add/remove history, ratings, lists, scrobble, playback delete); the default is read-only (`media:read`) and a read-only token cannot write.
4. Open `verification_uri_complete` (show it to the user). `device_code` never leaves the server.
5. Call `simkl_device_poll` (no arguments) once per `interval` until it returns `ok:true`. The server persists `SIMKL_ACCESS_TOKEN` / `SIMKL_REFRESH_TOKEN` / `SIMKL_SCOPE` to `.env.local` (mode 600; `$PLUGIN_DATA/.env.local` when `PLUGIN_DATA` is set). The result contains only `ok, scope, expires_in, refresh_token_present, persisted`.
6. Verify the granted `scope` in the poll result matches what you asked for (re-run device flow with the wider scope if not).
7. Confirm with `simkl_get_settings`.

If `SIMKL_CLIENT_ID` is missing, every API tool returns `MISSING_CLIENT_ID`: register the app, set it in `.env.local` (or the client's environment), restart the MCP server, and retry. Do not guess a client id.

## Orchestration

1. **Limiter / health** → `simkl_rate_limit_status` (local; no API call).
2. **Sync** → ALWAYS `simkl_get_activities` first. Only call `simkl_get_all_items` for buckets whose timestamp changed. Never poll all-items on a timer.
3. **Resolve id** → prefer `simkl_redirect` (Location) over `simkl_search_id` when you only need a Simkl id. Filename → `simkl_search_file`. Random pick → `simkl_search_random`.
4. **Catalog detail / episodes** → `simkl_get_movie` / `_tv` / `_anime` / `_tv_episodes` / `_anime_episodes`. The server sends **no** Authorization (client_id only; edge cache).
5. **Genre browse / airing / changes / recently-watched-background** → the server sends **Bearer** (AUTH V2 needs it even though OpenAPI lists clientId-only), so a valid `SIMKL_ACCESS_TOKEN` is required. Prefer `simkl_get_calendar` (CDN, no Authorization) over airing for high traffic.
6. **Search text** → `simkl_search_text` (needs Bearer on V2).
7. **Trending / calendar** → CDN tools (`simkl_get_trending`, `simkl_get_calendar`). UI titles for trending must include both “Simkl” and “Trending”.
8. **Continue watching** → `simkl_get_playback`; clear a session with `simkl_delete_playback` (destructive gate).
9. **Watched lookup** → `simkl_watched` is a **read** POST (array body via `items[]`) — not a mutation; no confirm gate.
10. **Stats / lists** → `simkl_get_settings` → user id → `simkl_get_user_stats` / `simkl_get_user_lists`. Custom lists are PRO/VIP beta.
11. **Writes / scrobble** → hard gates below. Batch arrays in one POST. Never fire parallel counted requests. Serialize writes (≥1.05s).

## Hard rules

| Rule | Why |
|------|-----|
| No `Authorization` on catalog detail/episodes, CDN (trending/calendar) or OAuth helper tools | Busts Cloudflare cache / burns origin; server enforces it |
| `Authorization: Bearer` on every other tool (incl. genres, airing, changes, recently-watched-background, search, redirect) | AUTH V2 returns `user_token_required` otherwise |
| Never parallelize uncached / sync / search | 10 GET/s · 1 POST/s; parallel burns the window |
| Batch writes | One array POST = one request vs N throttles |
| Activities before all-items | Cheap gate; avoids quota burn |
| No `debugLimit` in normal ops | Testing aid only (`user`/`app`) |
| On `daily_user` / `daily_app` | Stop counted calls; tell the user; wait NY midnight |
| Never invent consent | Server refuses writes without the preview's `confirmToken` + confirm flags |
| Path ids are validated | Ids must be positive integers or plain slugs; `.`, `..`, `/`, `?`, `#` are rejected |

## Safety — two-phase confirmation gates

Every write/delete/mass/revoke/scrobble tool is gated **in the server**, in two phases:

1. **Preview.** Call the tool normally (no `confirmToken`). The server validates the payload and returns `WRITE_CONFIRMATION_REQUIRED` with a `preview` built from the real payload (titles/ids, target status, rating scores, playback id, counted items incl. nested episodes) and a single-use `confirmToken` (valid 5 minutes, bound to the tool + exact payload). **Nothing is sent.**
2. **Confirm.** **Present the preview to the user. Only pass `confirmToken` after they say yes.** Then call the same tool again with the *same arguments* + `confirmToken` + the flags listed in `requiredFlagsOnConfirm`. A changed payload, a used/expired/unknown token, or a missing flag is refused.

Never fill `confirmToken` or any `*Confirmed` flag on a first call, and never reuse a token the user did not approve. On refusal the tool returns `isError` with `error` + `askUser[]`.

| Flag / code | When |
|------|------|
| `confirmToken` | All gated writes — from the preview response |
| `userConfirmed: true` | Any library-mutating write (list/history/ratings add|remove, scrobble start/pause/stop/checkin, playback delete, oauth revoke) — **only** after the user said yes in chat |
| `deleteConfirmed: true` | Destructive: `remove_history`, `remove_ratings`, `delete_playback` (`DELETE_CONFIRMATION_REQUIRED`) |
| `revokeConfirmed: true` | `simkl_oauth_revoke` (`REVOKE_CONFIRMATION_REQUIRED`) |
| `massEditConfirmed: true` | Counted items ≥ **10**, counted over nested leaves (`seasons[].episodes[]`); a show/season with no episode list counts as a mass edit (`MASS_EDIT_CONFIRMATION_REQUIRED`) |
| `EMPTY_WRITE` / `INVALID_INPUT` | Empty or non-array payloads, `shows:[{}]`, items without `ids`/`title`, bad ratings or ids |
| `MISSING_WRITE_SCOPE` | Known granted scope lacks `media:write` — re-run the device flow with `media:read media:write` |

None of these flags is in a tool's `required` list. Confirm fields are never sent to the API (request bodies are built field by field).

### Required question templates

**Ordinary write (list / history add / ratings add):**  
“Apply `<action>` to `<N>` Simkl item(s) (`<sample titles/ids>`)? Destination status: `<to>` (if list).”

**Delete / remove (history, ratings, playback):**  
“Permanently `<remove history | clear ratings | delete playback session id N>` on Simkl for `<sample>`? This cannot be undone from this tool.”

**Mass edit (≥10):**  
“You're about to change `<N>` Simkl items in one batch. Proceed?”

**Scrobble:**  
“Scrobble `<start|pause|stop|checkin>` on Simkl for `'<title or id>'` (progress `<%>` if relevant)?”

**Revoke:**  
“Revoke the Simkl OAuth token(s) for this MCP? Access and refresh tokens will stop working until you re-auth. CLIENT_ID is kept.”

Do **not** pass `confirmToken` or set confirm flags until the user answers yes to the preview. Do not split a mass edit into silent parallel calls to dodge the gate.

## Tool map

### Read / meta

Auth column = what the server actually sends (see "Authorization header" above): `none` or `Bearer`.

| Tool | Auth | Endpoint |
|------|------|----------|
| `simkl_rate_limit_status` | none | (local) |
| `simkl_get_settings` | Bearer | `GET /users/settings` |
| `simkl_get_activities` | Bearer | `GET /sync/activities` |
| `simkl_get_all_items` | Bearer | `GET /sync/all-items/{type}/{status}` |
| `simkl_get_playback` | Bearer | `GET /sync/playback` or `/sync/playback/{type}` |
| `simkl_get_ratings` | Bearer | `GET /sync/ratings/{type}/{rating}` |
| `simkl_watched` | Bearer | `POST /sync/watched` (lookup; `items[]` body) |
| `simkl_search_id` | Bearer | `GET /search/id` |
| `simkl_redirect` | Bearer | `GET /redirect` |
| `simkl_search_text` | Bearer | `GET /search/{type}` |
| `simkl_search_file` | Bearer | `POST /search/file` |
| `simkl_search_random` | Bearer | `POST /search/random` |
| `simkl_get_movie` | none | `GET /movies/{id}` |
| `simkl_get_tv` | none | `GET /tv/{id}` |
| `simkl_get_anime` | none | `GET /anime/{id}` |
| `simkl_get_tv_episodes` | none | `GET /tv/episodes/{id}` |
| `simkl_get_anime_episodes` | none | `GET /anime/episodes/{id}` |
| `simkl_get_movies_genres` | Bearer | `GET /movies/genres/…` |
| `simkl_get_tv_genres` | Bearer | `GET /tv/genres/…` |
| `simkl_get_anime_genres` | Bearer | `GET /anime/genres/…` |
| `simkl_get_anime_airing` | Bearer | `GET /anime/airing` |
| `simkl_get_tv_airing` | Bearer | `GET /tv/airing` |
| `simkl_get_trending` | none | CDN `data.simkl.in/discover/trending/…` |
| `simkl_get_calendar` | none | CDN `data.simkl.in/calendar/…` |
| `simkl_get_changes` | Bearer | `GET /changes` |
| `simkl_get_list` | Bearer | `GET /lists/{id}` |
| `simkl_get_user_lists` | Bearer | `GET /lists/user/{userId}` |
| `simkl_get_user_stats` | Bearer | `GET /users/{user_id}/stats` |
| `simkl_get_recently_watched_background` | Bearer | `GET /users/recently-watched-background/{user_id}` |

### Write (gated) — all Bearer

| Tool | Endpoint | Extra flags |
|------|----------|-------------|
| `simkl_add_to_list` | `POST /sync/add-to-list` | token + mass if ≥10 |
| `simkl_add_history` | `POST /sync/history` | token + mass if ≥10 |
| `simkl_remove_history` | `POST /sync/history/remove` | token + `deleteConfirmed` + mass |
| `simkl_add_ratings` | `POST /sync/ratings` | token + mass if ≥10 |
| `simkl_remove_ratings` | `POST /sync/ratings/remove` | token + `deleteConfirmed` + mass |
| `simkl_delete_playback` | `DELETE /sync/playback/{id}` | token + `deleteConfirmed` |
| `simkl_scrobble_start` | `POST /scrobble/start` | token; name title + start |
| `simkl_scrobble_pause` | `POST /scrobble/pause` | token; name title + pause |
| `simkl_scrobble_stop` | `POST /scrobble/stop` | token; name title + stop |
| `simkl_scrobble_checkin` | `POST /scrobble/checkin` | token; name title + checkin |

### Auth helpers — all none (no Authorization header)

| Tool | Endpoint |
|------|----------|
| `simkl_device_start` | `POST /oauth2/device` |
| `simkl_device_poll` | `POST /oauth2/token` (device_code held server-side; persists tokens) |
| `simkl_token_refresh` | `POST /oauth2/token` (refresh_token; persists, returns no tokens) |
| `simkl_oauth_revoke` | `POST /oauth2/revoke` (`userConfirmed` + `revokeConfirmed`; clears local tokens only when the revoked token is the local one) |

## Known limitations

- **S12 — pagination metadata not surfaced.** Responses are returned as the API sent them; the server does not add or interpret page counts / `X-Pagination-*`-style metadata, so for paged tools pass `page` / `limit` yourself and stop when a page comes back short or empty.
- **S13 — redirect follow ignored (resolved).** `simkl_redirect` no longer has a `follow` argument; it only returns the 301 `Location`.
- **`simkl_get_all_items` can return `RESPONSE_TOO_LARGE`** on very large libraries (response cap 10 MB, `SIMKL_MAX_RESPONSE_BYTES`). Use `simkl_get_activities` and then `simkl_get_all_items` with `date_from` set to the changed timestamp instead of fetching everything.
- `debugLimit` (testing aid, forces a 429) is accepted only on read tools; write, scrobble and delete tools do not accept it.

## Out of scope / deferred

See `RESEARCH.md` — browser OAuth authorize UI, V1 PIN, `/anime|tv/best`, premieres, DVD discover. No movies airing path in OpenAPI.

## Prove locally

From the plugin root:

```bash
node --check server/index.js
node server/limits-selftest.js   # classifier, NY-midnight, path-param, hashing and helper unit checks
node server/gates-selftest.js    # offline stdio gate/auth/scope/device-flow/timeout tests (dummy creds, mock server)
```

See the plugin README for NDJSON / Content-Length smokes.
