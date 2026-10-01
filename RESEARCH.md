# Simkl plugin — research notes

**Date:** 2026-09-24  
**Rule:** Do not invent API response shapes. Prefer flat JSON passthrough. Cite docs.

## Primary sources

| Topic | URL |
|-------|-----|
| Docs home | https://api.simkl.org |
| Rate limits | https://api.simkl.org/resources/rate-limits.md |
| AUTH V2 overview | https://api.simkl.org/api-reference/auth-v2 |
| Device / PIN flow | https://api.simkl.org/api-reference/oauth2-device |
| Headers | https://api.simkl.org/conventions/headers |
| Trending CDN | https://api.simkl.org/api-reference/trending |
| OpenAPI 3.1 | https://api.simkl.org/openapi.json (snapshot: `openapi.json` in this plugin, fetched 2026-09-24) |
| LLM index | https://api.simkl.org/llms.txt |
| Developer apps | https://simkl.com/settings/developer/ |

Classifier ported from the author's own sync project (`simkl_limits.py`; not included).

## Base URLs

- API: `https://api.simkl.com`
- CDN (trending/calendar): `https://data.simkl.in`

## Required on every request

Query: `client_id`, `app-name`, `app-version`  
Header: `User-Agent: ${app-name}/${app-version}`  
Optional alias: `simkl-api-key` header (= client_id); prefer query `client_id`.

## AUTH V2

Register at https://simkl.com/settings/developer/ — **new** `client_id` (V1 cannot upgrade).  
For this MCP prefer client type **TV, devices & command line** (device flow) OR paste tokens after external auth.

| Env | Role |
|-----|------|
| `SIMKL_CLIENT_ID` | Public; required |
| `SIMKL_ACCESS_TOKEN` | Bearer; prefix `simkl_at_` |
| `SIMKL_REFRESH_TOKEN` | Optional; prefix `simkl_rt_` |
| `SIMKL_CLIENT_SECRET` | Optional; **Server apps & services** only |
| `SIMKL_APP_NAME` | Default `simkl-mcp` |
| `SIMKL_APP_VERSION` | Default `0.1.0` |

Token response shape (documented, all grants):

```json
{
  "access_token": "simkl_at_...",
  "token_type": "Bearer",
  "expires_in": 604800,
  "refresh_token": "simkl_rt_...",
  "scope": "media:read media:write"
}
```

- Access: 7 days. Refresh: 180 days **sliding**, **non-rotating** (same string returned).  
- Device: `POST /oauth2/device` → poll `POST /oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.  
  Defaults: `expires_in: 900`, `interval: 5`. One poll per tool call — do not busy-loop.  
- Refresh: `POST /oauth2/token` with `grant_type=refresh_token` + `client_id` (+ `client_secret` if set).  
- Browser authorize redirect is **not** implemented in this MCP (stdio / headless).

### No-token catalog (even on V2)

- `GET /movies/{id}`, `/tv/{id}`, `/anime/{id}`
- `GET /tv/episodes/{id}`, `/anime/episodes/{id}`
- CDN trending & calendar on `data.simkl.in`

**Do not send Authorization on those catalog GETs** — busts edge cache.

Everything else needs Bearer on V2, **including search**.  
`/redirect` needs Bearer on V2 (auth-v2 overview) but is listed as quota-exempt in rate-limits.md.

## Sync shapes (passthrough)

### `GET /sync/activities`

Cheap gate — call before `/sync/all-items`. Response is a nested object of ISO timestamps per bucket (exact keys: see OpenAPI / live response). Passthrough.

### `GET /sync/all-items/{type}/{status}`

Path enums (OpenAPI):

- `type`: `movies` | `shows` | `anime` | `all`
- `status`: `watching` | `plantowatch` | `hold` | `completed` | `dropped` | `all`

Optional query: `date_from`, `extended`, `next_watch_info`, etc.  
Top-level keys `shows` / `movies` / `anime` present only when non-empty. Passthrough.

### Writes (batch arrays)

Bodies use `movies[]` / `shows[]` / `anime[]` (and sometimes `episodes[]` on history).  
Each item is a standard media object with `ids` (send every id you have). See OpenAPI schemas `AddToListRequest`, `HistoryRequest`, `RatingsAddRequest`. Passthrough request + response.

## Search / redirect

- `GET /search/id` — query any of imdb/tmdb/tvdb/mal/…; `[]` when no match (no 404).
- `GET /search/{type}?q=` — `type` ∈ `tv|anime|movie`.
- `GET /redirect?to=simkl&…` — **301** with `Location` (tiny; prefer for cheap id resolve). This MCP returns `{ status, location }` by default.

## Trending CDN example

`GET https://data.simkl.in/discover/trending/today_100.json?client_id=…&app-name=…&app-version=…`  
Combined file top-level: `{ movies, tv, anime }`. Per-type files return an array. Attribution required in UI titles (“Simkl” + “Trending”).

## Rate limits

See `RATE_LIMITS.md`. Implemented in `server/index.js` (`classifySimklResponse`, serial queue, POST gap, `simkl_rate_limit_status`).

## Doc gaps / ambiguities noted 2026-09-24

1. **`/redirect` auth vs cache:** auth-v2 says Bearer required on V2; rate-limits says `/redirect` is edge-cached / quota-exempt. This MCP sends Bearer when calling `simkl_redirect` and marks the call rate-exempt.
2. **`/sync/all-items` without status:** OpenAPI path requires `{status}`; tool defaults to `all`.
3. **`POST /sync/watched`:** OpenAPI defines a **lookup** (returns watched status for posted ids) — not a library mutation. Tool `simkl_watched` takes `items[]` as the JSON array body. **No confirm gate** (read). Brief text that listed "watched" among mutators is overridden by OpenAPI.
4. **Genre browse:** V1 thin cards; OpenAPI warns against 10-foot/TV app grids — wait for V2 Beta richer shape. Wrapped anyway for agent use; this MCP sends Bearer (see gap 7).
5. **Airing vs calendar:** OpenAPI prefers CDN calendar for high traffic; `/tv/airing` and `/anime/airing` remain available. **No movies airing path** in OpenAPI.
6. **`/anime/airing` vs catalog id:** naive `/anime/{id}` matchers must exclude reserved segments (`airing`, `genres`, `best`, `premieres`) or Auth is stripped and V2 returns `user_token_required`.
7. **V2 Bearer on “clientId-only” paths:** Live AUTH V2 `client_id` returns `401 user_token_required` for `/changes`, genre browse, airing, and recently-watched-background unless Bearer is sent. This MCP sends Bearer for those. **Still never** send Authorization on catalog detail/episodes or CDN.

## Deferred / skipped (do not invent)

| Path | Reason |
|------|--------|
| `GET /oauth2/authorize`, `GET /oauth/authorize` | Browser redirect UI — stdio MCP does not implement |
| `GET /oauth/pin`, `GET /oauth/pin/{user_code}`, `POST /oauth/token` | AUTH V1 PIN — V2 device/token tools cover headless |
| `GET /anime/best/{filter}`, `GET /tv/best/{filter}` | Useful but lower priority; not required by scaffold brief |
| `GET /anime/premieres/{param}`, `GET /tv/premieres/{param}` | Same — deferred |
| `GET /discover/dvd/{file}.json` | Movies-only DVD CDN; deferred |
| `GET /ratings/{type}` | Community ratings for watchlist items — distinct from `/sync/ratings/{type}/{rating}`; deferred pending need |
| Movies airing | Not present in OpenAPI snapshot |

## Wrapped in this scaffold (beyond original ~20)

Playback GET/DELETE, ratings remove + GET-by-rating, watched lookup, scrobble start/pause/stop/checkin, custom lists, user stats, recently-watched-background, search file/random, genre browse (movies/tv/anime), airing (tv/anime), CDN calendar, oauth2 revoke, changes.

## Local-only

Prove locally with `node server/index.js` (see README).
