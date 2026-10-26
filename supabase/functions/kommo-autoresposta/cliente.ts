// Cliente HTTP do Kommo usado pela edge, com dependências injetadas (fetch, sleep, reserva de
// ritmo) para ser testado em cliente_test.ts sem rede.
//
// Política:
//  - RITMO por CONTA: antes de cada chamada reserva um slot (RPC autoresposta_reservar, compartilhada
//    entre webhooks e cron). Reserva que falha = NÃO chama o Kommo (fail closed → LeituraFalhou, o
//    trabalho fica pendente). Espera o slot inteiro; se a espera passar de `esperaMaxMs`, devolve o
//    trabalho ao cron (Throttled) em vez de encurtar a espera.
//  - 429: respeita Retry-After por inteiro; acima de `esperaMaxMs` → Throttled (nunca encurta);
//    com `pararEm429` (varredura) → Throttled já no primeiro.
//  - GET: retentativa com backoff em 5xx/rede. POST/PATCH: por padrão NÃO repete (não são
//    idempotentes); resposta de rede perdida vira {ok:false, status:0} para quem chamou reconciliar.
//  - 200 com corpo que não é JSON = LeituraFalhou (nunca "lista vazia").
import { LeituraFalhou, Throttled, type KommoFn } from './motor.ts'

export type ClienteDeps = {
  base: string
  token: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  /** devolve ms a esperar antes de chamar, ou lança se a reserva falhar */
  reservar: (ms: number) => Promise<number>
  timeoutMs?: number
  slotMs?: number
  esperaMaxMs?: number
}

export function clienteKommo(d: ClienteDeps): KommoFn {
  const H = { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }
  const timeoutMs = d.timeoutMs ?? 15000, slotMs = d.slotMs ?? 200, esperaMax = d.esperaMaxMs ?? 30000
  return async (m, p, body, opts = {}) => {
    const etapa = opts.etapa ?? p
    const retries = opts.retries ?? (m === 'GET' ? 3 : 0)
    for (let t = 1; t <= 1 + retries; t++) {
      let espera: number
      try { espera = await d.reservar(slotMs) } catch (e) { throw new LeituraFalhou(etapa, `ritmo indisponível: ${(e as Error).message}`) }
      if (espera > esperaMax) throw new Throttled(Math.ceil(espera / 1000))
      if (espera > 0) await d.sleep(espera)
      let r: Response
      try {
        r = await d.fetch(d.base + p, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
      } catch (e) {
        if (m !== 'GET') return { ok: false, status: 0, body: { erro: `rede: ${(e as Error).message}` } } // ambíguo: quem chamou reconcilia
        if (t === 1 + retries) throw new LeituraFalhou(etapa, `rede: ${(e as Error).message}`)
        await d.sleep(500 * 2 ** t); continue
      }
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after') ?? 0)
        const esperaS = ra > 0 ? ra : 2 ** t
        if (opts.pararEm429 || esperaS * 1000 > esperaMax || t === 1 + retries) throw new Throttled(esperaS)
        await d.sleep(esperaS * 1000); continue
      }
      if (r.status >= 500) {
        if (m !== 'GET') return { ok: false, status: r.status, body: null }
        if (t === 1 + retries) throw new LeituraFalhou(etapa, `HTTP ${r.status}`)
        await d.sleep(500 * 2 ** t); continue
      }
      const texto = r.status === 204 ? '' : await r.text()
      let parsed: any = null
      if (texto) { try { parsed = JSON.parse(texto) } catch { if (r.ok) throw new LeituraFalhou(etapa, 'resposta não é JSON') } }
      return { ok: r.ok, status: r.status, body: parsed }
    }
    throw new LeituraFalhou(etapa, 'esgotou retentativas')
  }
}
