#!/usr/bin/env python3
"""Dedup dos perdidos SEM MOTIVO (PV-Inbound 10897863 + Pré Vendas velho 13655072)
por CONTATO compartilhado. Marca _lead_dupe (append) nos não-sobreviventes.
NÃO move etapa, NÃO mexe em motivo/responsável — só a tag. DRY-RUN por padrão.

Escopo: leads status=143 (perdido) com loss_reason_id vazio nos 2 pipelines.
Cluster = contact_id ligado a >1 lead do conjunto (cross-pipeline).
Sobrevivente por cluster: telefone > atividade(chat+notas) > created_at > id (maior).
Exclusão de sobrevivente global (multi-cluster safe): quem sobrevive em qualquer
cluster nunca é marcado. Aplicado 2026-07-05: 1.140 clusters, 831 sobreviventes,
839 marcados _lead_dupe. Motivo/etapa/responsável confirmados intocados por GET.
"""
import os, sys, requests, time
from collections import defaultdict, Counter

KT=os.environ["KOMMO_API_TOKEN"]; BASE=f"https://{os.environ['KOMMO_SUBDOMAIN']}.kommo.com"; SBT=os.environ["SB_TOKEN"]
H={"Authorization":f"Bearer {KT}","Content-Type":"application/json"}
APPLY="--apply" in sys.argv
PIPES=[10897863,13655072]

def sb(sql):
    r=requests.post("https://api.supabase.com/v1/projects/iaompeiokjxbffwehhrx/database/query",
      headers={"Authorization":f"Bearer {SBT}","Content-Type":"application/json"},json={"query":sql},timeout=180)
    r.raise_for_status(); return r.json()

def collect():
    ids=[]; tags={}
    for pid in PIPES:
        page=1
        while True:
            p={'limit':250,'page':page,'filter[statuses][0][pipeline_id]':pid,
               'filter[statuses][0][status_id]':143,'with':'tags'}
            r=requests.get(f"{BASE}/api/v4/leads",headers=H,params=p,timeout=40)
            if r.status_code==204: break
            items=r.json().get('_embedded',{}).get('leads',[])
            if not items: break
            for l in items:
                if l.get('loss_reason_id'): continue
                ids.append(l['id'])
                tags[l['id']]=[{"id":t["id"]} for t in (l.get('_embedded',{}).get('tags') or [])]
            if len(items)<250: break
            page+=1; time.sleep(0.15)
    return ids, tags

def main():
    ids, tags = collect()
    arr="ARRAY["+",".join(map(str,ids))+"]::bigint[]"
    rows=sb(f"""
    WITH t AS (SELECT id, kommo_created_at FROM kommo.leads WHERE id = ANY({arr})),
    lc AS (SELECT lead_id, array_agg(DISTINCT contact_id) contacts FROM kommo.lead_contacts WHERE lead_id = ANY({arr}) GROUP BY 1),
    ph AS (SELECT DISTINCT lc.lead_id FROM kommo.lead_contacts lc JOIN kommo.contacts c ON c.id=lc.contact_id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.custom_fields,'[]'::jsonb)) f
       CROSS JOIN LATERAL jsonb_array_elements(f->'values') v
       WHERE f->>'field_code'='PHONE' AND length(regexp_replace(v->>'value','\\D','','g'))>=10 AND lc.lead_id = ANY({arr})),
    act AS (SELECT entity_id lead_id, count(*) n FROM kommo.events WHERE entity_type='leads' AND entity_id = ANY({arr})
       AND type IN ('outgoing_chat_message','incoming_chat_message','talk_created','conversation_answered','entity_direct_message') GROUP BY 1),
    nt AS (SELECT entity_id lead_id, count(*) n FROM kommo.notes WHERE entity_type='leads' AND entity_id = ANY({arr}) GROUP BY 1)
    SELECT t.id, extract(epoch from t.kommo_created_at)::bigint created, (ph.lead_id IS NOT NULL) phone,
      COALESCE(act.n,0)+COALESCE(nt.n,0) act, lc.contacts
    FROM t LEFT JOIN lc ON lc.lead_id=t.id LEFT JOIN ph ON ph.lead_id=t.id LEFT JOIN act ON act.lead_id=t.id LEFT JOIN nt ON nt.lead_id=t.id;""")
    lead={r['id']:{'id':r['id'],'created':r['created'] or 0,'phone':bool(r['phone']),
                   'act':r['act'] or 0,'contacts':r['contacts'] or []} for r in rows}
    clusters=defaultdict(set)
    for lid,d in lead.items():
        for c in d['contacts']: clusters[c].add(lid)
    clusters={c:ls for c,ls in clusters.items() if len(ls)>1}
    keyf=lambda lid:(lead[lid]['phone'],lead[lid]['act'],lead[lid]['created'],lead[lid]['id'])
    survivors={max(ls,key=keyf) for ls in clusters.values()}
    in_cl=set().union(*clusters.values()) if clusters else set()
    dupes=sorted(in_cl-survivors)
    print(f"{'APPLY' if APPLY else 'DRY-RUN'} | clusters={len(clusters)} survivors={len(survivors)} dupes={len(dupes)}")
    if not APPLY:
        print("dry-run: nada marcado. --apply para aplicar."); return
    payload=[{"id":int(d),"_embedded":{"tags":tags.get(d,[])+[{"name":"_lead_dupe"}]}} for d in dupes]
    ok=0
    for i in range(0,len(payload),250):
        b=payload[i:i+250]
        for a in range(6):
            r=requests.patch(f"{BASE}/api/v4/leads",headers=H,json=b,timeout=90)
            if r.status_code in (200,202): ok+=len(b); break
            if r.status_code==429: time.sleep(2**a); continue
            print("ERRO",r.status_code,r.text[:150]); break
        time.sleep(0.5)
    print(f"marcados _lead_dupe: {ok}/{len(dupes)}")

if __name__=="__main__":
    main()
