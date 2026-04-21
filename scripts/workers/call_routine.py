"""
Chama a Claude Code Routine com o payload enriquecido (inputs + scraped_data).
Se scraped_data.json existir, inclui no payload.
"""
import os, json, sys
import requests


def main():
    payload = json.loads(os.environ["PAYLOAD"])
    briefing_id = payload.get("briefing_id")
    empresa = payload.get("empresa")
    inputs = payload.get("inputs") or {}

    routine_url = os.environ.get("ROUTINE_URL", "").strip()
    routine_key = os.environ.get("ROUTINE_API_KEY", "").strip()

    if not routine_url or not routine_key:
        print("[call_routine] ROUTINE_URL ou ROUTINE_API_KEY ausente", file=sys.stderr)
        sys.exit(1)

    # Scraped data (se existe)
    scraped = {}
    if os.path.exists("scraped_data.json"):
        with open("scraped_data.json", encoding="utf-8") as f:
            scraped = json.load(f)

    # Payload final pra Routine (mesmo shape do input que ela espera no prompt)
    routine_payload = {
        "briefing_id": briefing_id,
        "empresa": empresa,
        "segmento": inputs.get("segmento", ""),
        "site": inputs.get("site", ""),
        "instagram": inputs.get("instagram", ""),
        "faturamento_atual": inputs.get("faturamento_atual", ""),
        "meta_faturamento": inputs.get("meta_faturamento", ""),
        "concorrentes_conhecidos": inputs.get("concorrentes_conhecidos", ""),
        "contexto": inputs.get("contexto", ""),
        "meta_ads_library_url": inputs.get("meta_ads_library_url", ""),
        "google_ads_transparency_url": inputs.get("google_ads_transparency_url", ""),
        "scraped_data": scraped,  # NOVO: dados pre-coletados pelo worker
    }

    headers = {
        "Authorization": f"Bearer {routine_key}",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    resp = requests.post(
        routine_url,
        headers=headers,
        json={"text": json.dumps(routine_payload, ensure_ascii=False)},
        timeout=60,
    )
    print(f"[call_routine] status={resp.status_code}")
    if not resp.ok:
        print(f"[call_routine] body: {resp.text[:500]}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    print(f"[call_routine] session_id={data.get('claude_code_session_id') or data.get('session_id')}")

    # Atualiza o briefing com a session_id/url pro usuario poder abrir no Claude
    session_id = data.get("claude_code_session_id") or data.get("session_id") or ""
    session_url = data.get("claude_code_session_url") or data.get("session_url") or ""

    # Sempre marca progress_stage=analyzing quando Routine respondeu OK
    supa_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supa_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if supa_url and supa_key:
        update = {"progress_stage": "analyzing"}
        if session_id:
            update["routine_session_id"] = session_id
        if session_url:
            update["routine_session_url"] = session_url
        patch = requests.patch(
            f"{supa_url}/rest/v1/prep_briefings?id=eq.{briefing_id}",
            headers={
                "apikey": supa_key,
                "Authorization": f"Bearer {supa_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json=update,
            timeout=15,
        )
        print(f"[call_routine] stage=analyzing gravado: {patch.status_code}")


if __name__ == "__main__":
    main()
