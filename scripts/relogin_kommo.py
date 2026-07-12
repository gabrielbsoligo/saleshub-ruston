#!/usr/bin/env python3
# relogin_kommo.py — "BOTAO DE RELOGIN" (roda na maquina Windows do Gabriel).
# Faz o relogin do Kommo virar 1 clique: loga (manual) -> valida que o CHAT carrega
# -> salva storage_state.json -> gera base64 -> atualiza o secret KOMMO_STORAGE_STATE_B64
# no GitHub (encriptado, via API) -> (opcional) re-dispara o backfill. Sem git, sem copia-cola.
#
# ---------------------------------------------------------------------------
# PRE-REQUISITOS (uma vez so, no PowerShell):
#   pip install playwright pynacl requests keyring
#   python -m playwright install chromium
# ---------------------------------------------------------------------------
# O PAT (GitHub fine-grained) fica no WINDOWS CREDENTIAL MANAGER (via keyring):
#   - 1a execucao pede o token uma vez (nao ecoa) e guarda encriptado pelo Windows.
#   - Nunca vai pro repo, nunca pra secret do Actions, nunca pro log. O script nao imprime.
#   Pra trocar o token depois:  python relogin_kommo.py --set-token
# ---------------------------------------------------------------------------
import os, sys, base64, json, time, argparse, getpass, pathlib
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

OWNER = os.environ.get("GH_OWNER", "gabrielbsoligo")
REPO  = os.environ.get("GH_REPO",  "saleshub-ruston")
SECRET_NAME   = "KOMMO_STORAGE_STATE_B64"
WORKFLOW_FILE = "kommo-msg-worker.yml"
WORKFLOW_REF  = "main"
KB = "https://financeirorustonengenhariacombr.kommo.com"
ACTIVE_LEAD = int(os.environ.get("KOMMO_ACTIVE_LEAD", "24523405"))  # lead com conversa (valida chat)
STATE_PATH = pathlib.Path("storage_state.json")
KR_SERVICE, KR_USER = "kommo-relogin", "github_pat"   # entrada no Credential Manager

SHARED_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

def log(*a): print(*a, flush=True)

# ---------------- PAT (Windows Credential Manager via keyring) ----------------
def get_pat(force_set=False):
    import keyring
    if not force_set:
        tok = keyring.get_password(KR_SERVICE, KR_USER)
        if tok:
            return tok
    log("Cole o GitHub PAT (fine-grained, so este repo, Secrets: Read/write). Nao aparece na tela:")
    tok = getpass.getpass("PAT: ").strip()
    if not tok:
        sys.exit("PAT vazio — abortado.")
    keyring.set_password(KR_SERVICE, KR_USER, tok)
    log("PAT guardado no Windows Credential Manager (nao sera pedido de novo).")
    return tok

# ---------------- GitHub API ----------------
def gh(pat, method, path, body=None):
    import requests
    r = requests.request(method, f"https://api.github.com{path}",
        headers={"Authorization": f"Bearer {pat}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28"},
        json=body, timeout=30)
    return r

def encrypt_sealed(public_key_b64, value_str):
    """Sealed box (libsodium crypto_box_seal) exigido pelo GitHub p/ secrets."""
    from nacl.public import PublicKey, SealedBox
    pk = PublicKey(base64.b64decode(public_key_b64))
    enc = SealedBox(pk).encrypt(value_str.encode("utf-8"))
    return base64.b64encode(enc).decode("utf-8")

def update_secret(pat, value_str):
    r = gh(pat, "GET", f"/repos/{OWNER}/{REPO}/actions/secrets/public-key")
    if r.status_code == 403:
        sys.exit("403 ao ler a public-key: o PAT nao tem 'Secrets: Read/write' NESTE repo. "
                 "Recrie o token com o escopo minimo (ver instrucoes).")
    if r.status_code >= 400:
        sys.exit(f"Falha ao obter public-key: {r.status_code} {r.text[:200]}")
    pk = r.json()
    enc = encrypt_sealed(pk["key"], value_str)
    r2 = gh(pat, "PUT", f"/repos/{OWNER}/{REPO}/actions/secrets/{SECRET_NAME}",
            {"encrypted_value": enc, "key_id": pk["key_id"]})
    if r2.status_code not in (201, 204):
        sys.exit(f"Falha ao gravar o secret: {r2.status_code} {r2.text[:200]}")
    log(f"Secret {SECRET_NAME} atualizado no GitHub ({'criado' if r2.status_code==201 else 'atualizado'}).")

def dispatch_backfill(pat, mode="backfill", limit=""):
    inputs = {"mode": mode}
    if limit: inputs["limit"] = str(limit)
    r = gh(pat, "POST", f"/repos/{OWNER}/{REPO}/actions/workflows/{WORKFLOW_FILE}/dispatches",
           {"ref": WORKFLOW_REF, "inputs": inputs})
    if r.status_code == 204:
        log(f"Backfill re-disparado (mode={mode}{', limit='+str(limit) if limit else ''}).")
        return True
    if r.status_code == 403:
        log("  (re-dispatch pulado: PAT sem 'Actions: Read/write'. Clique 'Run workflow' na aba "
            "Actions — o secret ja foi atualizado.)")
        return False
    log(f"  aviso: re-dispatch retornou {r.status_code} {r.text[:150]} — dispare manual na aba Actions.")
    return False

# ---------------- Login + validacao de CHAT ----------------
def login_and_capture():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Falta playwright: pip install playwright && python -m playwright install chromium")
    ANCHORS = ".feed-note__message_paragraph, .feed-note__joined-attach"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False)
        ctx = browser.new_context(user_agent=SHARED_UA, viewport={"width":1500,"height":950})
        page = ctx.new_page()
        log("\n>> Abrindo o Kommo. FACA O LOGIN na janela (usuario/senha + captcha se pedir).")
        page.goto(KB + "/", wait_until="domcontentloaded", timeout=60000)

        # 1) espera autenticar (ate 6 min): /api/v4/account -> 200
        log(">> Aguardando login (ate 6 min)...")
        authed = False
        for _ in range(180):
            try:
                if page.request.get(KB + "/api/v4/account").ok:
                    authed = True; break
            except Exception: pass
            time.sleep(2)
        if not authed:
            browser.close(); sys.exit("Nao detectei login em 6 min — abortado (nada foi enviado).")
        log(">> Login detectado.")

        # 2) valida que o CHAT carrega (nao so o painel) num lead com conversa
        log(f">> Validando o chat no lead {ACTIVE_LEAD} (o painel carrega mas o chat degrada)...")
        page.goto(KB + f"/leads/detail/{ACTIVE_LEAD}", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)
        anchors = 0
        for _ in range(20):  # ~45s: rola pro topo e checa conteudo real
            try:
                page.evaluate("""() => {[...document.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);
                    return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight>e.clientHeight+100;})
                    .forEach(e=>e.scrollTop=0);}""")
                page.mouse.move(1180,500); page.mouse.wheel(0,-2000)
                anchors = page.evaluate(f"() => document.querySelectorAll('{ANCHORS}').length")
            except Exception: pass
            if anchors > 0: break
            page.wait_for_timeout(1500)
        if anchors == 0:
            browser.close()
            sys.exit(f"Chat NAO carregou no lead {ACTIVE_LEAD} (so painel/skeleton). Sessao ja "
                     f"degradada — feche tudo, aguarde e tente de novo. NADA foi enviado.")
        log(f">> Chat OK ({anchors} anchors reais).")

        # 3) salva a sessao fresca
        ctx.storage_state(path=str(STATE_PATH))
        browser.close()
    log(f">> storage_state.json salvo ({STATE_PATH.stat().st_size} bytes).")

def main():
    ap = argparse.ArgumentParser(description="Relogin Kommo -> atualiza secret -> (re-dispara backfill).")
    ap.add_argument("--set-token", action="store_true", help="regrava o PAT no Credential Manager e sai")
    ap.add_argument("--no-dispatch", action="store_true", help="so atualiza o secret (nao re-dispara)")
    ap.add_argument("--mode", default="backfill", help="modo do re-dispatch (backfill|incremental)")
    ap.add_argument("--limit", default="", help="limite de leads no re-dispatch (ex 20)")
    ap.add_argument("--skip-login", action="store_true", help="usa o storage_state.json ja existente")
    args = ap.parse_args()

    pat = get_pat(force_set=args.set_token)
    if args.set_token:
        log("Token gravado. Rode de novo sem --set-token."); return

    if not args.skip_login:
        login_and_capture()
    elif not STATE_PATH.exists():
        sys.exit("--skip-login mas storage_state.json nao existe.")

    b64 = base64.b64encode(STATE_PATH.read_bytes()).decode("utf-8")  # = conteudo do secret
    update_secret(pat, b64)
    if not args.no_dispatch:
        dispatch_backfill(pat, mode=args.mode, limit=args.limit)
    log("\n== PRONTO == sessao renovada e no ar. Acompanhe em GitHub > Actions.")

if __name__ == "__main__":
    main()
