// Núcleo PURO do "chat sem resposta" (decisão do Gabriel, 26/10): chat do lead em que o CLIENTE falou por último
// e nenhum HUMANO respondeu depois é a PRIMEIRA prioridade da fila do responsável pelo lead.
// Fonte: /api/v4/events (incoming_chat_message / outgoing_chat_message). Resposta humana = created_by > 0;
// bot/automação (Salesbot, autoresposta) vem com created_by = 0 e NÃO conta como resposta.
// Testado em kommo-widget/ruston-prevendas/tests/chats.test.ts.
import type { Item } from './prevendas_servidor.ts'

export interface EventoChat {
  type: string; entity_type?: string | null; entity_id?: number | null; created_at: number; created_by?: number | null
  value_after?: Array<{ message?: { talk_id?: number | null } | null }> | null
}
export interface ChatPendente { lead_id: number; talk_id: number | null; desde: number; ultima: number }

/** Leads cujo cliente está esperando resposta humana: mensagem do cliente depois da última resposta humana. */
export function chatsSemResposta(eventos: EventoChat[]): ChatPendente[] {
  const porLead = new Map<number, { humano: number; entradas: Array<{ em: number; talk: number | null }> }>()
  for (const e of eventos) {
    if (e.entity_type !== 'lead' || !e.entity_id) continue
    const id = Number(e.entity_id)
    const l = porLead.get(id) ?? { humano: 0, entradas: [] }
    if (e.type === 'outgoing_chat_message' && Number(e.created_by) > 0) l.humano = Math.max(l.humano, Number(e.created_at))
    else if (e.type === 'incoming_chat_message') l.entradas.push({ em: Number(e.created_at), talk: e.value_after?.[0]?.message?.talk_id ?? null })
    porLead.set(id, l)
  }
  const out: ChatPendente[] = []
  for (const [lead_id, l] of porLead) {
    const pend = l.entradas.filter((x) => x.em > l.humano).sort((a, b) => a.em - b.em)
    if (!pend.length) continue
    const ult = pend[pend.length - 1]
    out.push({ lead_id, talk_id: ult.talk != null ? Number(ult.talk) : null, desde: pend[0].em, ultima: ult.em })
  }
  return out.sort((a, b) => a.desde - b.desde)
}

export interface LeadChat { responsavel: number | null; status_id: number | null; nome?: string | null }
const FECHADO = new Set([142, 143])

/**
 * Itens da fila do usuário: só chats pendentes de leads ABERTOS dele, com talk não encerrado.
 * Talk de status desconhecido (não consultado) entra — melhor um chat a mais do que esconder um cliente esperando.
 * id negativo (-lead_id) para não colidir com id de tarefa; não há tarefa a concluir.
 */
export function itensDeChat(
  chats: ChatPendente[], uid: number, leads: Record<string, LeadChat>, talks: Record<string, string>,
): Item[] {
  const out: Item[] = []
  for (const c of chats) {
    const l = leads[String(c.lead_id)]
    if (!l || Number(l.responsavel) !== Number(uid) || (l.status_id != null && FECHADO.has(Number(l.status_id)))) continue
    if (c.talk_id != null && talks[String(c.talk_id)] === 'closed') continue
    out.push({
      id: -c.lead_id, entity_type: 'leads', entity_id: c.lead_id, due: c.desde, texto: 'Cliente aguardando resposta no chat',
      lead_nome: l.nome ?? null, etapa: null, origem_pendente: false,
      momento: 'chat_sem_resposta', acao: 'chat', grupo: 'G9', urgente: true, fonte: 'chat', motivo: 'cliente falou por último',
    })
  }
  return out
}
