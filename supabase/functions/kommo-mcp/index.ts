// kommo-mcp (Fases 6+7) — servidor MCP REMOTO (Streamable HTTP).
// LEITURA: sai do Postgres via wrappers public.kommo_* (service_role). Sem bater na API.
// ESCRITA: vai na API do Kommo (fonte de verdade) e volta pela réplica via webhook.
//          TODA escrita é preview→confirm: por default só mostra o diff; confirm=true aplica.
// Auth: bearer token (header) ou ?token=. Deploy --no-verify-jwt. URL fixa (não muda em redeploy).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SERVER = { name: 'kommo-saleshub', version: '0.2.0' }
const PROTOCOL = '2024-11-05'
const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
// >>> TROCA P/ TOKEN RESTRITO: troque o secret KOMMO_API_TOKEN por um token de escopo
//     restrito (apenas escrita de leads/tasks/notes). Nenhuma mudança de código é necessária. <<<
const WRITE_TOKEN_SECRET = 'KOMMO_API_TOKEN'
const cors = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
}

const TOOLS = [
  { name: 'find_stale_deals', description: 'Deals com proposta parados há >= dias (atividade real no Kommo: tarefa criada/concluída, nota, chat/WhatsApp/etapa). Corte parametrizável; somente_com_vinculo=true por default (sem vínculo fica fora).',
    inputSchema: { type: 'object', properties: { valor_min: { type: 'number' }, dias: { type: 'integer' }, somente_com_vinculo: { type: 'boolean' } } } },
  { name: 'find_duplicate_leads', description: 'Leads duplicados (telefone/email normalizados) com contexto. Detecta e agrupa — merge/move é write tool.',
    inputSchema: { type: 'object', properties: { limite: { type: 'integer' } } } },
  { name: 'get_lead', description: 'Ficha do lead por id, nome, telefone ou email (etapa, responsável, valor, última atividade, contatos/empresa).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'list_lead_activities', description: 'Timeline do lead: tarefas, notas, chat e mudança de etapa.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'integer' } }, required: ['lead_id'] } },
  { name: 'funnel_by_owner', description: 'Deals e valor por etapa, por closer (opcionalmente filtra um responsável).',
    inputSchema: { type: 'object', properties: { responsavel: { type: 'string' } } } },
  { name: 'deals_without_next_task', description: 'Deals (em aberto, com proposta) SEM tarefa aberta no Kommo — candidatos a próximo passo.',
    inputSchema: { type: 'object', properties: { valor_min: { type: 'number' }, somente_com_vinculo: { type: 'boolean' } } } },
  { name: 'new_leads', description: 'Leads que entraram no período, por canal/origem. Datas YYYY-MM-DD.',
    inputSchema: { type: 'object', properties: { de: { type: 'string' }, ate: { type: 'string' }, canal: { type: 'string' } }, required: ['de', 'ate'] } },
  { name: 'stale_ranking_by_owner', description: 'Ranking de quem está com mais deal parado (definição de stale travada, 15d).',
    inputSchema: { type: 'object', properties: {} } },
  // ---- WRITE (preview->confirm) ----
  { name: 'move_lead', description: 'ESCRITA (preview→confirm). Move lead(s) de etapa. Sem confirm=true só mostra o diff. lead_id OU lead_ids[].',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'integer' }, lead_ids: { type: 'array', items: { type: 'integer' } }, etapa_destino: { type: 'string' }, confirm: { type: 'boolean' }, confirm_bulk: { type: 'boolean' } }, required: ['etapa_destino'] } },
  { name: 'update_lead_value', description: 'ESCRITA (preview→confirm). Corrige valor (price) de lead(s), inclusive em lote. lead_id OU lead_ids[].',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'integer' }, lead_ids: { type: 'array', items: { type: 'integer' } }, valor: { type: 'number' }, confirm: { type: 'boolean' }, confirm_bulk: { type: 'boolean' } }, required: ['valor'] } },
  { name: 'update_lead_field', description: 'ESCRITA (preview→confirm). Atualiza um campo padrão do lead (ex.: name, price). lead_id obrigatório.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'integer' }, campo: { type: 'string' }, valor: {}, confirm: { type: 'boolean' } }, required: ['lead_id', 'campo', 'valor'] } },
  { name: 'add_note', description: 'ESCRITA (preview→confirm). Adiciona nota comum ao lead.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'integer' }, texto: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['lead_id', 'texto'] } },
  { name: 'create_task', description: 'ESCRITA (preview→confirm). Cria tarefa de follow no lead. prazo YYYY-MM-DD ou ISO.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'integer' }, texto: { type: 'string' }, prazo: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['lead_id', 'texto', 'prazo'] } },
]
const WRITE = new Set(['move_lead', 'update_lead_value', 'update_lead_field', 'add_note', 'create_task'])
const BULK_LIMIT = 10  // confirm que afeta > N registros exige confirm_bulk=true (trava anti-massa)

function jrpc(id: any, result?: any, error?: any) { return error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result } }

async function rpc(sb: any, fn: string, args: any) {
  const { data, error } = await sb.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}
function kommoWrite(method: string, path: string, body: any) {
  const token = Deno.env.get(WRITE_TOKEN_SECRET)
  return fetch(`${KOMMO_BASE}/api/v4${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.text().then((t) => { try { return JSON.parse(t) } catch { return t } }) }))
}
const idsOf = (a: any) => (a.lead_ids?.length ? a.lead_ids : (a.lead_id ? [a.lead_id] : [])).map(Number)

async function readTool(sb: any, name: string, a: any) {
  switch (name) {
    case 'find_stale_deals': { const d = await rpc(sb, 'kommo_find_stale_deals', { valor_min: a.valor_min ?? 50000, dias: a.dias ?? 15, somente_com_vinculo: a.somente_com_vinculo ?? true }); return { count: d?.length ?? 0, valor_total_somado: (d ?? []).reduce((s: number, r: any) => s + Number(r.valor_total || 0), 0), deals: d } }
    case 'find_duplicate_leads': { const [sum, rows] = await Promise.all([rpc(sb, 'kommo_duplicates_summary', {}), rpc(sb, 'kommo_list_duplicates', { limite: a.limite ?? 300 })]); return { resumo: sum?.[0] ?? {}, clusters: rows } }
    case 'get_lead': return { leads: await rpc(sb, 'kommo_get_lead', { p_query: String(a.query) }) }
    case 'list_lead_activities': return { atividades: await rpc(sb, 'kommo_lead_activities', { p_lead_id: Number(a.lead_id) }) }
    case 'funnel_by_owner': return { funil: await rpc(sb, 'kommo_funnel_by_owner', { p_owner: a.responsavel ?? null }) }
    case 'deals_without_next_task': return { deals: await rpc(sb, 'kommo_deals_without_next_task', { p_valor_min: a.valor_min ?? 0, p_somente_com_vinculo: a.somente_com_vinculo ?? true }) }
    case 'new_leads': return { por_canal: await rpc(sb, 'kommo_new_leads', { p_from: a.de, p_to: a.ate, p_canal: a.canal ?? null }) }
    case 'stale_ranking_by_owner': return { ranking: await rpc(sb, 'kommo_stale_ranking', {}) }
  }
  throw new Error('read tool desconhecida: ' + name)
}

async function writeTool(sb: any, name: string, a: any) {
  const confirm = a.confirm === true
  if (name === 'move_lead') {
    const ids = idsOf(a); if (!ids.length) throw new Error('informe lead_id ou lead_ids')
    const stages = await rpc(sb, 'kommo_resolve_stage', { p_name: String(a.etapa_destino) })
    const exact = (stages ?? []).filter((s: any) => s.stage_name?.toLowerCase() === String(a.etapa_destino).toLowerCase())
    const target = exact[0] ?? ((stages ?? []).length === 1 ? stages[0] : null)
    if (!target) return { error: 'etapa não resolvida (ambígua ou inexistente)', candidatos: stages }
    const cur = await rpc(sb, 'kommo_lead_current', { p_ids: ids })
    const mudancas = (cur ?? []).map((c: any) => ({ lead_id: c.lead_id, nome: c.nome, de: c.etapa, para: target.stage_name }))
    if (!confirm) return { preview: true, acao: 'move_lead', destino: target, total: ids.length, mudancas, nota: 'preview — passe confirm=true para aplicar' }
    if (ids.length > BULK_LIMIT && a.confirm_bulk !== true) return { blocked: true, acao: 'move_lead', total: ids.length, nota: `aplicação em massa: afeta ${ids.length} registros (> ${BULK_LIMIT}). Reenvie com confirm=true E confirm_bulk=true para aplicar.` }
    const results = []
    for (const id of ids) results.push({ lead_id: id, ...(await kommoWrite('PATCH', `/leads/${id}`, { status_id: target.status_id, pipeline_id: target.pipeline_id })) })
    return { applied: true, total: ids.length, etapa: target.stage_name, results }
  }
  if (name === 'update_lead_value') {
    const ids = idsOf(a); if (!ids.length) throw new Error('informe lead_id ou lead_ids')
    const cur = await rpc(sb, 'kommo_lead_current', { p_ids: ids })
    const mudancas = (cur ?? []).map((c: any) => ({ lead_id: c.lead_id, nome: c.nome, de: c.valor, para: a.valor }))
    if (!confirm) return { preview: true, acao: 'update_lead_value', valor: a.valor, total: ids.length, mudancas, nota: 'preview — passe confirm=true para aplicar' }
    if (ids.length > BULK_LIMIT && a.confirm_bulk !== true) return { blocked: true, acao: 'update_lead_value', total: ids.length, nota: `aplicação em massa: afeta ${ids.length} registros (> ${BULK_LIMIT}). Reenvie com confirm=true E confirm_bulk=true para aplicar.` }
    const results = []
    for (const id of ids) results.push({ lead_id: id, ...(await kommoWrite('PATCH', `/leads/${id}`, { price: Number(a.valor) })) })
    return { applied: true, total: ids.length, results }
  }
  if (name === 'update_lead_field') {
    const cur = await rpc(sb, 'kommo_lead_current', { p_ids: [Number(a.lead_id)] })
    if (!confirm) return { preview: true, acao: 'update_lead_field', lead_id: a.lead_id, campo: a.campo, valor: a.valor, atual: cur?.[0] ?? null, nota: 'preview — passe confirm=true para aplicar' }
    return { applied: true, ...(await kommoWrite('PATCH', `/leads/${a.lead_id}`, { [a.campo]: a.valor })) }
  }
  if (name === 'add_note') {
    if (!confirm) return { preview: true, acao: 'add_note', lead_id: a.lead_id, texto: a.texto, nota: 'preview — passe confirm=true para aplicar' }
    return { applied: true, ...(await kommoWrite('POST', `/leads/${a.lead_id}/notes`, [{ note_type: 'common', params: { text: a.texto } }])) }
  }
  if (name === 'create_task') {
    const till = Math.floor(new Date(a.prazo).getTime() / 1000)
    if (!till || isNaN(till)) throw new Error('prazo inválido (use YYYY-MM-DD ou ISO)')
    if (!confirm) return { preview: true, acao: 'create_task', lead_id: a.lead_id, texto: a.texto, prazo: a.prazo, nota: 'preview — passe confirm=true para aplicar' }
    return { applied: true, ...(await kommoWrite('POST', `/tasks`, [{ entity_id: Number(a.lead_id), entity_type: 'leads', text: a.texto, complete_till: till, task_type_id: 1 }])) }
  }
  throw new Error('write tool desconhecida: ' + name)
}

async function handle(msg: any, sb: any): Promise<any | null> {
  const { id, method, params } = msg ?? {}
  if (method === undefined) return null
  if (method.startsWith('notifications/')) return null
  if (method === 'initialize') return jrpc(id, { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER })
  if (method === 'ping') return jrpc(id, {})
  if (method === 'tools/list') return jrpc(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name, a = params?.arguments ?? {}
    try {
      const out = WRITE.has(name) ? await writeTool(sb, name, a) : await readTool(sb, name, a)
      return jrpc(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
    } catch (e) { return jrpc(id, { content: [{ type: 'text', text: `Erro: ${String(e)}` }], isError: true }) }
  }
  return jrpc(id, undefined, { code: -32601, message: `método não suportado: ${method}` })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const token = bearer || url.searchParams.get('token') || ''
  if (token !== Deno.env.get('KOMMO_MCP_TOKEN')) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'GET') return new Response('MCP kommo-saleshub: use POST.', { status: 405, headers: { ...cors, Allow: 'POST, OPTIONS' } })
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  let body: any; try { body = await req.json() } catch { return new Response('bad json', { status: 400, headers: cors }) }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, sb)))).filter(Boolean)
    return out.length ? new Response(JSON.stringify(out), { headers: { ...cors, 'Content-Type': 'application/json' } }) : new Response(null, { status: 202, headers: cors })
  }
  const res = await handle(body, sb)
  return res ? new Response(JSON.stringify(res), { headers: { ...cors, 'Content-Type': 'application/json' } }) : new Response(null, { status: 202, headers: cors })
})
