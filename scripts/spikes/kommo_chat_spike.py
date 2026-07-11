#!/usr/bin/env python3
# =====================================================================
# SPIKE DIAGNÓSTICO (GitHub Actions) — Kommo chat: XHR vs WebSocket
#
# Pergunta GO/NO-GO: o histórico das conversas de WhatsApp vem por um
# ENDPOINT XHR (JSON fetchável) ou só é empurrado por WEBSOCKET?
# Isso decide a arquitetura do scraper (login+requests por talk  vs
# browser/WS vivo).
#
# NÃO grava nada no banco. Só descobre, loga e salva spike_out/capture.json.
# Login: navegador real (Playwright headless). Credenciais só via env
# (secrets KOMMO_WEB_USER / KOMMO_WEB_PASS) — nunca hardcode.
# Tokens/JWT são REDIGIDOS (8 chars + …REDACTED) no log e no artifact.
# =====================================================================
import os, sys, re, json, base64, pathlib
from urllib.parse import urlparse

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Falta playwright: pip install playwright && python -m playwright install chromium")

KB   = "https://financeirorustonengenhariacombr.kommo.com"
USER = os.environ.get("KOMMO_WEB_USER")
PWD  = os.environ.get("KOMMO_WEB_PASS")
if not USER or not PWD:
    sys.exit("Defina KOMMO_WEB_USER e KOMMO_WEB_PASS no ambiente (GitHub secrets).")

LEADS = [int(x) for x in sys.argv[1:] if x.strip().isdigit()] or [24504277, 24156559, 24523405]
OUT = pathlib.Path("spike_out"); OUT.mkdir(exist_ok=True)

# ---------------- redação de segredos ----------------
_JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}")
def redact(s):
    if not isinstance(s, str):
        return s
    s = re.sub(r"(k=)eyJ[^&\s\"']+", r"\1eyJ…REDACTED", s)          # token na URL do WS (?k=eyJ...)
    s = _JWT.sub(lambda m: m.group(0)[:8] + "…REDACTED", s)          # qualquer JWT de 3 partes
    return s

# ---------------- captura ----------------
# XHR só interessa: host *.kommo.com + path com /ajax/ + (inbox|chat|message|talk|history).
# Telemetria (gtm/analytics/amplitude/doubleclick/facebook/sentry) fica fora por construção.
XHR_KW = re.compile(r"inbox|chat|message|talk|history", re.I)
TEXTKEYS = re.compile(r'"(text|message|body|content)"\s*:\s*"', re.I)

def is_target_xhr(url: str) -> bool:
    try:
        p = urlparse(url)
    except Exception:
        return False
    host = (p.hostname or "").lower()
    return host.endswith("kommo.com") and "/ajax/" in p.path and bool(XHR_KW.search(p.path))

xhr_hits = []    # {lead,url,status,has_textkey,body}
ws_frames = []   # {url,dir,kind,text,b64}
ws_urls = []
probe = {}       # resultados dos GET explícitos (inbox/list, talks/messages)

def log(*a): print(*a, flush=True)

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
    ctx = browser.new_context(viewport={"width": 1500, "height": 950},
        user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
    page = ctx.new_page()
    cur = {"lead": "login"}

    # ---- WebSocket: payload cru; base64 se binário ----
    def on_ws(ws):
        ws_urls.append(redact(ws.url))
        log("  WS aberto:", redact(ws.url))
        def rec(direction, payload):
            if len(ws_frames) >= 400:
                return
            if isinstance(payload, (bytes, bytearray)):
                ws_frames.append({"url": redact(ws.url), "dir": direction, "kind": "base64",
                                  "text": None, "b64": base64.b64encode(bytes(payload)).decode()[:8000]})
            else:
                ws_frames.append({"url": redact(ws.url), "dir": direction, "kind": "text",
                                  "text": redact(payload)[:4000], "b64": None})
        ws.on("framereceived", lambda p: rec("recv", p))
        ws.on("framesent",     lambda p: rec("sent", p))
    page.on("websocket", on_ws)

    # ---- XHR JSON de chat ----
    def on_resp(r):
        try:
            if not is_target_xhr(r.url):
                return
            body = ""
            try:
                body = r.text()
            except Exception:
                pass
            xhr_hits.append({"lead": cur["lead"], "url": redact(r.url), "status": r.status,
                             "has_textkey": bool(TEXTKEYS.search(body)), "body": redact(body)[:20000]})
        except Exception:
            pass
    page.on("response", on_resp)

    # ---- LOGIN ----
    log("== login ==")
    page.goto(KB, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3500)
    try:
        page.fill('input[name="username"], input[type="email"]', USER, timeout=10000)
    except Exception as e:
        log("  !! campo usuário:", e)
    try:
        page.fill('#password, input[name="password"]', PWD, timeout=4000)
    except Exception:
        try:
            page.click('button[type="submit"], .auth_form__submit', timeout=4000)
            page.wait_for_timeout(2000)
            page.fill('#password, input[name="password"]', PWD, timeout=8000)
        except Exception as e:
            log("  !! campo senha:", e)
    try:
        page.click('button[type="submit"], .auth_form__submit, #auth_submit', timeout=8000)
    except Exception as e:
        log("  !! submit:", e)
    page.wait_for_timeout(8000)
    try:
        page.screenshot(path=str(OUT / "00_pos_login.png"))
    except Exception:
        pass
    logged = "auth" not in page.url.lower()
    log("  url pós-login:", redact(page.url), "| LOGADO?", logged)

    # ---- (a) /ajax/v4/inbox/list cru ----
    log("\n== (a) GET /ajax/v4/inbox/list ==")
    try:
        r = page.request.get(KB + "/ajax/v4/inbox/list")
        body = r.text()
        probe["inbox_list"] = {"status": r.status, "body": redact(body)[:20000]}
        log("  status:", r.status)
        log("  body:", redact(body)[:800])
    except Exception as e:
        probe["inbox_list"] = {"error": str(e)}
        log("  erro:", e)

    # ---- (d) sessão desbloqueia /api/v4/talks/{id}/messages? (espera 403) ----
    log("\n== (d) /api/v4/talks/{id}/messages (com sessão) ==")
    talks_by_lead = {}
    try:
        r = page.request.get(KB + "/api/v4/talks?limit=250")
        if r.ok:
            for t in (r.json().get("_embedded", {}).get("talks", []) or []):
                talks_by_lead.setdefault(t.get("entity_id"), []).append(t.get("talk_id"))
        log("  GET /api/v4/talks ->", r.status, "| talks mapeados p/ leads-alvo:",
            {l: talks_by_lead.get(l, []) for l in LEADS})
    except Exception as e:
        log("  erro talks:", e)
    probe["talks_messages"] = []
    for lid in LEADS:
        for tid in talks_by_lead.get(lid, [])[:2]:
            try:
                r2 = page.request.get(KB + f"/api/v4/talks/{tid}/messages")
                body = r2.text()
                probe["talks_messages"].append({"lead": lid, "talk_id": tid, "status": r2.status,
                                                 "has_textkey": bool(TEXTKEYS.search(body)),
                                                 "body": redact(body)[:2000]})
                log(f"  lead {lid} talk {tid} -> {r2.status}  has_text={bool(TEXTKEYS.search(body))}")
            except Exception as e:
                log("  erro messages:", e)

    # ---- (b) abrir conversas reais (card do lead) e rolar o feed ----
    for lid in LEADS:
        cur["lead"] = lid
        log(f"\n== (b) lead {lid}: abrir card + rolar feed ==")
        try:
            page.goto(KB + f"/leads/detail/{lid}", wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(6000)
            for _ in range(6):
                page.mouse.wheel(0, -1200)
                page.wait_for_timeout(1200)
            page.screenshot(path=str(OUT / f"lead_{lid}.png"))
        except Exception as e:
            log("  erro:", e)

    browser.close()

# ---------------- dump + veredito ----------------
json.dump({"leads": LEADS, "xhr": xhr_hits, "ws_urls": ws_urls, "ws_frames": ws_frames, "probe": probe},
          open(OUT / "capture.json", "w"), ensure_ascii=False, indent=1)

xhr_text = [h for h in xhr_hits if h["has_textkey"]]
ws_text  = [f for f in ws_frames if f["kind"] == "text" and f["text"] and TEXTKEYS.search(f["text"])]
log("\n================ VEREDITO ================")
log(f"XHR /ajax/*chat capturados: {len(xhr_hits)} | com texto de mensagem: {len(xhr_text)}")
for h in xhr_text[:15]:
    log(f"  [XHR {h['status']}] lead {h['lead']}  {h['url'][:130]}")
log(f"WebSockets: {len(set(ws_urls))} | frames: {len(ws_frames)} | frames-texto c/ msg: {len(ws_text)} | "
    f"frames binários(base64): {sum(1 for f in ws_frames if f['kind']=='base64')}")
for u in sorted(set(ws_urls)):
    log(f"  WS: {u}")
log(">>> XHR com texto (ex.: /ajax/.../history ou /api/v4/talks/<id>/messages 200) ⇒ login+requests FECHA.")
log(">>> Texto só em frames de WebSocket ⇒ precisa browser/WS vivo — arquitetura de backfill muda.")
log(f"\nArtifact: {OUT/'capture.json'} (+ screenshots). Tudo redigido (sem JWT em claro).")
