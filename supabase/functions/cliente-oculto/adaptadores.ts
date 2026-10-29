// cliente-oculto/adaptadores.ts — Evolution API (WhatsApp) e Anthropic (Haiku), com fetch injetável.
// Evolution v2 (conferir no servidor do Gabriel; contrato documentado/comum):
//   POST {EVOLUTION_URL}/instance/create        {instanceName, qrcode:true, integration:'WHATSAPP-BAILEYS', webhook:{url, byEvents:false, base64:false, events:[...]}}
//   GET  {EVOLUTION_URL}/instance/connect/{inst} → {base64|code} (QR)      GET /instance/connectionState/{inst} → {instance:{state}}
//   POST {EVOLUTION_URL}/message/sendText/{inst} {number, text}            header apikey: EVOLUTION_APIKEY
//   POST {EVOLUTION_URL}/chat/findMessages/{inst} {where:{key:{remoteJid}}, limit} → mensagens recentes (reconciliação de envio incerto)
//   webhook: {event:'messages.upsert'|'MESSAGES_UPSERT', instance, data:{key:{remoteJid,fromMe,id}, pushName, message:{conversation|extendedTextMessage.text}, messageTimestamp}}
export type FetchFn = typeof fetch
export type Envio = { ok: boolean; id: string | null; status: number; transporte?: boolean; nota?: string }
export type Evolution = {
  enviarTexto: (numero: string, texto: string, digitandoMs?: number) => Promise<Envio>
  buscarMensagens: (numero: string, limite?: number) => Promise<{ ok: boolean; mensagens: { id: string | null; fromMe: boolean; texto: string; ts: number }[] }>
  criarInstancia: (webhookUrl: string) => Promise<{ ok: boolean; status: number; qr: string | null; jaExistia?: boolean; nota?: string }>
  registrarWebhook: (webhookUrl: string) => Promise<{ ok: boolean; status: number; nota?: string }>
  /** GET /instance/connect/{inst}[?number=55DDD…]: QR novo (base64/code) ou pairing code quando `number` vem */
  qr: (numero?: string | null) => Promise<{ ok: boolean; status: number; qr: string | null; pairingCode?: string | null; estado?: string | null; nota?: string }>
  estado: () => Promise<{ ok: boolean; estado: string | null; numero?: string | null }>
}
export function evolution(baseUrl: string, apikey: string, instancia: string, fetchFn: FetchFn = fetch): Evolution {
  const base = baseUrl.replace(/\/$/, '')
  const inst = encodeURIComponent(instancia)
  // transporte (rede/timeout) NÃO lança: devolve status 0 + transporte:true (quem chama decide se é incerto)
  const req = async (m: string, path: string, body?: unknown): Promise<{ status: number; body: any; transporte?: boolean; nota?: string }> => {
    try {
      const r = await fetchFn(`${base}${path}`, { method: m, headers: { apikey, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
      const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null } catch { j = { raw: txt.slice(0, 300) } }
      return { status: r.status, body: j }
    } catch (e) {
      return { status: 0, body: null, transporte: true, nota: String((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timeout' : (e as Error)?.message ?? e).slice(0, 120) }
    }
  }
  const textoDe = (m: any) => String(m?.message?.conversation ?? m?.message?.extendedTextMessage?.text ?? '').trim()
  return {
    async enviarTexto(numero, texto, digitandoMs) {
      // delay (ms): a Evolution mostra "digitando..." por esse tempo antes de entregar
      const r = await req('POST', `/message/sendText/${inst}`, { number: numero, text: texto, ...(digitandoMs ? { delay: Math.round(digitandoMs) } : {}) })
      if (r.transporte) return { ok: false, id: null, status: 0, transporte: true, nota: r.nota }
      if (r.status < 200 || r.status >= 300) return { ok: false, id: null, status: r.status, nota: JSON.stringify(r.body ?? '').slice(0, 200) }
      return { ok: true, id: r.body?.key?.id ? String(r.body.key.id) : null, status: r.status }
    },
    async buscarMensagens(numero, limite = 20) {
      const r = await req('POST', `/chat/findMessages/${inst}`, { where: { key: { remoteJid: `${numero}@s.whatsapp.net` } }, limit: limite })
      if (r.transporte || r.status < 200 || r.status >= 300) return { ok: false, mensagens: [] }
      const lista: any[] = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.messages?.records) ? r.body.messages.records : Array.isArray(r.body?.messages) ? r.body.messages : []
      return { ok: true, mensagens: lista.map((m) => ({ id: m?.key?.id ? String(m.key.id) : null, fromMe: !!m?.key?.fromMe, texto: textoDe(m), ts: Number(m?.messageTimestamp ?? 0) })) }
    },
    // IDEMPOTENTE: 403 "already in use" = já existe → só (re)registra o webhook e segue para o QR
    async criarInstancia(webhookUrl) {
      const r = await req('POST', '/instance/create', { instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS', webhook: { url: webhookUrl, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } })
      const corpo = JSON.stringify(r.body ?? '')
      if (!r.transporte && (r.status === 403 || r.status === 409 || /already in use|j[áa] existe|already exists/i.test(corpo))) {
        const w = await this.registrarWebhook(webhookUrl)
        return { ok: w.ok, status: w.status, qr: null, jaExistia: true, nota: w.ok ? 'instância já existia; webhook atualizado' : w.nota }
      }
      if (r.transporte || r.status < 200 || r.status >= 300) return { ok: false, status: r.status, qr: null, nota: r.nota ?? corpo.slice(0, 300) }
      return { ok: true, status: r.status, qr: r.body?.qrcode?.base64 ?? r.body?.qrcode?.code ?? null }
    },
    async registrarWebhook(webhookUrl) {
      // Evolution v2: POST /webhook/set/{inst} com {webhook:{…}} (v2.2+); campos planos mantidos para versões que os leem
      const cfg = { enabled: true, url: webhookUrl, webhookByEvents: false, webhookBase64: false, byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] }
      const r = await req('POST', `/webhook/set/${inst}`, { webhook: cfg, ...cfg })
      if (r.transporte || r.status < 200 || r.status >= 300) return { ok: false, status: r.status, nota: r.nota ?? JSON.stringify(r.body ?? '').slice(0, 200) }
      return { ok: true, status: r.status }
    },
    async qr(numero) {
      const r = await req('GET', `/instance/connect/${inst}${numero ? `?number=${encodeURIComponent(numero)}` : ''}`)
      if (r.transporte || r.status < 200 || r.status >= 300) return { ok: false, status: r.status, qr: null, nota: r.nota ?? JSON.stringify(r.body ?? '').slice(0, 200) }
      const b = r.body ?? {}
      return { ok: true, status: r.status, qr: b.base64 ?? b.code ?? b.qrcode?.base64 ?? null, pairingCode: b.pairingCode ?? b.pairing_code ?? null, estado: b.instance?.state ?? b.state ?? null }
    },
    async estado() {
      const r = await req('GET', `/instance/connectionState/${inst}`)
      if (r.transporte || r.status < 200 || r.status >= 300) return { ok: false, estado: null }
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
