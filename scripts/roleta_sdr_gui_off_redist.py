#!/usr/bin/env python3
"""
PASSO 2 (Gui OFF inbound) + PASSO 3 (redistribui os 3 leads frescos do Gui pelos ativos).
Guarda dura: SÓ os 3 kommo_ids abaixo. Idempotente (log só move se ainda for do Gui).
Algoritmo roleta: menor total (base+ciclo), tie -> menor ordem. base_count intacto.
"""
import os, json, time, requests

SB_TOKEN=os.environ["SB_TOKEN"]; REF="iaompeiokjxbffwehhrx"
SB_URL=f"https://api.supabase.com/v1/projects/{REF}/database/query"
SB_HEAD={"Authorization":f"Bearer {SB_TOKEN}","Content-Type":"application/json"}
KTOK=os.environ["KOMMO_API_TOKEN"]; KSUB=os.environ["KOMMO_SUBDOMAIN"]
KBASE=f"https://{KSUB}.kommo.com/api/v4"; KHEAD={"Authorization":f"Bearer {KTOK}","Content-Type":"application/json"}

GUI="599be4d0-6523-4860-a3e9-72d5383362c0"
# roster ativo (id, kommo_user_id, ordem, total_atual) — SEM Gui
ATIVOS={
  "Bianca": {"id":"3eb9606d-12a5-40ae-aa06-0a0ff1f7a494","kuid":15458912,"ordem":1,"total":4},
  "Edric":  {"id":"b2e5ffbc-6644-4d05-88fc-ac9c1d650851","kuid":15444836,"ordem":2,"total":3},
  "Lary":   {"id":"135ccd9e-6d70-4ece-9d39-4b1cd9403ead","kuid":14559996,"ordem":4,"total":3},
}
# GUARDA DURA: só estes 3 (kommo_id -> (lead_id, empresa))
TARGETS={
  24455723: ("451649c1-3aef-4912-adc0-21c7a22d40f6","FrigoFoods"),
  24456685: ("5b0704f2-eede-43bd-b0c9-a50750923049","Surfland Brasil"),
  24462599: ("46c21a5c-0700-46cf-a684-cd3d9799ede8","Sky energia"),
}

def sb(sql):
    for i in range(4):
        r=requests.post(SB_URL,headers=SB_HEAD,json={"query":sql},timeout=60)
        if r.status_code in (200,201): return r.json()
        time.sleep(2**i)
    raise RuntimeError(f"SB {r.status_code} {r.text[:300]}")

def guard_leads():
    ids=",".join(str(k) for k in TARGETS)
    rows=sb(f"select kommo_id, member_id, tipo_atribuicao, lead_id from roleta_assign_log where escopo='inbound' and kommo_id in ({ids})")
    got={r["kommo_id"] for r in rows}
    if got != set(TARGETS): raise SystemExit(f"GUARD: log kommo_ids {got} != {set(TARGETS)}")
    for r in rows:
        if r["member_id"]!=GUI: raise SystemExit(f"GUARD: {r['kommo_id']} não é do Gui (é {r['member_id']}) — abortar")
        if r["lead_id"]!=TARGETS[r["kommo_id"]][0]: raise SystemExit(f"GUARD: lead_id mismatch {r['kommo_id']}")
    print("GUARD OK — os 3 são do Gui, roleta, ciclo atual.")

def plan():
    tot={n:d["total"] for n,d in ATIVOS.items()}
    out=[]
    for k in sorted(TARGETS):   # ordem determinística por kommo_id
        # menor total, tie -> menor ordem
        pick=min(ATIVOS, key=lambda n:(tot[n], ATIVOS[n]["ordem"]))
        out.append((k, TARGETS[k][1], pick)); tot[pick]+=1
    return out, tot

def kpatch_owner(kid, kuid):
    r=requests.patch(f"{KBASE}/leads/{kid}",headers=KHEAD,json={"responsible_user_id":kuid},timeout=30)
    return r.status_code
def kget_owner(kid):
    r=requests.get(f"{KBASE}/leads/{kid}",headers=KHEAD,timeout=30)
    return r.json().get("responsible_user_id") if r.status_code==200 else ("ERR",r.status_code)

def main():
    guard_leads()
    pl, final = plan()
    print("\n=== PLANO (antes de escrever) ===")
    for k,emp,sdr in pl: print(f"  {emp:16} (kommo {k}) -> {sdr} (kuid {ATIVOS[sdr]['kuid']})")
    print("  balanço resultante:", {n:final[n] for n in ATIVOS})

    # PASSO 2: Gui OFF (base_count intacto)
    sb(f"update roleta_sdr set ativo=false, updated_at=now() where member_id='{GUI}' and escopo='inbound'")
    print("\nPASSO 2: Guilherme OFF (inbound). base_count intacto.")

    # PASSO 3: aplicar (idempotente: log só move se ainda for do Gui)
    report={"guard":"ok","plano":[{"kommo_id":k,"empresa":e,"para":s} for k,e,s in pl],
            "balanco_esperado":{n:final[n] for n in ATIVOS},"aplicacao":[]}
    for k,emp,sdr in pl:
        d=ATIVOS[sdr]; lead_id=TARGETS[k][0]
        sb(f"update roleta_assign_log set member_id='{d['id']}' where escopo='inbound' and kommo_id={k} and member_id='{GUI}'")
        sb(f"update leads set sdr_id='{d['id']}', updated_at=now() where id='{lead_id}'")
        code=kpatch_owner(k, d["kuid"]); owner=kget_owner(k)
        ok = owner==d["kuid"]
        report["aplicacao"].append({"kommo_id":k,"empresa":emp,"novo_sdr":sdr,"kuid":d["kuid"],
                                    "patch_status":code,"get_owner":owner,"owner_ok":ok})
        print(f"  {emp:16} -> {sdr}: log+lead atualizados, Kommo PATCH {code}, GET owner {owner} {'OK' if ok else 'FALHOU'}")

    # PASSO 4: verificar
    st=sb("select name, total, ativo from get_roleta_status_sdr('inbound', true) order by ativo desc, total, name")
    report["status_final"]=st
    print("\n=== get_roleta_status_sdr (incluindo inativos) ===")
    for r in st: print(f"  {r['name']:10} total={r['total']} ativo={r['ativo']}")

    report["all_owner_ok"]=all(a["owner_ok"] for a in report["aplicacao"])
    os.makedirs("reports",exist_ok=True)
    json.dump(report,open("reports/roleta_sdr_gui_off_redist.json","w"),indent=2,default=str)
    print("\nALL_OWNER_OK:",report["all_owner_ok"])

if __name__=="__main__": main()
