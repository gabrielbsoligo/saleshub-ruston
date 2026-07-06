#!/usr/bin/env python3
"""
Path B (reschedule/resolução SEM delete) — RE-TESTE no Pranchas (22796607).
Reconcile por slot->id via kommo.plan_reconcile (cérebro). Runner faz POST/PATCH direto no Kommo
(PATCH complete_till move; PATCH is_completed conclui). NUNCA DELETE. Guarda dura no lead teste.
"""
import os, json, time, requests
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=-3))
REUNIAO_ID = "ed9f13d8-4b73-407c-b480-1e8c63776ff1"
KOMMO_ID   = 22796607
LEFTOVER   = [3525311,3525313,3525315,3525317,3525319,3525321,
              3525331,3525333,3525335,3525337,3525339,3525341,
              3525343,3525345,3525347,3525349,3525351,3525353,
              3525355,3525357,3525359,3525361]

SB_TOKEN=os.environ["SB_TOKEN"]; SB_REF="iaompeiokjxbffwehhrx"
SB_URL=f"https://api.supabase.com/v1/projects/{SB_REF}/database/query"
SB_HEAD={"Authorization":f"Bearer {SB_TOKEN}","Content-Type":"application/json"}
KTOK=os.environ["KOMMO_API_TOKEN"]; KSUB=os.environ["KOMMO_SUBDOMAIN"]
KBASE=f"https://{KSUB}.kommo.com/api/v4"; KHEAD={"Authorization":f"Bearer {KTOK}","Content-Type":"application/json"}

def sb(sql):
    for i in range(4):
        r=requests.post(SB_URL,headers=SB_HEAD,json={"query":sql},timeout=60)
        if r.status_code in (200,201): return r.json()
        time.sleep(2**i)
    raise RuntimeError(f"SB {r.status_code} {r.text[:300]}")
def lit(s): return "'"+s.replace("'","''")+"'"

def kget(tid):
    r=requests.get(f"{KBASE}/tasks/{tid}",headers=KHEAD,timeout=30)
    return (r.status_code, r.json() if r.status_code==200 else None)
def kpost(touches):
    payload=[{"task_type_id":t["task_type_id"],"text":t["text"],"complete_till":t["complete_till"],
              "responsible_user_id":t["responsible_user_id"],"entity_type":t["entity_type"],"entity_id":t["entity_id"]}
             for t in touches]
    r=requests.post(f"{KBASE}/tasks",headers=KHEAD,json=payload,timeout=60)
    if r.status_code not in (200,201): raise RuntimeError(f"POST {r.status_code} {r.text[:300]}")
    return [t["id"] for t in r.json()["_embedded"]["tasks"]]
def kpatch_move(tid,ct):
    r=requests.patch(f"{KBASE}/tasks/{tid}",headers=KHEAD,json={"complete_till":ct},timeout=30)
    return r.status_code
def kcomplete(tid):
    r=requests.patch(f"{KBASE}/tasks/{tid}",headers=KHEAD,
                     json={"is_completed":True,"result":{"text":"reunião resolvida"}},timeout=30)
    return r.status_code

def guard():
    if REUNIAO_ID!="ed9f13d8-4b73-407c-b480-1e8c63776ff1": raise SystemExit("guard id")
    row=sb(f"select kommo_id from public.reunioes where id={lit(REUNIAO_ID)}")
    if not row or str(row[0]["kommo_id"])!=str(KOMMO_ID): raise SystemExit(f"guard kommo_id {row}")

def plan(): return sb(f"select kommo.plan_reconcile({lit(REUNIAO_ID)}) as p")[0]["p"]
def set_state(dt_lit, realizada, show):
    sb(f"update public.reunioes set data_reuniao={dt_lit}, realizada={realizada}, show={show} where id={lit(REUNIAO_ID)}")
def persist(new_map):
    sb(f"update public.reunioes set cadencia_task_ids='{json.dumps(new_map)}'::jsonb, cadencia_ancora_dt=data_reuniao where id={lit(REUNIAO_ID)}")

def loc(e): return datetime.fromtimestamp(int(e),TZ).strftime("%Y-%m-%d %H:%M")

ALL_CREATED=set()
def execute(p):
    """Executa as ações; devolve (new_map, resumo)."""
    actions=p["actions"]; cur_map=p.get("current_map",{}) or {}
    cur_ids={int(v) for v in cur_map.values()}
    posts=[a for a in actions if a["op"]=="post"]
    new_map={}
    posted_slots=[]; patched=[]; completed=[]; touched_ids=[]
    # patch_move / complete primeiro (reuso), depois posts
    for a in actions:
        if a["op"]=="patch_move":
            code=kpatch_move(a["task_id"],a["complete_till"]); patched.append((a["slot"],a["task_id"],code)); touched_ids.append(int(a["task_id"]))
            new_map[a["slot"]]=int(a["task_id"])
        elif a["op"]=="complete":
            code=kcomplete(a["task_id"]); completed.append((a["slot"],a["task_id"],code)); touched_ids.append(int(a["task_id"]))
    if posts:
        ids=kpost(posts)
        for a,nid in zip(posts,ids):
            new_map[a["slot"]]=nid; posted_slots.append(a["slot"]); ALL_CREATED.add(nid)
    resumo={"posted_slots":sorted(posted_slots),"patched":patched,"completed":completed,
            "touched_ids":touched_ids,"cur_ids":sorted(cur_ids),
            "only_map_touched": all(t in cur_ids for t in touched_ids)}
    return new_map,resumo

def open_count_among_created():
    """conta tarefas de cadência (que NÓS criamos) ainda abertas — prova zero-acúmulo real no lead."""
    n=0; details=[]
    for tid in sorted(ALL_CREATED):
        code,d=kget(tid)
        if code==200 and not d.get("is_completed"): n+=1; details.append(tid)
    return n,details

def run_round(label, dt_lit, realizada, show):
    set_state(dt_lit, realizada, show)
    p=plan()
    new_map,resumo=execute(p)
    persist(new_map)
    open_created,open_ids=open_count_among_created()
    return {"label":label,"mode":p["mode"],"estado":p["estado"],"data_reuniao":dt_lit,
            "open_target":p["open_target"],"open_after_map":len(new_map),
            "new_map":new_map,"open_created_on_lead":open_created,"open_created_ids":open_ids,
            "sdr_kuid":p["sdr_kuid"],"closer_kuid":p["closer_kuid"],
            "actions_ops":[{"slot":a["slot"],"op":a["op"]} for a in p["actions"]],
            **resumo}

def main():
    guard()
    rep={"reuniao_id":REUNIAO_ID,"kommo_id":KOMMO_ID,
         "lead_link":f"https://{KSUB}.kommo.com/leads/detail/{KOMMO_ID}","transicoes":[],"assertions":{}}

    # PRE-CLEAN: concluir (não deletar) leftovers + mapa já resetado pela migration
    pre={}
    for tid in LEFTOVER:
        code,d=kget(tid)
        if code==200 and not d.get("is_completed"): pre[tid]=kcomplete(tid)
        else: pre[tid]="already_done_or_missing"
    sb(f"update public.reunioes set cadencia_task_ids='{{}}'::jsonb, cadencia_ancora_dt=null where id={lit(REUNIAO_ID)}")
    rep["preclean"]=pre

    r1=run_round("R1 marcada D+5","'2026-07-11 15:00:00-03'", "false","false"); rep["transicoes"].append(r1)
    r2=run_round("R2 reschedule D+9","'2026-07-15 15:00:00-03'","false","false"); rep["transicoes"].append(r2)
    r3=run_round("R3 reschedule D+2","'2026-07-08 15:00:00-03'","false","false"); rep["transicoes"].append(r3)
    r4=run_round("R4 realizada","'2026-07-08 15:00:00-03'","true","true");        rep["transicoes"].append(r4)

    # ---- ASSERÇÕES ----
    # (a) zero acúmulo: em toda transição open_created_on_lead == open_target e <=6
    a_rows=[{"round":t["label"],"open_target":t["open_target"],"open_created_on_lead":t["open_created_on_lead"],
             "ok":(t["open_created_on_lead"]==t["open_target"] and t["open_created_on_lead"]<=6)} for t in rep["transicoes"]]
    assert_a={"pass":all(x["ok"] for x in a_rows),"por_round":a_rows}

    # (b) só ids do mapa foram tocados (patch/complete)
    b_rows=[{"round":t["label"],"only_map_touched":t["only_map_touched"],"touched_ids":t["touched_ids"]} for t in rep["transicoes"]]
    # R2: reuso total -> posted_slots vazio
    r2_reuse=(r2["posted_slots"]==[])
    assert_b={"pass":all(x["only_map_touched"] for x in b_rows) and r2_reuse,
              "por_round":b_rows,"R2_reuso_sem_post_novo":r2_reuse,"R2_posted_slots":r2["posted_slots"]}

    # (c) tipos/donos/horários nas ABERTAS após R3
    EXPECT={"T3":(3732759,"sdr","2026-07-07 18:00"),"T4":(3732759,"closer","2026-07-08 08:30"),
            "T5":(3732751,"sdr","2026-07-08 14:45"),"T6":(3732751,"sdr","2026-07-08 15:05")}
    sdr_k=r3["sdr_kuid"]; closer_k=r3["closer_kuid"]; live=[]; ok_c=True
    for slot,tid in r3["new_map"].items():
        code,d=kget(tid); exp_t,owner,exp_time=EXPECT.get(slot,(None,None,None))
        exp_owner=closer_k if owner=="closer" else sdr_k
        row={"slot":slot,"task_id":tid,"get":code}
        if code==200:
            row.update({"type":d["task_type_id"],"owner":d["responsible_user_id"],"when":loc(d["complete_till"]),
                        "exp_type":exp_t,"exp_owner":exp_owner,"exp_when":exp_time})
            row["type_ok"]=d["task_type_id"]==exp_t; row["owner_ok"]=d["responsible_user_id"]==exp_owner
            row["time_ok"]=loc(d["complete_till"])==exp_time
            if not(row["type_ok"] and row["owner_ok"] and row["time_ok"]): ok_c=False
        else: ok_c=False
        live.append(row)
    assert_c={"pass":ok_c,"sdr_kuid":sdr_k,"closer_kuid":closer_k,"live_apos_R3":live}

    # (d) pós-resolução: 0 aberta de cadência
    open_d,ids_d=open_count_among_created()
    assert_d={"pass":(open_d==0 and r4["open_after_map"]==0),"open_created_on_lead":open_d,"open_ids":ids_d,"map_final":r4["new_map"]}

    # skip-past/borda: R3 concluiu T1/T2 (passado)
    r3_completed_slots=sorted({c[0] for c in r3["completed"]})
    assert_skip={"pass":set(["T1","T2"]).issubset(set(r3_completed_slots)),"R3_completed_slots":r3_completed_slots}

    rep["assertions"]={"a_zero_acumulo":assert_a,"b_so_ids_do_mapa":assert_b,
                       "c_tipos_donos_horarios":assert_c,"d_pos_resolucao_zero_aberta":assert_d,
                       "skip_past_borda":assert_skip}
    rep["all_pass"]=all(rep["assertions"][k]["pass"] for k in rep["assertions"])

    os.makedirs("reports",exist_ok=True)
    json.dump(rep,open("reports/cadencia_pathB_pranchas.json","w"),indent=2,default=str)
    print("ALL_PASS:",rep["all_pass"])
    print("assertions:",{k:v["pass"] for k,v in rep["assertions"].items()})
    for t in rep["transicoes"]:
        print(f'  {t["label"]:20} mode={t["mode"]:9} target={t["open_target"]} open_created={t["open_created_on_lead"]} posted={t["posted_slots"]} completed={[c[0] for c in t["completed"]]}')

if __name__=="__main__": main()
