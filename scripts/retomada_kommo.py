# -*- coding: utf-8 -*-
"""
Lista de retomada (win-back) validada com o Kommo — SOMENTE LEITURA.

Identifica deals que:
  - têm proposta enviada (produto + preço preenchidos no SalesHub),
  - passaram por reunião (reunião realizada ou data_call),
  - não fecharam (status != contrato_assinado),
  - estão inativos há >= INATIVO_DIAS no banco (sem mudança de status nem reunião),
e então VALIDA contra a API de eventos do Kommo, removendo os que tiveram
ação recente (tarefa concluída / WhatsApp / mudança de status).

Credenciais via variáveis de ambiente (NÃO commitar tokens):
  SB_TOKEN          -> token da Supabase Management API (usado por _funil_lib)
  KOMMO_TOKEN       -> token de longa duração da API do Kommo
  KOMMO_SUBDOMAIN   -> subdomínio da conta (ex.: financeirorustonengenhariacombr)

Uso:  SB_TOKEN=... KOMMO_TOKEN=... KOMMO_SUBDOMAIN=... python3 scripts/retomada_kommo.py
"""
import importlib.util, os, json, csv, time
from datetime import datetime, timezone, timedelta
import urllib.request, urllib.parse, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("flib", os.path.join(HERE, "_funil_lib.py"))
flib = importlib.util.module_from_spec(spec); spec.loader.exec_module(flib)
run = flib.run

INATIVO_DIAS = int(os.environ.get("INATIVO_DIAS", "15"))
OUT = os.path.join(HERE, "..", "reports", "retomada_2026-06")
os.makedirs(OUT, exist_ok=True)
STATUS_ABERTO = ('negociacao', 'contrato_na_rua', 'follow_longo', 'dar_feedback')

# tipos de evento do Kommo que contam como AÇÃO humana de closer/SDR
ACAO = {'task_completed', 'task_added', 'task_deadline_changed', 'task_result_added',
        'outgoing_chat_message', 'incoming_chat_message', 'conversation_answered',
        'talk_created', 'common_note_added', 'lead_status_changed', 'outgoing_mail'}
WHATS = {'outgoing_chat_message', 'incoming_chat_message', 'conversation_answered', 'talk_created'}


def kommo_event_index(from_dt):
    """Varre /api/v4/events desde from_dt e indexa por entity_id (lead do Kommo)."""
    token = os.environ["KOMMO_TOKEN"]; sub = os.environ["KOMMO_SUBDOMAIN"]
    base = f"https://{sub}.kommo.com/api/v4"
    def get(path, tries=5):
        for i in range(tries):
            try:
                req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {token}"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    time.sleep(2 ** i); continue
                raise
        raise RuntimeError("Kommo rate limit")
    frm = int(from_dt.timestamp()); idx = {}; page = 1
    while True:
        q = urllib.parse.urlencode({"filter[created_at][from]": frm, "limit": 250, "page": page}, safe="[]")
        d = get("/events?" + q)
        evs = d.get("_embedded", {}).get("events", [])
        if not evs:
            break
        for e in evs:
            if e["type"] not in ACAO:
                continue
            eid = str(e["entity_id"]); ts = e["created_at"]; t = e["type"]
            s = idx.setdefault(eid, {"last_acao": 0, "last_task_done": 0, "last_whats": 0, "last_status": 0})
            s["last_acao"] = max(s["last_acao"], ts)
            if t == "task_completed": s["last_task_done"] = max(s["last_task_done"], ts)
            if t in WHATS: s["last_whats"] = max(s["last_whats"], ts)
            if t == "lead_status_changed": s["last_status"] = max(s["last_status"], ts)
        if "next" not in d.get("_links", {}):
            break
        page += 1; time.sleep(0.12)
    return idx


def norm_kommo_id(k):
    k = (k or "").strip()
    try:
        return str(int(float(k)))   # remove sufixo ".0" gravado como float
    except ValueError:
        return k


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def main():
    cutoff = datetime.now(timezone.utc) - timedelta(days=INATIVO_DIAS)
    print(f"Varrendo eventos do Kommo desde {cutoff.date()} ...")
    idx = kommo_event_index(cutoff)
    print(f"  {len(idx)} leads do Kommo com acao na janela.")

    sql = f"""
    with ult_status as (select deal_id, max(mudou_em) mx from deal_status_log group by 1),
     ult_reu_d as (select deal_id, max(data_reuniao) mx from reunioes where realizada and deal_id is not null group by 1),
     ult_reu_l as (select lead_id, max(data_reuniao) mx from reunioes where realizada and lead_id is not null group by 1)
     select d.empresa, coalesce(l.nome_contato, rc.nome_contato) nome_contato, l.telefone,
       coalesce(l.email, rc.lead_email) email, cl.name closer, sd.name sdr, d.produto,
       (coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) valor_total, d.valor_mrr, d.valor_ot,
       d.status, d.temperatura, d.bant, d.kommo_id,
       greatest(coalesce(us.mx,'1900-01-01'::timestamptz),coalesce(urd.mx,'1900-01-01'::timestamptz),
                coalesce(url.mx,'1900-01-01'::timestamptz),coalesce(d.data_call::timestamptz,'1900-01-01'::timestamptz))::date data_ultima_acao,
       (current_date - greatest(coalesce(us.mx,'1900-01-01'::timestamptz),coalesce(urd.mx,'1900-01-01'::timestamptz),
                coalesce(url.mx,'1900-01-01'::timestamptz),coalesce(d.data_call::timestamptz,'1900-01-01'::timestamptz))::date) dias_parado,
       coalesce(l.kommo_link, d.kommo_link) kommo_link
     from deals d
     left join leads l on l.id=d.lead_id
     left join team_members cl on cl.id=d.closer_id
     left join team_members sd on sd.id=d.sdr_id
     left join ult_status us on us.deal_id=d.id
     left join ult_reu_d urd on urd.deal_id=d.id
     left join ult_reu_l url on url.lead_id=d.lead_id
     left join lateral (select nome_contato, lead_email from reunioes r
        where (r.deal_id=d.id or (d.lead_id is not null and r.lead_id=d.lead_id))
        order by r.data_reuniao desc nulls last limit 1) rc on true
     where d.status in {STATUS_ABERTO!r}
       and d.produto is not null and btrim(d.produto) not in ('','-','nan','NULL')
       and coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0) > 0
    """
    rows = [r for r in run(sql) if int(num(r['dias_parado'])) >= INATIVO_DIAS]
    confirmados, falsos = [], []
    for r in rows:
        k = norm_kommo_id(r['kommo_id'])
        a = idx.get(k) if k else None
        if a:
            r['kommo_ult_acao'] = datetime.fromtimestamp(a['last_acao'], tz=timezone.utc).date().isoformat()
            r['whatsapp'] = 'sim' if a['last_whats'] else ''
            r['tarefa_concluida'] = 'sim' if a['last_task_done'] else ''
            r['mudou_status'] = 'sim' if a['last_status'] else ''
            falsos.append(r)
        else:
            r['kommo_status'] = 'sem_vinculo_kommo' if not k else 'inativo_confirmado'
            confirmados.append(r)
    confirmados.sort(key=lambda r: (-num(r['valor_total']), -int(num(r['dias_parado']))))
    falsos.sort(key=lambda r: -num(r['valor_total']))

    cols = ['empresa', 'nome_contato', 'telefone', 'email', 'closer', 'sdr', 'produto',
            'valor_total', 'valor_mrr', 'valor_ot', 'status', 'temperatura', 'bant',
            'data_ultima_acao', 'dias_parado', 'kommo_status', 'kommo_link']
    fcols = ['empresa', 'closer', 'sdr', 'produto', 'valor_total', 'status', 'dias_parado',
             'kommo_ult_acao', 'whatsapp', 'tarefa_concluida', 'mudou_status', 'kommo_link']

    def wcsv(fn, c, data):
        with open(os.path.join(OUT, fn), 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f, delimiter=';'); w.writerow(c)
            for r in data:
                w.writerow([(r.get(x) if r.get(x) is not None else '') for x in c])

    wcsv("retomada_pipeline_parado_VALIDADO.csv", cols, confirmados)
    wcsv("falsos_inativos_kommo.csv", fcols, falsos)
    print(f"Inativos pelo banco: {len(rows)} | falsos-inativos (Kommo): {len(falsos)} | "
          f"retomada confirmada: {len(confirmados)}")
    print("Arquivos em", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
