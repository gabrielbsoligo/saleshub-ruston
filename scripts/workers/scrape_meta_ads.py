"""
Scrape da Meta Ads Library via URL publica (HTML + heuristica leve).
Estrategia atual: busca pelo HTML da URL pre-filtrada que o closer cola,
extrai dados minimamente estruturados via regex.

Limitacao conhecida: Meta Ads Library eh SPA JS-heavy — HTML vem quase
vazio. Quando o doc_id GraphQL for configurado, trocar por GraphQL fetch.

Doc_id GraphQL: env var META_ADS_DOC_ID (pode ser null)
"""
import os, json, sys, re
import requests


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

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    }

    try:
        resp = requests.get(url, headers=headers, timeout=25, allow_redirects=True)
        result["status_code"] = resp.status_code
        result["html_size"] = len(resp.text)
        html = resp.text

        # Heuristica 1: detectar se a URL retornou "sem anuncios"
        # (a Library mostra esse texto no shell HTML quando nao tem resultado)
        low = html.lower()
        if "não encontramos" in low or "no ads to show" in low or "nenhum anuncio" in low:
            result["fetched"] = True
            result["active_count"] = 0
            result["hint"] = "HTML indica 'sem anuncios' — confirmar abrindo URL manualmente"
            save(result, errors)
            return

        # Heuristica 2: tentar pegar page_id do HTML (aparece em og:url e scripts JSON)
        m = re.search(r'"page_id"\s*:\s*"(\d+)"', html)
        if m:
            result["page_id"] = m.group(1)

        # Heuristica 3: contagem "X anúncios ativos" se o shell renderizou
        m = re.search(r'(\d+)\s*an[úu]ncios?\s*ativos?', html, re.I)
        if m:
            result["active_count_hint"] = int(m.group(1))

        # Se tem doc_id configurado, tenta GraphQL
        doc_id = os.environ.get("META_ADS_DOC_ID", "").strip()
        page_id = result.get("page_id")
        if doc_id and page_id:
            try:
                gql_result = fetch_ads_graphql(page_id, doc_id, headers)
                if gql_result:
                    result.update(gql_result)
                    result["fetched"] = True
            except Exception as ge:
                errors.append({"stage": "scrape_meta_ads_graphql", "message": str(ge)[:200]})

        # Se nao conseguiu dados ricos, marca que ao menos tentou
        result["fetched"] = result.get("fetched") or result["html_size"] > 1000

    except requests.exceptions.RequestException as e:
        errors.append({"stage": "scrape_meta_ads", "message": f"Request falhou: {type(e).__name__}: {str(e)[:200]}"})
    except Exception as e:
        errors.append({"stage": "scrape_meta_ads", "message": f"{type(e).__name__}: {str(e)[:200]}"})

    save(result, errors)
    print(f"[scrape_meta_ads] fetched={result.get('fetched')} active_count={result.get('active_count')}")


def fetch_ads_graphql(page_id: str, doc_id: str, base_headers: dict) -> dict:
    """Tentativa de buscar ads via GraphQL publico. doc_id muda periodicamente."""
    url = "https://www.facebook.com/api/graphql/"
    variables = {
        "adActiveStatus": "ALL",
        "country": "BR",
        "pageId": page_id,
        "viewAllPageID": page_id,
        "searchType": "PAGE",
    }
    import urllib.parse
    form = {
        "doc_id": doc_id,
        "variables": json.dumps(variables),
    }
    resp = requests.post(url, data=form, headers={**base_headers, "Content-Type": "application/x-www-form-urlencoded"}, timeout=20)
    if resp.status_code != 200:
        raise Exception(f"GraphQL {resp.status_code}")
    try:
        data = resp.json()
    except Exception:
        raise Exception("GraphQL resposta nao-JSON")

    # O shape muda conforme o doc_id. Tenta caminho comum.
    ads = []
    try:
        edges = data["data"]["ad_library_main"]["search_results_connection"]["edges"]
        for e in edges[:10]:
            node = e.get("node") or {}
            snap = node.get("snapshot") or {}
            ads.append({
                "creative_body": (snap.get("body", {}) or {}).get("text", "")[:500],
                "link_title": snap.get("title", "")[:200],
                "link_description": snap.get("link_description", "")[:300],
                "cta_text": (snap.get("cta_text") or "")[:100],
                "page_name": snap.get("page_name", ""),
                "start_date": node.get("start_date", ""),
                "platforms": node.get("publisher_platform", []),
                "format": snap.get("display_format", ""),
            })
    except (KeyError, TypeError):
        return {}

    return {"ads": ads, "active_count": len(ads)}


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
