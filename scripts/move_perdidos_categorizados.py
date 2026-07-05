#!/usr/bin/env python3
"""Move FINAL dos perdidos categorizados (PV-Inbound 10897863 + Pré Vendas velho
13655072) pros funis novos, por motivo de perda / balde. DRY-RUN por padrão.

Regra de ouro: preserva motivo. Como reativar (sair do status 143) ZERA o
loss_reason no Kommo, os qualificados que serão reativados recebem ANTES uma
tag motivo:* que preserva a informação. Cemitério fica perdido (loss preservado).

Destinos:
  RECOVERY  = 14062116/108545252 (BASE Outbound Disparo), reativa
  NUTRIÇÃO  = 14062120/108545312 (base — type=0; a inbox 108545308 NÃO aceita move via API)
  CEMITÉRIO = 14062096/143 (mantém perdido)
  DUPE      = só tag _lead_dupe (append), não move

Baldes (sem-motivo, sem _lead_dupe): A=origem+tel->recovery; C=sem origem+tel->
seta origem Outbound(823306)+recovery; B=origem sem tel->dupe; D=sem origem sem tel->dupe.
Já-_lead_dupe são pulados. Aplicado 2026-07-05: nutrição 336, recovery 1298
(111 qual + 173 A + 1014 C), cemitério 47, dupe 458 = 2139 (+839 dupes prévios).
Verificado por GET: reativações/etapas corretas, cemitério perdido, tags motivo/dupe
preservadas, origem C setada, loss preservado no cemitério.
"""
import os, sys, requests, time, json
from collections import defaultdict

KT=os.environ["KOMMO_API_TOKEN"]; BASE=f"https://{os.environ['KOMMO_SUBDOMAIN']}.kommo.com"; SBT=os.environ["SB_TOKEN"]
H={"Authorization":f"Bearer {KT}","Content-Type":"application/json"}
APPLY="--apply" in sys.argv
PIPES=[10897863,13655072]
NUTRI={28958387:'nao_interesse',28958395:'fora_icp'}
RECOV={28352655:'tentativas_esgotadas',28352659:'concorrente',28352647:'sem_budget',28352651:'sem_decisor',28958391:'sem_timing'}
CEMI={29138571:'em_contato_outra_v4'}
REC_DEST=(14062116,108545252); NUT_DEST=(14062120,108545312); CEMI_DEST=(14062096,143); OUTBOUND_ENUM=823306

def sb(sql):
    r=requests.post("https://api.supabase.com/v1/projects/iaompeiokjxbffwehhrx/database/query",
      headers={"Authorization":f"Bearer {SBT}","Content-Type":"application/json"},json={"query":sql},timeout=180)
    r.raise_for_status(); return r.json()

def classify():
    leads={}
    for pid in PIPES:
        page=1
        while True:
            p={'limit':250,'page':page,'filter[statuses][0][pipeline_id]':pid,'filter[statuses][0][status_id]':143,'with':'tags'}
            r=requests.get(f"{BASE}/api/v4/leads",headers=H,params=p,timeout=40)
            if r.status_code==204: break
            items=r.json().get('_embedded',{}).get('leads',[])
            if not items: break
            for l in items:
                leads[l['id']]={'loss':l.get('loss_reason_id'),
                    'tagnames':[t.get('name') for t in (l.get('_embedded',{}).get('tags') or [])],
                    'tagids':[{"id":t["id"]} for t in (l.get('_embedded',{}).get('tags') or [])]}
            if len(items)<250: break
            page+=1; time.sleep(0.15)
    arr="ARRAY["+",".join(map(str,leads))+"]::bigint[]"
    for r in sb(f"""
      WITH t AS (SELECT id, custom_fields FROM kommo.leads WHERE id=ANY({arr})),
      o AS (SELECT id,(SELECT f->'values'->0->>'enum_id' FROM jsonb_array_elements(COALESCE(custom_fields,'[]'::jsonb)) f WHERE f->>'field_id'='975168') eid FROM t),
      ph AS (SELECT DISTINCT lc.lead_id FROM kommo.lead_contacts lc JOIN kommo.contacts c ON c.id=lc.contact_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.custom_fields,'[]'::jsonb)) f CROSS JOIN LATERAL jsonb_array_elements(f->'values') v
        WHERE f->>'field_code'='PHONE' AND length(regexp_replace(v->>'value','\\D','','g'))>=10 AND lc.lead_id=ANY({arr}))
      SELECT t.id, o.eid, (ph.lead_id IS NOT NULL) tel FROM t LEFT JOIN o ON o.id=t.id LEFT JOIN ph ON ph.lead_id=t.id;"""):
        if r['id'] in leads: leads[r['id']].update(eid=r['eid'], tel=bool(r['tel']))
    P=defaultdict(list); motivo={}
    for lid,d in leads.items():
        if '_lead_dupe' in d['tagnames']: continue
        loss=d['loss']
        if loss in NUTRI: P['nutricao'].append(lid); motivo[lid]=f"motivo:{NUTRI[loss]}"
        elif loss in RECOV: P['recovery_q'].append(lid); motivo[lid]=f"motivo:{RECOV[loss]}"
        elif loss in CEMI: P['cemiterio'].append(lid)
        elif loss is None:
            so=not d.get('eid'); tel=d.get('tel')
            P['baldeA' if (not so and tel) else 'baldeC' if (so and tel) else 'baldeB' if (not so and not tel) else 'baldeD'].append(lid)
    return leads,P,motivo

def bulk(payload,label):
    ok=0
    for i in range(0,len(payload),250):
        b=payload[i:i+250]; done=False
        for a in range(6):
            r=requests.patch(f"{BASE}/api/v4/leads",headers=H,json=b,timeout=90)
            if r.status_code in (200,202): ok+=len(b); done=True; break
            if r.status_code==429: time.sleep(2**a); continue
            print(f"  [{label}] ERRO {r.status_code}: {r.text[:180]}"); return ok,False
        if not done: return ok,False
        time.sleep(0.4)
    print(f"  [{label}] {ok}/{len(payload)} OK"); return ok,True

def main():
    leads,P,motivo=classify()
    ti={lid:leads[lid]['tagids'] for lid in leads}
    rec=len(P['recovery_q'])+len(P['baldeA'])+len(P['baldeC'])
    print(f"{'APPLY' if APPLY else 'DRY-RUN'} | nutrição {len(P['nutricao'])} | recovery {rec} "
          f"(q{len(P['recovery_q'])}+A{len(P['baldeA'])}+C{len(P['baldeC'])}) | cemitério {len(P['cemiterio'])} "
          f"| dupe {len(P['baldeB'])+len(P['baldeD'])}")
    if not APPLY:
        print("dry-run: nada escrito. --apply para aplicar."); return
    # 1) tag motivo (antes de reativar) nos qualificados
    qual=P['nutricao']+P['recovery_q']
    if not bulk([{"id":int(d),"_embedded":{"tags":ti[d]+[{"name":motivo[d]}]}} for d in qual],"TAG motivo")[1]: return
    # 2..6 moves
    for label,pl in [
      ("MOVE nutrição",[{"id":int(d),"pipeline_id":NUT_DEST[0],"status_id":NUT_DEST[1]} for d in P['nutricao']]),
      ("MOVE recovery_q",[{"id":int(d),"pipeline_id":REC_DEST[0],"status_id":REC_DEST[1]} for d in P['recovery_q']]),
      ("MOVE balde C+origem",[{"id":int(d),"pipeline_id":REC_DEST[0],"status_id":REC_DEST[1],"custom_fields_values":[{"field_id":975168,"values":[{"enum_id":OUTBOUND_ENUM}]}]} for d in P['baldeC']]),
      ("MOVE balde A",[{"id":int(d),"pipeline_id":REC_DEST[0],"status_id":REC_DEST[1]} for d in P['baldeA']]),
      ("MOVE cemitério",[{"id":int(d),"pipeline_id":CEMI_DEST[0],"status_id":CEMI_DEST[1]} for d in P['cemiterio']]),
      ("TAG _lead_dupe",[{"id":int(d),"_embedded":{"tags":ti[d]+[{"name":"_lead_dupe"}]}} for d in P['baldeB']+P['baldeD']]),
    ]:
        if not bulk(pl,label)[1]: print("PAROU."); return
    print("TODOS OS LOTES OK")

if __name__=="__main__": main()
