"""
Scrape do site do lead.
Input: env var PAYLOAD com JSON {briefing_id, empresa, inputs}
Output: arquivo site.json com dados detectados
Fail mode: se nao conseguir, cria errors.json com a info do problema
"""
import os, json, re, sys
import requests

def main():
    payload = json.loads(os.environ["PAYLOAD"])
    inputs = payload.get("inputs") or {}
    site_url = (inputs.get("site") or "").strip()

    result = {"url": site_url, "fetched": False}
    errors = []

    if not site_url:
        save(result, errors)
        print("[scrape_site] sem site no input — skip")
        return

    # Garantir scheme
    if not site_url.startswith(("http://", "https://")):
        site_url = "https://" + site_url

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        }
        resp = requests.get(site_url, headers=headers, timeout=20, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text
        result["fetched"] = True
        result["status_code"] = resp.status_code
        result["final_url"] = resp.url

        # Deteccao de scripts/pixels via regex no HTML bruto
        low = html.lower()
        result["pixel_meta"] = bool(re.search(r"fbq\s*\(|connect\.facebook\.net/.+/fbevents\.js", low))
        result["gtm"] = bool(re.search(r"googletagmanager\.com/gtm\.js|gtm\.start", low))
        result["google_analytics"] = bool(re.search(r"google-analytics\.com/(ga\.js|analytics\.js)|gtag\s*\(", low))
        result["rd_station"] = "rdstation" in low or "rd-station" in low
        result["hubspot"] = "hs-scripts.com" in low or "hsforms.net" in low

        # Estrutura basica (HTML estatico)
        result["has_form"] = bool(re.search(r"<form[\s>]", low))
        result["whatsapp_button"] = bool(re.search(r"wa\.me/|api\.whatsapp\.com/send|whatsapp\.com/send\?phone", low))

        # Contagens simples
        result["cta_count"] = len(re.findall(r"<(button|a)[^>]+(?:class|role)[^>]*(?:btn|cta|button)", low))
        result["form_count"] = len(re.findall(r"<form[\s>]", low))
        result["img_count"] = len(re.findall(r"<img\s", low))

        # Meta description
        m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', html, re.I)
        result["meta_description"] = m.group(1)[:300] if m else None

        # Title
        m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
        result["title"] = m.group(1).strip()[:200] if m else None

        # H1
        m = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.I | re.S)
        if m:
            h1 = re.sub(r"<[^>]+>", "", m.group(1)).strip()
            result["h1"] = h1[:200]

        # SEO sinais
        result["has_sitemap"] = False
        try:
            s = requests.get(site_url.rstrip("/") + "/sitemap.xml", headers=headers, timeout=10)
            result["has_sitemap"] = s.status_code == 200
        except Exception:
            pass

        # HTML size (proxy pra SPA detection — muito pequeno = provavelmente SPA)
        result["html_size"] = len(html)
        result["likely_spa"] = len(html) < 5000 and "root" in low

    except requests.exceptions.RequestException as e:
        errors.append({"stage": "scrape_site", "message": f"Request falhou: {type(e).__name__}: {str(e)[:200]}"})
    except Exception as e:
        errors.append({"stage": "scrape_site", "message": f"Erro inesperado: {type(e).__name__}: {str(e)[:200]}"})

    save(result, errors)
    print(f"[scrape_site] fetched={result.get('fetched')} pixel={result.get('pixel_meta')} gtm={result.get('gtm')}")


def save(result, errors):
    with open("site.json", "w", encoding="utf-8") as f:
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
        print(f"[scrape_site] FATAL: {e}")
        sys.exit(1)
