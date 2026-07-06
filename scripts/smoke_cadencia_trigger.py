#!/usr/bin/env python3
"""
SMOKE do WIRING de produção — dispara via TRIGGER REAL (não chama a fn manual).
Hard-scope Pranchas ed9f13d8 / kommo_id 22796607. Mutação em public.reunioes -> trg_reuniao_cadencia
-> pg_net -> edge kommo-cadencia -> POST/PATCH no Kommo -> grava mapa. Poll até a edge reconciliar.
"""
import os, json, time, requests
from datetime import datetime, timezone, timedelta
TZ=timezone(timedelta(hours=-3))
RID="ed9f13d8-4b73-407c-b480-1e8c63776ff1"; KID=22796607
SB_TOKEN=os.environ["SB_TOKEN"]; REF="iaompeiokjxbffwehhrx"
SB_URL=f"https://api.supabase.com/v1/projects/{REF}/database/query"
SB_HEAD={"Authorization":f"Bearer {SB_TOKEN}","Content-Type":"application/json"}
KTOK=os.environ["KOMMO_API_TOKEN"]; KSUB=os.environ["KOMMO_SUBDOMAIN"]
KBASE=f"https://{KSUB}.kommo.com/api/v4"; KHEAD={"Authorization":f"Bearer {KTOK}","Content-Type":"application/json"}
def sb(sql):
    for i in range(4):
        r=requests.post(SB_URL,headers=SB_HEAD,json={"query":sql},timeout=60)
        if r.status_code in (200,201): return r.json()
        time.sleep(2**i)
    raise RuntimeError(f"SB {r.status_code} {r.text[:300]}")
def get_map():
    row=sb(f"select cadencia_task_ids as m, cadencia_ancora_dt as a from public.reunioes where id='{RID}'")[0]
    return row["m"] or {}, row["a"]
def guard():
    row=sb(f"select kommo_id from public.reunioes where id='{RID}'")
    if not row or str(row[0]["kommo_id"])!=str(KID): raise SystemExit(f"guard {row}")
def kget(tid):
    r=requests.get(f"{KBASE}/tasks/{tid}",headers=KHEAD,timeout=30)
    return (r.status_code, r.json() if r.status_code==200 else None)
def kcomplete(tid):
    return requests.patch(f"{KBASE}/tasks/{tid}",headers=KHEAD,json={"is_completed":True,"result":{"text":"smoke cleanup"}},timeout=30).status_code
def loc(e): return datetime.fromtimestamp(int(e),TZ).strftime("%Y-%m-%d %H:%M")

def wait_until(pred, secs=60, step=4):
    t=0
    while t<secs:
        m,a=get_map()
        if pred(m,a): return True,m,a
        time.sleep(step); t+=step
    m,a=get_map(); return False,m,a

def net_status():
    # última resposta pg_net p/ /kommo-cadencia
    try:
        rows=sb("select status_code, left(coalesce(content,error_msg,''),200) as body, created from net._http_response order by id desc limit 3")
        return rows
    except Exception as e:
        return [{"err":str(e)}]

def main():
    guard()
    rep={"reuniao_id":RID,"kommo_id":KID,"steps":[]}

    # STEP 1 — MARCADA (dispara trigger): data D+6, realizada=false
    sb(f"update public.reunioes set data_reuniao='2026-07-12 15:00:00-03', realizada=false, show=false where id='{RID}'")
    ok,m,a=wait_until(lambda m,a: len(m)>=6, 70)
    s1={"step":"1_marcada_D+6_via_trigger","trigger_fired_edge_populated":ok,"map":m,"ancora":a,"net":net_status()[:1]}
    # verifica tasks no Kommo
    verif=[]
    EXP={"T3":(3732759,"sdr","2026-07-11 18:00"),"T4":(3732759,"closer","2026-07-12 08:30"),
         "T5":(3732751,"sdr","2026-07-12 14:45"),"T6":(3732751,"sdr","2026-07-12 15:05"),
         "T1":(1,"sdr","2026-07-08 16:00"),"T2":(1,"sdr","2026-07-09 16:00")}
    for slot,tid in m.items():
        code,d=kget(tid)
        row={"slot":slot,"id":tid,"get":code}
        if code==200: row.update({"type":d["task_type_id"],"owner":d["responsible_user_id"],"when":loc(d["complete_till"]),"is_completed":d["is_completed"]})
        verif.append(row)
    s1["tasks"]=verif
    rep["steps"].append(s1)
    ids_after_create=set(m.values())

    # STEP 2 — RESCHEDULE (dispara trigger): data D+10 -> mesmas ids (patch-move), sem crescer
    sb(f"update public.reunioes set data_reuniao='2026-07-16 15:00:00-03' where id='{RID}'")
    ok2,m2,a2=wait_until(lambda m,a: a is not None and a.startswith('2026-07-16'), 70)
    reused = set(m2.values())==ids_after_create and len(m2)==len(ids_after_create)
    s2={"step":"2_reschedule_D+10_via_trigger","trigger_fired":ok2,"ancora":a2,
        "map":m2,"mesmas_ids_reuso":reused,"cresceu":len(m2)>6}
    rep["steps"].append(s2)

    # STEP 3 — RESOLUÇÃO (dispara trigger): realizada=true -> conclui tudo, mapa {}
    sb(f"update public.reunioes set realizada=true, show=true where id='{RID}'")
    ok3,m3,a3=wait_until(lambda m,a: len(m)==0, 70)
    # confirma tasks concluídas no Kommo
    concl=[]
    for tid in ids_after_create:
        code,d=kget(tid); concl.append({"id":tid,"is_completed":(d["is_completed"] if code==200 else None),"get":code})
    all_closed=all(c["is_completed"] for c in concl if c["get"]==200)
    s3={"step":"3_resolucao_via_trigger","trigger_fired_map_vazio":ok3,"map":m3,
        "todas_tasks_concluidas":all_closed,"tasks":concl}
    rep["steps"].append(s3)

    # CLEANUP defensivo — concluir qualquer id ainda aberto (não deletar)
    cleanup={}
    for tid in ids_after_create:
        code,d=kget(tid)
        if code==200 and not d["is_completed"]: cleanup[tid]=kcomplete(tid)
    rep["cleanup"]=cleanup

    rep["smoke_pass"]=bool(s1["trigger_fired_edge_populated"] and reused and (not s2["cresceu"]) and ok3 and all_closed)
    os.makedirs("reports",exist_ok=True)
    json.dump(rep,open("reports/smoke_cadencia_trigger.json","w"),indent=2,default=str)
    print("SMOKE_PASS:",rep["smoke_pass"])
    print("  1 marcada  -> edge populou mapa:", s1["trigger_fired_edge_populated"], "| slots:", sorted(m.keys()))
    print("  2 reschedule-> reuso mesmas ids:", reused, "| cresceu:", s2["cresceu"])
    print("  3 resolucao -> mapa {}:", ok3, "| todas concluidas:", all_closed)
    print("  T4 check:", next((r for r in verif if r["slot"]=="T4"), None))
if __name__=="__main__": main()
