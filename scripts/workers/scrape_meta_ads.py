"""
Scrape da Meta Ads Library via URL publica.

Descoberta importante: Meta bloqueia User-Agent normal (403), mas serve
SSR completo com dados pra Googlebot. A pagina vem renderizada com os
anuncios em JSON embutido no HTML.

Estrategia:
1. GET na URL com UA=Googlebot
2. Extrai padroes JSON do HTML: body.text, title, link_url, cta_text,
   page_name, start_date, plataformas
3. Deduplica por body+title
4. Retorna lista estruturada
"""
import os, json, sys, re
import requests


GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"


def decode_unicode(s: str) -> str:
    """Decodifica \\uXXXX e escapes do Meta usando json.loads (robusto pra emoji)."""
    try:
        # json.loads trata \uXXXX, surrogates e escapes JSON corretamente
        return json.loads(f'"{s}"')
    except Exception:
        # Fallback: retorna como string mesmo que tenha escapes
        return s


def main():
    payload = json.loads(os.environ["PAYLOAD"])
    inputs = payload.get("inputs") or {}
    url = (inputs.get("meta_ads_library_url") or "").strip()

    result = {"url": url, "fetched": False, "ads": [], "active_count": 0}
    errors = []

    if not url:
        save(result, errors)
        print("[scrape_meta_ads] sem url — skip")
        return

    try:
        resp = requests.get(
            url,
            headers={
                "User-Agent": GOOGLEBOT_UA,
                "Accept-Language": "en-US",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            timeout=25,
            allow_redirects=True,
        )
        result["status_code"] = resp.status_code
        result["html_size"] = len(resp.text)
        html = resp.text

        if resp.status_code != 200:
            errors.append({
                "stage": "scrape_meta_ads",
                "message": f"HTTP {resp.status_code} ao buscar Ad Library com Googlebot UA",
            })
            save(result, errors)
            return

        # Procura padroes de anuncios no JSON embutido
        # Meta embute cada ad como objeto com body.text, title, cta_text, etc.
        ads = extract_ads(html)
        if ads:
            result["ads"] = ads
            result["active_count"] = len(ads)
            result["fetched"] = True

        # Page name (geral)
        m = re.search(r'"page_name":"([^"]+)"', html)
        if m:
            result["page_name"] = decode_unicode(m.group(1))[:200]

        # Page ID
        m = re.search(r'"page_id":"(\d+)"', html)
        if m:
            result["page_id"] = m.group(1)

        print(f"[scrape_meta_ads] fetched={result['fetched']} active_count={result['active_count']}")

    except requests.exceptions.RequestException as e:
        errors.append({
            "stage": "scrape_meta_ads",
            "message": f"Request falhou: {type(e).__name__}: {str(e)[:200]}",
        })
    except Exception as e:
        errors.append({
            "stage": "scrape_meta_ads",
            "message": f"{type(e).__name__}: {str(e)[:200]}",
        })

    save(result, errors)


def extract_ads(html: str) -> list:
    """
    Extrai anuncios do HTML. O SSR do Meta pra Googlebot inclui objetos JSON
    com cada snapshot. Usamos regex pra pegar os campos principais.

    Como cada ad pode aparecer em varias plataformas, deduplicamos por body+title.
    """
    # Pega todos os pares (body.text, title mais proximo, cta_text mais proximo, etc)
    # Estrategia: dividir em blocos de ~2000 chars em volta de cada body encontrado
    bodies = list(re.finditer(r'"body":\s*\{\s*"text":\s*"((?:[^"\\]|\\.)*)"', html))

    ads = []
    seen = set()

    for m in bodies:
        start = max(0, m.start() - 500)
        end = min(len(html), m.end() + 2000)
        block = html[start:end]

        body_text = decode_unicode(m.group(1))[:600]
        if not body_text.strip():
            continue

        # Titulo (pode estar antes ou depois do body)
        title = ""
        t = re.search(r'"title":\s*"((?:[^"\\]|\\.)*)"', block)
        if t:
            title = decode_unicode(t.group(1))[:200]

        link_description = ""
        ld = re.search(r'"link_description":\s*"((?:[^"\\]|\\.)*)"', block)
        if ld:
            link_description = decode_unicode(ld.group(1))[:300]

        cta = ""
        c = re.search(r'"cta_text":\s*"((?:[^"\\]|\\.)*)"', block)
        if c:
            cta = decode_unicode(c.group(1))[:100]

        link_url = ""
        lu = re.search(r'"link_url":\s*"((?:[^"\\]|\\.)*)"', block)
        if lu:
            link_url = decode_unicode(lu.group(1))[:300]

        # Data de inicio
        start_date = ""
        sd = re.search(r'"start_date":\s*"?(\d+)"?', block)
        if sd:
            # Timestamp em segundos
            try:
                from datetime import datetime, timezone
                start_date = datetime.fromtimestamp(int(sd.group(1)), tz=timezone.utc).date().isoformat()
            except Exception:
                pass

        # Plataformas
        plats = re.findall(r'"publisher_platform":\s*\[([^\]]+)\]', block)
        platforms = []
        if plats:
            raw = plats[0]
            for p in re.findall(r'"([^"]+)"', raw):
                if p not in platforms:
                    platforms.append(p)

        # Formato (image, video, carousel)
        display_format = ""
        df = re.search(r'"display_format":\s*"([^"]+)"', block)
        if df:
            display_format = df.group(1)

        # Dedupe por body+title
        key = (body_text[:200], title[:100])
        if key in seen:
            continue
        seen.add(key)

        ads.append({
            "body": body_text,
            "title": title,
            "link_description": link_description,
            "cta_text": cta,
            "link_url": link_url,
            "start_date": start_date,
            "platforms": platforms,
            "format": display_format,
        })

        # Limita a 20 ads pra nao estourar payload
        if len(ads) >= 20:
            break

    return ads


def save(result, errors):
    with open("meta_ads.json", "w", encoding="utf-8") as f:
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
        print(f"[scrape_meta_ads] FATAL: {e}")
        sys.exit(1)
