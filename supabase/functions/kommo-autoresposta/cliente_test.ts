// deno test supabase/functions/kommo-autoresposta/cliente_test.ts — cliente Kommo com fetch/sleep/reserva falsos.
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { clienteKommo } from './cliente.ts'
import { LeituraFalhou, Throttled } from './motor.ts'

function harness(o: { respostas?: (() => Response)[]; reservas?: number[]; falharReserva?: boolean }) {
  const chamadas: string[] = []; const sonos: number[] = []
  const fila = [...(o.respostas ?? [])]; const reservas = [...(o.reservas ?? [])]
  const k = clienteKommo({
    base: 'https://x', token: 't', esperaMaxMs: 30000,
    fetch: async (u) => { chamadas.push(u); const f = fila.shift(); if (!f) throw new TypeError('rede caiu'); return f() },
    sleep: async (ms) => { sonos.push(ms) },
    reservar: async () => { if (o.falharReserva) throw new Error('rpc indisponível'); return reservas.length ? reservas.shift()! : 0 },
  })
  return { k, chamadas, sonos }
}
const resp = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => () => new Response(status === 204 ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status, headers })

Deno.test('#4 reserva de ritmo falha → NÃO chama o Kommo (fail closed, LeituraFalhou)', async () => {
  const h = harness({ falharReserva: true, respostas: [resp(200, { id: 1 })] })
  await assertRejects(() => h.k('GET', '/api/v4/leads/1'), LeituraFalhou, 'ritmo indisponível')
  assertEquals(h.chamadas.length, 0)
})

Deno.test('#4 espera o slot inteiro (10 s) e acima do máximo devolve ao cron (Throttled), sem chamar', async () => {
  const h = harness({ reservas: [10000], respostas: [resp(200, { id: 1 })] })
  await h.k('GET', '/api/v4/leads/1')
  assertEquals(h.sonos, [10000])
  const h2 = harness({ reservas: [45000], respostas: [resp(200, { id: 1 })] })
  await assertRejects(() => h2.k('GET', '/api/v4/leads/1'), Throttled)
  assertEquals(h2.chamadas.length, 0)
})

Deno.test('#4 Retry-After 60 não é encurtado: acima do máximo vira Throttled(60) sem repetir', async () => {
  const h = harness({ respostas: [resp(429, {}, { 'retry-after': '60' }), resp(200, { id: 1 })] })
  const e = await assertRejects(() => h.k('GET', '/api/v4/leads/1'), Throttled)
  assertEquals((e as Throttled).esperaS, 60); assertEquals(h.chamadas.length, 1)
})

Deno.test('Retry-After curto é respeitado por inteiro e a chamada repete; pararEm429 lança no primeiro', async () => {
  const h = harness({ respostas: [resp(429, {}, { 'retry-after': '3' }), resp(200, { id: 1 })] })
  const r = await h.k('GET', '/api/v4/leads/1')
  assertEquals(r.ok, true); assertEquals(h.sonos, [3000]); assertEquals(h.chamadas.length, 2)
  const h2 = harness({ respostas: [resp(429, {}, { 'retry-after': '3' }), resp(200, { id: 1 })] })
  await assertRejects(() => h2.k('GET', '/api/v4/leads/1', undefined, { pararEm429: true }), Throttled)
  assertEquals(h2.chamadas.length, 1)
})

Deno.test('GET: 5xx/rede retentam com backoff; POST/PATCH não repetem e devolvem ambíguo', async () => {
  const h = harness({ respostas: [resp(503), resp(200, { ok: 1 })] })
  assertEquals((await h.k('GET', '/x')).ok, true); assertEquals(h.chamadas.length, 2)
  const h2 = harness({ respostas: [resp(503)] })
  const r2 = await h2.k('POST', '/notes', [{}])
  assertEquals(r2.ok, false); assertEquals(r2.status, 503); assertEquals(h2.chamadas.length, 1)
  const h3 = harness({ respostas: [] }) // rede cai no PATCH
  const r3 = await h3.k('PATCH', '/leads/1', {})
  assertEquals(r3.status, 0); assertEquals(h3.chamadas.length, 1)
})

Deno.test('200 com corpo que não é JSON = LeituraFalhou; 204 = body null ok', async () => {
  const h = harness({ respostas: [resp(200, '<html>')] })
  await assertRejects(() => h.k('GET', '/x'), LeituraFalhou, 'não é JSON')
  const h2 = harness({ respostas: [resp(204)] })
  const r = await h2.k('GET', '/x'); assertEquals(r.status, 204); assertEquals(r.body, null)
})

Deno.test('GET 429 sem Retry-After esgota retentativas com backoff exponencial e termina Throttled', async () => {
  const h = harness({ respostas: [resp(429), resp(429), resp(429), resp(429)] })
  await assertRejects(() => h.k('GET', '/x'), Throttled)
  assert(h.chamadas.length >= 2)
})
