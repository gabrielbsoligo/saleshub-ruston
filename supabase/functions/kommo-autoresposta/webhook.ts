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

/** Transforma o corpo form-urlencoded (chaves com colchetes) num objeto aninhado. */
export function desdobrar(form: URLSearchParams | Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {}
  const entradas = form instanceof URLSearchParams ? [...form.entries()] : Object.entries(form)
  for (const [k, v] of entradas) {
    const partes = k.replace(/\]/g, '').split('[')
    let cur = out
    partes.forEach((p, i) => {
      if (i === partes.length - 1) cur[p] = v
      else { cur[p] = cur[p] ?? {}; cur = cur[p] }
    })
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
    if (!texto && anexo) texto = ANEXO_AUDIO.has(anexo) ? '[audio]' : '[midia]'
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
