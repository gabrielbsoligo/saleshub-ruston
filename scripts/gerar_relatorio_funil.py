# -*- coding: utf-8 -*-
"""
Relatório do funil comercial Ruston — Jan a Jun/2026 (somente leitura).
Roda SELECTs via Management API e gera .md + .csv em reports/funil_h1_2026/.
"""
import importlib.util, os, csv
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("flib", os.path.join(HERE, "_funil_lib.py"))
flib = importlib.util.module_from_spec(spec); spec.loader.exec_module(flib)
run = flib.run

OUT = os.path.join(HERE, "..", "reports", "funil_h1_2026")
os.makedirs(OUT, exist_ok=True)
MESES = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
MES_LABEL = {'2026-01': 'Jan', '2026-02': 'Fev', '2026-03': 'Mar',
             '2026-04': 'Abr', '2026-05': 'Mai', '2026-06': 'Jun*'}

# canal normalizado (cobre variantes de caixa/acento em reunioes.canal)
CANAL_NORM = """
 case lower(trim(both from coalesce({c},'')))
   when 'recomendação' then 'recomendacao'
   when 'recomendaçao' then 'recomendacao'
   else lower(trim(both from coalesce({c},''))) end"""

def series(rows, key='ym', val='n'):
    d = {r[key]: r[val] for r in rows}
    return [float(d.get(m, 0) or 0) for m in MESES]

def fnum(x):
    if x is None: return 0.0
    return float(x)

def trend(vals, complete_idx):
    """seta de tendência usando só meses completos (exclui jun parcial).
    Ignora meses iniciais com zero (dado ainda não existia) e suaviza extremos."""
    v = [vals[i] for i in complete_idx if vals[i] is not None]
    # remove zeros à esquerda (período sem rastreio do indicador)
    while v and v[0] == 0:
        v.pop(0)
    if len(v) < 2 or v[0] == 0:
        return '→ s/ tend.'
    first, last = v[0], v[-1]
    ch = (last - first) / first
    if ch > 1.5:  return f'↑ forte (×{last/first:.1f})'
    if ch > 0.10: return f'↑ subindo (+{ch*100:.0f}%)'
    if ch < -1.5: return f'↓ forte (×{last/first:.1f})'
    if ch < -0.10: return f'↓ caindo ({ch*100:.0f}%)'
    return '→ estável'

def write_csv(name, header, rows):
    p = os.path.join(OUT, name)
    with open(p, 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, delimiter=';')
        w.writerow(header)
        for r in rows: w.writerow(r)
    return p

md = []
def L(s=''): md.append(s)

# ---------------------------------------------------------------------------
# 1. FUNIL MENSAL (volume por etapa — eventos no mês)
# ---------------------------------------------------------------------------
leads_m = series(run("""
 select to_char(coalesce(data_cadastro, created_at::date),'YYYY-MM') ym, count(*) n
 from leads where coalesce(data_cadastro, created_at::date) >= '2026-01-01'
   and coalesce(data_cadastro, created_at::date) < '2026-07-01' group by 1"""))
mql_m = series(run("""
 select to_char(coalesce(data_cadastro, created_at::date),'YYYY-MM') ym, count(*) n
 from leads where coalesce(data_cadastro, created_at::date) >= '2026-01-01'
   and coalesce(data_cadastro, created_at::date) < '2026-07-01'
   and status not in ('sem_contato','estorno') group by 1"""))
ag_m = series(run("""
 select to_char(data_agendamento,'YYYY-MM') ym, count(*) n from reunioes
 where data_agendamento >= '2026-01-01' and data_agendamento < '2026-07-01' group by 1"""))
real_m = series(run("""
 select to_char(data_reuniao,'YYYY-MM') ym, count(*) n from reunioes
 where data_reuniao >= '2026-01-01' and data_reuniao < '2026-07-01'
   and realizada and show is not false group by 1"""))
prop_m = series(run("""
 select to_char(mudou_em,'YYYY-MM') ym, count(*) n from deal_status_log
 where status_novo='contrato_na_rua' and mudou_em >= '2026-01-01' and mudou_em < '2026-07-01' group by 1"""))
win_m = series(run("""
 select to_char(data_fechamento,'YYYY-MM') ym, count(*) n from deals
 where status='contrato_assinado' and data_fechamento >= '2026-01-01' and data_fechamento < '2026-07-01' group by 1"""))

COMPLETE = [0,1,2,3,4]  # Jan..Mai completos; Jun(5) parcial
def media(vals, idx=COMPLETE):
    v=[vals[i] for i in idx]; return sum(v)/len(v) if v else 0

MEET_WIN = [2,3,4]  # Mar–Mai: janela completa onde reunião já era rastreada
etapas = [
    ("Leads entrados", leads_m, COMPLETE),
    ("MQL (passou de sem_contato)†", mql_m, COMPLETE),
    ("Reunião agendada‡", ag_m, MEET_WIN),
    ("Reunião realizada‡", real_m, MEET_WIN),
    ("Proposta enviada (contrato_na_rua)§", prop_m, MEET_WIN),
    ("Fechamento (ganho)", win_m, COMPLETE),
]
funil_csv_rows = []
for nome, vals, win in etapas:
    funil_csv_rows.append([nome] + [int(v) for v in vals] + [round(media(vals),1), trend(vals, win)])

# ---------------------------------------------------------------------------
# 2. FUNIL POR CANAL (agregado período)
# ---------------------------------------------------------------------------
leads_canal = run("""
 select canal, count(*) n from leads
 where coalesce(data_cadastro, created_at::date) >= '2026-01-01'
   and coalesce(data_cadastro, created_at::date) < '2026-07-01' group by 1""")
ag_canal = run(("""
 select {norm} canal, count(*) n from reunioes
 where data_agendamento >= '2026-01-01' and data_agendamento < '2026-07-01' group by 1"""
 ).format(norm=CANAL_NORM.format(c='canal')))
real_canal = run(("""
 select {norm} canal, count(*) n from reunioes
 where data_reuniao >= '2026-01-01' and data_reuniao < '2026-07-01' and realizada and show is not false group by 1"""
 ).format(norm=CANAL_NORM.format(c='canal')))
win_canal = run("""
 select lower(trim(both from coalesce(origem,''))) canal, count(*) n,
        round(sum(coalesce(valor_ot,0)+coalesce(valor_mrr,0))) receita
 from deals where status='contrato_assinado'
   and data_fechamento >= '2026-01-01' and data_fechamento < '2026-07-01' group by 1""")

def to_d(rows, k='canal', v='n'):
    return {(r[k] or '—'): r[v] for r in rows}
ld, agd, rld = to_d(leads_canal), to_d(ag_canal), to_d(real_canal)
wnd = {(r['canal'] or '—'): r['n'] for r in win_canal}
recd = {(r['canal'] or '—'): r['receita'] for r in win_canal}
canais = ['leadbroker','blackbox','outbound','recovery','recomendacao','indicacao']
canal_rows = []
for c in canais:
    leads_n = ld.get(c,0); ag_n = agd.get(c,0); rl_n = rld.get(c,0); wn = wnd.get(c,0); rec = recd.get(c,0) or 0
    cv_lead_ag = f"{ag_n/leads_n*100:.0f}%" if leads_n else "—"
    cv_ag_real = f"{rl_n/ag_n*100:.0f}%" if ag_n else "—"
    cv_lead_win = f"{wn/leads_n*100:.1f}%" if leads_n else "—"
    canal_rows.append([c, leads_n, ag_n, rl_n, wn, int(rec), cv_lead_ag, cv_ag_real, cv_lead_win])

# ---------------------------------------------------------------------------
# 3. TICKET / ACV (won deals por mês)
# ---------------------------------------------------------------------------
ticket_rows_raw = run("""
 select to_char(data_fechamento,'YYYY-MM') ym, count(*) n,
   round(avg(coalesce(valor_ot,0)+coalesce(valor_mrr,0))) ticket,
   round(avg(coalesce(valor_ot,0))) avg_ot,
   round(avg(coalesce(valor_mrr,0))) avg_mrr,
   round(avg(coalesce(valor_ot,0)+12*coalesce(valor_mrr,0))) acv,
   round(sum(coalesce(valor_ot,0)+coalesce(valor_mrr,0))) receita
 from deals where status='contrato_assinado'
   and data_fechamento >= '2026-01-01' and data_fechamento < '2026-07-01' group by 1 order by 1""")
tk = {r['ym']: r for r in ticket_rows_raw}
wins_s   = [fnum(tk.get(m,{}).get('n')) for m in MESES]
ticket_s = [fnum(tk.get(m,{}).get('ticket')) for m in MESES]
ot_s     = [fnum(tk.get(m,{}).get('avg_ot')) for m in MESES]
mrr_s    = [fnum(tk.get(m,{}).get('avg_mrr')) for m in MESES]
acv_s    = [fnum(tk.get(m,{}).get('acv')) for m in MESES]
rec_s    = [fnum(tk.get(m,{}).get('receita')) for m in MESES]

# ---------------------------------------------------------------------------
# 4. CICLO DE VENDAS
# ---------------------------------------------------------------------------
ciclo_call = run("""
 select to_char(data_fechamento,'YYYY-MM') ym, count(*) n, round(avg(data_fechamento - data_call)) dias
 from deals where status='contrato_assinado'
   and data_fechamento >= '2026-01-01' and data_fechamento < '2026-07-01'
   and data_call is not null and data_fechamento >= data_call group by 1 order by 1""")
cc = {r['ym']: r for r in ciclo_call}
ciclo_call_s = [fnum(cc.get(m,{}).get('dias')) for m in MESES]
ciclo_n_s    = [fnum(cc.get(m,{}).get('n')) for m in MESES]
ciclo_lead = run("""
 select count(*) n, round(avg(d.data_fechamento - l.data_cadastro)) dias
 from deals d join leads l on l.id=d.lead_id
 where d.status='contrato_assinado' and d.data_fechamento >= '2026-01-01' and d.data_fechamento < '2026-07-01'
   and l.data_cadastro is not null and d.data_fechamento >= l.data_cadastro""")[0]

# ---------------------------------------------------------------------------
# 5. PRODUTIVIDADE — CLOSERS (por mês)
# ---------------------------------------------------------------------------
closer_real = run("""
 select tm.name, to_char(r.data_reuniao,'YYYY-MM') ym, count(*) n
 from reunioes r join team_members tm on tm.id=r.closer_id
 where r.data_reuniao >= '2026-01-01' and r.data_reuniao < '2026-07-01'
   and r.realizada and r.show is not false group by 1,2""")
closer_win = run("""
 select tm.name, to_char(d.data_fechamento,'YYYY-MM') ym, count(*) n,
   round(sum(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0))) receita
 from deals d join team_members tm on tm.id=d.closer_id
 where d.status='contrato_assinado' and d.data_fechamento >= '2026-01-01' and d.data_fechamento < '2026-07-01'
 group by 1,2""")

def agg_by_name_month(rows, valkey='n'):
    out = {}
    for r in rows:
        out.setdefault(r['name'], {})[r['ym']] = r[valkey]
    return out
cr = agg_by_name_month(closer_real)
cw = agg_by_name_month(closer_win)
cwrec = agg_by_name_month(closer_win, 'receita')
closer_names = sorted(set(list(cr)+list(cw)), key=lambda n:-sum((cw.get(n) or {}).values()))

closer_csv = []
for n in closer_names:
    reals = [int((cr.get(n) or {}).get(m,0)) for m in MESES]
    wins = [int((cw.get(n) or {}).get(m,0)) for m in MESES]
    recs = [int((cwrec.get(n) or {}).get(m,0) or 0) for m in MESES]
    closer_csv.append({
        'name': n, 'reals': reals, 'wins': wins, 'recs': recs,
        'tot_real': sum(reals), 'tot_win': sum(wins), 'tot_rec': sum(recs),
        'media_real': round(media(reals),1), 'media_win': round(media(wins),1),
    })

# ---------------------------------------------------------------------------
# 6. PRODUTIVIDADE — SDR (pré-vendas, por mês)  role='sdr'
# ---------------------------------------------------------------------------
sdr_ag = run("""
 select tm.name, to_char(r.data_agendamento,'YYYY-MM') ym,
   count(*) ag, count(*) filter (where r.show is false) noshow,
   count(*) filter (where r.realizada and r.show is not false) realizadas
 from reunioes r join team_members tm on tm.id=r.sdr_id
 where tm.role='sdr' and r.data_agendamento >= '2026-01-01' and r.data_agendamento < '2026-07-01'
 group by 1,2""")
sdr_lig = run("""
 select tm.name, to_char(l.started_at,'YYYY-MM') ym,
   count(*) lig, count(*) filter (where l.atendida) atend
 from ligacoes_4com l join team_members tm on tm.id=l.member_id
 where tm.role='sdr' and l.started_at >= '2026-01-01' and l.started_at < '2026-07-01'
 group by 1,2""")
def agg3(rows):
    out={}
    for r in rows:
        out.setdefault(r['name'],{})[r['ym']]=r
    return out
SA=agg3(sdr_ag); SL=agg3(sdr_lig)
sdr_names=sorted(set(list(SA)+list(SL)),
                 key=lambda n:-sum((v.get('ag',0) for v in (SA.get(n) or {}).values())))
sdr_csv=[]
for n in sdr_names:
    ag=[int((SA.get(n) or {}).get(m,{}).get('ag',0)) for m in MESES]
    ns=[int((SA.get(n) or {}).get(m,{}).get('noshow',0)) for m in MESES]
    rl=[int((SA.get(n) or {}).get(m,{}).get('realizadas',0)) for m in MESES]
    lg=[int((SL.get(n) or {}).get(m,{}).get('lig',0)) for m in MESES]
    at=[int((SL.get(n) or {}).get(m,{}).get('atend',0)) for m in MESES]
    tot_ag=sum(ag); tot_rl=sum(rl); tot_ns=sum(ns); tot_lg=sum(lg); tot_at=sum(at)
    show_rate = f"{tot_rl/(tot_rl+tot_ns)*100:.0f}%" if (tot_rl+tot_ns)>0 else "—"
    lig_por_ag = f"{tot_lg/tot_ag:.0f}" if tot_ag>0 else "—"
    sdr_csv.append({'name':n,'ag':ag,'ns':ns,'rl':rl,'lg':lg,'at':at,
                    'tot_ag':tot_ag,'tot_rl':tot_rl,'tot_ns':tot_ns,'tot_lg':tot_lg,'tot_at':tot_at,
                    'show_rate':show_rate,'lig_por_ag':lig_por_ag})

# operação SDR total por mês (descontando no-show = realizadas)
op_ag=[sum(int((SA.get(n) or {}).get(m,{}).get('ag',0)) for n in SA) for m in MESES]
op_rl=[sum(int((SA.get(n) or {}).get(m,{}).get('realizadas',0)) for n in SA) for m in MESES]
op_ns=[sum(int((SA.get(n) or {}).get(m,{}).get('noshow',0)) for n in SA) for m in MESES]
sdrs_ativos=series(run("""
 select to_char(data_agendamento,'YYYY-MM') ym, count(distinct r.sdr_id) n
 from reunioes r join team_members tm on tm.id=r.sdr_id
 where tm.role='sdr' and data_agendamento >= '2026-01-01' and data_agendamento < '2026-07-01' group by 1"""))

# leads trabalhados + conversão lead->reunião (proxy, por mês de entrada)
lead_work = run("""
 select to_char(coalesce(data_cadastro,created_at::date),'YYYY-MM') ym,
   count(*) entrados,
   count(*) filter (where status not in ('sem_contato','estorno')) trabalhados,
   count(*) filter (where status in ('reuniao_marcada','reuniao_realizada','noshow')) com_reuniao
 from leads where coalesce(data_cadastro,created_at::date) >= '2026-01-01'
   and coalesce(data_cadastro,created_at::date) < '2026-07-01' group by 1 order by 1""")
lw={r['ym']:r for r in lead_work}
lw_trab=[fnum(lw.get(m,{}).get('trabalhados')) for m in MESES]
lw_reun=[fnum(lw.get(m,{}).get('com_reuniao')) for m in MESES]

# =====================  MONTA O MARKDOWN  =====================
def row(cells): return "| " + " | ".join(str(c) for c in cells) + " |"
def hdr(cols):
    L(row(cols)); L("|" + "|".join(["---"]*len(cols)) + "|")
mlabels=[MES_LABEL[m] for m in MESES]

L("# Funil comercial Ruston — Jan a Jun/2026")
L()
L("> **Fonte:** banco de produção SalesHub (Supabase `iaompeiokjxbffwehhrx`) + dados sincronizados do Kommo. "
  "Consulta somente-leitura em 2026-06-25. **Jun/2026 é parcial** (até o dia 24–25) — marcado com `*`; "
  "as tendências usam apenas meses completos (Jan–Mai).")
L()
L("## ⚠️ Leia primeiro — o que é dado real e o que é lacuna")
L()
hdr(["Métrica","Situação","Desde quando há dado"])
L(row(["Leads entrados / canal","✅ Real","Histórico completo (Jan/2026+)"]))
L(row(["Reuniões agendadas / realizadas / no-show","✅ Real","**Só a partir de ~25/02/2026** — Jan e Fev quase sem registro de reunião"]))
L(row(["Fechamentos, ticket, ACV, receita","✅ Real","Histórico completo"]))
L(row(["Ciclo de vendas (call→fechamento)","✅ Real","Histórico completo (58/58 deals)"]))
L(row(["Ciclo lead-entrada→fechamento","🟡 Parcial","Só 19 de 58 deals têm lead vinculado (`lead_id`)"]))
L(row(["Ligações por SDR","✅ Real","**Só a partir de 03/04/2026** (telefonia 4com)"]))
L(row(["Proposta enviada (etapa)","🟡 Fraco","Só 37 transições p/ `contrato_na_rua` na história toda — etapa quase não usada; não é confiável como degrau do funil"]))
L(row(["Mensagens / WhatsApp por lead","❌ Lacuna","Não persistido (fetch on-demand do Kommo; `performance_sdr` está vazia)"]))
L(row(["E-mails por lead","❌ Lacuna","Não rastreado em lugar nenhum"]))
L(row(["Tentativas/atividades por lead até agendar","❌ Lacuna","Não há contador de tentativas nem data de último contato; ligação não guarda `lead_id`"]))
L()
L("**MQL** não existe como etapa nativa → proxy = lead que saiu de `sem_contato`. "
  "**SQL = reunião agendada.** Decisões de mapeamento conforme combinado.")
L()

# ---- 1
L("## 1. Funil por etapa — volume mensal (eventos no mês)")
L()
hdr(["Etapa"]+mlabels+["Média/mês†","Tendência"])
for r in funil_csv_rows:
    L(row(r))
L()
L("`†` média sobre meses completos (Jan–Mai). `‡` reunião só rastreada a partir de 25/02 — Jan≈0 e Fev=1 refletem ausência de histórico, não queda real. "
  "`§` etapa pouco usada (ver nota acima).")
L()
L("**Conversões-chave (período, sobre o que é confiável):**")
L()
tot_ag=sum(ag_m); tot_real=sum(real_m); tot_win=sum(win_m)
sr = f"{tot_real/tot_ag*100:.0f}%" if tot_ag else "—"
wr = f"{tot_win/tot_real*100:.0f}%" if tot_real else "—"
hdr(["Conversão","Valor","Leitura"])
L(row(["Reunião realizada / agendada (show rate global)", sr, f"{int(tot_real)} de {int(tot_ag)} reuniões"]))
L(row(["Fechamento / reunião realizada", wr, "eficiência de fechamento do time de closers (deal e reunião não são 1:1)"]))
L(row(["Reunião agendada / lead entrado (Mar–Jun)", f"{sum(ag_m[2:])/sum(leads_m[2:])*100:.0f}%", "janela onde as duas pontas têm dado"]))
L()
L("> Um funil-coorte completo *lead→fechamento* por mês de entrada não é reconstruível com confiança: "
  "só 20 dos 58 deals ganhos no semestre têm lead vinculado. Por isso as conversões acima são por evento, não por coorte.")
L()

# ---- 2
L("## 2. Funil por canal (agregado Jan–Jun)")
L()
hdr(["Canal","Leads","Reun. agend.","Reun. realiz.","Fecham.","Receita (R$)","Agend/Lead","Show rate","Fech/Lead"])
for r in canal_rows:
    rr=r[:]; rr[5]=f"{r[5]:,}".replace(",", "."); L(row(rr))
L()
L("> `Leads` por mês de entrada; `Reuniões` por data do evento (Fev–Jun); `Fechamento/Receita` por `deals.origem`. "
  "Canais de reunião/deal foram normalizados (BlackBox→blackbox, Recomendação→recomendacao).")
L()

# ---- 3
L("## 3. Ticket médio e ACV (vendas fechadas)")
L()
L("Ticket = `valor_ot + valor_mrr` (contrato total, 1 mês de MRR). ACV = `valor_ot + 12×valor_mrr` (anualizado, complementar).")
L()
hdr(["Métrica"]+mlabels+["Média/mês†","Tendência"])
def money_row(label, s, dec=0):
    cells=[label]+[f"{v:,.0f}".replace(",", ".") if v else "—" for v in s]
    cells+=[f"{media(s):,.0f}".replace(",", "."), trend(s,COMPLETE)]
    L(row(cells))
L(row(["Nº vendas"]+[int(v) for v in wins_s]+[round(media(wins_s),1), trend(wins_s,COMPLETE)]))
money_row("Ticket médio (R$)", ticket_s)
money_row("  – média OT (R$)", ot_s)
money_row("  – média MRR (R$)", mrr_s)
money_row("ACV médio (R$)", acv_s)
money_row("Receita do mês (R$)", rec_s)
L()
L(f"**Total do semestre:** {int(sum(wins_s))} vendas · receita (OT+1ºMRR) ≈ "
  f"**R$ {sum(rec_s):,.0f}**".replace(",", ".") + ".")
L()

# ---- 4
L("## 4. Ciclo de vendas")
L()
hdr(["Métrica"]+mlabels+["Média†"])
L(row(["Dias call→fechamento"]+[int(v) if v else "—" for v in ciclo_call_s]+[round(media(ciclo_call_s),1)]))
L(row(["(nº deals na conta)"]+[int(v) for v in ciclo_n_s]+[""]))
L()
L(f"- **Ciclo confiável (data da call → fechamento): ~{round(sum(ciclo_call_s[i]*ciclo_n_s[i] for i in range(6))/sum(ciclo_n_s)) if sum(ciclo_n_s) else '—'} dias** "
  f"(média ponderada, 58/58 deals).")
L(f"- Ciclo entrada-do-lead → fechamento: **~{ciclo_lead['dias']} dias**, mas só **{ciclo_lead['n']} deals** têm o lead vinculado "
  "(amostra pequena e enviesada p/ leads recentes — use com ressalva).")
L()

# ---- 5
L("## 5. Produtividade individual — Closers")
L()
hdr(["Closer","Reun. realizadas (mês)","Vendas (mês)","Receita total (R$)","Σ reuniões","Σ vendas","Média vendas/mês†"])
for c in closer_csv:
    real_str="·".join(str(x) for x in c['reals'][2:])  # Mar..Jun (onde há reunião)
    win_str="·".join(str(x) for x in c['wins'])
    L(row([c['name'], f"Mar–Jun: {real_str}", f"Jan–Jun: {win_str}",
           f"{c['tot_rec']:,}".replace(",", "."), c['tot_real'], c['tot_win'], c['media_win']]))
L()
L("> Reuniões realizadas só Mar–Jun (rastreio começou em 25/02). 'Propostas enviadas' por closer omitidas: "
  "a etapa `contrato_na_rua` é pouco usada (37 no total histórico), não dá série confiável.")
L()

# ---- 6
L("## 6. Produtividade — Pré-vendas (SDR)")
L()
tot_op_ag_calc = sum(op_ag)
lary_ag = next((s['tot_ag'] for s in sdr_csv if s['name']=='Lary'), 0)
lary_pct = lary_ag/tot_op_ag_calc*100 if tot_op_ag_calc else 0
L(f"**Contexto importante:** considerando só quem tem papel de SDR, a operação tinha **1 SDR ativa em Fev, "
  f"2 em Mar e 3–4 a partir de Abr** (SDRs distintos/mês: {'·'.join(str(int(x)) for x in sdrs_ativos)}). "
  f"**Lary** responde por **{lary_pct:.0f}%** ({lary_ag} de {int(tot_op_ag_calc)}) de todos os agendamentos do "
  "semestre — na prática, *ela é* a operação de pré-vendas na maior parte do período; os demais SDRs entraram "
  "entre Abr e Jun (e parte das reuniões foi agendada pelos próprios closers, fora desta seção). "
  "Médias 'por SDR' antes de Abr ≈ a própria Lary.")
L()
L("### 6a. Operação SDR consolidada (por mês)")
hdr(["Métrica"]+mlabels+["Tendência"])
L(row(["Reuniões agendadas"]+[int(v) for v in op_ag]+[trend(op_ag,[2,3,4])]))
L(row(["Reuniões realizadas (líq. no-show)"]+[int(v) for v in op_rl]+[trend(op_rl,[2,3,4])]))
L(row(["No-shows"]+[int(v) for v in op_ns]+[trend(op_ns,[2,3,4])]))
op_sr=[f"{op_rl[i]/(op_rl[i]+op_ns[i])*100:.0f}%" if (op_rl[i]+op_ns[i])>0 else "—" for i in range(6)]
L(row(["Show rate"]+op_sr+[""]))
L(row(["SDRs ativos"]+[int(v) for v in sdrs_ativos]+[""]))
L()
tot_op_rl=sum(op_rl); tot_op_ns=sum(op_ns); tot_op_ag=sum(op_ag)
rl_abr_jun=sum(op_rl[3:6]); sdr_abr_jun_avg=sum(sdrs_ativos[3:6])/3 if sum(sdrs_ativos[3:6]) else 1
L(f"- **Q1. Reuniões/mês por SDR (líq. no-show):** a operação realizou ~**{rl_abr_jun/3:.0f} reuniões/mês** "
  f"(média Abr–Jun, meses com time montado). Com ~{sdr_abr_jun_avg:.0f} SDRs ativos, dá ~**{rl_abr_jun/3/sdr_abr_jun_avg:.0f}/SDR/mês** "
  "— mas a distribuição é muito desigual (Lary concentra a maioria).")
L(f"- **Q2. Show rate global:** **{tot_op_rl/(tot_op_rl+tot_op_ns)*100:.0f}%** "
  f"({int(tot_op_rl)} realizadas de {int(tot_op_rl+tot_op_ns)} com desfecho) → "
  f"no-show ≈ **{tot_op_ns/(tot_op_rl+tot_op_ns)*100:.0f}%**.")
L()
L("### 6b. Por SDR (agregado Jan–Jun)")
hdr(["SDR","Agendadas","Realizadas","No-show","Show rate","Ligações (Abr–Jun)","Lig./agendam."])
for s in sdr_csv:
    L(row([s['name'], s['tot_ag'], s['tot_rl'], s['tot_ns'], s['show_rate'],
           s['tot_lg'] if s['tot_lg'] else "—", s['lig_por_ag']]))
L()
L("### 6c. Q3/Q4 — atividades e conversão (o que dá e o que falta)")
L()
hdr(["Pergunta","Resposta possível com os dados"])
L(row(["Q3. Leads trabalhados/mês",
       f"Proxy (lead saiu de sem_contato), por mês de entrada: {'·'.join(str(int(x)) for x in lw_trab)} "
       "(Jan–Jun). Atribuição por SDR é frágil (muitos leads sem SDR ou em lote)."]))
L(row(["Q3. Ligações/mensagens/e-mails por lead",
       "**Ligações:** só agregado por SDR/mês (Abr–Jun) — a telefonia não guarda `lead_id`, então 'por lead' não é calculável. "
       "**Mensagens e e-mails:** ❌ não há base. Proxy de esforço = coluna 'Lig./agendam.' na tabela 6b."]))
conv_lead_reun = sum(ag_m[2:])/sum(leads_m[2:])*100 if sum(leads_m[2:]) else 0
L(row(["Q4. Conversão lead → reunião agendada",
       f"Métrica confiável (reuniões agendadas ÷ leads entrados, Mar–Jun): **~{conv_lead_reun:.0f}%**. "
       "⚠️ O proxy 'lead trabalhado→reunião' por status dá ~100% e **não é útil**: como quase todo lead 'trabalhado' "
       "no banco é justamente o que virou reunião (status `em_follow` tem só 98 leads), o numerador ≈ denominador. "
       "Por isso a leitura honesta é a conversão lead→reunião acima."]))
L()
L("---")
L("### Notas de método")
L("- **Período:** 2026-01-01 a 2026-06-30; Jun parcial (até dia 24–25).")
L("- **Ticket** = `valor_ot + valor_mrr`; **ACV** = `valor_ot + 12×valor_mrr`.")
L("- **MQL** = lead com `status ∉ {sem_contato, estorno}` (proxy). **SQL** = reunião agendada.")
L("- **Show rate** = realizadas / (realizadas + no-show), só reuniões com desfecho.")
L("- **Tendência** (↑/↓/→): variação do 1º ao último mês completo; limiar ±10%.")
L("- Reuniões rastreadas desde ~25/02/2026; ligações desde 03/04/2026; `performance_sdr` vazia.")
L("- Canais normalizados (caixa/acento). Receita = OT + 1º MRR (não anualizada).")

with open(os.path.join(OUT,"relatorio_funil_jan-jun2026.md"),"w",encoding="utf-8") as f:
    f.write("\n".join(md))

# ===== CSVs =====
write_csv("funil_mensal.csv", ["etapa"]+MESES+["media_mes","tendencia"], funil_csv_rows)
write_csv("funil_por_canal.csv",
          ["canal","leads","reun_agendadas","reun_realizadas","fechamentos","receita","conv_agend_lead","show_rate","conv_fech_lead"],
          canal_rows)
write_csv("ticket_acv.csv", ["metrica"]+MESES+["media_mes"],
          [["n_vendas"]+[int(v) for v in wins_s]+[round(media(wins_s),1)],
           ["ticket_medio"]+[int(v) for v in ticket_s]+[round(media(ticket_s))],
           ["media_ot"]+[int(v) for v in ot_s]+[round(media(ot_s))],
           ["media_mrr"]+[int(v) for v in mrr_s]+[round(media(mrr_s))],
           ["acv_medio"]+[int(v) for v in acv_s]+[round(media(acv_s))],
           ["receita_mes"]+[int(v) for v in rec_s]+[round(media(rec_s))]])
write_csv("ciclo_vendas.csv", ["metrica"]+MESES+["media"],
          [["dias_call_fechamento"]+[int(v) for v in ciclo_call_s]+[round(media(ciclo_call_s),1)],
           ["n_deals"]+[int(v) for v in ciclo_n_s]+[""]])
write_csv("produtividade_closers.csv",
          ["closer"]+[f"reun_{m}" for m in MESES]+[f"vendas_{m}" for m in MESES]+["sigma_reunioes","sigma_vendas","receita_total"],
          [[c['name']]+c['reals']+c['wins']+[c['tot_real'],c['tot_win'],c['tot_rec']] for c in closer_csv])
write_csv("produtividade_sdr.csv",
          ["sdr"]+[f"agend_{m}" for m in MESES]+[f"realiz_{m}" for m in MESES]+[f"noshow_{m}" for m in MESES]
          +["sigma_agend","sigma_realiz","sigma_noshow","show_rate","ligacoes_abr_jun","lig_por_agendamento"],
          [[s['name']]+s['ag']+s['rl']+s['ns']+[s['tot_ag'],s['tot_rl'],s['tot_ns'],s['show_rate'],s['tot_lg'],s['lig_por_ag']] for s in sdr_csv])
write_csv("sdr_prevendas.csv", ["metrica"]+MESES,
          [["operacao_agendadas"]+[int(v) for v in op_ag],
           ["operacao_realizadas_liq_noshow"]+[int(v) for v in op_rl],
           ["operacao_noshows"]+[int(v) for v in op_ns],
           ["sdrs_ativos"]+[int(v) for v in sdrs_ativos],
           ["leads_trabalhados_proxy"]+[int(v) for v in lw_trab],
           ["leads_com_reuniao_proxy"]+[int(v) for v in lw_reun]])

print("OK — arquivos em", os.path.abspath(OUT))
for fn in sorted(os.listdir(OUT)):
    print("  ", fn)
