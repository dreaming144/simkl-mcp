# Simkl rate limits (operator copy)

Source: https://api.simkl.org/resources/rate-limits.md (read 2026-09-24).  
Classifier ported from the author's own sync project (`simkl_limits.py`; not included).

## Two limits at once

| Cap | Limit (AUTH V2) |
|-----|-----------------|
| Per-second | **10 GET/sec**, **1 POST/sec** (per user) |
| Daily quota | Free **500** / PRO **1000** / VIP **10000** per user (shared across all apps that user connected) |

Reset: **next midnight `America/New_York`** (not rolling 24h, not local midnight). Winter = 05:00 UTC, summer = 04:00 UTC — do **not** hardcode the offset; this server uses `Intl` + iterative conversion.

## Headers (counted V2 requests)

| Header | Meaning |
|--------|---------|
| `X-RateLimit-Limit` | User’s daily allowance |
| `X-RateLimit-Remaining` | Left today |
| `Retry-After` | **Only on daily 429** — seconds until reset (**duration**, not unix ts) |

First request after a brand-new token may **omit** `X-RateLimit-*`. Treat absence as **N/A**, never as zero.

## Exempt (no Auth, no quota, no per-second)

- `GET /movies/{id}`, `/tv/{id}`, `/anime/{id}`
- `GET /tv/episodes/{id}`, `/anime/episodes/{id}`
- CDN `https://data.simkl.in/...` trending & calendar
- `/redirect` is quota-exempt per rate-limits docs (AUTH V2 still needs Bearer for `/redirect` / search)

**Never send `Authorization` on catalog detail/episodes** — Auth busts the Cloudflare edge cache and burns origin.

## Classify table (`classifySimklResponse`)

| Status + body `error` | Kind | Action in this MCP |
|----------------------|------|--------------------|
| `429` `rate_limit` | `per_second` | Wait ~1.2s; **ignore** `Retry-After`; auto-retry ≤3 |
| `429` `user_limit_exceeded` | `daily_user` | Stop further counted calls this session; surface error; **no** auto-retry |
| `429` `app_limit_exceeded` | `daily_app` | Same (V1 leftover; still handled) |
| `400` `rate_limit` / `RATE_LIMIT` | `write_lock` | Wait ~3.5s; serialize writes; auto-retry ≤3; **not** daily |
| `401` `user_token_required` | `user_token_required` | Not a rate limit — attach Bearer |

## Server pacing

- Global **serial queue** for non-exempt requests (one in flight through the queue).
- POST / write methods: ≥ **1.05s** gap.
- Counted GET: ≥ **105ms** gap (~10/s).
- Catalog + CDN: exempt from pacing/quota tracking (still go through the queue).
- Tool: `simkl_rate_limit_status` → `{ limit, remaining, resetsAtIso, resetsInSeconds, lastKind, lastError, headersSeen, … }`.

## Testing aid

Optional tool arg `debugLimit: "user"|"app"` appends `?debug_limit=…` (forces that 429). **Never use in normal ops.**

## Best practices (skill)

1. Always `simkl_get_activities` before `simkl_get_all_items`.
2. Batch write arrays — one POST beats N singles.
3. Never parallelize uncached / counted endpoints.
4. Prefer `/redirect` over `/search/id` when you only need a Simkl id.
