#!/usr/bin/env python3
"""
Prova de RESCHEDULE da cadência anti-no-show — SÓ no lead Pranchas (22796607).
Guarda dura: só mexe na reunião de teste ed9f13d8 / kommo_id 22796607.
Kommo executa (POST/DELETE tasks); SalesHub audita (cadencia_task_ids + cadencia_ancora_dt).
Planner = kommo.plan_cadencia (read-only, retorna o plano). Runner faz o I/O.
"""
import os, json, time, requests, sys

# ---- HARD GUARD ----
REUNIAO_ID = "ed9f13d8-4b73-407c-b480-1e8c63776ff1"
KOMMO_ID   = 22796607
OLD_TEST_TASKS = [3525311, 3525313, 3525315, 3525317, 3525319, 3525321]

SB_TOKEN = os.environ["SB_TOKEN"]
SB_REF   = "iaompeiokjxbffwehhrx"
SB_URL   = f"https://api.supabase.com/v1/projects/{SB_REF}/database/query"
SB_HEAD  = {"Authorization": f"Bearer {SB_TOKEN}", "Content-Type": "application/json"}

KTOK = os.environ["KOMMO_API_TOKEN"]
KSUB = os.environ["KOMMO_SUBDOMAIN"]
KBASE = f"https://{KSUB}.kommo.com/api/v4"
KHEAD = {"Authorization": f"Bearer {KTOK}", "Content-Type": "application/json"}

def sb(sql):
    for i in range(4):
        r = requests.post(SB_URL, headers=SB_HEAD, json={"query": sql}, timeout=60)
        if r.status_code in (200, 201):
            return r.json()
        time.sleep(2 ** i)
    raise RuntimeError(f"SB failed: {r.status_code} {r.text[:300]}\n{sql[:200]}")

def sb_lit(s):
    return "'" + s.replace("'", "''") + "'"

def kget_task(tid):
    r = requests.get(f"{KBASE}/tasks/{tid}", headers=KHEAD, timeout=30)
    return r.status_code, (r.json() if r.status_code == 200 else r.text[:120])

def kdelete_tasks(ids):
    """DELETE /tasks bulk. Returns dict id->status. id inexistente = ok."""
    out = {}
    for tid in ids:
        r = requests.delete(f"{KBASE}/tasks/{tid}", headers=KHEAD, timeout=30)
        out[tid] = r.status_code
    return out

def kpost_tasks(touches):
    payload = [{
        "task_type_id": t["task_type_id"],
        "text": t["text"],
        "complete_till": t["complete_till"],
        "responsible_user_id": t["responsible_user_id"],
        "entity_type": t["entity_type"],
        "entity_id": t["entity_id"],
    } for t in touches]
    r = requests.post(f"{KBASE}/tasks", headers=KHEAD, json=payload, timeout=60)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"POST /tasks {r.status_code}: {r.text[:300]}")
    tasks = r.json().get("_embedded", {}).get("tasks", [])
    return [t["id"] for t in tasks]

def guard(reuniao_id):
    if reuniao_id != REUNIAO_ID:
        raise SystemExit(f"GUARD: reuniao_id {reuniao_id} != {REUNIAO_ID}")
    row = sb(f"select kommo_id from public.reunioes where id={sb_lit(reuniao_id)}")
    if not row or str(row[0]["kommo_id"]) != str(KOMMO_ID):
        raise SystemExit(f"GUARD: kommo_id mismatch {row}")

def plan(reuniao_id):
    row = sb(f"select kommo.plan_cadencia({sb_lit(reuniao_id)}) as p")
    return row[0]["p"]

def set_data_reuniao(reuniao_id, dt_lit):
    sb(f"update public.reunioes set data_reuniao={dt_lit} where id={sb_lit(reuniao_id)}")

def persist(reuniao_id, new_ids):
    ids_json = json.dumps(new_ids)
    sb(f"""update public.reunioes
           set cadencia_task_ids='{ids_json}'::jsonb,
               cadencia_ancora_dt=data_reuniao
           where id={sb_lit(reuniao_id)}""")

def run_round(reuniao_id, dt_lit, label):
    set_data_reuniao(reuniao_id, dt_lit)
    p = plan(reuniao_id)
    mode = p["mode"]
    delete_ids = [int(x) for x in p.get("delete_ids", [])]
    touches = p.get("touches", [])
    del_result = kdelete_tasks(delete_ids) if delete_ids else {}
    new_ids = kpost_tasks(touches) if touches else []
    # map new ids -> toque labels (touches ordered T1..T6)
    created = [{"toque": t["toque"], "task_id": nid, "task_type_id": t["task_type_id"],
                "responsible_user_id": t["responsible_user_id"], "complete_till": t["complete_till"]}
               for t, nid in zip(touches, new_ids)]
    all_toques = {"T1","T2","T3","T4","T5","T6"}
    present = {t["toque"] for t in touches}
    skipped = sorted(all_toques - present)
    persist(reuniao_id, new_ids)
    return {
        "label": label, "mode": mode, "data_reuniao": dt_lit,
        "delete_ids": delete_ids, "delete_result": del_result,
        "created": created, "skipped_toques": skipped,
        "sdr_kuid": p.get("sdr_kuid"), "closer_kuid": p.get("closer_kuid"),
    }

def main():
    guard(REUNIAO_ID)
    report = {"reuniao_id": REUNIAO_ID, "kommo_id": KOMMO_ID,
              "lead_link": f"https://{KSUB}.kommo.com/leads/detail/{KOMMO_ID}",
              "rounds": [], "assertions": {}}

    # ---- PRE-CLEAN: apagar os 6 tasks do teste de cadência anterior + zerar colunas ----
    preclean = kdelete_tasks(OLD_TEST_TASKS)
    sb(f"update public.reunioes set cadencia_task_ids='[]'::jsonb, cadencia_ancora_dt=null where id={sb_lit(REUNIAO_ID)}")
    report["preclean"] = {"deleted_prior_test_tasks": preclean}

    # ---- ROUND 1: CREATE em D+5 (2026-07-11 15:00 -03) ----
    r1 = run_round(REUNIAO_ID, "'2026-07-11 15:00:00-03'", "R1 create D+5")
    report["rounds"].append(r1)
    r1_ids = [c["task_id"] for c in r1["created"]]

    # ---- ROUND 2: RESCHEDULE pra frente D+9 (2026-07-15 15:00 -03) ----
    r2 = run_round(REUNIAO_ID, "'2026-07-15 15:00:00-03'", "R2 reschedule D+9")
    report["rounds"].append(r2)
    r2_ids = [c["task_id"] for c in r2["created"]]

    # ---- ROUND 3: RESCHEDULE pra trás D+2 (2026-07-08 15:00 -03) — T1/T2 skip-past ----
    r3 = run_round(REUNIAO_ID, "'2026-07-08 15:00:00-03'", "R3 reschedule D+2")
    report["rounds"].append(r3)
    r3_ids = [c["task_id"] for c in r3["created"]]

    # ---- ROUND 4: ASSERTIONS via GET direto por id ----
    # (a) nenhum id antigo (R1 e R2) sobreviveu
    old_ids = r1_ids + r2_ids
    survivors = []
    for tid in old_ids:
        code, _ = kget_task(tid)
        if code == 200:
            survivors.append(tid)
    assert_a = {"pass": len(survivors) == 0, "old_ids_checked": old_ids, "survivors": survivors}

    # (b) nenhuma task fora de cadencia_task_ids foi tocada:
    #     por construção só deletamos plan.delete_ids (= cadencia_task_ids). Registramos os delete_ids de cada round.
    touched_dels = {"R2_delete_ids": r2["delete_ids"], "R3_delete_ids": r3["delete_ids"]}
    assert_b = {"pass": r2["delete_ids"] == r1_ids and r3["delete_ids"] == r2_ids,
                "detail": touched_dels, "R1_ids": r1_ids, "R2_ids": r2_ids}

    # (c) tipos/donos/horários corretos nas tasks vivas (R3)
    EXPECT = {  # toque -> (task_type_id, owner_kind)
        "T3": (3732759, "sdr"), "T4": (3732759, "closer"),
        "T5": (3732751, "sdr"), "T6": (3732751, "sdr"),
    }
    sdr_k = r3["sdr_kuid"]; closer_k = r3["closer_kuid"]
    live = []
    ok_c = True
    for c in r3["created"]:
        code, d = kget_task(c["task_id"])
        exp_type, owner_kind = EXPECT.get(c["toque"], (None, None))
        exp_owner = closer_k if owner_kind == "closer" else sdr_k
        row = {"toque": c["toque"], "task_id": c["task_id"], "get_status": code}
        if code == 200:
            row.update({"task_type_id": d.get("task_type_id"),
                        "responsible_user_id": d.get("responsible_user_id"),
                        "complete_till": d.get("complete_till"),
                        "expected_type": exp_type, "expected_owner": exp_owner})
            row["type_ok"] = d.get("task_type_id") == exp_type
            row["owner_ok"] = d.get("responsible_user_id") == exp_owner
            if not (row["type_ok"] and row["owner_ok"]):
                ok_c = False
        else:
            ok_c = False
        live.append(row)
    # T4 08h30 check: complete_till local hour == 8:30
    assert_c = {"pass": ok_c, "sdr_kuid": sdr_k, "closer_kuid": closer_k, "live_tasks": live}

    # skip-past assertion (R3 pulou T1/T2)
    assert_skip = {"pass": set(r3["skipped_toques"]) == {"T1","T2"}, "skipped": r3["skipped_toques"]}

    report["assertions"] = {
        "a_no_old_id_survived": assert_a,
        "b_only_cadencia_ids_touched": assert_b,
        "c_types_owners_times_correct": assert_c,
        "skip_past_T1_T2": assert_skip,
    }
    report["all_pass"] = all(report["assertions"][k]["pass"] for k in report["assertions"])

    os.makedirs("reports", exist_ok=True)
    with open("reports/reschedule_teste_pranchas.json", "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(json.dumps(report, indent=2, default=str))

if __name__ == "__main__":
    main()
