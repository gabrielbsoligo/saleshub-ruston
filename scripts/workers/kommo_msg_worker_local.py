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
#   --mode backfill     fila = leads com talk (/api/v4/talks) e messages_extracted_at IS NULL
#   --mode incremental  fila = leads com chat novo desde a ultima extracao (kommo.events)
#
# SEGURANCA DE SESSAO DEGRADADA: todo lead da fila TEM conversa (veio de talks/eventos de
# chat). Se a extracao vier com 0 mensagens, a sessao provavelmente caiu (painel abre mas
# o chat fica em skeleton). O worker PARA com mensagem clara e NAO marca o lead — nunca
# grava vazio por cima de conversa real (o marca-como-processado destruiria o dado bom).
#
# USO (PowerShell, mesma pasta do storage_state.json FRESCO):
#   pip install playwright requests ; python -m playwright install chromium
#   set SUPABASE_URL=https://iaompeiokjxbffwehhrx.supabase.co
#   set SUPABASE_SERVICE_ROLE_KEY=...            (service_role; NAO commitar)
#   python kommo_msg_worker_local.py --mode backfill --limit 5
#   python kommo_msg_worker_local.py --mode backfill 24550897 24523405   (leads explicitos)
#   python kommo_msg_worker_local.py --mode incremental --since 2026-07-11T00:00:00Z
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
if not (SB_URL and SB_KEY):
    sys.exit("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente.")
if not pathlib.Path("storage_state.json").exists():
    sys.exit("storage_state.json nao encontrado nesta pasta (rode o login/probe antes).")

PACE_SECONDS = 5          # respiro entre leads (nao martelar o Kommo / poupar a sessao)
LOAD_WAIT_MS = 6000       # espera pos-goto pro chat hidratar

def log(*a): print(*a, flush=True)

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
            cand = explicit
        else:
            cand = sorted(origin_map.keys())
        pend = rpc("kommo_mensagens_pending", {"p_lead_ids": cand}) or []
        queue = [row["lead_id"] for row in pend]
        # leads explicitos que nao vieram de talks ainda precisam de origin (resolve no lead)
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
def extract_lead(page, lid):
    page.goto(KB + f"/leads/detail/{lid}", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(LOAD_WAIT_MS)
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

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Falta playwright: pip install playwright && python -m playwright install chromium")

    done=0; wrote=0; failed_lead=None
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False)
        ctx = browser.new_context(storage_state="storage_state.json", user_agent=SHARED_UA,
                                  viewport={"width":1500,"height":950})
        page = ctx.new_page()
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
                break

            msgs, evs = to_payload(res)
            # --- GUARDA de sessao degradada: lead da fila TEM conversa; 0 msgs = suspeito ---
            if len(msgs) == 0:
                failed_lead = lid
                log(f"  !! lead {lid} veio com 0 mensagens (anchors={res.get('_anchors')}, "
                    f"rounds={res.get('_rounds')}), mas ESTA na fila (tem conversa).")
                log(f"  >> Sessao provavelmente caiu no lead {lid} (chat em skeleton). NAO vou "
                    f"marcar/gravar vazio. Relogar (regenerar storage_state.json) e rodar de novo.")
                break

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
    log(f"leads processados: {done} | mensagens novas gravadas: {wrote}")
    if failed_lead:
        log(f"PAROU no lead {failed_lead} (sessao suspeita). Relogar e rodar de novo — retoma sozinho.")
        sys.exit(2)
    log("fim OK.")

if __name__ == "__main__":
    main()
