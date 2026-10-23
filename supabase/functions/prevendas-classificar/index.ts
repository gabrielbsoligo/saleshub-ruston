// prevendas-classificar — classifica as tarefas candidatas do PRÓXIMO (widget ruston-prevendas).
// Entrada: POST { task_ids: number[] } com header X-Auth-Token (JWT descartável do Kommo, $authorizedAjax).
// Saída:   { ok, tarefas: [{id, momento, acao, grupo, urgente, fonte, motivo, lead_nome, etapa}], negadas }
//
// Autorização em camadas (falha fechada) — ver kommo-widget/ruston-prevendas/PROPOSTA.md §2.4:
//  1) identidade: JWT HS256 assinado com o secret da integração; exp/nbf/iat; conta e integração esperadas;
//     user_id mapeado para team_members ATIVO.  (NÃO exige discador/ramal.)
//  2) leitura: cada id do navegador é conferido no Kommo (aberta + responsável = usuário, ou gestor
//     autorizado) ANTES de ler lead/origem/cadência. Ids que não passam são só contados em "negadas".
// Env: KOMMO_API_TOKEN, KOMMO_WIDGET_SECRET, KOMMO_WIDGET_CLIENT_ID, KOMMO_ACCOUNT_ID,
//      PREVENDAS_GESTORES (csv de kommo user ids, opcional), PREVENDAS_TIPOS_MOMENTO (json {tipo:momento}, opcional)
// Deploy: verify_jwt=false (a autenticação é o JWT do Kommo, não o do Supabase).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { classificar, mapaSlots, type Momento } from '../_shared/prevendas_classificar.ts'
import { verificarJwtKommo } from '../_shared/kommo_jwt.ts'

const SUB = 'financeirorustonengenhariacombr'
const KOMMO_BASE = `https://${SUB}.kommo.com`
const ORIGEM_FIELD = 975168
const MAX_IDS = 500

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin === KOMMO_BASE ? KOMMO_BASE : 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Auth-Token, Content-Type, X-Requested-With',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
})

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } })
}

// ---------- Kommo ----------
const KH = () => ({ Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}` })
async function kommoGet(path: string): Promise<any> {
  for (let i = 1; ; i++) {
    const r = await fetch(`${KOMMO_BASE}${path}`, { headers: KH() })
    if (r.status === 204) return null
    if (r.ok) return r.json()
    if ((r.status === 429 || r.status >= 500) && i < 3) { await new Promise((ok) => setTimeout(ok, 800 * i)); continue }
    throw new Error(`kommo ${path.split('?')[0]} ${r.status}`)
  }
}
const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

let cacheEtapas: { em: number; mapa: Map<number, string> } | null = null
async function etapas(): Promise<Map<number, string>> {
  if (cacheEtapas && Date.now() - cacheEtapas.em < 10 * 60_000) return cacheEtapas.mapa
  const j = await kommoGet('/api/v4/leads/pipelines')
  const m = new Map<number, string>()
  for (const p of j?._embedded?.pipelines ?? []) for (const s of p?._embedded?.statuses ?? []) m.set(Number(s.id), String(s.name))
  cacheEtapas = { em: Date.now(), mapa: m }
  return m
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405, origin)

  // ---- 1) identidade ----
  const secret = Deno.env.get('KOMMO_WIDGET_SECRET'), clientId = Deno.env.get('KOMMO_WIDGET_CLIENT_ID'), contaId = Deno.env.get('KOMMO_ACCOUNT_ID')
  if (!secret || !clientId || !contaId) return json({ erro: 'nao_configurado' }, 503, origin)
  const v = await verificarJwtKommo(req.headers.get('X-Auth-Token') ?? '', { secret, contaId, host: `${SUB}.kommo.com`, clientId })
  if (!v.ok) return json({ erro: v.erro }, 401, origin)
  const userId = v.userId

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: membro } = await sb.from('team_members').select('id,active,role').eq('kommo_user_id', userId).maybeSingle()
  if (!membro?.active) return json({ erro: 'usuario_inativo' }, 403, origin)
  const gestores = new Set(String(Deno.env.get('PREVENDAS_GESTORES') ?? '').split(',').map((s) => Number(s.trim())).filter(Boolean))
  const ehGestor = gestores.has(userId)

  // ---- 2) leitura: confere cada tarefa ----
  let body: any
  try { body = await req.json() } catch { return json({ erro: 'json' }, 400, origin) }
  const ids = [...new Set((Array.isArray(body?.task_ids) ? body.task_ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS) as number[]
  if (!ids.length) return json({ ok: true, tarefas: [], negadas: 0 }, 200, origin)

  try {
    const tarefas: any[] = []
    for (const lote of chunks(ids, 50)) {
      const q = lote.map((id) => `filter[id][]=${id}`).join('&')
      const j = await kommoGet(`/api/v4/tasks?${q}&limit=50`)
      tarefas.push(...(j?._embedded?.tasks ?? []))
    }
    const permitidas = tarefas.filter((t) => !t.is_completed && (Number(t.responsible_user_id) === userId || ehGestor))
    const negadas = ids.length - permitidas.length

    // leads das tarefas permitidas (origem, etapa, nome) — só depois da checagem
    const leadIds = [...new Set(permitidas.filter((t) => t.entity_type === 'leads' && t.entity_id).map((t) => Number(t.entity_id)))]
    const leads = new Map<number, { nome: string; etapa: string | null; origem: string | null }>()
    const mapaEtapas = leadIds.length ? await etapas() : new Map()
    for (const lote of chunks(leadIds, 50)) {
      const q = lote.map((id) => `filter[id][]=${id}`).join('&')
      const j = await kommoGet(`/api/v4/leads?${q}&limit=50`)
      for (const l of j?._embedded?.leads ?? []) {
        const cf = (l.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === ORIGEM_FIELD)
        leads.set(Number(l.id), { nome: String(l.name ?? ''), etapa: mapaEtapas.get(Number(l.status_id)) ?? null, origem: cf?.values?.[0]?.value ?? null })
      }
    }

    // slots da cadência (reuniões recentes)
    const desde = new Date(Date.now() - 30 * 86400_000).toISOString()
    const { data: reunioes } = await sb.from('reunioes').select('cadencia_task_ids').not('cadencia_task_ids', 'is', null).gte('data_reuniao', desde)
    const slotDe = mapaSlots(reunioes ?? [])

    let tiposMomento: Record<number, Momento> = {}
    try { tiposMomento = JSON.parse(Deno.env.get('PREVENDAS_TIPOS_MOMENTO') ?? '{}') } catch { tiposMomento = {} }

    const out = permitidas.map((t) => {
      const lead = t.entity_type === 'leads' ? leads.get(Number(t.entity_id)) ?? null : null
      const c = classificar({ id: t.id, task_type_id: t.task_type_id ?? null, text: t.text ?? null }, slotDe.get(Number(t.id)) ?? null, lead, tiposMomento)
      return { id: t.id, ...c, lead_nome: lead?.nome ?? null, etapa: lead?.etapa ?? null }
    })
    return json({ ok: true, tarefas: out, negadas }, 200, origin)
  } catch (e) {
    console.error('[prevendas-classificar]', (e as Error).message)
    return json({ erro: 'falha_kommo' }, 502, origin)
  }
})
