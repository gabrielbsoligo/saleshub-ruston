# -*- coding: utf-8 -*-
"""
kommo_backfill_full.py — Backfill COMPLETO da réplica `kommo` (Fase 2), SOMENTE LEITURA do Kommo.

Popula a conta inteira: users, pipelines/stages, custom_fields, leads (+associações
lead↔contato e lead↔empresa), contacts e companies. É o FALLBACK operável enquanto o
pg_cron + pg_net + Vault (migration_043) não estão de pé, e é o que REPRODUZ os números
da Fase 2 (ex.: 7.971 leads / 17.908 contatos / 2.914 empresas / clusters de duplicados).

Não toca `public`. Idempotente (upsert por PK, com dedup por PK no batch e DO NOTHING em
tabelas só-PK). Resiliente a blip de rede (re-tenta SSL/timeout). Não traz tasks/notes/
events — esses já vêm do kommo_backfill.py (deals) e da kommo-sync (delta/webhook).

Credenciais por ambiente (NUNCA hardcoded):
  SB_TOKEN          -> Supabase Management API token
  KOMMO_TOKEN       -> token de longa duração da API do Kommo
  KOMMO_SUBDOMAIN   -> subdomínio (default: financeirorustonengenhariacombr)
  SB_PROJECT_REF    -> ref do projeto (default: iaompeiokjxbffwehhrx)

Uso:  SB_TOKEN=... KOMMO_TOKEN=... python3 scripts/kommo_backfill_full.py
"""
import os, json, time, requests
import urllib.request, urllib.parse, urllib.error

REF = os.environ.get("SB_PROJECT_REF", "iaompeiokjxbffwehhrx")
SBT = os.environ["SB_TOKEN"]
KT = os.environ["KOMMO_TOKEN"]
SUB = os.environ.get("KOMMO_SUBDOMAIN", "financeirorustonengenhariacombr")
SQLURL = f"https://api.supabase.com/v1/projects/{REF}/database/query"
SBH = {"Authorization": f"Bearer {SBT}", "Content-Type": "application/json"}
B = f"https://{SUB}.kommo.com/api/v4"


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
            if e.code == 429: time.sleep(2 ** i); continue
            if e.code == 204: return {}
            raise
        except Exception:
            time.sleep(min(2 ** i, 20)); continue   # blip de rede (SSL EOF / timeout)
    raise RuntimeError(f"falhou após {tries} tentativas: {path}")


def esc(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def ts(e): return f"to_timestamp({int(e)})" if e else "NULL"
def jb(o): return "NULL" if o is None else "'" + json.dumps(o, ensure_ascii=False).replace("'", "''") + "'::jsonb"


def upsert(table, cols, rows, pk="id"):
    if not rows: return 0
    pkcols = [c.strip() for c in pk.split(",")]
    idxs = [cols.index(c) for c in pkcols]
    dedup = {}
    for r in rows:
        dedup[tuple(r[i] for i in idxs)] = r          # mantém última ocorrência por PK
    rows = list(dedup.values())
    setc = ",".join(f"{c}=excluded.{c}" for c in cols if c not in pkcols)
    conflict = f"do update set {setc}" if setc else "do nothing"   # tabela só-PK -> do nothing
    n = 0
    for i in range(0, len(rows), 200):
        vals = ",".join("(" + ",".join(r) + ")" for r in rows[i:i + 200])
        sb(f"insert into {table} ({','.join(cols)}) values {vals} on conflict ({pk}) {conflict}")
        n += len(rows[i:i + 200])
    return n


def page_all(path_base, embed_key, handle):
    page, total = 1, 0
    while True:
        sep = "&" if "?" in path_base else "?"
        d = kget(f"{path_base}{sep}limit=250&page={page}")
        items = d.get("_embedded", {}).get(embed_key, [])
        if not items: break
        handle(items); total += len(items)
        if page % 20 == 0: print(f"   ...{embed_key} pág {page} ({total})")
        if len(items) < 250 or "next" not in d.get("_links", {}): break
        page += 1; time.sleep(0.05)
    return total


def main():
    # users
    u = [[esc(x["id"]), esc(x.get("name")), esc(x.get("email")),
          esc((x.get("rights") or {}).get("role_id")), esc((x.get("rights") or {}).get("is_active"))]
         for x in kget("/users?limit=250").get("_embedded", {}).get("users", [])]
    print("users:", upsert("kommo.users", ["id", "name", "email", "role_id", "is_active"], u))

    # pipelines + stages
    d = kget("/leads/pipelines"); pp, ss = [], []
    for p in d.get("_embedded", {}).get("pipelines", []):
        pp.append([esc(p["id"]), esc(p.get("name")), esc(p.get("sort")), esc(p.get("is_main"))])
        for s in p.get("_embedded", {}).get("statuses", []):
            ss.append([esc(s["id"]), esc(p["id"]), esc(s.get("name")), esc(s.get("sort")), esc(s.get("type"))])
    print("pipelines:", upsert("kommo.pipelines", ["id", "name", "sort", "is_main"], pp),
          "| stages:", upsert("kommo.stages", ["id", "pipeline_id", "name", "sort", "type"], ss))

    # custom_fields
    cf = []
    for et in ["leads", "contacts", "companies"]:
        for f in kget(f"/{et}/custom_fields?limit=250").get("_embedded", {}).get("custom_fields", []):
            cf.append([esc(f["id"]), esc(et), esc(f.get("name")), esc(f.get("code")), esc(f.get("type")), jb(f.get("enums"))])
    print("custom_fields:", upsert("kommo.custom_fields", ["id", "entity_type", "name", "code", "type", "enums"], cf))

    # leads (todos) + associações
    L, lc, lk = [], [], []
    LCOLS = ["id", "name", "pipeline_id", "status_id", "responsible_user_id", "price", "custom_fields", "kommo_created_at", "kommo_updated_at"]
    def flush_leads():
        upsert("kommo.leads", LCOLS, L); L.clear()
        upsert("kommo.lead_contacts", ["lead_id", "contact_id", "is_main"], lc, pk="lead_id,contact_id"); lc.clear()
        upsert("kommo.lead_companies", ["lead_id", "company_id"], lk, pk="lead_id,company_id"); lk.clear()
    def h_leads(items):
        for x in items:
            L.append([esc(x["id"]), esc(x.get("name")), esc(x.get("pipeline_id")), esc(x.get("status_id")),
                      esc(x.get("responsible_user_id")), esc(x.get("price")), jb(x.get("custom_fields_values")),
                      ts(x.get("created_at")), ts(x.get("updated_at"))])
            for c in x.get("_embedded", {}).get("contacts", []): lc.append([esc(x["id"]), esc(c["id"]), esc(c.get("is_main"))])
            for co in x.get("_embedded", {}).get("companies", []): lk.append([esc(x["id"]), esc(co["id"])])
        if len(L) >= 2000: flush_leads()
    print("LEADS total:", page_all("/leads?with=contacts,companies", "leads", h_leads)); flush_leads()

    # contacts (todos)
    C = []
    CCOLS = ["id", "name", "first_name", "last_name", "responsible_user_id", "custom_fields", "kommo_created_at", "kommo_updated_at"]
    def h_contacts(items):
        for x in items:
            C.append([esc(x["id"]), esc(x.get("name")), esc(x.get("first_name")), esc(x.get("last_name")),
                      esc(x.get("responsible_user_id")), jb(x.get("custom_fields_values")), ts(x.get("created_at")), ts(x.get("updated_at"))])
        if len(C) >= 2000: upsert("kommo.contacts", CCOLS, C); C.clear()
    print("CONTACTS total:", page_all("/contacts", "contacts", h_contacts)); upsert("kommo.contacts", CCOLS, C)

    # companies (todas)
    K = []
    KCOLS = ["id", "name", "responsible_user_id", "custom_fields", "kommo_created_at", "kommo_updated_at"]
    def h_co(items):
        for x in items:
            K.append([esc(x["id"]), esc(x.get("name")), esc(x.get("responsible_user_id")),
                      jb(x.get("custom_fields_values")), ts(x.get("created_at")), ts(x.get("updated_at"))])
        if len(K) >= 2000: upsert("kommo.companies", KCOLS, K); K.clear()
    print("COMPANIES total:", page_all("/companies", "companies", h_co)); upsert("kommo.companies", KCOLS, K)
    print("FULL BACKFILL OK")


if __name__ == "__main__":
    main()
