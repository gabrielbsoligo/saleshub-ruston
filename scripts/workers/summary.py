"""
Gera markdown pra $GITHUB_STEP_SUMMARY.
Mostra rapidamente o que cada step fez.
"""
import os, json


def icon(outcome):
    return {
        "success": "✅",
        "failure": "❌",
        "skipped": "⏭️",
        "cancelled": "⚠️",
        "": "❓",
    }.get(outcome, "❓")


def main():
    site = os.environ.get("STEP_SITE", "")
    ig = os.environ.get("STEP_INSTAGRAM", "")
    meta = os.environ.get("STEP_META_ADS", "")
    goog = os.environ.get("STEP_GOOGLE_ADS", "")
    routine = os.environ.get("STEP_ROUTINE", "")

    lines = []
    lines.append("## Prep Call Worker Summary")
    lines.append("")
    lines.append("| Step | Outcome |")
    lines.append("|---|---|")
    lines.append(f"| Scrape site | {icon(site)} {site} |")
    lines.append(f"| Scrape Instagram | {icon(ig)} {ig} |")
    lines.append(f"| Scrape Meta Ads | {icon(meta)} {meta} |")
    lines.append(f"| Scrape Google Ads | {icon(goog)} {goog} |")
    lines.append(f"| Call Routine | {icon(routine)} {routine} |")
    lines.append("")

    # Conteudo coletado
    for name, label in [
        ("site.json", "Site"),
        ("instagram.json", "Instagram"),
        ("meta_ads.json", "Meta Ads"),
        ("google_ads.json", "Google Ads"),
    ]:
        if os.path.exists(name):
            try:
                with open(name, encoding="utf-8") as f:
                    d = json.load(f)
                lines.append(f"### {label}")
                lines.append("```json")
                lines.append(json.dumps(d, ensure_ascii=False, indent=2)[:1500])
                lines.append("```")
                lines.append("")
            except Exception:
                pass

    if os.path.exists("errors.json"):
        try:
            with open("errors.json", encoding="utf-8") as f:
                errs = json.load(f)
            if errs:
                lines.append("### ❌ Errors")
                for e in errs:
                    lines.append(f"- **{e.get('stage')}** — {e.get('message')}")
                lines.append("")
        except Exception:
            pass

    print("\n".join(lines))


if __name__ == "__main__":
    main()
