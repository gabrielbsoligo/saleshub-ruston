#!/usr/bin/env python3
# kommo_msg_worker_local.py — WORKER (etapa 1, LOCAL) que liga o extrator v9 a RPC
# public.kommo_apply_mensagens. Reusa storage_state.json (SEM login). NAO altera o v9
# (JS_SCROLL/JS_EXTRACT abaixo sao byte-identicos ao dom_extract_probe_local.py v9).
#
# LOOP LEAD-A-LEAD ATOMICO: extrai -> grava (RPC) -> a RPC marca o lead -> proximo.
# Grava um lead por vez; se cair no lead 800, os 799 ja estao salvos e marcados.
# Idempotente (a RPC deduplica). Retomavel (a fila pula quem ja tem messages_extracted_at).
#
# DOIS MODOS (muda so a fila):
#   --mode backfill     fila = UNIAO (talks live ∪ events-chat ∪ mensagens) ∩ kommo.leads, pendentes
#                       (messages_extracted_at IS NULL). A prova de ponto cego (>= qualquer fonte sozinha).
#   --mode incremental  fila = leads com chat novo desde a ultima extracao (kommo.events)
#
# GUARDA quando a extracao da 0 mensagens (3 casos distinguidos, NAO mais "para p/ sempre"):
#   1) SESSAO/CHAT morto  -> canary /ajax/v4/inbox/list falha -> PARA + email de relogin (nao marca).
#   2) lead SEM chat de WhatsApp (email/ligacao/CRM; ex UDIFER 24304535 — veio de /api/v4/talks
#      mas nao tem balao) -> timeline hidratou + sessao viva + canal NAO-WhatsApp -> MARCA 0 e SEGUE.
#   3) chat nao hidratou (timing/degradacao) -> re-tenta com espera maior; se ainda 0 e a sessao
#      segue viva, NAO marca (nao perde conversa real), DEFERE e segue; N leads SEGUIDOS sem
#      hidratar => trata como sessao degradando => PARA + relogin.
# Nunca marca vazio por cima de conversa real: so marca 0 quando ha prova de que a timeline
# renderizou E o canal nao e WhatsApp; na duvida, defere (re-tentado numa proxima run).
#
# USO (PowerShell, mesma pasta do storage_state.json FRESCO):
#   pip install playwright requests ; python -m playwright install chromium
#   set SUPABASE_URL=https://iaompeiokjxbffwehhrx.supabase.co
#   set SUPABASE_SERVICE_ROLE_KEY=...            (service_role; NAO commitar)
#   python kommo_msg_worker_local.py --mode backfill --limit 5
#   python kommo_msg_worker_local.py --mode backfill 24550897 24523405   (leads explicitos)
#   python kommo_msg_worker_local.py --mode incremental --since 2026-07-11T00:00:00Z
#
# CI (GitHub Actions): rodar HEADED sob xvfb (identico ao local) — nao usar headless.
#   xvfb-run -a python scripts/workers/kommo_msg_worker_local.py --mode incremental
#   (WORKER_HEADLESS=1 forca headless, mas NAO recomendado p/ este extrator.)
# Aviso de relogar por email: setar SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS + ALERT_EMAIL_TO.
import sys, os, re, json, time, argparse, datetime, pathlib
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
try:
    import requests
except ImportError:
    sys.exit("Falta requests: pip install requests")

KB = "https://financeirorustonengenhariacombr.kommo.com"
SHARED_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SB_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""

PACE_SECONDS = 5          # respiro entre leads (nao martelar o Kommo / poupar a sessao)
LOAD_WAIT_MS = 6000       # espera pos-goto pro chat hidratar
RELOAD_WAIT_MS = 12000    # espera estendida na re-tentativa (chat que so demorou a hidratar)
HEADLESS = os.environ.get("WORKER_HEADLESS", "0") == "1"  # CI usa xvfb + headed (default)
CANARY_PATH = "/ajax/v4/inbox/list"          # canary de sessao viva (mesmo do session_probe)
MAX_UNHYDRATED_STREAK = 3 # N leads SEGUIDOS sem hidratar (sessao viva) => sessao degradando => PARA
WA_ORIGINS = {"waba", "com.amocrm.amocrmwa"} # canais WhatsApp; 0 balao aqui = suspeito, nunca marca direto

def log(*a): print(*a, flush=True)

# ---- aviso de RELOGAR: email quando a sessao cai (guard de sessao degradada) ----
# Opcional: so envia se SMTP_* estiverem no ambiente (no Actions vem de secrets).
def notify_session_down(lead_id, reason):
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER"); pwd = os.environ.get("SMTP_PASS")
    to   = os.environ.get("ALERT_EMAIL_TO", "gabriel.bianchini@v4company.com")
    if not (user and pwd):
        log("  (SMTP_USER/SMTP_PASS ausentes — pulei o email; rodando local?)")
        return
    import smtplib, ssl
    from email.message import EmailMessage
    m = EmailMessage()
    m["Subject"] = f"[Kommo worker] Sessao caiu no lead {lead_id} — relogar"
    m["From"] = user; m["To"] = to
    m.set_content(
        "O worker de mensagens do Kommo parou: sessao provavelmente degradada.\n\n"
        f"Lead: {lead_id}\nMotivo: {reason}\n\n"
        "Acao: relogar no Kommo NA SUA MAQUINA, regenerar o storage_state.json, "
        "atualizar o secret KOMMO_STORAGE_STATE_B64 no GitHub e re-disparar o backfill "
        "(ele retoma sozinho pelos leads ainda nao marcados).\n")
    try:
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls(context=ssl.create_default_context()); s.login(user, pwd); s.send_message(m)
        log(f"  email de aviso enviado p/ {to}")
    except Exception as e:
        log(f"  aviso: falha ao enviar email ({e}) — veja o log do Actions.")

# ---- PostgREST RPC (service_role) ----
def rpc(fn, payload):
    r = requests.post(f"{SB_URL}/rest/v1/rpc/{fn}",
        headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"},
        json=payload, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"RPC {fn} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.text.strip() else None

# ===== v9 CONGELADO — scroll (byte-identico) =====
JS_SCROLL = r"""
() => {
  const scr = [...document.querySelectorAll('*')].filter(e=>{
     const s=getComputedStyle(e); return (s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight>e.clientHeight+100;
  });
  // acha o feed (maior scrollHeight) e le o scrollTop dele ANTES de subir
  let feed=null, mx=-1;
  for (const e of scr) { if (e.scrollHeight > mx) { mx = e.scrollHeight; feed = e; } }
  const top = feed ? feed.scrollTop : 0;
  scr.forEach(e=>{ e.scrollTop = 0; });               // sobe pro topo
  const anchors = document.querySelectorAll('.feed-note__message_paragraph, .feed-note__joined-attach').length;
  const sh = scr.length ? Math.max(...scr.map(e=>e.scrollHeight)) : 0;
  return { anchors, sh, top };
}
"""

# ===== v9 CONGELADO — parser por NOTA-PAI (byte-identico) =====
JS_EXTRACT = r"""
() => {
  const clean = s => (s||'').replace(/ /g,' ').replace(/\s+/g,' ').trim();
  const feedW = document.body.clientWidth || 1;
  const inQuote = el => !!(el && el.closest('.quotation__container, [class*="quotation"]'));
  // sobe da folha ate o ancestral que contem a DATA da PROPRIA nota (ignora data de citacao)
  const noteOf = (leaf) => {
    let e = leaf.parentElement, h = 0;
    while (e && h < 10) {
      const d = [...e.querySelectorAll(':scope .feed-note__date, :scope .js-feed-note__date')]
                  .some(x => !inQuote(x));
      if (d) return e;
      e = e.parentElement; h++;
    }
    return leaf.parentElement || leaf;
  };
  // Direcao CRAVADA (validada balao-a-balao): feed-note-incoming = entrada; senao = saida.
  const dirOf = (note) => {
    const sig = ((note.className||'')+' '+((note.parentElement||{}).className||'')).toString().toLowerCase();
    return sig.includes('feed-note-incoming') ? 'in' : 'out';
  };

  // ---- MENSAGENS: ancora no conteudo real, IGNORANDO previews de citacao ----
  const anchors = [...document.querySelectorAll('.feed-note__message_paragraph, .feed-note__joined-attach')]
    .filter(a => !inQuote(a));
  const seen = new Set(); const notes = [];
  for (const a of anchors) { const c = noteOf(a); if (!seen.has(c)) { seen.add(c); notes.push(c); } }

  const messages = [];
  const note_html = [];
  for (const note of notes) {
    const paras = [...note.querySelectorAll('.feed-note__message_paragraph')].filter(p => !inQuote(p));
    const audio = [...note.querySelectorAll('.feed-note__joined-attach, audio')].some(el => !inQuote(el));
    const img   = [...note.querySelectorAll('img:not([class*="avatar"]):not([class*="user-pic"])')].some(el => !inQuote(el));
    const file  = [...note.querySelectorAll('a[download],[class*="attach"]')].some(el => !inQuote(el));
    let text = clean(paras.map(p=>p.innerText).join('\n'));
    let type = 'text';
    if (!paras.length && audio) { type='audio'; text = text || '[audio]'; }
    else if (audio) type='audio';
    else if (!paras.length && img) { type='image'; text = text || '[image]'; }
    else if (!paras.length && file) { type='file'; text = text || '[file]'; }
    else if (!paras.length) continue; // nota sem texto/midia -> pula

    const authEl = [...note.querySelectorAll('.feed-note__amojo-user')].find(el => !inQuote(el)) || null;
    const author = authEl ? clean(authEl.getAttribute('title') || authEl.innerText) : null;
    const dateEl = [...note.querySelectorAll('.feed-note__date, .js-feed-note__date')].find(el => !inQuote(el)) || null;
    const ts = dateEl ? clean(dateEl.innerText) : null;
    const wrap = paras[0] ? paras[0].closest('[class*="feed-note__message"]') : null;
    let align = null;
    try { const b=(wrap||paras[0]||note).getBoundingClientRect(); align=+((b.left+b.width/2)/feedW).toFixed(2); } catch(_){}

    messages.push({ text: text.slice(0,2000), type, author,
                    author_reply: !!(authEl && /js-amojo-reply/.test(authEl.className||'')),
                    timestamp: ts, direction: dirOf(note), align,
                    container_class: (note.className||'').toString().slice(0,180),
                    parent_class: ((note.parentElement||{}).className||'').toString().slice(0,180) });

    if (note_html.length < 6) note_html.push((note.outerHTML||'').slice(0,4000));
  }

  // ---- EVENTOS CRM: lista separada ----
  const crmAnchors = [...document.querySelectorAll('.feed-note__pipeline-status, .feed-note__status-before, .feed-note__field-changed-item')];
  const seenSys = new Set(); const system_events = [];
  for (const a of crmAnchors) {
    const c = noteOf(a); if (seen.has(c) || seenSys.has(c)) continue; seenSys.add(c);
    const dateEl = c.querySelector('.feed-note__date, .js-feed-note__date');
    const t = c.querySelector('.feed-note__field-changed-item') ? 'field_change'
            : (c.querySelector('.feed-note__pipeline-status, .feed-note__status-before') ? 'stage_move' : 'crm');
    system_events.push({ type:t, text: clean(c.innerText).slice(0,300),
                         timestamp: dateEl ? clean(dateEl.innerText) : null });
  }

  return { n_notes: notes.length, messages, system_events, note_html };
}
"""

# ===== DIAGNOSTICO de HIDRATACAO (NAO faz parte do v9; so roda quando a extracao deu 0 msgs) =====
# Distingue "lead sem chat" (timeline renderizou, sem baloes) de "chat nao hidratou/skeleton".
# Usa classes que o proprio v9 confia (.feed-note*, .feed-note__date) -> sinal confiavel de
# que a timeline pintou. skeleton e best-effort (so deixa MAIS cauteloso, nunca marca a mais).
JS_DIAG = r"""
() => {
  const q = s => document.querySelectorAll(s).length;
  return {
    feed_notes: q('.feed-note'),                                   // qualquer item do feed (nota/call/email/stage)
    feed_dates: q('.feed-note__date, .js-feed-note__date'),        // itens do feed COM data (renderizados)
    msg_anchors: q('.feed-note__message_paragraph, .feed-note__joined-attach'),
    skeleton: q('[class*="skeleton"], [class*="Skeleton"], .feed-loading, [class*="feed-loading"], [class*="loader"]'),
    feed_container: !!document.querySelector('.card-feed, [class*="feed-notes"], .js-feed, .feed-notes-wrapper')
  };
}
"""

def classify_zero(alive, origin, rendered, skel):
    """Classifica uma observacao de 0 mensagens. Puro (testavel). Retorna:
       'stop'            : canary falhou -> sessao/chat morto -> para + relogin (nunca marca).
       'mark'            : timeline pintou, sem skeleton, canal CONCRETO nao-WhatsApp -> sem chat -> marca 0.
       'defer_hydrated'  : pagina pintou mas canal WhatsApp/desconhecido com 0 balao -> suspeito;
                           NAO marca (nao perde conversa) e NAO conta como degradacao (a pagina esta ok).
       'defer_unhydrated': nao pintou (skeleton/branco) -> suspeita de degradacao -> conta pro streak."""
    if not alive:
        return "stop"
    hydrated = rendered and not skel
    if not hydrated:
        return "defer_unhydrated"
    # hidratou: so marca se o canal for CONCRETO e nao-WhatsApp. Origem '?'/vazia (veio da uniao
    # events/mensagens, sem talk ao vivo) provavelmente TEM chat -> nunca marca, so defere.
    if origin and origin != "?" and origin not in WA_ORIGINS:
        return "mark"
    return "defer_hydrated"

# ---- fila de leads ----
def fetch_talk_leads(page):
    """/api/v4/talks paginado -> {lead_id: origin} (todos os leads com conversa)."""
    by = {}
    for pg in range(1, 40):
        try:
            r = page.request.get(KB + f"/api/v4/talks?limit=250&page={pg}")
            if not r.ok: break
            talks = r.json().get("_embedded", {}).get("talks", []) or []
            if not talks: break
            for t in talks:
                eid = t.get("entity_id")
                if eid: by.setdefault(eid, t.get("origin"))
            if len(talks) < 250: break
        except Exception as e:
            log("  aviso: falha talks page", pg, e); break
    return by

def build_queue(page, args):
    explicit = [int(x) for x in args.leads if str(x).isdigit()]
    origin_map = {}
    if args.mode == "backfill":
        origin_map = fetch_talk_leads(page)
        if explicit:
            # leads explicitos: so os pendentes DESSES ids (nao expande p/ a uniao)
            pend = rpc("kommo_mensagens_pending", {"p_lead_ids": explicit}) or []
        else:
            # FONTE DA FILA = UNIAO (talks live ∪ events-chat ∪ mensagens) ∩ kommo.leads.
            # talks ao vivo entram como extra; a RPC une com events/mensagens e exclui orfaos.
            talk_ids = sorted(origin_map.keys())
            pend = rpc("kommo_mensagens_backfill_pending", {"p_extra_lead_ids": talk_ids}) or []
        queue = [row["lead_id"] for row in pend]
    else:  # incremental
        if explicit:
            queue = sorted(explicit)
        else:
            rows = rpc("kommo_mensagens_incremental", {"p_since": args.since}) or []
            queue = [row["lead_id"] for row in rows]
        origin_map = fetch_talk_leads(page)  # p/ carimbar origin
    if args.limit:
        queue = queue[:args.limit]
    return queue, origin_map

# ---- extracao de 1 lead (v9) ----
def extract_lead(page, lid, load_wait_ms=LOAD_WAIT_MS):
    page.goto(KB + f"/leads/detail/{lid}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(load_wait_ms)
    prev_a=-1; prev_sh=-1; stable=0; rounds=0
    for i in range(200):
        rounds=i+1
        try: st=page.evaluate(JS_SCROLL)
        except Exception: st={"anchors":0,"sh":0,"top":0}
        page.mouse.move(1180,500); page.mouse.wheel(0,-2400)
        page.wait_for_timeout(1500)
        a=st.get("anchors",0); sh=st.get("sh",0); top=st.get("top",0)
        if a==prev_a and sh==prev_sh and top==0: stable+=1
        else: stable=0
        prev_a=a; prev_sh=sh
        if stable>=6 and i>=10: break
    res = page.evaluate(JS_EXTRACT)
    res["_anchors"] = prev_a; res["_rounds"] = rounds
    return res

def to_payload(res):
    """Renomeia timestamp->timestamp_raw; container/parent_class NAO persistem."""
    msgs = [{"text": m.get("text"), "type": m.get("type"), "author": m.get("author"),
             "author_reply": m.get("author_reply"), "timestamp_raw": m.get("timestamp"),
             "direction": m.get("direction")} for m in res.get("messages", [])]
    evs = [{"type": e.get("type"), "text": e.get("text"), "timestamp_raw": e.get("timestamp")}
           for e in res.get("system_events", [])]
    return msgs, evs

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["backfill","incremental"], default="backfill")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--since", default=None, help="ISO ts p/ incremental (corte global)")
    ap.add_argument("leads", nargs="*", help="lead_ids explicitos (opcional)")
    args = ap.parse_args()

    if not (SB_URL and SB_KEY):
        sys.exit("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.")
    if not pathlib.Path("storage_state.json").exists():
        sys.exit("storage_state.json nao encontrado nesta pasta (rode o login/probe antes).")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Falta playwright: pip install playwright && python -m playwright install chromium")

    done=0; wrote=0; marked_nochat=0; failed_lead=None; deferred=[]; unhydrated_streak=0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context(storage_state="storage_state.json", user_agent=SHARED_UA,
                                  viewport={"width":1500,"height":950})
        page = ctx.new_page()

        def canary_alive():
            """Sessao/chat viva? GET /ajax/v4/inbox/list com os cookies da sessao. (ok, status)."""
            try:
                rr = page.request.get(KB + CANARY_PATH, timeout=20000)
                return rr.ok, rr.status
            except Exception as e:
                return False, f"err:{str(e)[:60]}"

        def dom_diag():
            try: return page.evaluate(JS_DIAG)
            except Exception: return {}

        log(f"== worker {args.mode} == abrindo app")
        page.goto(KB+"/leads/pipeline/", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)

        queue, origin_map = build_queue(page, args)
        log(f"  fila: {len(queue)} leads" + (f" (limit {args.limit})" if args.limit else ""))
        if not queue:
            log("  nada a fazer."); browser.close(); return

        for idx, lid in enumerate(queue, 1):
            origin = origin_map.get(lid) or "?"
            log(f"\n[{idx}/{len(queue)}] lead {lid} (origin {origin})")
            captured_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
            try:
                res = extract_lead(page, lid)
            except Exception as e:
                failed_lead = lid
                log(f"  !! ERRO ao carregar/extrair lead {lid}: {e}")
                log(f"  >> Sessao provavelmente caiu no lead {lid}. Relogar (regenerar "
                    f"storage_state.json) e rodar de novo — o worker retoma daqui.")
                notify_session_down(lid, f"erro ao carregar/extrair: {e}")
                break

            msgs, evs = to_payload(res)
            # --- GUARDA: 0 mensagens. Distingue sessao morta x lead-sem-chat x nao-hidratou ---
            if len(msgs) == 0:
                def observe():
                    alive, cstat = canary_alive()
                    d = dom_diag()
                    rendered = bool(d.get("feed_notes", 0) or d.get("feed_dates", 0) or len(evs))
                    skel = int(d.get("skeleton", 0) or 0)
                    return alive, cstat, rendered, skel, d

                def mark_nochat(note):
                    r = rpc("kommo_apply_mensagens", {
                        "p_lead_id": lid, "p_origin": origin, "p_captured_at": captured_at,
                        "p_messages": [], "p_system_events": evs})
                    log(f"  lead {lid} SEM chat de WhatsApp ({note}, canal '{origin}') — "
                        f"marcado={r.get('lead_marked')} crm={r.get('events_inserted')}/{r.get('events_seen')}. Seguindo.")

                alive, cstat, rendered, skel, d = observe()
                log(f"  0 msgs — canary={cstat} feed_notes={d.get('feed_notes')} dates={d.get('feed_dates')} "
                    f"skeleton={skel} events={len(evs)} origin={origin}")
                act = classify_zero(alive, origin, rendered, skel)

                if act == "stop":
                    failed_lead = lid
                    log(f"  >> SESSAO CAIU (canary={cstat}) no lead {lid}. NAO marco. "
                        f"Relogar (regenerar storage_state.json) e re-rodar — retoma daqui.")
                    notify_session_down(lid, f"canary {CANARY_PATH}={cstat} (sessao/chat morto)")
                    break
                if act == "mark":
                    unhydrated_streak = 0; mark_nochat("timeline ok, 0 baloes")
                    done += 1; marked_nochat += 1; time.sleep(PACE_SECONDS); continue

                # 'defer_*': re-tenta 1x com espera maior (chat que so demorou a hidratar/pintar baloes)
                log(f"  chat nao confirmado ({act}); re-tento com espera maior…")
                try:
                    res = extract_lead(page, lid, load_wait_ms=RELOAD_WAIT_MS)
                except Exception as e:
                    failed_lead = lid
                    log(f"  >> erro na re-tentativa do lead {lid}: {e}. NAO marco. Relogar/re-rodar.")
                    notify_session_down(lid, f"erro na re-tentativa: {e}")
                    break
                msgs, evs = to_payload(res)
                if len(msgs) == 0:
                    alive, cstat, rendered, skel, d = observe()
                    act2 = classify_zero(alive, origin, rendered, skel)
                    if act2 == "stop":
                        failed_lead = lid
                        log(f"  >> SESSAO CAIU (canary={cstat}) apos re-tentativa no lead {lid}. Relogar/re-rodar.")
                        notify_session_down(lid, f"canary={cstat} apos re-tentativa")
                        break
                    if act2 == "mark":
                        unhydrated_streak = 0; mark_nochat("confirmado na re-tentativa")
                        done += 1; marked_nochat += 1; time.sleep(PACE_SECONDS); continue
                    # DEFERE (nao marca, nao perde conversa). So conta pro streak se NAO hidratou.
                    deferred.append(lid)
                    if act2 == "defer_unhydrated":
                        unhydrated_streak += 1
                        log(f"  !! lead {lid} nao hidratou 2x (streak={unhydrated_streak}/{MAX_UNHYDRATED_STREAK}). "
                            f"NAO marco e SIGO — re-tentado numa proxima run.")
                        if unhydrated_streak >= MAX_UNHYDRATED_STREAK:
                            failed_lead = lid
                            log(f"  >> {unhydrated_streak} leads SEGUIDOS sem hidratar: sessao provavelmente "
                                f"degradando. PARO e aviso relogin (os deferidos voltam na proxima run).")
                            notify_session_down(lid, f"{unhydrated_streak} leads seguidos sem hidratar (chat degradando)")
                            break
                    else:  # defer_hydrated: pagina ok, canal WA/desconhecido, 0 balao -> nao e degradacao
                        log(f"  !! lead {lid}: pagina ok mas 0 balao em canal '{origin}' (WA/desconhecido). "
                            f"NAO marco (pode ser conversa real) e SIGO — re-tentado numa proxima run.")
                    time.sleep(PACE_SECONDS); continue
                # re-tentativa recuperou mensagens: chat estava lento -> gravacao normal abaixo
                log(f"  re-tentativa recuperou {len(msgs)} msgs (chat estava lento).")

            # --- gravacao normal (msgs > 0, ou recuperado na re-tentativa) ---
            unhydrated_streak = 0
            r = rpc("kommo_apply_mensagens", {
                "p_lead_id": lid, "p_origin": origin, "p_captured_at": captured_at,
                "p_messages": msgs, "p_system_events": evs})
            if not r or not r.get("lead_marked"):
                log(f"  aviso: RPC retornou {r} (lead_marked falso — lead ausente em kommo.leads?). "
                    f"Mensagens gravadas por dedupe, mas NAO marcado; sera re-tentado.")
            log(f"  gravado: msgs {r.get('messages_inserted')}/{r.get('messages_seen')} "
                f"| crm {r.get('events_inserted')}/{r.get('events_seen')} | marcado={r.get('lead_marked')}")
            done+=1; wrote += (r.get("messages_inserted") or 0)
            time.sleep(PACE_SECONDS)

        browser.close()

    log("\n================ RESUMO ================")
    log(f"leads processados: {done} | mensagens novas gravadas: {wrote} | marcados sem-chat: {marked_nochat}")
    if deferred:
        log(f"deferidos (nao hidrataram, sessao viva — voltam na proxima run): {len(deferred)} -> {deferred[:20]}"
            + (" …" if len(deferred) > 20 else ""))
    if failed_lead:
        log(f"PAROU no lead {failed_lead} (sessao suspeita). Relogar e rodar de novo — retoma sozinho.")
        sys.exit(2)
    log("fim OK.")

if __name__ == "__main__":
    main()
