import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { anthropicHaiku, evolution, extrairJson } from './adaptadores.ts'

const fakeFetch = (rotas: Record<string, { status: number; body: unknown }>, chamadas: { url: string; init: any }[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); chamadas.push({ url: u, init })
    const k = Object.keys(rotas).find((r) => u.includes(r))
    const r = k ? rotas[k] : { status: 404, body: { error: 'rota' } }
    return new Response(JSON.stringify(r.body), { status: r.status })
  }) as unknown as typeof fetch

Deno.test('evolution.enviarTexto: POST /message/sendText/{inst} com apikey, number e text; id da key; erro HTTP = ok:false com nota', async () => {
  const chamadas: any[] = []
  const wa = evolution('https://evo.x/', 'k1', 'oculto-v4', fakeFetch({ '/message/sendText/oculto-v4': { status: 201, body: { key: { id: 'ABC' } } } }, chamadas))
  assertEquals(await wa.enviarTexto('5511999999999', 'oi'), { ok: true, id: 'ABC', status: 201 })
  assertEquals(chamadas[0].url, 'https://evo.x/message/sendText/oculto-v4')
  assertEquals(chamadas[0].init.headers.apikey, 'k1'); assertEquals(JSON.parse(chamadas[0].init.body), { number: '5511999999999', text: 'oi' })
  const wa2 = evolution('https://evo.x', 'k1', 'i', fakeFetch({ '/message/sendText': { status: 400, body: { message: 'number invalid' } } }))
  const r = await wa2.enviarTexto('1', 'x'); assertEquals(r.ok, false); assertEquals(r.status, 400)
})

Deno.test('evolution.criarInstancia/qr/estado: payload com webhook e eventos; QR base64; estado open', async () => {
  const chamadas: any[] = []
  const wa = evolution('https://evo.x', 'k', 'inst', fakeFetch({ '/instance/create': { status: 201, body: { qrcode: { base64: 'data:image/png;base64,AAA' } } }, '/instance/connect/inst': { status: 200, body: { base64: 'data:image/png;base64,BBB' } }, '/instance/connectionState/inst': { status: 200, body: { instance: { state: 'open', owner: '5511888887777@s.whatsapp.net' } } } }, chamadas))
  const c = await wa.criarInstancia('https://edge/cliente-oculto/s/seg')
  assertEquals(c.ok, true); assertEquals(c.qr, 'data:image/png;base64,AAA')
  const payload = JSON.parse(chamadas[0].init.body)
  assertEquals(payload.instanceName, 'inst'); assertEquals(payload.webhook.url, 'https://edge/cliente-oculto/s/seg'); assertEquals(payload.webhook.events.includes('MESSAGES_UPSERT'), true)
  assertEquals((await wa.qr()).qr, 'data:image/png;base64,BBB')
  assertEquals(await wa.estado(), { ok: true, estado: 'open', numero: '5511888887777@s.whatsapp.net' })
})

Deno.test('anthropicHaiku: devolve o texto do bloco text; HTTP de erro lança; extrairJson acha o objeto no meio do texto', async () => {
  const chamadas: any[] = []
  const llm = anthropicHaiku('key', 'claude-haiku-4-5-20251001', fakeFetch({ 'api.anthropic.com': { status: 200, body: { content: [{ type: 'text', text: '  Oi, tudo bem? Vocês têm horário amanhã?  ' }] } } }, chamadas))
  assertEquals(await llm('p'), 'Oi, tudo bem? Vocês têm horário amanhã?')
  assertEquals(JSON.parse(chamadas[0].init.body).model, 'claude-haiku-4-5-20251001'); assertEquals(chamadas[0].init.headers['x-api-key'], 'key')
  const ruim = anthropicHaiku('key', 'm', fakeFetch({ 'api.anthropic.com': { status: 529, body: { error: 'overloaded' } } }))
  await assertRejects(() => ruim('p'), Error, 'anthropic HTTP 529')
  assertEquals(extrairJson('aqui vai: {"qualificacao": 7, "parecer": "ok"} fim'), { qualificacao: 7, parecer: 'ok' })
  assertEquals(extrairJson('nada'), null)
})
