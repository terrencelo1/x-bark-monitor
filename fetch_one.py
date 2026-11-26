"""Fetch one tweet by ID via twifork (spare-account cookies only).

Reads fetch_request.json in the repo root: {"tweet_id": "..."}.
Prints a JSON block between FETCH_ONE_BEGIN / FETCH_ONE_END with:
  id, url, user screen_name/name, created_at, full text, lang,
  favorite/retweet/reply/view counts, and media (type, url, duration,
  video stream urls with bitrate/content_type).

Run in GitHub Actions with X_AUTH_TOKEN / X_CT0 from repo Secrets.
Never print the cookies. Exits non-zero when login fails or the
tweet cannot be fetched, so the run log shows the failure loudly.
"""
import asyncio
import json
import os
import sys

REQUEST_FILE = os.path.join(os.path.dirname(__file__), "fetch_request.json")


def media_to_dict(m):
    d = {"type": type(m).__name__}
    for k in ("url", "media_url", "media_url_https", "display_url", "expanded_url"):
        v = getattr(m, k, None)
        if v:
            d[k] = v
    vi = getattr(m, "video_info", None)
    if vi:
        d["duration_millis"] = vi.get("duration_millis")
        d["aspect_ratio"] = vi.get("aspect_ratio")
        streams = []
        for s in vi.get("variants", []) or []:
            streams.append({
                "content_type": s.get("content_type"),
                "url": s.get("url"),
                "bitrate": s.get("bitrate"),
            })
        # highest-bitrate mp4 first, m3u8 last (m3u8 has no bitrate)
        streams.sort(key=lambda s: (s.get("content_type") == "video/mp4", s.get("bitrate") or 0), reverse=True)
        d["streams"] = streams
    return d


async def main():
    with open(REQUEST_FILE, encoding="utf-8") as f:
        req = json.load(f)
    tweet_id = str(req["tweet_id"]).strip()
    if not tweet_id.isdigit():
        raise SystemExit(f"bad tweet_id in fetch_request.json: {tweet_id!r}")

    from twikit import Client

    client = Client("en-US", impersonate="chrome124")
    client.set_cookies({
        "auth_token": os.environ["X_AUTH_TOKEN"],
        "ct0": os.environ["X_CT0"],
    })
    if not await client.is_logged_in():
        raise SystemExit("Cookies stale - re-export auth_token + ct0.")

    tweet = await client.get_tweet_by_id(tweet_id)
    user = getattr(tweet, "user", None)
    out = {
        "id": str(tweet.id),
        "url": f"https://x.com/i/status/{tweet.id}",
        "user": {
            "screen_name": getattr(user, "screen_name", None),
            "name": getattr(user, "name", None),
            "id": str(getattr(user, "id", "")) if user is not None else None,
        } if user is not None else None,
        "created_at": str(getattr(tweet, "created_at", "")),
        "text": getattr(tweet, "full_text", None) or getattr(tweet, "text", ""),
        "lang": getattr(tweet, "lang", None),
        "favorite_count": getattr(tweet, "favorite_count", None),
        "retweet_count": getattr(tweet, "retweet_count", None),
        "reply_count": getattr(tweet, "reply_count", None),
        "view_count": getattr(tweet, "view_count", None),
        "media": [media_to_dict(m) for m in (getattr(tweet, "media", None) or [])],
    }
    print("FETCH_ONE_BEGIN")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    print("FETCH_ONE_END")


if __name__ == "__main__":
    asyncio.run(main())
