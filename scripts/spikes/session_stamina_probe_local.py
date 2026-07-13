#!/usr/bin/env python3
# session_stamina_probe_local.py — MEDE por que a sessao do Kommo degrada tao rapido no
# backfill. NAO grava banco, NAO altera o worker de producao. Reusa storage_state.json (SEM
# login). Espelha o padrao de carga do worker (goto /leads/detail + scroll v9) e instrumenta:
#   - por lead: tempo decorrido, #requests ao backend de CHAT, status HTTP (429/403/401),
#               se o chat HIDRATOU (anchors>0) ou virou SKELETON (0), canary /ajax/v4/inbox/list;
#   - quando cai: prova se o NUCLEO (API v4) continua vivo enquanto o CHAT morre.
#
# Responde as 4 perguntas do diagnostico:
#   Q1 anti-bot/pacing  -> rode --scroll full vs --scroll light e --pace 5 vs 30
#   Q2 IP datacenter    -> rode o MESMO script local e no Actions, compare "morreu no lead N"
#   Q3 tempo vs uso     -> rode --timed-gap 120 (espaca leads no tempo SEM carga extra)
#   Q4 o que morre      -> ao cair, imprime se core (talks) vive e se o canary vira 429/403
#
# USO local (PowerShell, mesma pasta do storage_state.json FRESCO — recem-relogado):
#   pip install playwright ; python -m playwright install chromium
#   python session_stamina_probe_local.py --leads 15 --pace 5  --scroll full     # Actions-rapido-like
#   python session_stamina_probe_local.py --leads 15 --pace 30 --scroll full     # devagar
#   python session_stamina_probe_local.py --leads 15 --pace 5  --scroll light    # pouca carga/lead
#   python session_stamina_probe_local.py --leads 8  --timed-gap 120             # tempo vs uso
# No Actions: xvfb-run -a python scripts/spikes/session_stamina_probe_local.py --leads 15 ...
#   (WORKER_HEADLESS=1 forca headless; default headed, igual ao worker.)
# Saida: stamina_out/stamina.csv (uma linha por lead) + veredito no stdout. Sem PII de msg.
import sys, os, re, json, time, argparse, pathlib
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

KB = "https://financeirorustonengenhariacombr.kommo.com"
SHARED_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
HEADLESS = os.environ.get("WORKER_HEADLESS", "0") == "1"
OUT = pathlib.Path("stamina_out"); OUT.mkdir(exist_ok=True)

if not pathlib.Path("storage_state.json").exists():
    sys.exit("storage_state.json nao encontrado nesta pasta (reloga e regenera antes).")
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Falta playwright: pip install playwright && python -m playwright install chromium")

def log(*a): print(*a, flush=True)

# hosts/paths do subsistema de CHAT (amojo/kommochat/rtm) vs nucleo (api/v4).
CHAT_RE = re.compile(r"amojo|kommochat|/rtm|/chat|/inbox|message|history|talk", re.I)
CORE_RE = re.compile(r"/api/v4/", re.I)

# conta anchors reais de mensagem e detecta skeleton (chat carregando/travado).
JS_STATE = r"""
() => {
  const anchors = document.querySelectorAll('.feed-note__message_paragraph, .feed-note__joined-attach').length;
  const skel = document.querySelectorAll('[class*="skeleton"], .feed-loading, [class*="feed-loading"]').length;
  const scr = [...document.querySelectorAll('*')].filter(e=>{
     const s=getComputedStyle(e); return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight>e.clientHeight+100;
  });
  let feed=null, mx=-1; for (const e of scr){ if (e.scrollHeight>mx){ mx=e.scrollHeight; feed=e; } }
  const top = feed ? feed.scrollTop : 0;
  scr.forEach(e=>{ e.scrollTop = 0; });
  return { anchors, skel, sh: mx<0?0:mx, top };
}
"""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leads", type=int, default=15, help="quantos leads abrir no maximo")
    ap.add_argument("--pace", type=float, default=5.0, help="segundos de respiro ENTRE leads")
    ap.add_argument("--scroll", choices=["full", "light"], default="full",
                    help="full = igual ao worker (sobe ate estabilizar); light = 3 scrolls so")
    ap.add_argument("--timed-gap", type=float, default=0.0,
                    help="se >0, espaca leads nesse tempo (sobrescreve --pace) p/ isolar tempo vs uso")
    ap.add_argument("--confirm", type=int, default=2, help="quantos leads a mais apos 1o skeleton, p/ confirmar")
    args = ap.parse_args()
    gap = args.timed_gap if args.timed_gap > 0 else args.pace

    # instrumentacao de rede (por lead)
    ctr = {"chat": 0, "core": 0, "http429": 0, "http403": 0, "http401": 0}
    ws_events = []
    cur = {"idx": 0}

    def reset_ctr():
        for k in ctr: ctr[k] = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context(storage_state="storage_state.json", user_agent=SHARED_UA,
                                  viewport={"width": 1500, "height": 950})
        page = ctx.new_page()

        def on_resp(r):
            try:
                u = r.url
                if "kommo.com" not in u and "amocrm" not in u and "amojo" not in u: return
                if CHAT_RE.search(u): ctr["chat"] += 1
                elif CORE_RE.search(u): ctr["core"] += 1
                s = r.status
                if s == 429: ctr["http429"] += 1
                elif s == 403: ctr["http403"] += 1
                elif s == 401: ctr["http401"] += 1
            except Exception: pass
        page.on("response", on_resp)
        page.on("websocket", lambda ws: ws_events.append(("open", cur["idx"], ws.url.split("?")[0])))

        # canary leve do backend de chat: status do inbox/list (mesmo endpoint do teste cross-IP)
        def canary():
            try:
                rr = page.request.get(KB + "/ajax/v4/inbox/list", timeout=20000)
                return rr.status
            except Exception as e:
                return f"err:{str(e)[:40]}"

        # nucleo vivo? talks (API v4) deve responder mesmo com chat morto
        def core_alive():
            try:
                rr = page.request.get(KB + "/api/v4/talks?limit=1", timeout=20000)
                return rr.status
            except Exception as e:
                return f"err:{str(e)[:40]}"

        log(f"== stamina probe == headless={HEADLESS} pace={gap}s scroll={args.scroll} leads={args.leads}")
        t0 = time.time()
        page.goto(KB + "/leads/pipeline/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)

        # enumera leads reais com conversa (mesma fonte do worker)
        targets = []
        try:
            r = page.request.get(KB + "/api/v4/talks?limit=250")
            if r.ok:
                for t in r.json().get("_embedded", {}).get("talks", []) or []:
                    eid = t.get("entity_id")
                    if eid and eid not in targets: targets.append(eid)
        except Exception as e:
            log("  erro talks:", e)
        if not targets:
            sys.exit("nao consegui enumerar leads via /api/v4/talks (sessao invalida?).")
        targets = targets[:max(args.leads, 1)]
        log(f"  {len(targets)} leads alvo (canary inicial inbox/list = {canary()})")

        rows = []
        first_skeleton_idx = None
        extra_after_skeleton = 0
        for i, lid in enumerate(targets, 1):
            cur["idx"] = i
            reset_ctr()
            t_lead = time.time()
            hydrated = False; anchors = 0; skel = 0
            try:
                page.goto(KB + f"/leads/detail/{lid}", wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(6000)
                if args.scroll == "full":
                    prev_a = -1; prev_sh = -1; stable = 0
                    for k in range(60):  # teto menor que o worker (200) — so p/ medir hidratacao
                        st = page.evaluate(JS_STATE)
                        page.mouse.move(1180, 500); page.mouse.wheel(0, -2400)
                        page.wait_for_timeout(1500)
                        a = st.get("anchors", 0); sh = st.get("sh", 0); top = st.get("top", 0)
                        if a == prev_a and sh == prev_sh and top == 0: stable += 1
                        else: stable = 0
                        prev_a = a; prev_sh = sh
                        if stable >= 6 and k >= 10: break
                else:  # light: 3 scrolls suaves
                    for _ in range(3):
                        page.mouse.move(1180, 500); page.mouse.wheel(0, -1600)
                        page.wait_for_timeout(1200)
                st = page.evaluate(JS_STATE)
                anchors = st.get("anchors", 0); skel = st.get("skel", 0)
                hydrated = anchors > 0
            except Exception as e:
                log(f"  [{i}] lead {lid}: EXCECAO {str(e)[:80]}")

            elapsed = round(time.time() - t0, 1)
            row = {"idx": i, "lead_id": lid, "t_elapsed_s": elapsed,
                   "lead_secs": round(time.time() - t_lead, 1),
                   "hydrated": int(hydrated), "anchors": anchors, "skeleton": skel,
                   "chat_reqs": ctr["chat"], "core_reqs": ctr["core"],
                   "http429": ctr["http429"], "http403": ctr["http403"], "http401": ctr["http401"],
                   "canary_inbox": canary()}
            rows.append(row)
            log(f"  [{i}/{len(targets)}] lead {lid} t={elapsed}s hidratou={hydrated} "
                f"anchors={anchors} skel={skel} chatReq={ctr['chat']} "
                f"429={ctr['http429']} 403={ctr['http403']} 401={ctr['http401']} canary={row['canary_inbox']}")

            if not hydrated and first_skeleton_idx is None:
                first_skeleton_idx = i
                log(f"  >> PRIMEIRO SKELETON no lead #{i} (lead {lid}) apos {elapsed}s. "
                    f"NUCLEO vivo? talks={core_alive()}")
            if first_skeleton_idx is not None:
                extra_after_skeleton += 1
                if extra_after_skeleton > args.confirm:
                    log("  >> confirmado skeleton persistente; encerrando.")
                    break
            time.sleep(gap)

        # post-mortem: com a sessao possivelmente degradada, o backend de chat recusa request cru?
        log(f"\n== post-mortem == canary inbox/list={canary()} | core talks={core_alive()}")
        log(f"   WS abertos observados: {len(ws_events)}")
        browser.close()

    # CSV + veredito
    import csv
    with open(OUT / "stamina.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["idx"])
        w.writeheader(); [w.writerow(r) for r in rows]

    hydr = [r for r in rows if r["hydrated"]]
    log("\n================ VEREDITO ================")
    log(f"leads abertos: {len(rows)} | hidrataram (chat OK): {len(hydr)} | "
        f"primeiro skeleton: lead #{first_skeleton_idx if first_skeleton_idx else '—'}")
    if first_skeleton_idx:
        r = rows[first_skeleton_idx - 1]
        log(f"MORREU no lead #{first_skeleton_idx} apos {r['t_elapsed_s']}s de sessao.")
    tot429 = sum(r["http429"] for r in rows); tot403 = sum(r["http403"] for r in rows)
    log(f"HTTP 429 (rate-limit) totais: {tot429} | 403 totais: {tot403} "
        f"| 401 totais: {sum(r['http401'] for r in rows)}")
    log(f"requests de chat por lead: {[r['chat_reqs'] for r in rows]}")
    log("\nComo ler:")
    log("  - 429/403 aparecendo no lead que morre => rate-limit do backend de CHAT (nao bug do extrator).")
    log("  - canary inbox/list vira !=200 exatamente quando o chat cai => confirma quota no subsistema de chat.")
    log("  - core talks=200 no post-mortem => so o CHAT morre; a sessao/nucleo vive (muda a retomada).")
    log("  - compare 'morreu no lead N' entre: Actions vs local (Q2), pace 5 vs 30 (Q1/Q3),")
    log("    scroll full vs light (Q1: carga/lead), timed-gap alto (Q3: tempo vs uso).")
    log(f"\nCSV: {OUT/'stamina.csv'} — me manda esse arquivo + o stdout de cada cenario.")

if __name__ == "__main__":
    main()
