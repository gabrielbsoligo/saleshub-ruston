// kommo-sync (Fase 2) — réplica completa SalesHub <-> Kommo, fatiada por CURSOR.
// Sincroniza users, pipelines/stages, leads (+associações), contacts, companies,
// tasks, notes, custom_fields e eventos-de-toque para o schema `kommo`.
// Réplica é SOMENTE LEITURA; escrita só pela API do Kommo.
//
// FULL fatiado: cada invocação processa até MAX_PAGES_PER_RUN páginas por entidade,
// persiste o cursor (full_page) em kommo.sync_status e retorna {done|continue}. Um
// agendador (Supabase Cron) reinvoca até full_done; depois disso roda DELTA por updated_at.
//
// Trigger (POST): { "entity": "all"|"users"|"pipelines"|"leads"|"contacts"|"companies"
//                              |"tasks"|"notes"|"events"|"custom_fields", "full": false }
//
// Convenções: token em integracao_config(key='kommo_access_token'); supabase-js + service role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const MAX_PAGES_PER_RUN = 8          // fatia: nº de páginas (250 itens) por invocação
const EVENT_BACKFILL_DAYS = 90
const TOUCH_TYPES = new Set([
  'outgoing_chat_message', 'incoming_chat_message', 'talk_created',
  'conversation_answered', 'entity_direct_message', 'lead_status_changed',
])
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

class RateLimiter {
  private q: number[] = []
  constructor(private max = 7, private win = 1100) {}
  async acquire() {
    for (;;) {
      const now = Date.now()
      this.q = this.q.filter((t) => now - t < this.win)
      if (this.q.length < this.max) { this.q.push(now); return }
      await new Promise((r) => setTimeout(r, this.win / this.max))
    }
  }
}
const tsISO = (e?: number | null) => (e ? new Date(e * 1000).toISOString() : null)

async function getKommoToken(supabase: any): Promise<string | null> {
  const { data } = await supabase.from('integracao_config').select('value')
    .eq('key', 'kommo_access_token').maybeSingle()
  return data?.value || null
}

function makeClient(token: string, rl: RateLimiter) {
  return async function kget(path: string): Promise<any> {
    for (let i = 0; i < 6; i++) {
      await rl.acquire()
      const r = await fetch(`${KOMMO_BASE}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } })
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 2 ** i * 1000)); continue }
      if (r.status === 204) return {}
      if (!r.ok) throw new Error(`Kommo ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`)
      return await r.json()
    }
    throw new Error('Kommo rate limit')
  }
}

async function getStatus(supabase: any, entity: string) {
  const { data } = await supabase.schema('kommo').from('sync_status')
    .select('*').eq('entity', entity).maybeSingle()
  return data ?? { entity, full_done: false, full_page: null, last_delta_at: null }
}
async function setStatus(supabase: any, entity: string, patch: Record<string, unknown>) {
  await supabase.schema('kommo').from('sync_status')
    .upsert({ entity, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'entity' })
}
const embed = (d: any) => { const k = Object.keys(d?._embedded ?? {})[0]; return k ? d._embedded[k] : [] }

// Sync genérico paginado por entidade-tempo (leads/contacts/companies/tasks).
// Fatiado por cursor no full; delta por updated_at depois.
async function syncEntity(
  supabase: any, kget: any, entity: string, base: string, table: string,
  map: (x: any) => any, full: boolean, afterPage?: (items: any[]) => Promise<void>,
) {
  const st = await getStatus(supabase, entity)
  const doFull = full || !st.full_done
  let count = 0, maxUpdated = st.last_delta_at ?? 0

  if (doFull) {
    let page = (full ? 1 : (st.full_page ?? 1))
    await setStatus(supabase, entity, { status: 'running', full_started_at: st.full_started_at ?? new Date().toISOString() })
    for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
      const qs = new URLSearchParams({ 'order[updated_at]': 'asc', limit: '250', page: String(page) }).toString()
      const d = await kget(`${base}?${qs}`)
      const items = embed(d)
      if (!items.length) { await setStatus(supabase, entity, { status: 'done', full_done: true, full_page: null, last_delta_at: maxUpdated }); return { entity, done: true, count } }
      const rows = items.map(map).filter(Boolean)
      if (rows.length) await supabase.schema('kommo').from(table).upsert(rows, { onConflict: 'id' })
      if (afterPage) await afterPage(items)
      for (const it of items) if (it.updated_at > maxUpdated) maxUpdated = it.updated_at
      count += rows.length
      page++
      if (!d?._links?.next) { await setStatus(supabase, entity, { status: 'done', full_done: true, full_page: null, last_delta_at: maxUpdated }); return { entity, done: true, count } }
    }
    await setStatus(supabase, entity, { status: 'running', full_page: page, last_delta_at: maxUpdated })
    return { entity, done: false, next_page: page, count }
  }

  // DELTA (full já concluído): só o que mudou desde last_delta_at.
  let page = 1
  for (;;) {
    const params: Record<string, string> = { 'order[updated_at]': 'asc', limit: '250', page: String(page) }
    if (st.last_delta_at) params['filter[updated_at][from]'] = String(st.last_delta_at)
    const d = await kget(`${base}?${new URLSearchParams(params).toString()}`)
    const items = embed(d)
    if (!items.length) break
    const rows = items.map(map).filter(Boolean)
    if (rows.length) await supabase.schema('kommo').from(table).upsert(rows, { onConflict: 'id' })
    if (afterPage) await afterPage(items)
    for (const it of items) if (it.updated_at > maxUpdated) maxUpdated = it.updated_at
    count += rows.length
    if (!d?._links?.next) break
    page++
  }
  await setStatus(supabase, entity, { status: 'done', last_delta_at: maxUpdated })
  return { entity, done: true, count }
}

// Eventos de toque, fatiado por cursor (por created_at; backfill 90d no full).
async function syncEvents(supabase: any, kget: any, full: boolean) {
  const st = await getStatus(supabase, 'events')
  const from = (!full && st.last_delta_at)
    ? st.last_delta_at
    : Math.floor(Date.now() / 1000) - EVENT_BACKFILL_DAYS * 86400
  let page = (full ? 1 : (st.full_page ?? 1)), count = 0, maxCreated = st.last_delta_at ?? from
  await setStatus(supabase, 'events', { status: 'running' })
  for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
    const qs = new URLSearchParams({ 'filter[created_at][from]': String(from), limit: '250', page: String(page) }).toString()
    const d = await kget(`/events?${qs}`)
    const items = embed(d)
    if (!items.length) { await setStatus(supabase, 'events', { status: 'done', full_done: true, full_page: null, last_delta_at: maxCreated }); return { entity: 'events', done: true, count } }
    for (const e of items) if (e.created_at > maxCreated) maxCreated = e.created_at
    const rows = items.filter((e: any) => TOUCH_TYPES.has(e.type)).map((e: any) => ({
      id: e.id, type: e.type, entity_type: e.entity_type, entity_id: e.entity_id,
      created_by: e.created_by, kommo_created_at: tsISO(e.created_at), synced_at: new Date().toISOString(),
    }))
    if (rows.length) await supabase.schema('kommo').from('events').upsert(rows, { onConflict: 'id' })
    count += rows.length
    page++
    if (!d?._links?.next) { await setStatus(supabase, 'events', { status: 'done', full_done: true, full_page: null, last_delta_at: maxCreated }); return { entity: 'events', done: true, count } }
  }
  await setStatus(supabase, 'events', { status: 'running', full_page: page, last_delta_at: maxCreated })
  return { entity: 'events', done: false, next_page: page, count }
}

async function syncPipelines(supabase: any, kget: any) {
  const d = await kget('/leads/pipelines')
  const pipes: any[] = [], stages: any[] = []
  for (const p of d?._embedded?.pipelines ?? []) {
    pipes.push({ id: p.id, name: p.name, sort: p.sort, is_main: p.is_main, synced_at: new Date().toISOString() })
    for (const s of p?._embedded?.statuses ?? [])
      stages.push({ id: s.id, pipeline_id: p.id, name: s.name, sort: s.sort, type: s.type, synced_at: new Date().toISOString() })
  }
  if (pipes.length) await supabase.schema('kommo').from('pipelines').upsert(pipes, { onConflict: 'id' })
  if (stages.length) await supabase.schema('kommo').from('stages').upsert(stages, { onConflict: 'id' })
  await setStatus(supabase, 'pipelines', { status: 'done', full_done: true, count: pipes.length })
  return { entity: 'pipelines', done: true, count: pipes.length }
}

async function syncCustomFields(supabase: any, kget: any) {
  let total = 0
  for (const et of ['leads', 'contacts', 'companies']) {
    const d = await kget(`/${et}/custom_fields?limit=250`)
    const rows = (embed(d) as any[]).map((f) => ({
      id: f.id, entity_type: et, name: f.name, code: f.code, type: f.type,
      enums: f.enums ?? null, synced_at: new Date().toISOString(),
    }))
    if (rows.length) await supabase.schema('kommo').from('custom_fields').upsert(rows, { onConflict: 'id' })
    total += rows.length
  }
  await setStatus(supabase, 'custom_fields', { status: 'done', full_done: true, count: total })
  return { entity: 'custom_fields', done: true, count: total }
}

async function syncUsers(supabase: any, kget: any) {
  const d = await kget('/users?limit=250')
  const rows = (embed(d) as any[]).map((u) => ({
    id: u.id, name: u.name, email: u.email, role_id: u.rights?.role_id ?? null,
    is_active: u.rights?.is_active ?? null, synced_at: new Date().toISOString(),
  }))
  if (rows.length) await supabase.schema('kommo').from('users').upsert(rows, { onConflict: 'id' })
  await setStatus(supabase, 'users', { status: 'done', full_done: true, count: rows.length })
  return { entity: 'users', done: true, count: rows.length }
}

// Associações a partir do _embedded dos leads (with=contacts,companies).
async function upsertLeadLinks(supabase: any, items: any[]) {
  const lc: any[] = [], lk: any[] = []
  for (const L of items) {
    for (const c of L?._embedded?.contacts ?? [])
      lc.push({ lead_id: L.id, contact_id: c.id, is_main: c.is_main ?? false, synced_at: new Date().toISOString() })
    for (const co of L?._embedded?.companies ?? [])
      lk.push({ lead_id: L.id, company_id: co.id, synced_at: new Date().toISOString() })
  }
  if (lc.length) await supabase.schema('kommo').from('lead_contacts').upsert(lc, { onConflict: 'lead_id,contact_id' })
  if (lk.length) await supabase.schema('kommo').from('lead_companies').upsert(lk, { onConflict: 'lead_id,company_id' })
}

const mapLead = (x: any) => ({
  id: x.id, name: x.name, pipeline_id: x.pipeline_id, status_id: x.status_id,
  responsible_user_id: x.responsible_user_id, price: x.price,
  custom_fields: x.custom_fields_values ?? null, is_deleted: false,
  kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at), synced_at: new Date().toISOString(),
})
const mapContact = (x: any) => ({
  id: x.id, name: x.name, first_name: x.first_name, last_name: x.last_name,
  responsible_user_id: x.responsible_user_id, custom_fields: x.custom_fields_values ?? null,
  is_deleted: false, kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at), synced_at: new Date().toISOString(),
})
const mapCompany = (x: any) => ({
  id: x.id, name: x.name, responsible_user_id: x.responsible_user_id,
  custom_fields: x.custom_fields_values ?? null, is_deleted: false,
  kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at), synced_at: new Date().toISOString(),
})
const mapTask = (x: any) => ({
  id: x.id, entity_type: x.entity_type, entity_id: x.entity_id, responsible_user_id: x.responsible_user_id,
  is_completed: x.is_completed, task_type_id: x.task_type_id, text: x.text, complete_till: tsISO(x.complete_till),
  kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at), synced_at: new Date().toISOString(),
})
const mapNote = (x: any) => ({
  id: x.id, entity_type: 'leads', entity_id: x.entity_id, note_type: x.note_type, created_by: x.created_by,
  params: x.params ?? null, kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at), synced_at: new Date().toISOString(),
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const token = await getKommoToken(supabase)
    if (!token) throw new Error('kommo_access_token ausente em integracao_config')
    const body = await req.json().catch(() => ({}))
    const entity = body.entity ?? 'all'
    const full = !!body.full
    const kget = makeClient(token, new RateLimiter())
    const wants = (e: string) => entity === 'all' || entity === e

    const out: any[] = []
    // Ordem por dependência de FK. Entidades "metadados" são single-shot; as grandes, fatiadas.
    if (wants('users')) out.push(await syncUsers(supabase, kget))
    if (wants('pipelines')) out.push(await syncPipelines(supabase, kget))
    if (wants('custom_fields')) out.push(await syncCustomFields(supabase, kget))
    if (wants('leads')) out.push(await syncEntity(supabase, kget, 'leads', '/leads?with=contacts,companies', 'leads', mapLead, full, (items) => upsertLeadLinks(supabase, items)))
    if (wants('contacts')) out.push(await syncEntity(supabase, kget, 'contacts', '/contacts', 'contacts', mapContact, full))
    if (wants('companies')) out.push(await syncEntity(supabase, kget, 'companies', '/companies', 'companies', mapCompany, full))
    if (wants('tasks')) out.push(await syncEntity(supabase, kget, 'tasks', '/tasks', 'tasks', mapTask, full))
    if (wants('notes')) out.push(await syncEntity(supabase, kget, 'notes', '/leads/notes', 'notes', mapNote, full))
    if (wants('events')) out.push(await syncEvents(supabase, kget, full))

    const pending = out.some((o) => o && o.done === false)
    return new Response(JSON.stringify({ ok: true, pending, result: out }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('kommo-sync error', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
