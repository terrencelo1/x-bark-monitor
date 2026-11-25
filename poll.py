"""Poller for x-bark-monitor (scheme 2).

Fetches the latest tweets for Unusual Whales + Cheddarflow via twifork
and POSTs candidates to the translate+Bark Worker. The Worker owns dedupe
(KV, only writes on new posts), translation, and the Bark push — this
script does NOT push Bark directly and does NOT store state locally,
because every Actions run is a fresh machine.

Secrets (env, from GitHub Secrets — never commit real values):
  X_AUTH_TOKEN, X_CT0 — spare/burner X account cookies ONLY, never the
  main account.
  WORKER_URL, WORKER_TOKEN — translate+Bark Worker /ingest endpoint.

User IDs: resolved live each run via get_user_by_screen_name (no
hard-coded guess). Fallback IDs below are the IDInfo lookups of
2026-11-26: unusual_whales 1200616796295847936 (joined 2019-11-30),
Cheddarflow 1004137473679679488 (joined 2018-06-05).
"""
import asyncio
import json
import os
import re
import urllib.request

HANDLES = [
    {"label": "Unusual Whales", "screen_name": "unusual_whales", "fallback_id": "1200616796295847936"},
    {"label": "Cheddarflow", "screen_name": "Cheddarflow", "fallback_id": "1004137473679679488"},
]

MAX_PER_HANDLE = 10

# Promo posts from Unusual Whales (sales / discount codes / sign-up pushes)
# are not pushed (user 2026-11-26). Flow posts mention tickers, strikes and
# premium dollar amounts, so the patterns below only match marketing
# language — "premium" alone is NOT a promo signal (it is an options term).
PROMO_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\b\d+\s*%\s*off\b",          # 50% off
        r"\bblack friday\b",
        r"\bcyber monday\b",
        r"\bpromo\b",
        r"\buse code\b",
        r"\bdiscount code\b",
        r"\bdiscount\b",
        r"\bsubscribe\b",
        r"\bsign\s?up\b",
        r"\bgiveaway\b",
        r"\bfree trial\b",
        r"\blimited time\b",
        r"\bjoin (unusual whales|us)\b",
        r"\bflash sale\b",
        r"\bon sale\b",
    ]
]


def is_promo(text):
    return any(p.search(text or "") for p in PROMO_PATTERNS)


async def resolve_user_id(client, handle):
    try:
        user = await client.get_user_by_screen_name(handle["screen_name"])
        uid = str(user.id)
        print(f"resolved {handle['screen_name']} -> {uid}")
        return uid
    except Exception as e:  # noqa: BLE001 — fall back to the verified ID
        print(f"resolve failed for {handle['screen_name']}: {e!r}; using fallback {handle['fallback_id']}")
        return handle["fallback_id"]


async def fetch_latest(client, user_id):
    tweets = await client.get_user_tweets(user_id, "Tweets")
    out = []
    for t in list(tweets)[:MAX_PER_HANDLE]:
        out.append({
            "id": str(t.id),
            "text": t.text,
            "created_at": str(getattr(t, "created_at", "")),
            "url": f"https://x.com/i/status/{t.id}",
        })
    # oldest first so the Worker pushes in chronological order
    return list(reversed(out))


async def main():
    from twikit import Client  # twifork installs as `twikit`

    client = Client("en-US", impersonate="chrome124")
    client.set_cookies({
        "auth_token": os.environ["X_AUTH_TOKEN"],
        "ct0": os.environ["X_CT0"],
    })
    if not await client.is_logged_in():
        raise SystemExit("Cookies stale - re-export auth_token + ct0.")

    payload = {"tweets": []}
    for h in HANDLES:
        try:
            user_id = await resolve_user_id(client, h)
            items = await fetch_latest(client, user_id)
        except Exception as e:  # noqa: BLE001 — one handle failing must not kill the other
            print(f"fetch failed for {h['label']}: {e!r}")
            continue
        for it in items:
            if h["screen_name"] == "unusual_whales" and is_promo(it.get("text", "")):
                print(f"skipped promo {it['id']}: {it.get('text', '')[:80]!r}")
                continue
            payload["tweets"].append({**it, "source": h["label"]})

    if not payload["tweets"]:
        print("no candidates")
        return
    req = urllib.request.Request(
        os.environ["WORKER_URL"],
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ['WORKER_TOKEN']}",
            # workers.dev edge returns 1010 for the default Python-urllib UA
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        print("worker:", resp.status, resp.read().decode()[:500])


if __name__ == "__main__":
    asyncio.run(main())
