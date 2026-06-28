# -*- coding: utf-8 -*-
"""
kommo_backfill.py — Backfill inicial da réplica `kommo` (Fase 1), SOMENTE LEITURA do Kommo.

Por que existe: a Edge Function `supabase/functions/kommo-sync` faz o sync num único
request e, dado o volume de eventos da conta (~77 mil em 35 dias), o backfill inicial de
90 dias estoura o limite de tempo da Edge Function. O sync fatiado por cursor é da Fase 2.
Até lá, ESTE script faz o backfill inicial (e o delta/webhook da função mantém atualizado).

Foi com este backfill que se calculou o número de "deals frios" do caso de uso:
  deals em aberto (negociacao/contrato_na_rua/follow_longo) COM proposta (produto + preço),
  cruzados com a última atividade real no Kommo (tarefa criada/concluída, nota, mensagem de
  chat/WhatsApp/DM, mudança de etapa) via a recipe kommo.find_stale_deals(valor_min, dias).

Escopo: popula kommo.leads/tasks/notes/events APENAS para os leads vinculados a deals em
aberto com proposta (universo avaliável). Não toca `public`. Reaplicável (upsert idempotente).

Credenciais por ambiente (NUNCA hardcoded):
  SB_TOKEN          -> Supabase Management API token (DDL/DML no schema kommo)
  KOMMO_TOKEN       -> token de longa duração da API do Kommo
  KOMMO_SUBDOMAIN   -> subdomínio da conta (default: financeirorustonengenhariacombr)
  BACKFILL_DIAS     -> janela de tasks/notes/eventos (default 90; decisão do projeto)
  SB_PROJECT_REF    -> ref do projeto Supabase (default: iaompeiokjxbffwehhrx)

Uso:
  SB_TOKEN=... KOMMO_TOKEN=... python3 scripts/kommo_backfill.py
"""
import os, json, time, requests
from datetime import datetime, timezone, timedelta
import urllib.request, urllib.parse, urllib.error

REF = os.environ.get("SB_PROJECT_REF", "iaompeiokjxbffwehhrx")
SBT = os.environ["SB_TOKEN"]
KT = os.environ["KOMMO_TOKEN"]
SUB = os.environ.get("KOMMO_SUBDOMAIN", "financeirorustonengenhariacombr")
DIAS = int(os.environ.get("BACKFILL_DIAS", "90"))
SQLURL = f"https://api.supabase.com/v1/projects/{REF}/database/query"
SBH = {"Authorization": f"Bearer {SBT}", "Content-Type": "application/json"}
B = f"https://{SUB}.kommo.com/api/v4"

# Tipos de evento de TOQUE espelhados em kommo.events (seletivo, NÃO o firehose):
TOUCH = {'outgoing_chat_message', 'incoming_chat_message', 'talk_created',
         'conversation_answered', 'entity_direct_message', 'lead_status_changed'}


def sb(sql):
    r = requests.post(SQLURL, headers=SBH, json={"query": sql}, timeout=180)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Supabase {r.status_code}: {r.text[:300]}")
    return r.json()


def kget(path, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(B + path, headers={"Authorization": f"Bearer {KT}"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 ** i); continue
            if e.code == 204:
                return {}
            raise
    raise RuntimeError("Kommo rate limit")


def esc(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def ts(epoch):
    return f"to_timestamp({int(epoch)})" if epoch else "NULL"


def jb(obj):
    return "NULL" if obj is None else "'" + json.dumps(obj, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def upsert(table, cols, rows, pk="id"):
    if not rows: return 0
    updates = [c for c in cols if c != pk]
    setc = ",".join(f"{c}=excluded.{c}" for c in updates)
    n = 0
    for i in range(0, len(rows), 200):
        chunk = rows[i:i + 200]
        vals = ",".join("(" + ",".join(r) + ")" for r in chunk)
        sb(f"insert into {table} ({','.join(cols)}) values {vals} on conflict ({pk}) do update set {setc}")
        n += len(chunk)
    return n


def main():
    # universo avaliável: kommo ids de deals em aberto com proposta
    rel = sb(r"""select distinct floor(btrim(kommo_id)::numeric)::bigint id from public.deals
      where status in ('negociacao','contrato_na_rua','follow_longo')
        and produto is not null and btrim(produto) not in ('','-','nan','NULL')
        and coalesce(valor_ot,0)+coalesce(valor_mrr,0)>0
        and kommo_id ~ '^[0-9]+(\.0+)?$'""")
    relset = {r["id"] for r in rel}
    print(f"leads avaliáveis (deals em aberto c/ proposta + vínculo): {len(relset)}")

    # 1) LEADS
    ids = list(relset); leadrows = []
    for i in range(0, len(ids), 250):
        q = "&".join(f"filter[id][]={x}" for x in ids[i:i + 250]) + "&limit=250"
        for L in kget("/leads?" + q).get("_embedded", {}).get("leads", []):
            leadrows.append([esc(L["id"]), esc(L.get("name")), esc(L.get("pipeline_id")), esc(L.get("status_id")),
                             esc(L.get("responsible_user_id")), esc(L.get("price")), jb(L.get("custom_fields_values")),
                             ts(L.get("created_at")), ts(L.get("updated_at"))])
        time.sleep(0.15)
    print("kommo.leads:", upsert("kommo.leads", ["id", "name", "pipeline_id", "status_id",
          "responsible_user_id", "price", "custom_fields", "kommo_created_at", "kommo_updated_at"], leadrows))

    frm = int((datetime.now(timezone.utc) - timedelta(days=DIAS)).timestamp())

    # 2) TASKS (updated na janela) -> leads relevantes
    rows = []; page = 1
    while True:
        q = urllib.parse.urlencode({"filter[updated_at][from]": frm, "limit": 250, "page": page}, safe="[]")
        items = kget("/tasks?" + q).get("_embedded", {}).get("tasks", [])
        if not items: break
        for t in items:
            if t.get("entity_type") == "leads" and t.get("entity_id") in relset:
                rows.append([esc(t["id"]), esc("leads"), esc(t["entity_id"]), esc(t.get("responsible_user_id")),
                             esc(t.get("is_completed")), esc(t.get("task_type_id")), esc(t.get("text")),
                             ts(t.get("complete_till")), ts(t.get("created_at")), ts(t.get("updated_at"))])
        if len(items) < 250: break
        page += 1; time.sleep(0.1)
    print("kommo.tasks:", upsert("kommo.tasks", ["id", "entity_type", "entity_id", "responsible_user_id",
          "is_completed", "task_type_id", "text", "complete_till", "kommo_created_at", "kommo_updated_at"], rows))

    # 3) NOTES (account-wide leads notes, na janela) -> relevantes
    rows = []; page = 1
    while True:
        q = urllib.parse.urlencode({"filter[updated_at][from]": frm, "limit": 250, "page": page}, safe="[]")
        items = kget("/leads/notes?" + q).get("_embedded", {}).get("notes", [])
        if not items: break
        for nt in items:
            if nt.get("entity_id") in relset:
                rows.append([esc(nt["id"]), esc("leads"), esc(nt["entity_id"]), esc(nt.get("note_type")),
                             esc(nt.get("created_by")), jb(nt.get("params")), ts(nt.get("created_at")), ts(nt.get("updated_at"))])
        if len(items) < 250: break
        page += 1; time.sleep(0.1)
    print("kommo.notes:", upsert("kommo.notes", ["id", "entity_type", "entity_id", "note_type",
          "created_by", "params", "kommo_created_at", "kommo_updated_at"], rows))

    # 4) EVENTS de toque (na janela) -> relevantes
    rows = []; page = 1; total = 0
    while True:
        q = urllib.parse.urlencode({"filter[created_at][from]": frm, "limit": 250, "page": page}, safe="[]")
        items = kget("/events?" + q).get("_embedded", {}).get("events", [])
        if not items: break
        for e in items:
            total += 1
            if e.get("type") in TOUCH and e.get("entity_id") in relset:
                rows.append([esc(e["id"]), esc(e["type"]), esc(e.get("entity_type")), esc(e["entity_id"]),
                             esc(e.get("created_by")), ts(e.get("created_at"))])
        if len(items) < 250: break
        page += 1
        if page % 25 == 0: print(f"   ...events página {page} ({total} varridos)")
        time.sleep(0.1)
    print("kommo.events:", upsert("kommo.events", ["id", "type", "entity_type", "entity_id",
          "created_by", "kommo_created_at"], rows), f"(de {total} eventos varridos)")
    print("BACKFILL OK")


if __name__ == "__main__":
    main()
