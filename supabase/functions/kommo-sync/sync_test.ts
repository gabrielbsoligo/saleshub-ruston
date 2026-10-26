import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { syncEntity, syncEvents } from './sync.ts'

// sb fake: kommo.sync_status em memória, com a mesma semântica das RPCs (migration_048/158)
function sbFake() {
  const st: Record<string, any> = {}
  const gravados: any[] = []
  const row = (e: string) => (st[e] ??= { full_done: false, full_page: null, last_delta_at: null, full_cursor: null })
  const rpc = async (name: string, p: any) => {
    if (name === 'kommo_sync_get_v2') { const r = st[p.p_entity]; return { data: r ? [{ ...r }] : [], error: null } }
    if (name === 'kommo_sync_set') {
      const r = row(p.p_entity)
      if (p.p_full_done != null) r.full_done = p.p_full_done
      r.full_page = p.p_reset_page ? null : (p.p_full_page ?? r.full_page)
      if (p.p_last_delta_at != null) r.last_delta_at = p.p_last_delta_at
      return { data: null, error: null }
    }
    if (name === 'kommo_sync_set_cursor') { row(p.p_entity).full_cursor = p.p_cursor; return { data: null, error: null } }
    if (name.startsWith('kommo_bulk_')) { gravados.push(...p.p); return { data: p.p.length, error: null } }
    throw new Error('rpc inesperada ' + name)
  }
  return { sb: { rpc }, st, gravados }
}
// kget fake: N páginas de 2 itens, registra as URLs pedidas
function kgetFake(paginas: number, chave = 'tasks', createdAt = false) {
  const urls: string[] = []
  const fn = async (url: string) => {
    urls.push(url)
    const page = Number(new URL('http://x' + url).searchParams.get('page'))
    if (page > paginas) return {}
    const items = [1, 2].map((k) => createdAt ? { id: page * 10 + k, type: 'lead_status_changed', entity_type: 'lead', entity_id: 1, created_at: BASE + 1000 + page * 10 + k } : { id: page * 10 + k, updated_at: 1_000_000 + page * 10 + k })
    return { _embedded: { [chave]: items }, _links: page < paginas ? { next: {} } : undefined }
  }
  return { fn, urls }
}
const map = (x: any) => ({ id: x.id, kommo_updated_at: x.updated_at })
const AGORA = Math.floor(Date.now() / 1000), BASE = AGORA - 90 * 86400 // janela do backfill de eventos

Deno.test('full:true vira modo persistido: rodadas full:false seguintes continuam da página gravada até o fim (20 páginas = 3 invocações); cursor só consolida no fim', async () => {
  const { sb, st, gravados } = sbFake(); const k = kgetFake(20)
  st.tasks = { full_done: true, full_page: null, last_delta_at: 999, full_cursor: null } // entidade já tinha terminado o full
  const r1 = await syncEntity(sb, k.fn, 'tasks', '/tasks', 'tasks', map, true)
  assertEquals(r1.done, false); assertEquals(st.tasks.full_done, false); assertEquals(st.tasks.full_page, 9); assertEquals(st.tasks.last_delta_at, 999)
  const r2 = await syncEntity(sb, k.fn, 'tasks', '/tasks', 'tasks', map, false)   // cron normal: NÃO cai no delta
  assertEquals(r2.done, false); assertEquals(st.tasks.full_page, 17); assertEquals(st.tasks.last_delta_at, 999)
  const r3 = await syncEntity(sb, k.fn, 'tasks', '/tasks', 'tasks', map, false)
  assertEquals(r3.done, true); assertEquals(st.tasks.full_done, true); assertEquals(st.tasks.full_page, null); assertEquals(st.tasks.last_delta_at, 1_000_202)
  const pages = k.urls.map((u) => Number(new URL('http://x' + u).searchParams.get('page')))
  assertEquals(pages, Array.from({ length: 20 }, (_, i) => i + 1))             // cada página uma vez, em ordem, sem filtro de delta
  assertEquals(k.urls.some((u) => u.includes('filter[updated_at]')), false)
  assertEquals(gravados.length, 40)
  // depois do fim: delta normal com o cursor consolidado
  const k2 = kgetFake(1); await syncEntity(sb, k2.fn, 'tasks', '/tasks', 'tasks', map, false)
  assertEquals(k2.urls[0].includes('filter%5Bupdated_at%5D%5Bfrom%5D=1000202') || k2.urls[0].includes('filter[updated_at][from]=1000202'), true)
})

Deno.test('events: full:true grava a janela em full_cursor; continuação usa a MESMA janela e a página; cursor e janela só mudam no fim', async () => {
  const { sb, st } = sbFake(); const k = kgetFake(10, 'events', true)
  st.events = { full_done: true, full_page: null, last_delta_at: AGORA - 86400, full_cursor: null }
  const r1 = await syncEvents(sb, k.fn, true)
  assertEquals(r1.done, false); assertEquals(st.events.full_done, false); assertEquals(st.events.full_page, 9)
  const janela = st.events.full_cursor; assertEquals(typeof janela, 'string'); assertEquals(Math.abs(Number(janela) - BASE) <= 2, true)
  assertEquals(st.events.last_delta_at, AGORA - 86400)                              // não consolidou
  const r2 = await syncEvents(sb, k.fn, false)
  assertEquals(r2.done, true); assertEquals(st.events.full_done, true); assertEquals(st.events.full_page, null); assertEquals(st.events.full_cursor, null)
  const froms = k.urls.map((u) => new URL('http://x' + u).searchParams.get('filter[created_at][from]'))
  assertEquals(new Set(froms).size, 1); assertEquals(froms[0], janela)           // mesma janela nas 10 páginas, nas 2 invocações
  const pages = k.urls.map((u) => Number(new URL('http://x' + u).searchParams.get('page')))
  assertEquals(pages, Array.from({ length: 10 }, (_, i) => i + 1))
  assertEquals(st.events.last_delta_at, AGORA - 86400)                             // nenhum evento mais novo que o cursor anterior
})

Deno.test('events: paginação de delta com cursor inicial nulo também fixa a janela entre invocações', async () => {
  const { sb, st } = sbFake(); const k = kgetFake(9, 'events', true)
  const r1 = await syncEvents(sb, k.fn, false)
  assertEquals(r1.done, false); const janela = st.events.full_cursor
  const r2 = await syncEvents(sb, k.fn, false)
  assertEquals(r2.done, true)
  const froms = k.urls.map((u) => new URL('http://x' + u).searchParams.get('filter[created_at][from]'))
  assertEquals(new Set(froms).size, 1); assertEquals(froms[0], janela)
  assertEquals(st.events.last_delta_at, BASE + 1092); assertEquals(st.events.full_cursor, null)
})
