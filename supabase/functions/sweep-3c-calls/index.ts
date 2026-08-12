// =============================================================
// Edge Function: sweep-3c-calls
// =============================================================
// Rede de segurança do webhook do 3C (10/08: o 3C desativou o webhook sozinho
// após 50 timeouts e ficamos 2h30 sem eventos — leads não moveram, qualidade
// não registrou). A cada 30 min (pg_cron, migration_138):
//   1. Lista na API do 3C as chamadas das últimas ~3h (datas em hora LOCAL/BRT).
//   2. Filtra o que interessa (tem agente, ou tabulação 240055/240056).
//   3. Confere o que JÁ chegou (ligacoes_4com/call_quality por call_id).
//   4. O que faltar é reinjetado no webhook-3c-calls (mesmo payload do 3C) —
//      moves + nota + transcrição + qualidade acontecem normalmente.
// Auth: {secret} = KOMMO_SYNC_SECRET (chamada pelo pg_cron via vault).
// Retorna contagens; console.log lista os call_ids reinjetados.
// Deploy: management API, verify_jwt=false.
// =============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://iaompeiokjxbffwehhrx.supabase.co'
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

const QUALS_MOVE = [240055, 240056]

function secs(t: unknown): number {
  if (!t) return 0
  const p = String(t).split(':')
  return p.length === 3 ? Number(p[0]) * 3600 + Number(p[1]) * 60 + Number(p[2]) : 0
}
// hora local de São Paulo no formato que a API do 3C espera (YYYY-MM-DD HH:MM:SS)
function brt(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace('T', ' ')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405)
  let b: any
  try { b = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  if (!b?.secret || b.secret !== Deno.env.get('KOMMO_SYNC_SECRET')) return json({ error: 'unauthorized' }, 401)

  const t3c = Deno.env.get('THREEC_API_TOKEN') ?? ''
  const whTok = Deno.env.get('THREEC_WEBHOOK_TOKEN') ?? ''
  if (!t3c || !whTok) return json({ error: 'faltam THREEC_API_TOKEN/THREEC_WEBHOOK_TOKEN' }, 500)

  const horas = Number(b.horas ?? 3)
  const start = brt(new Date(Date.now() - horas * 3600_000))
  const end = brt(new Date(Date.now() + 10 * 60_000))

  // 1) lista chamadas no 3C (paginado; o 3C às vezes devolve corpo vazio sob rajada —
  //    tenta de novo uma vez e segue)
  const candidatas: any[] = []
  for (let page = 1; page <= 15; page++) {
    let j: any = null
    for (let tent = 1; tent <= 2 && !j; tent++) {
      const r = await fetch(`https://app.3c.plus/api/v1/calls?api_token=${t3c}&per_page=200&page=${page}` +
        `&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`)
      if (!r.ok) { console.error(`[sweep-3c] 3C /calls p${page} HTTP ${r.status}`); await new Promise((res) => setTimeout(res, 1500)); continue }
      j = await r.json().catch(() => null)
      if (!j) await new Promise((res) => setTimeout(res, 1500))
    }
    if (!j) { console.error(`[sweep-3c] p${page} sem resposta — parando a paginação`); break }
    const data = j?.data ?? []
    for (const c of data) {
      const qid = c.qualification_id
      const st = secs(c.speaking_time)
      if (!c.agent_id && !QUALS_MOVE.includes(qid)) continue
      if (st <= 0 && qid == null) continue
      candidatas.push(c)
    }
    if (data.length < 200) break
    await new Promise((res) => setTimeout(res, 400))
  }

  // 2) o que já chegou
  const supabase = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const ids = candidatas.map((c) => String(c.id))
  const existentes = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const [lg, cq] = await Promise.all([
      supabase.from('ligacoes_4com').select('call_id').in('call_id', chunk),
      supabase.from('call_quality').select('call_id').in('call_id', chunk),
    ])
    for (const r of lg.data ?? []) existentes.add(r.call_id)
    for (const r of cq.data ?? []) existentes.add(r.call_id)
  }

  // 3) reinjeta o que faltou — no MÁXIMO 30 por rodada (o runtime da edge tem rate
  //    limit de fetch; com o cron de 30min a fila anda sozinha e o dedup garante
  //    idempotência). Qualquer erro no meio: para graciosamente e devolve o parcial.
  const faltantes = candidatas.filter((c) => !existentes.has(String(c.id)))
  let reinjetadas = 0
  try {
  for (const c of faltantes.slice(0, 30)) {
    const payload = {
      body: { 'call-history-was-created': { callHistory: {
        _id: c.id,
        agent: { id: c.agent_id, name: c.agent },
        speaking_time: secs(c.speaking_time),
        billed_time: secs(c.billed_time),
        call_date: c.call_date_rfc3339 || c.call_date,
        number: c.phone || c.mailing_data?.phone,
        mailing_data: c.mailing_data,
        qualification: { id: c.qualification_id, name: c.qualification },
        campaign: { id: c.campaign_id, name: c.campaign },
        recorded: true,
      } } },
    }
    const r = await fetch(`${SUPABASE_URL}/functions/v1/webhook-3c-calls?t=${whTok}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (r.ok) { reinjetadas++; console.log(`[sweep-3c] reinjetada ${c.id} ${c.agent ?? '-'} ${c.qualification ?? '-'}`) }
    else console.error(`[sweep-3c] falhou ${c.id} HTTP ${r.status}`)
    await new Promise((res) => setTimeout(res, 700))
  }
  } catch (e) {
    console.error('[sweep-3c] interrompida no meio (rate limit?) — próxima rodada continua:', String((e as any)?.message ?? e).slice(0, 200))
  }

  if (faltantes.length > 0) {
    console.warn(`[sweep-3c] BURACO detectado: ${faltantes.length} chamadas não tinham chegado pelo webhook — confira o toggle do webhook no painel do 3C.`)
  }
  return json({ ok: true, janela_horas: horas, candidatas: candidatas.length, ja_existiam: existentes.size, reinjetadas })
})
