// Parser do webhook de CONTA do Kommo, evento "add_message" (form-urlencoded):
//   message[add][0][id] [chat_id] [talk_id] [contact_id] [text] [created_at] [element_type]
//   [element_id] [entity_type] [type] ("incoming"|"outgoing") [author][...] [attachment][type]
// Puro (sem rede), testado em webhook_test.ts.
import { normalizar } from './triagem.ts'

export type MensagemWebhook = {
  id: string                       // identidade da mensagem (o mesmo id que aparece em /events)
  tipo: 'incoming' | 'outgoing' | 'desconhecido'
  texto: string                    // texto direto; áudio/mídia sem legenda viram '[audio]' / '[midia]'
  createdAt: number | null         // epoch s
  leadId: number | null            // element_type 2 = lead
  contactId: number | null
  talkId: number | null
  elementType: number | null
  anexo: string | null             // tipo do anexo (voice/audio/picture/video/file/…)
}

const SEGMENTO_PROIBIDO = new Set(['__proto__', 'constructor', 'prototype'])
/**
 * Transforma o corpo form-urlencoded (chaves com colchetes) num objeto aninhado SEM protótipo
 * (Object.create(null)): chave com __proto__/constructor/prototype é descartada e colisão
 * escalar × objeto também (a chave é ignorada em vez de sobrescrever). Nunca toca o protótipo global.
 */
export function desdobrar(form: URLSearchParams | Record<string, string>): Record<string, any> {
  const out: Record<string, any> = Object.create(null)
  const entradas = form instanceof URLSearchParams ? [...form.entries()] : Object.entries(form)
  for (const [k, v] of entradas) {
    const partes = k.replace(/\]/g, '').split('[')
    if (partes.some((p) => SEGMENTO_PROIBIDO.has(p))) continue
    let cur = out, ok = true
    for (let i = 0; i < partes.length; i++) {
      const p = partes[i]
      if (i === partes.length - 1) {
        if (Object.prototype.hasOwnProperty.call(cur, p) && typeof cur[p] === 'object') { ok = false; break }
        cur[p] = v
      } else {
        if (!Object.prototype.hasOwnProperty.call(cur, p)) cur[p] = Object.create(null)
        else if (typeof cur[p] !== 'object' || cur[p] === null) { ok = false; break }
        cur = cur[p]
      }
    }
    if (!ok) continue
  }
  return out
}

const ANEXO_AUDIO = new Set(['voice', 'audio', 'ptt'])

/** Extrai as mensagens de um payload já desdobrado (ou JSON com a mesma forma). Lista vazia se não for add_message. */
export function extrairMensagens(payload: Record<string, any>): MensagemWebhook[] {
  const add = payload?.message?.add
  if (!add) return []
  const lista: any[] = Array.isArray(add) ? add : Object.keys(add).sort((a, b) => Number(a) - Number(b)).map((k) => add[k])
  const out: MensagemWebhook[] = []
  for (const m of lista) {
    if (!m || typeof m !== 'object') continue
    const id = String(m.id ?? '').trim()
    if (!id) continue
    const tipoRaw = String(m.type ?? '').toLowerCase()
    const tipo: MensagemWebhook['tipo'] = tipoRaw === 'incoming' ? 'incoming' : tipoRaw === 'outgoing' ? 'outgoing' : 'desconhecido'
    const anexo = m.attachment && typeof m.attachment === 'object' ? String(m.attachment.type ?? '').toLowerCase() || null : null
    let texto = String(m.text ?? '').trim()
    // sem texto: anexo de voz = [audio]; outro anexo, ou nada (sticker/localização/contato) = [midia] — alguém interagiu
    if (!texto) texto = anexo && ANEXO_AUDIO.has(anexo) ? '[audio]' : '[midia]'
    const elementType = m.element_type != null && m.element_type !== '' ? Number(m.element_type) : null
    const elementId = m.element_id != null && m.element_id !== '' ? Number(m.element_id) : null
    const created = Number(m.created_at)
    out.push({
      id, tipo, texto,
      createdAt: Number.isFinite(created) && created > 0 ? created : null,
      leadId: elementType === 2 && Number.isFinite(elementId) && elementId! > 0 ? elementId : null,
      contactId: m.contact_id != null && m.contact_id !== '' && Number.isFinite(Number(m.contact_id)) ? Number(m.contact_id) : null,
      talkId: m.talk_id != null && m.talk_id !== '' && Number.isFinite(Number(m.talk_id)) ? Number(m.talk_id) : null,
      elementType, anexo,
    })
  }
  return out
}

/** Só para log/depuração: resumo sem o texto (dado pessoal). */
export const resumo = (m: MensagemWebhook) => ({ id: m.id, tipo: m.tipo, lead: m.leadId, contato: m.contactId, anexo: m.anexo, palavras: normalizar(m.texto).split(' ').filter(Boolean).length })
