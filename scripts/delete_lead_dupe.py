#!/usr/bin/env python3
"""Exclusão dos leads _lead_dupe — com TRAVA DE SEGURANÇA. DRY-RUN por padrão.

⚠️ ACHADO (2026-07-05): a API v4 do Kommo NÃO permite apagar leads —
   DELETE /api/v4/leads  e  DELETE /api/v4/leads/{id}  retornam 405 Method
   Not Allowed nesta conta/token. Exclusão de lead no Kommo é só pela UI
   (filtrar por tag _lead_dupe na interface e deletar em lote) — o filtro de
   tag da UI funciona, ao contrário do filter[tags] da API (furado aqui).
   Este script fica pronto caso surja um método de delete válido.

TRAVA (não remover):
  - Fonte de verdade = LISTA DE IDS DO BACKUP (backup_lead_dupe_YYYY-MM-DD.json).
    Nunca apaga id fora dessa lista (teto absoluto).
  - Antes de apagar, RE-VERIFICA por GET que o lead ainda tem a tag _lead_dupe
    (client-side; NÃO usa filter[tags], que é furado). Sem a tag -> PULA.
  - NÃO usa filtro de tag pra selecionar (só a lista + verificação client-side).
  - Lotes pequenos, para no primeiro erro (não continua cego).
"""
import os, sys, json, time, requests

KT=os.environ["KOMMO_API_TOKEN"]; BASE=f"https://{os.environ['KOMMO_SUBDOMAIN']}.kommo.com"
H={"Authorization":f"Bearer {KT}"}; HJ={**H,"Content-Type":"application/json"}
APPLY="--apply" in sys.argv
BACKUP=os.environ.get("DUPE_BACKUP","/mnt/user-data/outputs/backup_lead_dupe_2026-07-05.json")

def has_tag(lid):
    d=requests.get(f"{BASE}/api/v4/leads/{lid}?with=tags",headers=H,timeout=30)
    if d.status_code!=200: return None  # sumiu / erro
    return '_lead_dupe' in [t['name'] for t in (d.json().get('_embedded',{}).get('tags') or [])]

def delete_batch(ids):
    # método a confirmar: hoje ambos 405. Mantido p/ quando houver delete válido.
    r=requests.delete(f"{BASE}/api/v4/leads",headers=HJ,json=[{"id":int(i)} for i in ids],timeout=60)
    return r.status_code, r.text[:200]

def main():
    bk=json.load(open(BACKUP))
    backup_ids=set(l['id'] for l in bk['leads'])
    print(f"backup ids: {len(backup_ids)}")
    ids=sorted(backup_ids)
    if not APPLY:
        print("DRY-RUN: nada apagado. (Lembrete: API delete = 405; use a UI ou --apply se houver método.)")
        return
    apagados=0; pulados=0; B=50
    for i in range(0,len(ids),B):
        batch=ids[i:i+B]
        verif=[x for x in batch if has_tag(x) is True]     # só os que AINDA têm a tag
        pulados+=len(batch)-len(verif)
        assert set(verif)<=backup_ids, "VIOLAÇÃO: id fora do backup"
        if not verif: continue
        code,txt=delete_batch(verif)
        if code not in (200,202,204):
            print(f"  lote {i//B+1}: ERRO {code} {txt} — PARANDO"); return
        apagados+=len(verif)
        print(f"  lote {i//B+1}: apagados {len(verif)} (acum {apagados})")
        time.sleep(0.5)
    print(f"TOTAL apagado: {apagados} | pulados (sem tag): {pulados}")

if __name__=="__main__": main()
