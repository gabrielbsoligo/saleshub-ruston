#!/usr/bin/env python3
# =====================================================================
# PARTE A (LOCAL, headed) — mina uma sessão do Kommo no SEU IP e prova
# que ela serve pra chamar /ajax/v4/inbox/list via requests (não pelo
# browser). Salva storage_state.json pra reusar no GitHub Actions (Parte B).
#
# Objetivo do experimento: descobrir se a MESMA sessão funciona do IP do
# GitHub Actions (cross-IP) ou é IP-bound. Aqui provamos o lado LOCAL.
#
# USO:
#   pip install playwright requests
#   python -m playwright install chromium
#   KOMMO_WEB_USER='robozinho@robozinho.com' KOMMO_WEB_PASS='...' \
#     python scripts/spikes/session_probe_local.py
#
# Segurança: storage_state.json é credencial VIVA (sessão logada). Nunca
# versione (está no .gitignore). Tokens são redigidos em todo log.
# =====================================================================
import os, sys, re, json, base64, time
import requests

KB = "https://financeirorustonengenhariacombr.kommo.com"
# UA compartilhado — TEM que ser idêntico ao do session_probe_ci.py pro teste
# isolar IP (e não header). Se mudar aqui, mude lá também.
SHARED_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

USER = os.environ.get("KOMMO_WEB_USER")
PWD  = os.environ.get("KOMMO_WEB_PASS")
if not USER or not PWD:
    sys.exit("Defina KOMMO_WEB_USER e KOMMO_WEB_PASS no ambiente.")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Falta playwright: pip install playwright && python -m playwright install chromium")

_JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}")
def redact(s):
    if not isinstance(s, str):
        return s
    s = re.sub(r"(k=)eyJ[^&\s\"']+", r"\1eyJ…REDACTED", s)
    return _JWT.sub(lambda m: m.group(0)[:8] + "…REDACTED", s)

# ---- receita de headers ÚNICA (idêntica na Parte B) ----
def build_headers(cookies):
    jar = "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name"))
    csrf = next((c["value"] for c in cookies if c.get("name") == "csrf_token"), None)
    h = {
        "User-Agent": SHARED_UA,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/plain, */*",
        "Cookie": jar,
    }
    if csrf:
        h["X-CSRF-Token"] = csrf
    return h

def jwt_exp(val):
    try:
        p = val.split(".")[1]; p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p)).get("exp")
    except Exception:
        return None

def log(*a): print(*a, flush=True)

browser_ajax_headers = {}

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=False)
    ctx = browser.new_context(user_agent=SHARED_UA, viewport={"width": 1400, "height": 900})
    page = ctx.new_page()

    def on_req(r):
        if "/ajax/" in r.url and not browser_ajax_headers:
            try: browser_ajax_headers.update(r.headers)
            except Exception: pass
    page.on("request", on_req)

    log("== login (headed) ==")
    page.goto(KB, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(3500)
    # sessão longa: garantir o checkbox 'temporary_auth' (#USER_REMEMBER) DESMARCADO
    try:
        if page.is_checked("#USER_REMEMBER"):
            page.uncheck("#USER_REMEMBER", timeout=3000)
    except Exception:
        pass
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

    cookies = ctx.cookies()
    names = {c["name"] for c in cookies}
    ok_login = ("auth" not in page.url.lower()) and ("session_id" in names)
    log("  url pós-login:", redact(page.url))
    log("  cookies:", sorted(names))
    if not ok_login:
        log("  !! LOGIN FALHOU (sem session_id ou preso no /auth). Abortando.")
        browser.close(); sys.exit(2)
    log("  LOGIN OK")

    # navega pra disparar /ajax/ (captura headers reais do browser p/ diff)
    try:
        page.goto(KB + "/leads/pipeline/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(4000)
    except Exception:
        pass

    ctx.storage_state(path="storage_state.json")
    cookies = ctx.cookies()  # re-lê após navegação
    browser.close()

# ---- janela de validade (exp dos tokens JWT nos cookies) ----
log("\n== validade dos tokens (exp) ==")
now = int(time.time())
for c in cookies:
    exp = jwt_exp(c.get("value", ""))
    if exp:
        rem = (exp - now) / 3600
        log(f"  cookie {c['name']}: exp={time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(exp))}Z "
            f"| faltam {rem:.1f}h  (token {redact(c['value'])[:14]})")

# ---- CONTROLE: /ajax/v4/inbox/list via requests, com a receita de headers ----
log("\n== controle: GET /ajax/v4/inbox/list (requests, mesma receita da CI) ==")
headers = build_headers(cookies)
r = requests.get(KB + "/ajax/v4/inbox/list", headers=headers, timeout=30)
log(f"  LOCAL: {r.status_code}")
log(f"  body[:300]: {redact(r.text[:300])}")
if r.status_code == 200:
    log("  PASS — sessão vale via requests no seu IP. Teste do Actions é VÁLIDO.")
else:
    log("  FAIL — 401/erro aqui = problema de header/sessão (não IP). Ajustar headers antes da CI.")

# diff: o que o browser mandou e a receita não replica (informativo)
if browser_ajax_headers:
    recipe_keys = {k.lower() for k in headers}
    extra = {k: v for k, v in browser_ajax_headers.items()
             if k.lower() not in recipe_keys and k.lower() not in ("cookie", ":authority", ":method", ":path", ":scheme")}
    log("\n  headers que o BROWSER mandou e a receita NÃO replica:",
        {k: redact(str(v))[:40] for k, v in extra.items()} or "(nenhum relevante)")

# ---- base64 pro secret ----
log("\n== gerar o base64 do storage_state (cole no secret KOMMO_STORAGE_STATE_B64) ==")
log("  Linux:  base64 -w0 storage_state.json")
log("  macOS:  base64 -i storage_state.json | tr -d '\\n'")
log("\n(storage_state.json é credencial viva — não versione; regenere quando o exp passar.)")
