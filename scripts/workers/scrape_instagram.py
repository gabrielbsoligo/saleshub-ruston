"""
Scrape de perfil Instagram publico.
Ordem de tentativa:
1. Fallback leve: GET na URL do perfil com UA de browser + parse de og:description
   (serve seguidores/posts/following que Instagram coloca em meta tags).
2. Instaloader sem login (pode falhar com 403 ou ratelimit).

Se ambos falharem, grava fetched=false + erros descritivos.
"""
import os, json, sys, re, time, random
import requests

try:
    import instaloader
    HAS_INSTALOADER = True
except Exception:
    HAS_INSTALOADER = False


BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Instagram agora eh SPA full — HTML com UA normal vem vazio. Mas
# Instagram serve SSR completo pra bots de indexacao (Googlebot).
# og:description contem: "Xk Followers, Y Following, Z Posts - See..."
GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"


def extract_handle(raw: str) -> str:
    if not raw:
        return ""
    s = raw.strip().lstrip("@")
    m = re.search(r"instagram\.com/([^/?#]+)", s)
    if m:
        return m.group(1).strip("/")
    return s


def parse_number(s: str) -> int:
    """Converte '5.2K', '1.3M', '234' etc. em int."""
    s = s.replace(",", "").replace(" ", "").strip()
    if not s:
        return 0
    multiplier = 1
    last = s[-1].upper()
    if last == "K":
        multiplier = 1_000
        s = s[:-1]
    elif last == "M":
        multiplier = 1_000_000
        s = s[:-1]
    elif last == "B":
        multiplier = 1_000_000_000
        s = s[:-1]
    try:
        return int(float(s) * multiplier)
    except ValueError:
        return 0


def try_public_profile(handle: str) -> dict:
    """Fallback: GET no HTML da pagina com UA Googlebot (IG faz SSR pra bots).

    Retry em 429/403 com backoff aleatorio — reduz chance de cair no rate limit
    global do pool IP do GitHub runner.
    """
    url = f"https://www.instagram.com/{handle}/"
    max_attempts = 3
    html = None
    last_status = None

    # Delay inicial aleatorio (0-4s) — se varios briefings disparam em paralelo,
    # evita que todos batam IG no mesmo instante
    time.sleep(random.uniform(0, 4))

    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.get(
                url,
                headers={
                    "User-Agent": GOOGLEBOT_UA,
                    "Accept-Language": "en-US",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
                timeout=15,
                allow_redirects=True,
            )
            last_status = resp.status_code

            if resp.status_code == 200:
                html = resp.text
                break

            # 429/403 — espera e tenta de novo
            if resp.status_code in (429, 403) and attempt < max_attempts:
                wait = random.uniform(8, 25) * attempt  # backoff crescente
                print(f"[scrape_instagram] tentativa {attempt}: HTTP {resp.status_code} — aguardando {wait:.1f}s")
                time.sleep(wait)
                continue

            # Outros codigos — desiste
            return {"ok": False, "reason": f"HTTP {resp.status_code}"}

        except requests.exceptions.RequestException as e:
            if attempt < max_attempts:
                wait = random.uniform(5, 15)
                print(f"[scrape_instagram] tentativa {attempt}: {type(e).__name__} — aguardando {wait:.1f}s")
                time.sleep(wait)
                continue
            return {"ok": False, "reason": f"Request: {type(e).__name__}: {str(e)[:150]}"}

    if html is None:
        return {"ok": False, "reason": f"HTTP {last_status} apos {max_attempts} tentativas (provavelmente rate limit persistente)"}

    try:

        # Primeira linha de defesa: Instagram serve meta og:description com
        # contagens em perfis publicos. Formato tipico:
        #   "5,234 Followers, 123 Following, 45 Posts - See Instagram..."
        #   "5.2K Followers, ..."
        m = re.search(
            r'"og:description"\s+content="([^"]+)"',
            html,
        )
        if not m:
            m = re.search(
                r'<meta\s+property="og:description"\s+content="([^"]+)"',
                html,
            )
        if not m:
            # Busca mais solta
            m = re.search(
                r'([\d.,KMB]+)\s*Followers?[,\s]+([\d.,KMB]+)\s*Following[,\s]+([\d.,KMB]+)\s*Posts',
                html,
                re.I,
            )
            if m:
                followers, following, posts = m.group(1), m.group(2), m.group(3)
                return {
                    "ok": True,
                    "followers": parse_number(followers),
                    "followees": parse_number(following),
                    "posts_total": parse_number(posts),
                    "source": "regex_body",
                }
            return {"ok": False, "reason": "og:description nao encontrado"}

        desc = m.group(1)
        # "5,234 Followers, 123 Following, 45 Posts - See Instagram..."
        m2 = re.search(
            r'([\d.,KMB]+)\s*Followers?[,\s]+([\d.,KMB]+)\s*Following[,\s]+([\d.,KMB]+)\s*Posts',
            desc,
            re.I,
        )
        if not m2:
            # Versao em portugues
            m2 = re.search(
                r'([\d.,KMB]+)\s*Seguidores[,\s]+([\d.,KMB]+)\s*Seguindo[,\s]+([\d.,KMB]+)\s*Publica',
                desc,
                re.I,
            )
        if not m2:
            return {"ok": False, "reason": f"Nao parseou og:description: {desc[:150]}"}

        followers, following, posts = m2.group(1), m2.group(2), m2.group(3)
        result = {
            "ok": True,
            "followers": parse_number(followers),
            "followees": parse_number(following),
            "posts_total": parse_number(posts),
            "source": "og_description",
        }

        # Extras que dá pra tirar do HTML
        m_bio = re.search(
            r'"og:title"\s+content="([^"]+)"',
            html,
        )
        if m_bio:
            result["og_title"] = m_bio.group(1)[:200]

        # Tenta pegar bio que o Instagram coloca em biography no JSON incorporado
        m_json = re.search(r'"biography":"([^"]+)"', html)
        if m_json:
            result["biography"] = m_json.group(1).encode().decode("unicode_escape")[:500]

        m_verified = re.search(r'"is_verified":\s*(true|false)', html)
        if m_verified:
            result["is_verified"] = m_verified.group(1) == "true"

        m_private = re.search(r'"is_private":\s*(true|false)', html)
        if m_private:
            result["is_private"] = m_private.group(1) == "true"

        m_external = re.search(r'"external_url":"([^"]+)"', html)
        if m_external:
            result["external_url"] = m_external.group(1).encode().decode("unicode_escape")

        return result
    except requests.exceptions.RequestException as e:
        return {"ok": False, "reason": f"Request: {type(e).__name__}: {str(e)[:150]}"}
    except Exception as e:
        return {"ok": False, "reason": f"Exception: {type(e).__name__}: {str(e)[:150]}"}


def try_instaloader(handle: str) -> dict:
    """Fallback mais rico se Instaloader conseguir. Comumente falha com 403."""
    if not HAS_INSTALOADER:
        return {"ok": False, "reason": "instaloader nao disponivel"}

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
        result = {
            "ok": True,
            "source": "instaloader",
            "handle": profile.username,
            "followers": profile.followers,
            "followees": profile.followees,
            "posts_total": profile.mediacount,
            "biography": (profile.biography or "")[:500],
            "external_url": profile.external_url,
            "is_private": profile.is_private,
            "is_verified": profile.is_verified,
        }

        # Posts recentes (melhor senao irrita rate limit)
        try:
            from datetime import datetime, timezone, timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(days=30)
            posts_30d = 0
            recent = []
            count = 0
            for post in profile.get_posts():
                count += 1
                if count > 12:
                    break
                if post.date_utc.replace(tzinfo=timezone.utc) >= cutoff:
                    posts_30d += 1
                recent.append({
                    "date": post.date_utc.isoformat(),
                    "typename": post.typename,
                    "likes": post.likes,
                    "comments": post.comments,
                    "caption": (post.caption or "")[:300],
                })
            result["posts_30d"] = posts_30d
            result["recent_posts"] = recent[:6]
        except Exception:
            pass  # Posts falhou mas profile OK

        return result
    except Exception as e:
        name = type(e).__name__
        msg = str(e)[:200]
        # ProfileNotExistsException eh enganoso — geralmente eh bloqueio
        if name == "ProfileNotExistsException":
            return {"ok": False, "reason": f"Meta retornou erro (provavelmente bloqueio/ratelimit): {msg}"}
        return {"ok": False, "reason": f"{name}: {msg}"}


def main():
    payload = json.loads(os.environ["PAYLOAD"])
    inputs = payload.get("inputs") or {}
    raw = (inputs.get("instagram") or "").strip()
    handle = extract_handle(raw)

    result = {"handle": handle, "fetched": False, "profile_url": f"https://www.instagram.com/{handle}/" if handle else None}
    errors = []

    if not handle:
        save(result, errors)
        print("[scrape_instagram] sem handle — skip")
        return

    # Tentativa 1: fallback leve (og:description)
    light = try_public_profile(handle)
    if light.get("ok"):
        result.update({k: v for k, v in light.items() if k != "ok"})
        result["fetched"] = True

    # Tentativa 2: instaloader (se disponivel E light nao pegou posts recentes)
    if not result.get("recent_posts") or not result.get("fetched"):
        rich = try_instaloader(handle)
        if rich.get("ok"):
            # Merge — instaloader tem mais dados, mas preserva o que light ja pegou
            for k, v in rich.items():
                if k != "ok" and (v is not None):
                    result[k] = v
            result["fetched"] = True
        elif not result.get("fetched"):
            errors.append({"stage": "scrape_instagram", "message": f"og fallback falhou ({light.get('reason')}); instaloader falhou ({rich.get('reason')})"})

    save(result, errors)
    print(
        f"[scrape_instagram] fetched={result.get('fetched')} "
        f"followers={result.get('followers')} source={result.get('source', 'none')}"
    )


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
