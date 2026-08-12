// kommo-redistribuir — redistribui leads de um usuário entre outros (round-robin),
// reatribui as TAREFAS ABERTAS desses leads e (opcional) move todos para um estágio.
//
// Ações:
//   {acao:'listar', pipeline_id, status_ids[], from_user_id}
//     -> leads do usuário na pipeline/estágios (fonte: API do Kommo, ao vivo)
//   {acao:'redistribuir', pipeline_id, status_ids[], from_user_id, to_user_ids[],
//    move_to_status_id?, dry_run?}
//     -> plano de distribuição; aplica quando dry_run=false
//
// Auth por segredo (ENRIQ_KOMMO_SECRET, header x-enriq-secret). Deploy --no-verify-jwt.
// Secrets: ENRIQ_KOMMO_SECRET, KOMMO_API_TOKEN. Opcional: KOMMO_SUBDOMAIN.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-enriq-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

const SUB = Deno.env.get('KOMMO_SUBDOMAIN') || 'financeirorustonengenhariacombr'
const BASE = `https://${SUB}.kommo.com/api/v4`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Kommo tolera ~7 req/s — mantém folga.
let ultima = 0
async function kommo(method: string, path: string, body?: unknown) {
  const espera = 160 - (Date.now() - ultima)
  if (espera > 0) await sleep(espera)
  ultima = Date.now()
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const txt = await r.text()
  let parsed: unknown = null
  try { parsed = txt ? JSON.parse(txt) : null } catch { parsed = txt }
  return { status: r.status, ok: r.ok, body: parsed as any }
}

// Todos os leads do usuário na pipeline (pagina até acabar), filtrando os estágios pedidos.
async function listarLeads(pipelineId: number, statusIds: number[], userId: number) {
  const out: any[] = []
  for (let page = 1; page <= 20; page++) {
    const q = `/leads?filter[pipeline_id][]=${pipelineId}&filter[responsible_user_id][]=${userId}&limit=250&page=${page}`
    const r = await kommo('GET', q)
    if (r.status === 204) break
    if (!r.ok) throw new Error(`listar leads HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`)
    const leads = r.body?._embedded?.leads ?? []
    out.push(...leads)
    if (leads.length < 250) break
  }
  const alvo = new Set(statusIds)
  return out
    .filter((l) => alvo.size === 0 || alvo.has(Number(l.status_id)))
    .map((l) => ({
      id: Number(l.id),
      name: l.name ?? '',
      status_id: Number(l.status_id),
      responsible_user_id: Number(l.responsible_user_id),
      created_at: l.created_at ?? null,
    }))
}

// Tarefas ABERTAS dos leads (lotes de 20 ids por request).
async function listarTarefasAbertas(leadIds: number[]) {
  const out: any[] = []
  for (let i = 0; i < leadIds.length; i += 20) {
    const chunk = leadIds.slice(i, i + 20)
    const filtro = chunk.map((id) => `filter[entity_id][]=${id}`).join('&')
    const r = await kommo('GET', `/tasks?filter[entity_type]=leads&${filtro}&filter[is_completed]=0&limit=250`)
    if (r.status === 204) continue
    if (!r.ok) throw new Error(`listar tarefas HTTP ${r.status}`)
    out.push(...(r.body?._embedded?.tasks ?? []))
  }
  return out.map((t) => ({
    id: Number(t.id),
    entity_id: Number(t.entity_id),
    text: t.text ?? '',
    complete_till: t.complete_till,
    responsible_user_id: Number(t.responsible_user_id),
  }))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'método não suportado' })
  if (req.headers.get('x-enriq-secret') !== Deno.env.get('ENRIQ_KOMMO_SECRET')) {
    return json(401, { error: 'segredo inválido' })
  }

  let b: Record<string, any>
  try { b = await req.json() } catch { return json(400, { error: 'JSON inválido' }) }

  const pipelineId = Number(b.pipeline_id)
  const statusIds: number[] = (b.status_ids ?? []).map(Number)
  const fromUser = Number(b.from_user_id)
  if (!pipelineId || !fromUser) return json(400, { error: 'pipeline_id e from_user_id obrigatórios' })

  try {
    const leads = await listarLeads(pipelineId, statusIds, fromUser)

    if (b.acao === 'listar') {
      return json(200, { ok: true, total: leads.length, leads })
    }

    if (b.acao !== 'redistribuir') return json(400, { error: "acao deve ser 'listar' ou 'redistribuir'" })

    const toUsers: number[] = (b.to_user_ids ?? []).map(Number).filter(Boolean)
    if (!toUsers.length) return json(400, { error: 'to_user_ids obrigatório' })
    const moveTo = b.move_to_status_id ? Number(b.move_to_status_id) : null
    const dryRun = b.dry_run !== false

    // Round-robin na ordem recebida (leads já vêm ordenados pela API por id).
    const ordenados = [...leads].sort((a, b2) => a.name.localeCompare(b2.name, 'pt-BR'))
    const plano = ordenados.map((l, i) => ({
      lead_id: l.id,
      name: l.name,
      de_user: l.responsible_user_id,
      para_user: toUsers[i % toUsers.length],
      de_status: l.status_id,
      para_status: moveTo ?? l.status_id,
    }))

    const tarefas = await listarTarefasAbertas(ordenados.map((l) => l.id))
    const novoDonoPorLead = new Map(plano.map((p) => [p.lead_id, p.para_user]))
    const planoTarefas = tarefas
      .map((t) => ({ ...t, para_user: novoDonoPorLead.get(t.entity_id) ?? null }))
      .filter((t) => t.para_user && t.para_user !== t.responsible_user_id)

    if (dryRun) {
      return json(200, {
        ok: true, dry_run: true,
        total_leads: plano.length, total_tarefas: planoTarefas.length,
        distribuicao: toUsers.map((u) => ({ user: u, leads: plano.filter((p) => p.para_user === u).length })),
        plano, plano_tarefas: planoTarefas,
      })
    }

    // ── aplica ────────────────────────────────────────────────────────────
    const erros: string[] = []
    let leadsOk = 0
    for (let i = 0; i < plano.length; i += 25) {
      const chunk = plano.slice(i, i + 25).map((p) => ({
        id: p.lead_id,
        responsible_user_id: p.para_user,
        ...(moveTo ? { status_id: moveTo, pipeline_id: pipelineId } : {}),
      }))
      const r = await kommo('PATCH', '/leads', chunk)
      if (r.ok) leadsOk += chunk.length
      else erros.push(`leads lote ${i / 25 + 1}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
    }

    let tarefasOk = 0
    for (let i = 0; i < planoTarefas.length; i += 25) {
      const chunk = planoTarefas.slice(i, i + 25).map((t) => ({
        id: t.id,
        responsible_user_id: t.para_user,
        complete_till: t.complete_till,
      }))
      const r = await kommo('PATCH', '/tasks', chunk)
      if (r.ok) tarefasOk += chunk.length
      else erros.push(`tarefas lote ${i / 25 + 1}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
    }

    return json(200, {
      ok: erros.length === 0,
      aplicado: true,
      leads_atualizados: leadsOk,
      tarefas_atualizadas: tarefasOk,
      distribuicao: toUsers.map((u) => ({ user: u, leads: plano.filter((p) => p.para_user === u).length })),
      erros,
    })
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) })
  }
})
