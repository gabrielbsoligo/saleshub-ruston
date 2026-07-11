#!/usr/bin/env python3
# =====================================================================
# PARTE B (GitHub Actions) — reusa a sessão minada no IP do Gabriel
# (storage_state.json, vindo do secret KOMMO_STORAGE_STATE_B64) e faz
# EXATAMENTE o mesmo GET /ajax/v4/inbox/list, via requests, do IP do
# Actions. Sem browser, sem login, sem gravar nada.
#
# Compara com o resultado LOCAL (Parte A):
#   local 200 + actions 200 -> sessão cross-IP funciona
#   local 200 + actions 401 -> sessão IP-bound
# =====================================================================
import sys, re, json
import requests

KB = "https://financeirorustonengenhariacombr.kommo.com"
# TEM que ser idêntico ao SHARED_UA do session_probe_local.py.
SHARED_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_JWT = re.compile(r"eyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}")
def redact(s):
    if not isinstance(s, str):
        return s
    s = re.sub(r"(k=)eyJ[^&\s\"']+", r"\1eyJ…REDACTED", s)
    return _JWT.sub(lambda m: m.group(0)[:8] + "…REDACTED", s)

# receita de headers IDÊNTICA à Parte A
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

def log(*a): print(*a, flush=True)

try:
    state = json.load(open("storage_state.json"))
except Exception as e:
    sys.exit(f"storage_state.json ausente/inválido: {e}")

cookies = state.get("cookies", [])
if not any(c.get("name") == "session_id" for c in cookies):
    log("  aviso: sem cookie session_id no storage_state — provável sessão inválida/expirada.")

headers = build_headers(cookies)
r = requests.get(KB + "/ajax/v4/inbox/list", headers=headers, timeout=30)
log(f"ACTIONS: {r.status_code}")
log(f"body[:600]: {redact(r.text[:600])}")

if r.status_code == 200:
    log("PASS — sessão do IP do Gabriel funciona do IP do Actions (cross-IP OK).")
    sys.exit(0)
else:
    log("NÃO-200 — se a Parte A deu 200 e isto rodou dentro da janela do exp, a sessão é IP-bound.")
    sys.exit(1)
