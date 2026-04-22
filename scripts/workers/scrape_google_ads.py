"""
Scrape do Google Ads Transparency Center via API interna.

Descoberta: os endpoints /anji/_/rpc/... retornam JSON estruturado
com o conteudo REAL dos anuncios (incluindo HTML do corpo pra text
ads, URL de imagem pra display, URL de video pra YouTube).

Estrategia:
1. Extrai advertiser_id da URL que o closer colou
2. SearchCreatives pra listar creative_ids (ate 40)
3. GetCreativeById pra cada (paralelo com pool de threads)
4. Parse por formato: Text (1), Image (2), Video (3)

Substitui o Playwright pesado por ~30 requests rapidas.
"""
import os
import sys
import json
import re
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

MAX_ADS = 25
API_BASE = "https://adstransparency.google.com/anji/_/rpc"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def extract_advertiser_id(url: str) -> str:
    """Extrai AR... da URL do Transparency Center."""
    if not url:
        return ""
    m = re.search(r"/advertiser/(AR\d+)", url)
    return m.group(1) if m else ""


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    })
    # Pega cookies iniciais
    try:
        s.get("https://adstransparency.google.com/?region=BR", timeout=15)
    except Exception:
        pass
    return s


def parse_response_json(text: str):
    """Remove prefixo )]} do Google e parseia JSON."""
    if text.startswith(")]}'"):
        text = text[5:]
    elif text.startswith(")]}"):
        text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def search_creatives(session: requests.Session, advertiser_id: str, region: str = "BR", count: int = 40) -> list:
    """Lista creative_ids de um advertiser."""
    req = {
        "2": min(count, 100),
        "3": {
            "12": {"1": "", "2": True},
            "13": {"1": [advertiser_id]},
        },
        "7": {"1": 1},
    }
    data = {"f.req": json.dumps(req)}
    try:
        r = session.post(
            f"{API_BASE}/SearchService/SearchCreatives",
            params={"authuser": ""},
            data=data,
            timeout=20,
        )
        if r.status_code != 200:
            return []
        j = parse_response_json(r.text)
        if not j:
            return []
        items = j.get("1", [])
        # Cada item: {"2": "CR...", ...}
        return [it.get("2") for it in items if it.get("2")]
    except Exception:
        return []


def get_creative_detail(session: requests.Session, advertiser_id: str, creative_id: str) -> dict:
    """Pega detalhe de um creative. Retorna dict com format, text/image/video, data."""
    req = {"1": advertiser_id, "2": creative_id, "5": {"1": 1}}
    data = {"f.req": json.dumps(req)}
    try:
        r = session.post(
            f"{API_BASE}/LookupService/GetCreativeById",
            params={"authuser": "0"},
            data=data,
            timeout=20,
        )
        if r.status_code != 200:
            return {"creative_id": creative_id, "fetched": False, "error": f"HTTP {r.status_code}"}
        j = parse_response_json(r.text)
        if not j or "1" not in j:
            return {"creative_id": creative_id, "fetched": False, "error": "sem campo 1"}

        node = j["1"]
        format_int = node.get("8", 0)
        fmt_label = {1: "text", 2: "image", 3: "video"}.get(format_int, "unknown")

        # Data última exibicao (campo 4.1 = timestamp)
        ts = None
        if isinstance(node.get("4"), dict):
            ts = node["4"].get("1")
        last_shown = None
        if ts:
            try:
                import datetime
                last_shown = datetime.datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d")
            except Exception:
                pass

        # Nome do advertiser
        advertiser_name = None
        if isinstance(node.get("22"), dict):
            advertiser_name = node["22"].get("1")

        # Conteúdo (campo 5 é array com {3:{2:<html>} | 1:{4:<url_video>}})
        text_html = ""
        text_extracted = ""
        headline = ""
        description = ""
        image_url = ""
        video_url = ""
        landing_url = ""

        content_items = node.get("5", [])
        for item in content_items:
            if not isinstance(item, dict):
                continue
            # Imagem/texto inline (campo 3)
            if "3" in item and isinstance(item["3"], dict):
                html = item["3"].get("2", "")
                if html:
                    text_html = html
                    # Text ads: extrai headline/description do HTML
                    # Image ads: extrai <img src=...>
                    img_m = re.search(r'<img[^>]+src="([^"]+)"', html)
                    if img_m:
                        image_url = img_m.group(1)
                    # Headlines/descriptions aparecem em divs/spans no HTML de text ads
                    # Remove tags pra pegar texto visivel
                    text_only = re.sub(r"<[^>]+>", " ", html)
                    text_only = re.sub(r"\s+", " ", text_only).strip()
                    if text_only:
                        text_extracted = text_only[:500]
            # Video (campo 1 ou 2)
            if "1" in item and isinstance(item["1"], dict):
                v = item["1"].get("4") or item["1"].get("2")
                if v and ("http" in str(v)):
                    video_url = str(v)
            if "2" in item and isinstance(item["2"], dict):
                v = item["2"].get("4") or item["2"].get("2")
                if v and ("http" in str(v)):
                    video_url = str(v)

        # Destino (landing): campo 6 geralmente tem dest URL
        dest = node.get("6")
        if isinstance(dest, dict):
            landing_url = dest.get("1") or dest.get("2") or ""
        elif isinstance(dest, str):
            landing_url = dest

        # Tenta extrair headline/description estruturados de Text ads
        # Text ads: HTML tem <div class="headline">...</div> ou similar.
        # Estrutura frequente: varios headlines separados, varios descriptions.
        headlines = []
        descriptions = []
        if format_int == 1 and text_html:
            # Pega conteudo de tags que geralmente tem headlines/descs
            # Heuristica: spans/divs com texto direto
            # Tenta pegar textos separados
            # Primeiro remove tags e quebra em linhas pelo espaço triplo
            text_blocks = re.findall(r">([^<>]{8,200})<", text_html)
            for block in text_blocks:
                s = block.strip()
                if not s or s.startswith("{") or "Anúncio" in s:
                    continue
                # Headlines geralmente sao mais curtos (<80 chars)
                if len(s) < 80 and s not in headlines:
                    headlines.append(s)
                elif len(s) < 300 and s not in descriptions:
                    descriptions.append(s)

        return {
            "creative_id": creative_id,
            "fetched": True,
            "format": fmt_label,
            "last_shown": last_shown,
            "advertiser_name": advertiser_name,
            "image_url": image_url,
            "video_url": video_url,
            "landing_url": landing_url,
            "headlines": headlines[:15],
            "descriptions": descriptions[:4],
            "text_extracted": text_extracted,
            "transparency_url": f"https://adstransparency.google.com/advertiser/{advertiser_id}/creative/{creative_id}?hl=pt-BR&region=BR",
        }
    except Exception as e:
        return {"creative_id": creative_id, "fetched": False, "error": f"{type(e).__name__}: {str(e)[:150]}"}


def main():
    payload = json.loads(os.environ["PAYLOAD"])
    inputs = payload.get("inputs") or {}
    url = (inputs.get("google_ads_transparency_url") or "").strip()

    result = {
        "url": url,
        "fetched": False,
        "ads_count": 0,
        "ads": {"search": [], "display": [], "youtube": [], "all": []},
        "counts_by_format": {},
    }
    errors = []

    if not url:
        save(result, errors)
        print("[scrape_google_ads] sem url — skip")
        return

    advertiser_id = extract_advertiser_id(url)
    if not advertiser_id:
        errors.append({"stage": "scrape_google_ads", "message": f"Nao extraiu advertiser_id da URL: {url[:100]}"})
        save(result, errors)
        return

    result["advertiser_id"] = advertiser_id

    session = make_session()

    # Lista creatives
    creative_ids = search_creatives(session, advertiser_id, count=MAX_ADS)
    print(f"[scrape_google_ads] advertiser={advertiser_id} creatives={len(creative_ids)}")

    if not creative_ids:
        errors.append({"stage": "scrape_google_ads", "message": "SearchCreatives retornou vazio (advertiser_id inválido ou sem ads)"})
        save(result, errors)
        return

    # Pega detalhes em paralelo (5 threads)
    details = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(get_creative_detail, session, advertiser_id, cid): cid for cid in creative_ids[:MAX_ADS]}
        for fut in as_completed(futures):
            try:
                details.append(fut.result())
            except Exception as e:
                details.append({"creative_id": futures[fut], "fetched": False, "error": str(e)[:150]})

    # Separa por formato
    for d in details:
        if not d.get("fetched"):
            continue
        fmt = d.get("format", "unknown")
        result["ads"]["all"].append(d)
        if fmt == "video":
            result["ads"]["youtube"].append(d)
        elif fmt == "image":
            result["ads"]["display"].append(d)
        elif fmt == "text":
            result["ads"]["search"].append(d)

    result["counts_by_format"] = {
        "search": len(result["ads"]["search"]),
        "display": len(result["ads"]["display"]),
        "youtube": len(result["ads"]["youtube"]),
    }
    result["ads_count"] = len(result["ads"]["all"])
    result["fetched"] = result["ads_count"] > 0

    print(f"[scrape_google_ads] fetched={result['fetched']} ads={result['ads_count']} (s={result['counts_by_format']['search']} d={result['counts_by_format']['display']} y={result['counts_by_format']['youtube']})")

    save(result, errors)


def save(result, errors):
    with open("google_ads.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    if errors:
        prev = []
        if os.path.exists("errors.json"):
            try:
                with open("errors.json") as f:
                    prev = json.load(f)
            except Exception:
                pass
        prev.extend(errors)
        with open("errors.json", "w", encoding="utf-8") as f:
            json.dump(prev, f, ensure_ascii=False)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[scrape_google_ads] FATAL: {e}")
        sys.exit(1)
