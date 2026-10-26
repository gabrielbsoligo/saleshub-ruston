// cliente-oculto/adaptadores.ts — Evolution API (WhatsApp) e Anthropic (Haiku), com fetch injetável.
// Evolution v2 (conferir no servidor do Gabriel; o contrato abaixo é o documentado/comum):
//   POST {EVOLUTION_URL}/instance/create        {instanceName, qrcode:true, integration:'WHATSAPP-BAILEYS', webhook:{url, byEvents:false, base64:false, events:[...]}}
//   GET  {EVOLUTION_URL}/instance/connect/{inst} → {base64|code} (QR)      GET /instance/connectionState/{inst} → {instance:{state}}
//   POST {EVOLUTION_URL}/message/sendText/{inst} {number, text}            header apikey: EVOLUTION_APIKEY
//   webhook: {event:'messages.upsert'|'MESSAGES_UPSERT', instance, data:{key:{remoteJid,fromMe,id}, pushName, message:{conversation|extendedTextMessage.text}, messageTimestamp}}
export type FetchFn = typeof fetch
export type Evolution = {
  enviarTexto: (numero: string, texto: string) => Promise<{ ok: boolean; id: string | null; status: number; nota?: string }>
  criarInstancia: (webhookUrl: string) => Promise<{ ok: boolean; status: number; qr: string | null; nota?: string }>
  qr: () => Promise<{ ok: boolean; status: number; qr: string | null; estado?: string | null }>
  estado: () => Promise<{ ok: boolean; estado: string | null; numero?: string | null }>
}
export function evolution(baseUrl: string, apikey: string, instancia: string, fetchFn: FetchFn = fetch): Evolution {
  const base = baseUrl.replace(/\/$/, '')
  const req = async (m: string, path: string, body?: unknown) => {
    const r = await fetchFn(`${base}${path}`, { method: m, headers: { apikey, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
    const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null } catch { j = { raw: txt.slice(0, 300) } }
    return { status: r.status, body: j }
  }
  return {
    async enviarTexto(numero, texto) {
      const r = await req('POST', `/message/sendText/${encodeURIComponent(instancia)}`, { number: numero, text: texto })
      if (r.status < 200 || r.status >= 300) return { ok: false, id: null, status: r.status, nota: JSON.stringify(r.body ?? '').slice(0, 200) }
      return { ok: true, id: r.body?.key?.id ? String(r.body.key.id) : null, status: r.status }
    },
    async criarInstancia(webhookUrl) {
      const r = await req('POST', '/instance/create', { instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook: { url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } })
      if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status, qr: null, nota: JSON.stringify(r.body ?? '').slice(0, 300) }
      return { ok: true, status: r.status, qr: r.body?.qrcode?.base64 ?? r.body?.qrcode?.code ?? null }
    },
    async qr() {
      const r = await req('GET', `/instance/connect/${encodeURIComponent(instancia)}`)
      if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status, qr: null }
      return { ok: true, status: r.status, qr: r.body?.base64 ?? r.body?.code ?? null, estado: r.body?.instance?.state ?? null }
    },
    async estado() {
      const r = await req('GET', `/instance/connectionState/${encodeURIComponent(instancia)}`)
      if (r.status < 200 || r.status >= 300) return { ok: false, estado: null }
      return { ok: true, estado: r.body?.instance?.state ?? r.body?.state ?? null, numero: r.body?.instance?.owner ?? null }
    },
  }
}

export type Llm = (prompt: string, maxTokens?: number) => Promise<string>
export function anthropicHaiku(apiKey: string, modelo: string, fetchFn: FetchFn = fetch): Llm {
  return async (prompt, maxTokens = 400) => {
    const r = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error(`anthropic HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json()
    return String((j.content ?? []).find((c: any) => c.type === 'text')?.text ?? '').trim()
  }
}
export function extrairJson(texto: string): any | null { const m = texto.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }
