#!/usr/bin/env python3
"""Migração dos leads ATIVOS dos 7 funis SDR antigos -> 3 funis novos (Kommo).

Método: PATCH em LOTE direto na API v4 do Kommo (endpoint bulk /api/v4/leads,
até 250 por request), respeitando rate limit (429 -> backoff). NÃO passa por
public.leads (evita triggers) nem pela réplica — escreve direto no Kommo; a
réplica kommo.leads se atualiza sozinha pelos webhooks.

Guardas:
  - só leads is_deleted=false e status_id NÃO em (142 ganho, 143 perdido);
  - só os 7 pipelines antigos (leads já nos funis novos nunca são tocados);
  - só status_id presente no DE-PARA (unmatched/excluídos são pulados);
  - idempotente: quem já moveu sai do conjunto de origem.

DRY-RUN por padrão. Aplica de verdade só com --apply.
"""
import os, sys, json, time, requests

SB_TOKEN = os.environ["SB_TOKEN"]
KOMMO_TOKEN = os.environ["KOMMO_API_TOKEN"]
KOMMO_BASE = f"https://{os.environ['KOMMO_SUBDOMAIN']}.kommo.com"
APPLY = "--apply" in sys.argv
# --limit N: aplica só os primeiros N (lote-piloto). Sem limite = todos.
LIMIT = next((int(a.split("=")[1]) for a in sys.argv if a.startswith("--limit=")), None)

PV, DISP, NUT = 14062096, 14062116, 14062120
N = {'ENTRADA':108545092,'SPEED':108545096,'F1':108545216,'F2':108545220,'F3':108545224,
     'F4':108545228,'F5':108545232,'F6':108545236,'CONEXAO':108545100,'REUNIAO':108545240,
     'NOSHOW':108545244,'D_BASE':108545252,'D1':108545280,'RESPONDEU':108545256,
     'OPTOUT':108545304,'NUT_BASE':108545312}

# DE-PARA final: old status_id -> (new_pipeline_id, new_status_id)
M = {
  # PV-Inbound (10897863)
  83570647:(PV,N['ENTRADA']),83673167:(PV,N['ENTRADA']),83673175:(PV,N['F1']),
  83673179:(PV,N['F2']),83673183:(PV,N['F3']),83673191:(PV,N['F5']),83673195:(PV,N['F6']),
  83572739:(PV,N['CONEXAO']),83572751:(PV,N['REUNIAO']),83572755:(PV,N['NOSHOW']),
  # PV-Retomada (11336967)
  87020219:(NUT,N['NUT_BASE']),102171448:(NUT,N['NUT_BASE']),
  107946628:(PV,N['F1']),107946632:(PV,N['F2']),107946636:(PV,N['F3']),
  87020227:(PV,N['CONEXAO']),87037879:(PV,N['REUNIAO']),102171452:(PV,N['NOSHOW']),
  # PV-Outbound (13250384)
  102173864:(DISP,N['D_BASE']),102173868:(PV,N['SPEED']),
  102173872:(PV,N['F1']),102174368:(PV,N['F2']),102174372:(PV,N['F3']),
  102174376:(PV,N['F4']),102174380:(PV,N['F5']),102174384:(PV,N['F6']),
  102174388:(PV,N['CONEXAO']),102174392:(PV,N['REUNIAO']),102174560:(PV,N['NOSHOW']),
  # Pré Vendas (13655072) — EM CADÊNCIA -> DISPARO 1
  105378764:(PV,N['ENTRADA']),
  105378828:(DISP,N['D1']),105378832:(DISP,N['D1']),105378836:(DISP,N['D1']),
  105378840:(DISP,N['D1']),105378844:(DISP,N['D1']),105378852:(DISP,N['D1']),105378856:(DISP,N['D1']),
  105378860:(PV,N['CONEXAO']),105378864:(PV,N['REUNIAO']),105378868:(PV,N['NOSHOW']),
  105378872:(NUT,N['NUT_BASE']),
  # OUTBOUND DISPARO (13815136)
  108282324:(NUT,N['NUT_BASE']),107908780:(DISP,N['RESPONDEU']),
  106594544:(DISP,N['RESPONDEU']),106594560:(DISP,N['OPTOUT']),
  106594548:(PV,N['REUNIAO']),          # "Agendado" -> Pre Vendas/REUNIÃO MARCADA
  # OUTBOUND HUNTER (14004600)
  108089864:(DISP,N['RESPONDEU']),108089872:(PV,N['NOSHOW']),
  # Aquecimento (14024288)
  108245500:(DISP,N['D1']),
}
EXCLUDED = {108090728, 108090732}          # Hunter Propostas/Contratos (Closer) — não migra
OLDP = [10897863,11336967,13250384,13655072,14004600,14024288,13815136]

def sb(sql):
    r = requests.post("https://api.supabase.com/v1/projects/iaompeiokjxbffwehhrx/database/query",
        headers={"Authorization":f"Bearer {SB_TOKEN}","Content-Type":"application/json"},
        json={"query":sql}, timeout=120); r.raise_for_status(); return r.json()

def kommo_bulk_patch(batch):
    """PATCH /api/v4/leads com lista [{id,pipeline_id,status_id}]. 429 -> backoff."""
    for attempt in range(6):
        r = requests.patch(f"{KOMMO_BASE}/api/v4/leads",
            headers={"Authorization":f"Bearer {KOMMO_TOKEN}","Content-Type":"application/json"},
            json=batch, timeout=60)
        if r.status_code in (200, 202): return True, r.status_code
        if r.status_code == 429:
            time.sleep(2 ** attempt); continue
        return False, f"{r.status_code}: {r.text[:200]}"
    return False, "429 after retries"

def main():
    rows = sb(f"""SELECT id, pipeline_id, status_id FROM kommo.leads
                  WHERE is_deleted IS NOT TRUE AND status_id NOT IN (142,143)
                    AND pipeline_id IN ({','.join(map(str,OLDP))})""")
    payload, skipped = [], {'unmatched':0,'excluded':0}
    for r in rows:
        sid = r['status_id']
        if sid in EXCLUDED: skipped['excluded'] += 1; continue
        if sid not in M:    skipped['unmatched'] += 1; continue
        np, ns = M[sid]
        payload.append({"id": int(r['id']), "pipeline_id": np, "status_id": ns})

    print(f"{'APPLY' if APPLY else 'DRY-RUN'} | elegíveis={len(payload)} | pulados={skipped}")
    if LIMIT is not None:
        payload = payload[:LIMIT]
        print(f"LOTE-PILOTO: limitado aos primeiros {len(payload)}")
    if not APPLY:
        print("dry-run: nada enviado. Rode com --apply para executar.")
        return
    CH = 250; ok = 0; moved_ids = []
    for i in range(0, len(payload), CH):
        batch = payload[i:i+CH]
        good, info = kommo_bulk_patch(batch)
        if good:
            ok += len(batch); moved_ids += [b["id"] for b in batch]
        print(f"  lote {i//CH+1}: {len(batch)} -> {'OK' if good else 'ERRO '+str(info)}")
        time.sleep(0.5)   # folga no rate limit (~2 req/s << limite)
    print(f"TOTAL movido: {ok}/{len(payload)}")
    if moved_ids:
        print("SAMPLE_IDS:", json.dumps(moved_ids[:5]))
        exp = {b["id"]: (b["pipeline_id"], b["status_id"]) for b in payload}
        print("EXPECTED:", json.dumps({str(i): exp[i] for i in moved_ids[:5]}))

if __name__ == "__main__":
    main()
