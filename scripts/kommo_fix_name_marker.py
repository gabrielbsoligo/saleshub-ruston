#!/usr/bin/env python3
"""
kommo_fix_name_marker.py
Corrige o marcador de nome nos templates de chat que subimos: troca APENAS
"[Primeiro Nome]" (literal, vazava pro cliente) pelo marcador nativo do Kommo
"{{contact.first_name}}" (provado nos WABA aprovados que renderizam).

- Casa os templates pelo content conter "[Primeiro Nome]" (só os nossos têm;
  os pré-existentes usam {{contact.first_name}}). Guarda extra: pula uma
  skiplist de nomes pré-existentes.
- NÃO toca em [Seu Nome], [Empresa], [Nicho], etc. (preenchimento do SDR).
- EDITA por id via PATCH no endpoint em lote /api/v4/chats/templates (cada
  objeto carrega seu id) — é o método oficial de update do Kommo; edita as
  linhas existentes pelo id, NÃO recadastra -> não duplica. Sem DELETE.
  Enviamos 1 objeto por request pra ter status por template e parar no 1º erro.

USO
  Dry-run (não envia; salva reports/fix_templates_preview.json):
    python3 scripts/kommo_fix_name_marker.py --dry-run
  Aplicar de verdade:
    export KOMMO_SUBDOMAIN="financeirorustonengenhariacombr"
    export KOMMO_TOKEN="TOKEN_ADMIN"
    python3 scripts/kommo_fix_name_marker.py --apply

Token só via env. Nunca no arquivo/git.
"""
import argparse, json, os, sys, urllib.request, urllib.error

OLD = "[Primeiro Nome]"
NEW = "{{contact.first_name}}"
# Pré-existentes que NÃO devem ser tocados (guarda redundante ao match por content).
SKIP_NAMES = {"confirmacao_reuniao", "lembrete_call_v4", "lembrete_call_naooficial"}
PREVIEW_PATH = "reports/fix_templates_preview.json"


def api(subdomain, token, method, path, body=None):
    url = f"https://{subdomain}.kommo.com{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except urllib.error.URLError as e:
        return None, f"URLError: {e.reason}"


def fetch_templates(subdomain, token):
    st, body = api(subdomain, token, "GET", "/api/v4/chats/templates?limit=250")
    if st != 200 or not isinstance(body, dict):
        sys.exit(f"ERRO ao listar templates: HTTP {st} -> {body}")
    return (body.get("_embedded") or {}).get("chat_templates", [])


def targets(templates):
    out = []
    for t in templates:
        content = t.get("content") or ""
        if t.get("name") in SKIP_NAMES:
            continue
        if OLD in content:
            out.append({"id": t["id"], "name": t["name"], "type": t.get("type", "amocrm"),
                        "before": content, "after": content.replace(OLD, NEW)})
    return out


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    subdomain = os.environ.get("KOMMO_SUBDOMAIN")
    token = os.environ.get("KOMMO_TOKEN")
    if not subdomain or not token:
        sys.exit("ERRO: defina KOMMO_SUBDOMAIN e KOMMO_TOKEN no ambiente.")

    tpls = fetch_templates(subdomain, token)
    tg = targets(tpls)
    print(f"Templates com '{OLD}' a corrigir: {len(tg)}")
    for t in tg:
        print(f"  - id {t['id']}  {t['name']}")

    if args.dry_run:
        os.makedirs(os.path.dirname(PREVIEW_PATH), exist_ok=True)
        with open(PREVIEW_PATH, "w", encoding="utf-8") as f:
            json.dump(tg, f, ensure_ascii=False, indent=2)
        print(f"\nDRY-RUN: preview salvo em {PREVIEW_PATH}. Nada foi enviado.")
        return

    ok, fail = 0, []
    for t in tg:
        # endpoint em lote, 1 objeto por request (edita pelo id -> sem duplicar)
        st, body = api(subdomain, token, "PATCH", "/api/v4/chats/templates",
                       [{"id": t["id"], "name": t["name"], "content": t["after"], "type": t["type"]}])
        good = st in (200, 201)
        print(f"PATCH {t['id']} {t['name']} -> HTTP {st} {'OK' if good else 'FALHOU'}")
        if good:
            ok += 1
        else:
            fail.append({"id": t["id"], "name": t["name"], "status": st, "body": body})
            print(f"  resposta: {body}")
            print("Parando no primeiro erro (como combinado).")
            break
    print(f"\nResumo: {ok}/{len(tg)} editados. Falhas: {len(fail)}")
    if fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
