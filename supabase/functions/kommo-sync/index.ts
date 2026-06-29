// kommo-sync (Fase 5) — réplica completa SalesHub <-> Kommo, fatiada por CURSOR.
// Escreve via wrappers public.kommo_bulk_* / kommo_sync_get/set (schema kommo FECHADO,
// não exposto no PostgREST). Réplica é SOMENTE LEITURA do ponto de vista do Kommo.
//
// FULL fatiado: MAX_PAGES_PER_RUN páginas/entidade por invocação; cursor em kommo.sync_status;
// depois de full_done -> DELTA por updated_at. Chamada por cron (pg_net) com ?secret=.
//
// Trigger (POST, autenticado por ?secret= ou Bearer): { "entity":"all"|..., "full":false }
// Deploy: --no-verify-jwt (auth é o segredo). Secret: KOMMO_SYNC_SECRET.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const MAX_PAGES_PER_RUN = 8
const EVENT_BACKFILL_DAYS = 90
const TOUCH_TYPES = new Set([
  'outgoing_chat_message','incoming_chat_message','talk_created','conversation_answered','entity_direct_message','lead_status_changed',
])
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

class RateLimiter {
  private q: number[] = []
  constructor(private max = 7, private win = 1100) {}
  async acquire() {
    for (;;) {
      const now = Date.now(); this.q = this.q.filter((t) => now - t < this.win)
      if (this.q.length < this.max) { this.q.push(now); return }
      await new Promise((r) => setTimeout(r, this.win / this.max))
    }
  }
}
const tsISO = (e?: number | null) => (e ? new Date(e * 1000).toISOString() : null)

async function getKommoToken(sb: any): Promise<string | null> {
  const { data } = await sb.from('integracao_config').select('value').eq('key', 'kommo_access_token').maybeSingle()
  return data?.value || null
}
function makeClient(token: string, rl: RateLimiter) {
  return async function kget(path: string): Promise<any> {
    for (let i = 0; i < 6; i++) {
      await rl.acquire()
      const r = await fetch(`${KOMMO_BASE}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } })
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 2 ** i * 1000)); continue }
      if (r.status === 204) return {}
      if (!r.ok) throw new Error(`Kommo ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`)
      return await r.json()
    }
    throw new Error('Kommo rate limit')
  }
}
const embed = (d: any) => { const k = Object.keys(d?._embedded ?? {})[0]; return k ? d._embedded[k] : [] }

async function getStatus(sb: any, entity: string) {
  const { data } = await sb.rpc('kommo_sync_get', { p_entity: entity })
  return data?.[0] ?? { full_done: false, full_page: null, last_delta_at: null }
}
async function setStatus(sb: any, entity: string, patch: any) {
  await sb.rpc('kommo_sync_set', {
    p_entity: entity, p_status: patch.status ?? null, p_full_done: patch.full_done ?? null,
    p_full_page: patch.full_page ?? null, p_reset_page: patch.reset_page ?? false,
    p_last_delta_at: patch.last_delta_at ?? null, p_error: patch.error ?? null, p_count: patch.count ?? null,
  })
}
const bulk = (sb: any, name: string, rows: any[]) => (rows.length ? sb.rpc('kommo_bulk_' + name, { p: rows }) : Promise.resolve())

async function syncEntity(sb: any, kget: any, entity: string, base: string, table: string, map: (x: any) => any, full: boolean, afterPage?: (items: any[]) => Promise<void>) {
  const st = await getStatus(sb, entity)
  const doFull = full || !st.full_done
  let count = 0, maxUpdated = st.last_delta_at ?? 0
  if (doFull) {
    let page = full ? 1 : (st.full_page ?? 1)
    await setStatus(sb, entity, { status: 'running' })
    for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
      const qs = new URLSearchParams({ 'order[updated_at]': 'asc', limit: '250', page: String(page) }).toString()
      const d = await kget(`${base}?${qs}`); const items = embed(d)
      if (!items.length) { await setStatus(sb, entity, { status: 'done', full_done: true, reset_page: true, last_delta_at: maxUpdated, count }); return { entity, done: true, count } }
      await bulk(sb, table, items.map(map).filter(Boolean))
      if (afterPage) await afterPage(items)
      for (const it of items) if (it.updated_at > maxUpdated) maxUpdated = it.updated_at
      count += items.length; page++
      if (!d?._links?.next) { await setStatus(sb, entity, { status: 'done', full_done: true, reset_page: true, last_delta_at: maxUpdated, count }); return { entity, done: true, count } }
    }
    await setStatus(sb, entity, { status: 'running', full_page: page, last_delta_at: maxUpdated })
    return { entity, done: false, next_page: page, count }
  }
  let page = 1
  for (;;) {
    const params: Record<string, string> = { 'order[updated_at]': 'asc', limit: '250', page: String(page) }
    if (st.last_delta_at) params['filter[updated_at][from]'] = String(st.last_delta_at)
    const d = await kget(`${base}?${new URLSearchParams(params).toString()}`); const items = embed(d)
    if (!items.length) break
    await bulk(sb, table, items.map(map).filter(Boolean))
    if (afterPage) await afterPage(items)
    for (const it of items) if (it.updated_at > maxUpdated) maxUpdated = it.updated_at
    count += items.length
    if (!d?._links?.next) break
    page++
  }
  await setStatus(sb, entity, { status: 'done', last_delta_at: maxUpdated, count })
  return { entity, done: true, count }
}

async function syncEvents(sb: any, kget: any, full: boolean) {
  const st = await getStatus(sb, 'events')
  const from = (!full && st.last_delta_at) ? st.last_delta_at : Math.floor(Date.now() / 1000) - EVENT_BACKFILL_DAYS * 86400
  let page = full ? 1 : (st.full_page ?? 1), count = 0, maxCreated = st.last_delta_at ?? from
  await setStatus(sb, 'events', { status: 'running' })
  for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
    const qs = new URLSearchParams({ 'filter[created_at][from]': String(from), limit: '250', page: String(page) }).toString()
    const d = await kget(`/events?${qs}`); const items = embed(d)
    if (!items.length) { await setStatus(sb, 'events', { status: 'done', full_done: true, reset_page: true, last_delta_at: maxCreated, count }); return { entity: 'events', done: true, count } }
    for (const e of items) if (e.created_at > maxCreated) maxCreated = e.created_at
    const rows = items.filter((e: any) => TOUCH_TYPES.has(e.type)).map((e: any) => ({ id: e.id, type: e.type, entity_type: e.entity_type, entity_id: e.entity_id, created_by: e.created_by, kommo_created_at: tsISO(e.created_at) }))
    await bulk(sb, 'events', rows); count += rows.length; page++
    if (!d?._links?.next) { await setStatus(sb, 'events', { status: 'done', full_done: true, reset_page: true, last_delta_at: maxCreated, count }); return { entity: 'events', done: true, count } }
  }
  await setStatus(sb, 'events', { status: 'running', full_page: page, last_delta_at: maxCreated })
  return { entity: 'events', done: false, next_page: page, count }
}

async function syncPipelines(sb: any, kget: any) {
  const d = await kget('/leads/pipelines'); const pipes: any[] = [], stages: any[] = []
  for (const p of d?._embedded?.pipelines ?? []) {
    pipes.push({ id: p.id, name: p.name, sort: p.sort, is_main: p.is_main })
    for (const s of p?._embedded?.statuses ?? []) stages.push({ id: s.id, pipeline_id: p.id, name: s.name, sort: s.sort, type: s.type })
  }
  await bulk(sb, 'pipelines', pipes); await bulk(sb, 'stages', stages)
  await setStatus(sb, 'pipelines', { status: 'done', full_done: true, count: pipes.length })
  return { entity: 'pipelines', done: true, count: pipes.length }
}
async function syncUsers(sb: any, kget: any) {
  const rows = (embed(await kget('/users?limit=250')) as any[]).map((u) => ({ id: u.id, name: u.name, email: u.email, role_id: u.rights?.role_id ?? null, is_active: u.rights?.is_active ?? null }))
  await bulk(sb, 'users', rows); await setStatus(sb, 'users', { status: 'done', full_done: true, count: rows.length })
  return { entity: 'users', done: true, count: rows.length }
}
async function syncCustomFields(sb: any, kget: any) {
  let total = 0
  for (const et of ['leads', 'contacts', 'companies']) {
    const rows = (embed(await kget(`/${et}/custom_fields?limit=250`)) as any[]).map((f) => ({ id: f.id, entity_type: et, name: f.name, code: f.code, type: f.type, enums: f.enums ?? null }))
    await bulk(sb, 'custom_fields', rows); total += rows.length
  }
  await setStatus(sb, 'custom_fields', { status: 'done', full_done: true, count: total })
  return { entity: 'custom_fields', done: true, count: total }
}
async function upsertLeadLinks(sb: any, items: any[]) {
  const lc: any[] = [], lk: any[] = []
  for (const L of items) {
    for (const c of L?._embedded?.contacts ?? []) lc.push({ lead_id: L.id, contact_id: c.id, is_main: c.is_main ?? false })
    for (const co of L?._embedded?.companies ?? []) lk.push({ lead_id: L.id, company_id: co.id })
  }
  await bulk(sb, 'lead_contacts', lc); await bulk(sb, 'lead_companies', lk)
}

const mapLead = (x: any) => ({ id: x.id, name: x.name, pipeline_id: x.pipeline_id, status_id: x.status_id, responsible_user_id: x.responsible_user_id, price: x.price, custom_fields: x.custom_fields_values ?? null, is_deleted: false, kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at) })
const mapContact = (x: any) => ({ id: x.id, name: x.name, first_name: x.first_name, last_name: x.last_name, responsible_user_id: x.responsible_user_id, custom_fields: x.custom_fields_values ?? null, is_deleted: false, kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at) })
const mapCompany = (x: any) => ({ id: x.id, name: x.name, responsible_user_id: x.responsible_user_id, custom_fields: x.custom_fields_values ?? null, is_deleted: false, kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at) })
const mapTask = (x: any) => ({ id: x.id, entity_type: x.entity_type, entity_id: x.entity_id, responsible_user_id: x.responsible_user_id, is_completed: x.is_completed, task_type_id: x.task_type_id, text: x.text, complete_till: tsISO(x.complete_till), kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at) })
const mapNote = (x: any) => ({ id: x.id, entity_type: 'leads', entity_id: x.entity_id, note_type: x.note_type, created_by: x.created_by, params: x.params ?? null, kommo_created_at: tsISO(x.created_at), kommo_updated_at: tsISO(x.updated_at) })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const secret = bearer || url.searchParams.get('secret') || ''
  const expected = Deno.env.get('KOMMO_SYNC_SECRET')
  if (!expected || secret !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: cors })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const token = await getKommoToken(sb)
    if (!token) throw new Error('kommo_access_token ausente em integracao_config')
    const body = await req.json().catch(() => ({}))
    const entity = body.entity ?? 'all'; const full = !!body.full
    const kget = makeClient(token, new RateLimiter())
    const wants = (e: string) => entity === 'all' || entity === e
    const out: any[] = []
    if (wants('users')) out.push(await syncUsers(sb, kget))
    if (wants('pipelines')) out.push(await syncPipelines(sb, kget))
    if (wants('custom_fields')) out.push(await syncCustomFields(sb, kget))
    if (wants('leads')) out.push(await syncEntity(sb, kget, 'leads', '/leads?with=contacts,companies', 'leads', mapLead, full, (items) => upsertLeadLinks(sb, items)))
    if (wants('contacts')) out.push(await syncEntity(sb, kget, 'contacts', '/contacts', 'contacts', mapContact, full))
    if (wants('companies')) out.push(await syncEntity(sb, kget, 'companies', '/companies', 'companies', mapCompany, full))
    if (wants('tasks')) out.push(await syncEntity(sb, kget, 'tasks', '/tasks', 'tasks', mapTask, full))
    if (wants('notes')) out.push(await syncEntity(sb, kget, 'notes', '/leads/notes', 'notes', mapNote, full))
    if (wants('events')) out.push(await syncEvents(sb, kget, full))
    const pending = out.some((o) => o && o.done === false)
    return new Response(JSON.stringify({ ok: true, pending, result: out }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('kommo-sync error', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors })
  }
})
