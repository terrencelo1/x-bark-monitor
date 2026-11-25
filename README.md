# x-bark-monitor

Free X → Bark monitor: polls @unusual_whales and @Cheddarflow
every minute, translates to Simplified Chinese, pushes to Bark (iPhone + iPad).

Chain: Cloudflare Worker cron `* * * * *` → `workflow_dispatch` → GitHub
Actions (public repo, unlimited standard-runner minutes) → `poll.py` with
twifork → POST to the translate+Bark Worker → Bark.

## Why public repo + Worker trigger (not schedule)

- Public repos: standard runners free, no minute cap. Private: 2,000 min/mo.
  1,440 runs/day × 1 min = 1,440 min/day — private is exhausted in ~2 days.
- GitHub `schedule:` cron is unreliable (observed hours apart) and has a
  5-min floor. The Worker is the clock; the workflow is dispatch-only.
- No Oracle VM, no Fly.io (no free tier), no RSSHub on Workers free
  (3 MB size limit). Nothing here costs money.

## Secrets (never in code or logs)

GitHub Secrets for this repo:

- `X_AUTH_TOKEN`, `X_CT0` — spare/burner X account cookies ONLY, never the
  main account. Export from Mac Chrome: right-click → Inspect →
  Application → Cookies → x.com.
- `WORKER_URL` — translate+Bark Worker `/ingest` URL.
- `WORKER_TOKEN` — shared token the Worker checks on `/ingest`.

Cloudflare Worker trigger secrets:

- `GH_PAT` — fine-grained PAT, Actions: write, ONLY this repo.

Bark keys (22-char, iPhone + iPad) live in the delivery Worker, never here.

## Files

- `.github/workflows/poll.yml` — dispatch-only, concurrency group `poll`,
  timeout 3 min, pip cache on.
- `poll.py` — fetch latest 10 tweets per handle via twifork
  `get_user_tweets`, oldest-first, POST candidates to `WORKER_URL`.
  User IDs are resolved live via `get_user_by_screen_name`; fallbacks are
  unusual_whales 1200616796295847936, Cheddarflow 1004137473679679488 (IDInfo, 2026-11-26).
- `requirements.txt` — `twifork[impersonate]`
- `workers/trigger/` — Cloudflare Worker, one dispatch per minute.
- `workers/delivery/` — translate+Bark Worker (KV dedupe, Workers AI
  llama-3.1-8b-instruct-fp8-fast, same glossary / billion guard /
  TRIM LOSSES guard as tg-firstsquawk-translate).
- `.github/workflows/keepalive.yml` — weekly empty commit so the repo
  is never 60 days inactive.

## Latency budget (expected)

Worker trigger 0s + Actions queue/boot 20-30s + pip (cached) ~5s
+ twifork fetch 2-3s + translate 1-2s + Bark 1s = ~30-35s avg, ~60-70s worst.

## Risks

- X changes GraphQL every 2-4 weeks → upgrade twifork + re-export cookies.
- Cookie stale → `is_logged_in()` false → poll.py exits non-zero; check the run log.
- Rate limit: `get_user_tweets` 50 / 15 min per account; 2 handles × 1/min = 120/hr, OK.
