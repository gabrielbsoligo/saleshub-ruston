// kommo-sync/sync.ts — estado de sincronização e paginação por cursor, separados do index.ts para
// serem testáveis com fakes (sb com rpc em memória + kget servindo páginas). Política pura da
// janela/página em reconcile.ts (janelaEventos/paginaFull).
import { janelaEventos, montarUrl, paginaFull, type EstadoSync } from './reconcile.ts'

export const MAX_PAGES_PER_RUN = 8
export const EVENT_BACKFILL_DAYS = 90
export const TOUCH_TYPES = new Set([
  'outgoing_chat_message','incoming_chat_message','talk_created','conversation_answered','entity_direct_message','lead_status_changed',
])
export const tsISO = (e?: number | null) => (e ? new Date(e * 1000).toISOString() : null)
export const embed = (d: any) => { const k = Object.keys(d?._embedded ?? {})[0]; return k ? d._embedded[k] : [] }

export async function getStatus(sb: any, entity: string): Promise<EstadoSync> {
  const { data, error } = await sb.rpc('kommo_sync_get_v2', { p_entity: entity })
  if (error) throw new GravacaoFalhou(entity, `kommo_sync_get_v2(${entity}): ${error.message}`) // nunca tratar falha de leitura como estado inicial
  const r = data?.[0]
  return r ? { full_done: !!r.full_done, full_page: r.full_page ?? null, last_delta_at: r.last_delta_at ?? null, full_cursor: r.full_cursor ?? null } : { full_done: false, full_page: null, last_delta_at: null, full_cursor: null }
}
export class GravacaoFalhou extends Error { constructor(public entity: string, msg: string) { super(msg) } }
// Uma única RPC grava status/modo/página/cursor ATOMICAMENTE (abertura de backfill = 1 instrução:
// não existe estado intermediário "modo gravado, janela não"). patch.cursor: undefined = mantém,
// null = limpa, objeto = grava JSON.
export async function setStatus(sb: any, entity: string, patch: any) {
  const temCursor = 'cursor' in patch
  const { error } = await sb.rpc('kommo_sync_set_v2', {
    p_entity: entity, p_status: patch.status ?? null, p_full_done: patch.full_done ?? null,
    p_full_page: patch.full_page ?? null, p_reset_page: patch.reset_page ?? false,
    p_last_delta_at: patch.last_delta_at ?? null, p_error: patch.error ?? null, p_count: patch.count ?? null,
    p_set_cursor: temCursor, p_cursor: temCursor && patch.cursor != null ? JSON.stringify(patch.cursor) : null,
  })
  if (error) throw new GravacaoFalhou(entity, `kommo_sync_set_v2(${entity}): ${error.message}`)
}
// grava e CONFERE: erro de gravação lança (quem chamou não avança cursor nem marca done)
export async function bulk(sb: any, name: string, rows: any[]) {
  if (!rows.length) return 0
  const { data, error } = await sb.rpc('kommo_bulk_' + name, { p: rows })
  if (error) throw new GravacaoFalhou(name, `kommo_bulk_${name}: ${error.message}`)
  return Number(data ?? 0)
}

export async function syncEntity(sb: any, kget: any, entity: string, base: string, table: string, map: (x: any) => any, full: boolean, afterPage?: (items: any[]) => Promise<void>) {
  const st = await getStatus(sb, entity)
  const pf = paginaFull(st, full)
  const doFull = pf.doFull
  let count = 0, maxUpdated = pf.max
  if (doFull) {
    let page = pf.page
    // full:true vira MODO persistido (full_done=false, page=1, cursor zerado) numa ÚNICA gravação:
    // as rodadas seguintes (full:false do cron) continuam o backfill de onde parou, retomando o max
    await setStatus(sb, entity, pf.iniciar ? { status: 'running', full_done: false, full_page: 1, cursor: { max: maxUpdated } } : { status: 'running' })
    const concluir = async () => { await setStatus(sb, entity, { status: 'done', full_done: true, reset_page: true, last_delta_at: maxUpdated, count, cursor: null }); return { entity, done: true, count } }
    for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
      const d = await kget(montarUrl(base, { 'order[updated_at]': 'asc', limit: '250', page: String(page) })); const items = embed(d)
      if (!items.length) return await concluir()
      await bulk(sb, table, items.map(map).filter(Boolean))   // lança se falhar: cursor não avança
      if (afterPage) await afterPage(items)
      for (const it of items) if (it.updated_at > maxUpdated) maxUpdated = it.updated_at
      count += items.length; page++
      if (!d?._links?.next) return await concluir()
    }
    // SEM last_delta_at (consolida só no fim); página + maior updated_at visto viajam no cursor
    await setStatus(sb, entity, { status: 'running', full_page: page, cursor: { max: maxUpdated } })
    return { entity, done: false, next_page: page, count }
  }
  let page = 1
  for (;;) {
    const params: Record<string, string> = { 'order[updated_at]': 'asc', limit: '250', page: String(page) }
    if (st.last_delta_at) params['filter[updated_at][from]'] = String(st.last_delta_at)
    const d = await kget(montarUrl(base, params)); const items = embed(d)
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

// Eventos vêm em ordem DECRESCENTE e a paginação é por offset: a janela (filter[created_at][from])
// precisa ficar ESTÁVEL enquanto se pagina. Por isso o cursor last_delta_at só é consolidado quando
// a paginação termina (antes, uma rodada parcial gravava page=9 + cursor novo e a próxima paginava
// outro conjunto, pulando os eventos antigos). Eventos repetidos entre rodadas são inofensivos
// (kommo_bulk_events é upsert).
export async function syncEvents(sb: any, kget: any, full: boolean) {
  const st = await getStatus(sb, 'events')
  const j = janelaEventos(st, full, Math.floor(Date.now() / 1000), EVENT_BACKFILL_DAYS)
  const from = j.from
  let page = j.page, count = 0, maxCreated = Math.max(j.max, from)
  // janela FIXA + maior created_at já visto gravados juntos em full_cursor enquanto a paginação
  // atravessa invocações (inclusive com cursor inicial nulo); full:true persiste o modo backfill
  // (full_done=false, page=1, janela nova) na MESMA gravação — não há estado intermediário
  await setStatus(sb, 'events', { status: 'running', ...(j.iniciarBackfill ? { full_done: false, full_page: 1 } : {}), cursor: { from, max: maxCreated } })
  const concluir = async () => { await setStatus(sb, 'events', { status: 'done', full_done: true, reset_page: true, last_delta_at: maxCreated, count, cursor: null }); return { entity: 'events', done: true, count } }
  for (let i = 0; i < MAX_PAGES_PER_RUN; i++) {
    const d = await kget(montarUrl('/events', { 'filter[created_at][from]': String(from), limit: '250', page: String(page) })); const items = embed(d)
    if (!items.length) return await concluir()
    for (const e of items) if (e.created_at > maxCreated) maxCreated = e.created_at
    const rows = items.filter((e: any) => TOUCH_TYPES.has(e.type)).map((e: any) => ({ id: e.id, type: e.type, entity_type: e.entity_type, entity_id: e.entity_id, created_by: e.created_by, kommo_created_at: tsISO(e.created_at) }))
    await bulk(sb, 'events', rows); count += rows.length; page++
    if (!d?._links?.next) return await concluir()
  }
  await setStatus(sb, 'events', { status: 'running', full_page: page, cursor: { from, max: maxCreated } }) // SEM last_delta_at: janela segue a mesma; max retomado na próxima fatia
  return { entity: 'events', done: false, next_page: page, count }
}

