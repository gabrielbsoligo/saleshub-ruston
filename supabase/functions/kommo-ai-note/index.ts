// kommo-ai-note — P2.2: publica a ANÁLISE DA REUNIÃO (ai_result) como NOTA no lead do Kommo.
// Disparada por trigger de post_meeting_automations (status -> completed) ou chamada manual
// {automation_id} | {reuniao_id}. IDEMPOTENTE: guarda kommo_note_id na automação; se já existe,
// PATCH na MESMA nota (nunca duplica). Formato humano (resumo + BANT + próximos passos) com
// prefixo identificável — NUNCA o JSON cru. Auth: mesmo segredo do kommo-writeback.
// Deploy: supabase functions deploy kommo-ai-note --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const PREFIX = '🤖 Análise da reunião (SalesHub)'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok')
  let b: any
  try { b = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  if (!b?.secret || b.secret !== Deno.env.get('KOMMO_SYNC_SECRET')) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

  // localizar a automação (por id ou reunião)
  let q = supabase.from('post_meeting_automations').select('id, reuniao_id, ai_result, kommo_note_id').not('ai_result', 'is', null)
  q = b.automation_id ? q.eq('id', b.automation_id) : q.eq('reuniao_id', b.reuniao_id)
  const { data: auto } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (!auto?.ai_result) return json({ skipped: true, reason: 'sem_ai_result' })

  // resolver kommo lead id (reunião -> lead -> deal, mesma cadeia do plan_reconcile)
  const { data: kid } = await supabase.rpc('kommo_id_da_reuniao', { p_reuniao_id: auto.reuniao_id })
  if (!kid) return json({ skipped: true, reason: 'sem_kommo_id', reuniao_id: auto.reuniao_id })

  const a = auto.ai_result
  const fmtBRL = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR')}`
  const linhas: string[] = [PREFIX, '']
  if (a.resumo_executivo) linhas.push(a.resumo_executivo, '')
  linhas.push(`Temperatura: ${a.temperatura ?? '—'} · BANT: ${a.bant ?? '—'}/4 · Tier: ${a.tier ?? '—'}`)
  if (a.valor_recorrente || a.valor_escopo) linhas.push(`Valores: MRR ${fmtBRL(a.valor_recorrente)} · OT ${fmtBRL(a.valor_escopo)}`)
  const prods = [...(a.produtos_mrr || []), ...(a.produtos_ot || [])]
  if (prods.length) linhas.push(`Produtos: ${prods.join(', ')}`)
  linhas.push('', `Próximo passo: ${a.proximo_passo ?? '—'}`)
  const datas = a.plano_cadencia?.datas_acordadas || []
  if (datas.length) linhas.push(`Datas acordadas: ${datas.join(' · ')}`)
  for (const t of (a.plano_cadencia?.tarefas_especificas || [])) linhas.push(`• ${t.quando}: ${t.o_que}`)
  const inds = a.indicacoes || []
  if (inds.length) {
    linhas.push('', `Indicações (${inds.length}):`)
    for (const i of inds) linhas.push(`• ${i.nome || '—'}${i.empresa ? ' — ' + i.empresa : ''}${i.telefone ? ' — ' + i.telefone : ''}`)
  }
  const texto = linhas.join('\n').slice(0, 15000)

  const token = Deno.env.get('KOMMO_API_TOKEN')
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // idempotência: PATCH na nota existente; se sumiu (404), cria de novo
  if (auto.kommo_note_id) {
    const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${kid}/notes/${auto.kommo_note_id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ note_type: 'common', params: { text: texto } }),
    })
    if (r.ok) return json({ ok: true, updated: true, note_id: auto.kommo_note_id, kommo_id: kid })
    if (r.status !== 404 && r.status !== 400) return json({ error: 'PATCH nota falhou', status: r.status, detail: (await r.text()).slice(0, 300) }, 502)
  }

  const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${kid}/notes`, {
    method: 'POST', headers: H,
    body: JSON.stringify([{ note_type: 'common', params: { text: texto } }]),
  })
  if (!r.ok) return json({ error: 'POST nota falhou', status: r.status, detail: (await r.text()).slice(0, 300) }, 502)
  const noteId = (await r.json())?._embedded?.notes?.[0]?.id ?? null
  if (noteId) await supabase.from('post_meeting_automations').update({ kommo_note_id: noteId }).eq('id', auto.id)
  return json({ ok: true, created: true, note_id: noteId, kommo_id: kid })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
