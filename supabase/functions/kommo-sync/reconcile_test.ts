// deno test supabase/functions/kommo-sync/reconcile_test.ts
import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { ReconciliacaoAbortada, conferirLote, conferirTodas, montarUrl, type GetRaw } from './reconcile.ts'

const ok = (ids: number[]) => ({ status: 200, body: { _embedded: { tasks: ids.map((id) => ({ id })) } } })
function fake(rotas: Record<string, { status: number; body?: any }>, log: string[] = []): GetRaw {
  return async (path) => {
    log.push(path)
    const chave = path.startsWith('/tasks/') ? path : 'lote'
    const r = rotas[chave] ?? rotas['*']
    if (!r) throw new Error('rota não prevista: ' + path)
    return { status: r.status, body: r.body ?? null }
  }
}

Deno.test('montarUrl preserva query existente do base e junta com &', () => {
  assertEquals(montarUrl('/leads?with=contacts,companies', { 'order[updated_at]': 'asc', limit: '250', page: '1' }), '/leads?with=contacts%2Ccompanies&order%5Bupdated_at%5D=asc&limit=250&page=1')
  assertEquals(montarUrl('/tasks', { limit: '1' }), '/tasks?limit=1')
})

Deno.test('lote 200 com todas presentes: vistas, sem GET individual', async () => {
  const log: string[] = []
  const r = await conferirLote(fake({ lote: ok([1, 2]) }, log), [1, 2])
  assertEquals(r, { vistas: [1, 2], ausentes: [] }); assertEquals(log.length, 1)
})

Deno.test('ausência só é confirmada individualmente: 204 individual = ausente; 200 individual = vista', async () => {
  const r = await conferirLote(fake({ lote: ok([1]), '/tasks/2': { status: 204 }, '/tasks/3': { status: 200, body: { id: 3 } } }), [1, 2, 3])
  assertEquals(r, { vistas: [1, 3], ausentes: [2] })
})

Deno.test('lote 204 (ninguém) ainda exige confirmação id a id', async () => {
  const log: string[] = []
  const r = await conferirLote(fake({ lote: { status: 204 }, '/tasks/7': { status: 204 }, '/tasks/8': { status: 200, body: { id: 8 } } }, log), [7, 8])
  assertEquals(r, { vistas: [8], ausentes: [7] }); assertEquals(log.length, 3)
})

Deno.test('200 com corpo vazio/inválido NÃO é ausência: aborta o lote; no individual idem', async () => {
  await assertRejects(() => conferirLote(fake({ lote: { status: 200, body: {} } }), [7]), ReconciliacaoAbortada, 'envelope')
  await assertRejects(() => conferirLote(fake({ lote: { status: 204 }, '/tasks/7': { status: 200, body: {} } }), [7]), ReconciliacaoAbortada, 'corpo inesperado')
  await assertRejects(() => conferirLote(fake({ lote: { status: 204 }, '/tasks/7': { status: 200, body: { id: 99 } } }), [7]), ReconciliacaoAbortada)
})

Deno.test('id fora do lote (filtro ignorado) e página parcial abortam', async () => {
  await assertRejects(() => conferirLote(fake({ lote: ok([1, 555]) }), [1, 2]), ReconciliacaoAbortada, 'fora do lote')
  await assertRejects(() => conferirLote(fake({ lote: { status: 200, body: { _embedded: { tasks: [{ id: 1 }] }, _links: { next: { href: 'x' } } } } }), [1, 2]), ReconciliacaoAbortada, 'parcial')
})

Deno.test('429/5xx/outros no lote ou no individual abortam (nada é marcado)', async () => {
  await assertRejects(() => conferirLote(fake({ lote: { status: 429 } }), [1]), ReconciliacaoAbortada, '429')
  await assertRejects(() => conferirLote(fake({ lote: { status: 204 }, '/tasks/1': { status: 503 } }), [1]), ReconciliacaoAbortada, '503')
})

Deno.test('conferirTodas: erro no último lote aborta a rodada inteira (nada parcial)', async () => {
  const rotas: Record<string, any> = { lote: ok([1]) }
  let chamadas = 0
  const get: GetRaw = async (p) => { chamadas++; if (chamadas === 2) return { status: 500, body: null }; return rotas[p.startsWith('/tasks/') ? p : 'lote'] }
  await assertRejects(() => conferirTodas(get, [1, 2], 1), ReconciliacaoAbortada)
})
