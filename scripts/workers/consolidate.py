"""
Consolida resultados dos 4 scrapers em um unico scraped_data JSON.
Input: site.json, instagram.json, meta_ads.json, google_ads.json,
       errors.json (opcionais — nem todos rodam)
Output: scraped_data.json com {site, instagram, meta_ads, google_ads, errors}
"""
import os, json


def load(name):
    if not os.path.exists(name):
        return None
    try:
        with open(name, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    scraped = {}
    site = load("site.json")
    if site:
        scraped["site"] = site

    ig = load("instagram.json")
    if ig:
        scraped["instagram"] = ig

    meta = load("meta_ads.json")
    if meta:
        scraped["meta_ads"] = meta

    goog = load("google_ads.json")
    if goog:
        scraped["google_ads"] = goog

    errors = load("errors.json") or []

    # Adiciona ao errors: steps que deram status=failure no GH
    for stage_env, label in [
        ("STEP_SITE", "scrape_site"),
        ("STEP_INSTAGRAM", "scrape_instagram"),
        ("STEP_META_ADS", "scrape_meta_ads"),
        ("STEP_GOOGLE_ADS", "scrape_google_ads"),
    ]:
        outcome = os.environ.get(stage_env, "").lower()
        if outcome == "failure":
            # So adiciona se ainda nao tem essa stage nos errors
            if not any(e.get("stage", "").startswith(label) for e in errors):
                errors.append({"stage": label, "message": f"GitHub step {label} falhou (outcome=failure)"})

    if errors:
        scraped["errors"] = errors

    with open("scraped_data.json", "w", encoding="utf-8") as f:
        json.dump(scraped, f, ensure_ascii=False)

    print(f"[consolidate] keys={list(scraped.keys())} errors={len(errors)}")


if __name__ == "__main__":
    main()
