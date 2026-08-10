// =============================================================
// Edge Function: deal-diagnostico
// =============================================================
// Ferramentas do modal de negociação: dispara a Claude Code Routine do
// Gabriel que pega a TRANSCRIÇÃO da reunião e gera a análise de
// diagnóstico do negócio (personas etc.), e recebe o resultado de volta.
//
// POST {action:'fire', deal_id}
//   - auth: JWT de usuário logado do SalesHub (Authorization: Bearer).
//   - junta contexto do deal + lead + transcrição mais recente
//     (reuniao_transcricoes das reuniões do deal/lead; fallback
//     deals.link_transcricao) e chama a rotina:
//       URL  = env DIAG_ROUTINE_TRIGGER_URL (fallback CLAUDE_ROUTINE_TRIGGER_URL)
//       auth = Bearer env CLAUDE_DIAG_ROUTINE_KEY
//       headers anthropic-beta/version iguais ao prep-call (call_routine.py)
//       body {text: JSON.stringify(payload)} — payload inclui callback_url
//       e callback_secret pra rotina devolver o resultado.
//   - grava deal_diagnosticos (status processing, session ids).
//
// POST {action:'callback', diagnostico_id, markdown?, html?, file_base64?,
//       filename?, file_url?, error?}  + header X-Diag-Secret
//   - secret = integracao_config.deal_diag_callback_secret.
//   - html/markdown/file_base64 viram ARQUIVO no bucket 'contracts' em
//     <deal_id>/diagnostico-<ts>.<ext> (aparece na aba Arquivos do modal).
//   - atualiza a linha pra completed/error.
//
// Deploy: management API, verify_jwt=false (o callback vem de fora; o fire
// valida o JWT manualmente via supabase.auth.getUser).
// =============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://iaompeiokjxbffwehhrx.supabase.co'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-diag-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

const svc = () => createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405)
  let b: any
  try { b = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  const supabase = svc()

  // ---------- CALLBACK (a rotina devolve o resultado) ----------
  if (b.action === 'callback') {
    const { data: cfg } = await supabase.from('integracao_config').select('value').eq('key', 'deal_diag_callback_secret').maybeSingle()
    const secret = req.headers.get('x-diag-secret') ?? b.secret
    if (!cfg?.value || secret !== cfg.value) return json({ error: 'unauthorized' }, 401)

    const { data: diag } = await supabase.from('deal_diagnosticos').select('id, deal_id').eq('id', b.diagnostico_id).maybeSingle()
    if (!diag) return json({ error: 'diagnostico_id desconhecido' }, 404)

    if (b.error) {
      await supabase.from('deal_diagnosticos').update({
        status: 'error', error_message: String(b.error).slice(0, 2000), completed_at: new Date().toISOString(),
      }).eq('id', diag.id)
      return json({ ok: true, status: 'error' })
    }

    // resultado vira arquivo no bucket (aba Arquivos)
    let arquivo_url: string | null = b.file_url ?? null
    let arquivo_filename: string | null = b.filename ?? null
    const ts = Date.now()
    const upload = async (bytes: Uint8Array, name: string, type: string) => {
      const path = `${diag.deal_id}/${name}`
      const { error } = await supabase.storage.from('contracts').upload(path, new Blob([bytes], { type }), { upsert: true })
      if (error) { console.error('upload', error.message); return }
      arquivo_url = supabase.storage.from('contracts').getPublicUrl(path).data.publicUrl
      arquivo_filename = name
    }
    if (b.file_base64) {
      const bytes = Uint8Array.from(atob(b.file_base64), (c) => c.charCodeAt(0))
      const name = (b.filename || `diagnostico-${ts}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_')
      const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.md') ? 'text/markdown' : 'application/pdf'
      await upload(bytes, name, type)
    } else if (b.html) {
      await upload(new TextEncoder().encode(b.html), `diagnostico-${ts}.html`, 'text/html')
    } else if (b.markdown && !arquivo_url) {
      await upload(new TextEncoder().encode(b.markdown), `diagnostico-${ts}.md`, 'text/markdown')
    }

    await supabase.from('deal_diagnosticos').update({
      status: 'completed',
      arquivo_url, arquivo_filename,
      resultado_markdown: b.markdown ?? null,
      completed_at: new Date().toISOString(),
    }).eq('id', diag.id)
    return json({ ok: true, status: 'completed', arquivo_url })
  }

  // ---------- FIRE (botão Ferramentas no modal) ----------
  if (b.action === 'fire') {
    // auth: usuário logado do SalesHub, OU o secret interno (X-Diag-Secret,
    // mesmo do callback) p/ testes/automação server-side
    const { data: fireCfg } = await supabase.from('integracao_config').select('value').eq('key', 'deal_diag_callback_secret').maybeSingle()
    const viaSecret = !!fireCfg?.value && req.headers.get('x-diag-secret') === fireCfg.value
    if (!viaSecret) {
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const anon = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '')
      const { data: userData } = await anon.auth.getUser(jwt)
      if (!userData?.user) return json({ error: 'unauthorized' }, 401)
    }

    // SEM fallback pra CLAUDE_ROUTINE_TRIGGER_URL: aquela URL dispara a rotina do
    // prep-call (outra rotina). Cada rotina tem sua própria trigger URL.
    const routineUrl = Deno.env.get('DIAG_ROUTINE_TRIGGER_URL') || ''
    const routineKey = Deno.env.get('CLAUDE_DIAG_ROUTINE_KEY') || ''
    if (!routineUrl || !routineKey) {
      return json({ error: 'Rotina de diagnóstico ainda não configurada: falta a secret DIAG_ROUTINE_TRIGGER_URL (a URL de trigger da rotina — o Gabriel precisa mandar, igual à do prep-call).' }, 500)
    }

    const { data: deal } = await supabase.from('deals')
      .select('id, empresa, lead_id, reuniao_id, origem, produto, produtos_mrr, produtos_ot, valor_recorrente, valor_escopo, observacoes, bant, temperatura, link_transcricao, cadencia_perfil')
      .eq('id', b.deal_id).maybeSingle()
    if (!deal) return json({ error: 'deal não encontrado' }, 404)

    const { data: lead } = deal.lead_id
      ? await supabase.from('leads').select('empresa, nome_contato, telefone, email, canal, faturamento, produto').eq('id', deal.lead_id).maybeSingle()
      : { data: null }

    // transcrição mais recente das reuniões do deal/lead
    let transcricao: string | null = null
    let transcript_url: string | null = deal.link_transcricao ?? null
    const orClauses = [`deal_id.eq.${deal.id}`]
    if (deal.lead_id) orClauses.push(`lead_id.eq.${deal.lead_id}`)
    const { data: reunioesDoDeal } = await supabase.from('reunioes').select('id').or(orClauses.join(','))
    const rids = (reunioesDoDeal ?? []).map((r: any) => r.id)
    if (deal.reuniao_id && !rids.includes(deal.reuniao_id)) rids.push(deal.reuniao_id)
    if (rids.length) {
      const { data: trs } = await supabase.from('reuniao_transcricoes')
        .select('transcript_text, transcript_url, started_at, created_at')
        .in('reuniao_id', rids)
        .order('created_at', { ascending: false })
        .limit(5)
      const comTexto = (trs ?? []).find((t: any) => t.transcript_text && t.transcript_text.length > 200)
      if (comTexto) { transcricao = comTexto.transcript_text; transcript_url = comTexto.transcript_url ?? transcript_url }
      else if (trs?.[0]?.transcript_url) transcript_url = trs[0].transcript_url
    }
    if (!transcricao && !transcript_url) {
      return json({ error: 'Nenhuma transcrição vinculada a esse deal (nem texto nem link). Rode "Buscar transcrição" na reunião primeiro.' }, 400)
    }

    const { data: cfg } = await supabase.from('integracao_config').select('value').eq('key', 'deal_diag_callback_secret').maybeSingle()

    const { data: novo, error: insErr } = await supabase.from('deal_diagnosticos')
      .insert({ deal_id: deal.id, status: 'processing' }).select('id').single()
    if (insErr) return json({ error: insErr.message }, 500)

    const payload = {
      tipo: 'diagnostico_negocio',
      diagnostico_id: novo.id,
      deal_id: deal.id,
      empresa: deal.empresa,
      contato: lead?.nome_contato ?? null,
      canal: deal.origem ?? lead?.canal ?? null,
      produto: deal.produto ?? lead?.produto ?? null,
      produtos_mrr: deal.produtos_mrr ?? [],
      produtos_ot: deal.produtos_ot ?? [],
      valor_recorrente: deal.valor_recorrente ?? 0,
      valor_escopo: deal.valor_escopo ?? 0,
      faturamento: lead?.faturamento ?? null,
      temperatura: deal.temperatura ?? null,
      bant: deal.bant ?? null,
      observacoes: deal.observacoes ?? null,
      perfil: deal.cadencia_perfil ?? null,
      transcricao,                       // texto integral quando existe
      transcript_url,                    // link do Doc quando só há link
      callback_url: `${SUPABASE_URL}/functions/v1/deal-diagnostico`,
      callback_action: 'callback',
      callback_secret: cfg?.value ?? null,
    }

    const r = await fetch(routineUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${routineKey}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: JSON.stringify(payload) }),
    })
    const rj = await r.json().catch(() => null)
    if (!r.ok) {
      await supabase.from('deal_diagnosticos').update({
        status: 'error', error_message: `trigger ${r.status}: ${JSON.stringify(rj).slice(0, 500)}`, completed_at: new Date().toISOString(),
      }).eq('id', novo.id)
      return json({ error: `Rotina recusou o disparo (HTTP ${r.status})`, detail: rj }, 502)
    }
    const sessionId = rj?.claude_code_session_id || rj?.session_id || null
    const sessionUrl = rj?.claude_code_session_url || rj?.session_url || null
    await supabase.from('deal_diagnosticos').update({
      routine_session_id: sessionId, routine_session_url: sessionUrl,
    }).eq('id', novo.id)

    return json({ ok: true, diagnostico_id: novo.id, session_url: sessionUrl })
  }

  return json({ error: 'action desconhecida (fire | callback)' }, 400)
})
