// kommo-sync — Fase 1 da réplica SalesHub <-> Kommo.
// Sincroniza (full + delta) leads, stages, tasks, notes e eventos-de-toque do Kommo
// para o schema `kommo`. Réplica é SOMENTE LEITURA; escrita só pela API do Kommo.
//
// Trigger (POST):
//   { "entity": "all" | "leads" | "stages" | "tasks" | "notes" | "events", "full": false }
// Backfill de eventos: janela de 90 dias (decisão do projeto); daí pra frente, webhook.
//
// Convenções: token em integracao_config(key='kommo_access_token'); supabase-js + service role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const EVENT_BACKFILL_DAYS = 90
// Tipos de TOQUE espelhados em kommo.events (seletivo, NÃO o firehose):
const TOUCH_TYPES = new Set([
  'outgoing_chat_message', 'incoming_chat_message', 'talk_created',
  'conversation_answered', 'entity_direct_message', 'lead_status_changed',
])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Rate limiter token-bucket, ~7 req/s.
class RateLimiter {
  private queue: number[] = []
  constructor(private max = 7, private windowMs = 1100) {}
  async acquire() {
    for (;;) {
      const now = Date.now()
      this.queue = this.queue.filter((t) => now - t < this.windowMs)
      if (this.queue.length < this.max) { this.queue.push(now); return }
      await new Promise((r) => setTimeout(r, this.windowMs / this.max))
    }
  }
}

function tsISO(epoch?: number | null) {
  return epoch ? new Date(epoch * 1000).toISOString() : null
}

async function getKommoToken(supabase: any): Promise<string | null> {
  const { data } = await supabase.from('integracao_config').select('value')
    .eq('key', 'kommo_access_token').maybeSingle()
  return data?.value || null
}

function makeClient(token: string, rl: RateLimiter) {
  return async function kget(path: string): Promise<any> {
    for (let i = 0; i < 6; i++) {
      await rl.acquire()
      const r = await fetch(`${KOMMO_BASE}/api/v4${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 2 ** i * 1000)); continue }
      if (r.status === 204) return {}
      if (!r.ok) throw new Error(`Kommo ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`)
      return await r.json()
    }
    throw new Error('Kommo rate limit exhausted')
  }
}

// Paginação genérica /api/v4 (250/página, order updated_at).
async function* paginate(kget: any, base: string, params: Record<string, string | number>) {
  let page = 1
  for (;;) {
    const qs = new URLSearchParams({ ...params, limit: '250', page: String(page) } as any).toString()
    const d = await kget(`${base}?${qs}`)
    const key = Object.keys(d?._embedded ?? {})[0]
    const items = key ? d._embedded[key] : []
    if (!items?.length) return
    yield items
    if (!d?._links?.next) return
    page++
  }
}

async function setStatus(supabase: any, entity: string, patch: Record<string, unknown>) {
  await supabase.schema('kommo').from('sync_status')
    .upsert({ entity, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'entity' })
}

async function syncStages(supabase: any, kget: any) {
  const d = await kget('/leads/pipelines')
  const rows: any[] = []
  for (const p of d?._embedded?.pipelines ?? []) {
    for (const s of p?._embedded?.statuses ?? []) {
      rows.push({ id: s.id, pipeline_id: p.id, name: s.name, sort: s.sort, type: s.type,
        synced_at: new Date().toISOString() })
    }
  }
  if (rows.length) await supabase.schema('kommo').from('stages').upsert(rows, { onConflict: 'id' })
  await setStatus(supabase, 'stages', { status: 'done', count: rows.length })
  return rows.length
}

async function syncSimple(
  supabase: any, kget: any, entity: string, base: string, table: string,
  map: (x: any) => any, full: boolean,
) {
  await setStatus(supabase, entity, { status: 'running' })
  const { data: st } = await supabase.schema('kommo').from('sync_status')
    .select('last_delta_at').eq('entity', entity).maybeSingle()
  const params: Record<string, string | number> = { 'order[updated_at]': 'asc' }
  if (!full && st?.last_delta_at) params['filter[updated_at][from]'] = st.last_delta_at
  let count = 0, maxUpdated = st?.last_delta_at ?? 0
  try {
    for await (const items of paginate(kget, base, params)) {
      const rows = items.map(map).filter(Boolean)
      for (const it of items) if (it.updated_at > maxUpdated) maxUpdated = it.updated_at
      if (rows.length) await supabase.schema('kommo').from(table).upsert(rows, { onConflict: 'id' })
      count += rows.length
    }
    await setStatus(supabase, entity, { status: 'done', count, last_delta_at: maxUpdated, error_message: null })
  } catch (e) {
    await setStatus(supabase, entity, { status: 'error', error_message: String(e) })
    throw e
  }
  return count
}

async function syncEvents(supabase: any, kget: any, full: boolean) {
  await setStatus(supabase, 'events', { status: 'running' })
  const { data: st } = await supabase.schema('kommo').from('sync_status')
    .select('last_delta_at').eq('entity', 'events').maybeSingle()
  const from = !full && st?.last_delta_at
    ? st.last_delta_at
    : Math.floor(Date.now() / 1000) - EVENT_BACKFILL_DAYS * 86400
  let count = 0, maxCreated = from
  try {
    for await (const items of paginate(kget, '/events', { 'filter[created_at][from]': from })) {
      for (const e of items) if (e.created_at > maxCreated) maxCreated = e.created_at
      const rows = items.filter((e: any) => TOUCH_TYPES.has(e.type)).map((e: any) => ({
        id: e.id, type: e.type, entity_type: e.entity_type, entity_id: e.entity_id,
        created_by: e.created_by, kommo_created_at: tsISO(e.created_at),
        synced_at: new Date().toISOString(),
      }))
      if (rows.length) await supabase.schema('kommo').from('events').upsert(rows, { onConflict: 'id' })
      count += rows.length
    }
    await setStatus(supabase, 'events', { status: 'done', count, last_delta_at: maxCreated, error_message: null })
  } catch (e) {
    await setStatus(supabase, 'events', { status: 'error', error_message: String(e) })
    throw e
  }
  return count
}

const mapLead = (x: any) => ({
  id: x.id, name: x.name, pipeline_id: x.pipeline_id, status_id: x.status_id,
  responsible_user_id: x.responsible_user_id, price: x.price,
  custom_fields: x.custom_fields_values ?? null, is_deleted: false,
  kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at),
  synced_at: new Date().toISOString(),
})
const mapTask = (x: any) => ({
  id: x.id, entity_type: x.entity_type, entity_id: x.entity_id,
  responsible_user_id: x.responsible_user_id, is_completed: x.is_completed,
  task_type_id: x.task_type_id, text: x.text, complete_till: tsISO(x.complete_till),
  kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at),
  synced_at: new Date().toISOString(),
})
const mapNote = (x: any) => ({
  id: x.id, entity_type: 'leads', entity_id: x.entity_id, note_type: x.note_type,
  created_by: x.created_by, params: x.params ?? null,
  kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at),
  synced_at: new Date().toISOString(),
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const token = await getKommoToken(supabase)
    if (!token) throw new Error('kommo_access_token ausente em integracao_config')
    const body = await req.json().catch(() => ({}))
    const entity = body.entity ?? 'all'
    const full = !!body.full
    const rl = new RateLimiter()
    const kget = makeClient(token, rl)

    const out: Record<string, number> = {}
    const wants = (e: string) => entity === 'all' || entity === e
    if (wants('stages')) out.stages = await syncStages(supabase, kget)
    if (wants('leads')) out.leads = await syncSimple(supabase, kget, 'leads', '/leads', 'leads', mapLead, full)
    if (wants('tasks')) out.tasks = await syncSimple(supabase, kget, 'tasks', '/tasks', 'tasks', mapTask, full)
    if (wants('notes')) out.notes = await syncSimple(supabase, kget, 'notes', '/leads/notes', 'notes', mapNote, full)
    if (wants('events')) out.events = await syncEvents(supabase, kget, full)

    return new Response(JSON.stringify({ ok: true, synced: out }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('kommo-sync error', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
