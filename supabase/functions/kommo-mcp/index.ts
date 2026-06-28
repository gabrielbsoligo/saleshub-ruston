// kommo-mcp (Fase 6/8) — servidor MCP REMOTO (Streamable HTTP) de LEITURA sobre a réplica kommo.
// Lê as views via wrappers public.kommo_* (service_role). NÃO escreve no Kommo (escrita = Fase 7).
// Auth: bearer token (header Authorization: Bearer <T>) OU ?token=<T>. Deploy com --no-verify-jwt.
//
// URL pública: https://<ref>.supabase.co/functions/v1/kommo-mcp
// Conectar no claude.ai: Connectors -> custom connector -> a URL (token embutido em ?token=).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SERVER = { name: 'kommo-saleshub', version: '0.1.0' }
const PROTOCOL = '2024-11-05'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
}

const TOOLS = [
  {
    name: 'find_stale_deals',
    description:
      'Deals do SalesHub COM proposta (produto + preço) parados há >= `dias`, cruzando com a ' +
      'última atividade real no Kommo (tarefa criada/concluída, nota, mensagem de chat/WhatsApp/DM ' +
      'ou mudança de etapa). Corte de valor/dias parametrizável. Retorna lista ordenada por valor.',
    inputSchema: {
      type: 'object',
      properties: {
        valor_min: { type: 'number', description: 'Valor mínimo (valor_ot+valor_mrr). Default 50000.' },
        dias: { type: 'integer', description: 'Dias sem atividade p/ contar como parado. Default 15.' },
        somente_com_vinculo: { type: 'boolean', description: 'Só deals com kommo_id resolvido. Default true.' },
      },
    },
  },
  {
    name: 'find_duplicate_leads',
    description:
      'Leads duplicados no Kommo agrupados por telefone/email normalizados, com contexto ' +
      '(responsável, etapa, valor, criação). DETECTA e AGRUPA — merge/move é escrita (Fase 7, indisponível). ' +
      'Retorna um resumo (nº de clusters e leads) + os maiores clusters.',
    inputSchema: {
      type: 'object',
      properties: { limite: { type: 'integer', description: 'Máx. de linhas de cluster. Default 300.' } },
    },
  },
]

function jrpc(id: any, result?: any, error?: any) {
  return error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }
}

async function callTool(sb: any, name: string, args: any) {
  if (name === 'find_stale_deals') {
    const { data, error } = await sb.rpc('kommo_find_stale_deals', {
      valor_min: args?.valor_min ?? 50000, dias: args?.dias ?? 15,
      somente_com_vinculo: args?.somente_com_vinculo ?? true,
    })
    if (error) throw new Error(error.message)
    const total = (data ?? []).reduce((s: number, r: any) => s + Number(r.valor_total || 0), 0)
    return { count: data?.length ?? 0, valor_total_somado: total, deals: data ?? [] }
  }
  if (name === 'find_duplicate_leads') {
    const [{ data: sum }, { data: rows, error }] = await Promise.all([
      sb.rpc('kommo_duplicates_summary'),
      sb.rpc('kommo_list_duplicates', { limite: args?.limite ?? 300 }),
    ])
    if (error) throw new Error(error.message)
    return { resumo: sum?.[0] ?? {}, clusters: rows ?? [] }
  }
  throw new Error(`tool desconhecida: ${name}`)
}

async function handle(msg: any, sb: any): Promise<any | null> {
  const { id, method, params } = msg ?? {}
  if (method === undefined) return null
  if (method.startsWith('notifications/')) return null // notificação: sem resposta
  try {
    if (method === 'initialize') {
      return jrpc(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
      })
    }
    if (method === 'ping') return jrpc(id, {})
    if (method === 'tools/list') return jrpc(id, { tools: TOOLS })
    if (method === 'tools/call') {
      try {
        const out = await callTool(sb, params?.name, params?.arguments ?? {})
        return jrpc(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
      } catch (e) {
        return jrpc(id, { content: [{ type: 'text', text: `Erro: ${String(e)}` }], isError: true })
      }
    }
    return jrpc(id, undefined, { code: -32601, message: `método não suportado: ${method}` })
  } catch (e) {
    return jrpc(id, undefined, { code: -32603, message: String(e) })
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  // --- AUTH: bearer token (header) ou ?token= ---
  const url = new URL(req.url)
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const token = bearer || url.searchParams.get('token') || ''
  const expected = Deno.env.get('KOMMO_MCP_TOKEN')
  if (!expected || token !== expected) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  // GET = sem stream server->client neste servidor stateless
  if (req.method === 'GET') {
    return new Response('MCP kommo-saleshub: use POST (Streamable HTTP).', {
      status: 405, headers: { ...cors, Allow: 'POST, OPTIONS' },
    })
  }

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  let body: any
  try { body = await req.json() } catch { return new Response('bad json', { status: 400, headers: cors }) }

  // batch ou único
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, sb)))).filter(Boolean)
    if (!out.length) return new Response(null, { status: 202, headers: cors })
    return new Response(JSON.stringify(out), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const res = await handle(body, sb)
  if (!res) return new Response(null, { status: 202, headers: cors }) // notificação
  return new Response(JSON.stringify(res), { headers: { ...cors, 'Content-Type': 'application/json' } })
})
