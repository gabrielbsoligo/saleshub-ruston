"""
Scrape de perfil Instagram publico via instaloader (sem login).
Risco: Meta bloqueia bastante. Aceita-se falha graciosa.
"""
import os, json, sys, re
try:
    import instaloader
except Exception as e:
    print(f"[scrape_instagram] instaloader nao disponivel: {e}")
    sys.exit(0)


def extract_handle(raw: str) -> str:
    if not raw:
        return ""
    s = raw.strip().lstrip("@")
    m = re.search(r"instagram\.com/([^/?#]+)", s)
    if m:
        return m.group(1).strip("/")
    return s


def main():
    payload = json.loads(os.environ["PAYLOAD"])
    inputs = payload.get("inputs") or {}
    raw = (inputs.get("instagram") or "").strip()
    handle = extract_handle(raw)

    result = {"handle": handle, "fetched": False}
    errors = []

    if not handle:
        save(result, errors)
        print("[scrape_instagram] sem instagram no input — skip")
        return

    try:
        L = instaloader.Instaloader(
            quiet=True,
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            download_geotags=False,
            download_comments=False,
            save_metadata=False,
            post_metadata_txt_pattern="",
        )
        profile = instaloader.Profile.from_username(L.context, handle)
        result["fetched"] = True
        result["handle"] = profile.username
        result["followers"] = profile.followers
        result["followees"] = profile.followees
        result["posts_total"] = profile.mediacount
        result["biography"] = (profile.biography or "")[:500]
        result["external_url"] = profile.external_url
        result["is_private"] = profile.is_private
        result["is_verified"] = profile.is_verified
        result["profile_url"] = f"https://www.instagram.com/{profile.username}/"

        # Posts recentes — limite 12 pra nao irritar o rate limit
        posts_30d = 0
        recent_captions = []
        from datetime import datetime, timezone, timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(days=30)
        try:
            count = 0
            for post in profile.get_posts():
                count += 1
                if count > 12:
                    break
                if post.date_utc.replace(tzinfo=timezone.utc) >= cutoff:
                    posts_30d += 1
                caption = (post.caption or "")[:300]
                recent_captions.append({
                    "date": post.date_utc.isoformat(),
                    "typename": post.typename,
                    "likes": post.likes,
                    "comments": post.comments,
                    "caption": caption,
                })
        except Exception as pe:
            # Posts falhou mas profile ok — ainda vale salvar
            errors.append({"stage": "scrape_instagram_posts", "message": f"posts iter falhou: {str(pe)[:200]}"})

        result["posts_30d"] = posts_30d
        result["recent_posts"] = recent_captions[:6]

    except instaloader.exceptions.ProfileNotExistsException:
        errors.append({"stage": "scrape_instagram", "message": "Perfil nao existe"})
    except instaloader.exceptions.ConnectionException as e:
        errors.append({"stage": "scrape_instagram", "message": f"Conn/ratelimit: {str(e)[:200]}"})
    except Exception as e:
        errors.append({"stage": "scrape_instagram", "message": f"{type(e).__name__}: {str(e)[:200]}"})

    save(result, errors)
    print(f"[scrape_instagram] fetched={result.get('fetched')} followers={result.get('followers')}")


def save(result, errors):
    with open("instagram.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    if errors:
        prev = []
        if os.path.exists("errors.json"):
            with open("errors.json") as f:
                prev = json.load(f)
        prev.extend(errors)
        with open("errors.json", "w", encoding="utf-8") as f:
            json.dump(prev, f, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[scrape_instagram] FATAL: {e}")
        sys.exit(1)
