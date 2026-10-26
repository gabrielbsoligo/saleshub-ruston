// Núcleo PURO do "chat sem resposta" (decisão do Gabriel, 26/10): chat do lead em que o CLIENTE falou por último
// e nenhum HUMANO respondeu depois é a PRIMEIRA prioridade da fila do responsável pelo lead.
// Fonte: /api/v4/events (incoming_chat_message / outgoing_chat_message). Resposta humana = created_by > 0;
// bot/automação (Salesbot, autoresposta) vem com created_by = 0 e NÃO conta como resposta.
// A pendência é calculada por CONVERSA (lead + talk): responder no talk B não limpa a espera do talk A; o
// encerramento também é por talk. Só no fim os talks pendentes viram UM card por lead.
// Testado em kommo-widget/ruston-prevendas/tests/chats.test.ts.
import type { Item } from './prevendas_servidor.ts'

export interface EventoChat {
  type: string; entity_type?: string | null; entity_id?: number | null; created_at: number; created_by?: number | null
  value_after?: Array<{ message?: { talk_id?: number | null } | null }> | null
}
/** Uma conversa pendente (talk_id null = evento sem talk; tratado como conversa própria do lead). */
export interface ChatPendente { lead_id: number; talk_id: number | null; desde: number; ultima: number }

const talkDe = (e: EventoChat) => { const t = e.value_after?.[0]?.message?.talk_id; return t == null ? null : Number(t) }

/** Conversas (lead + talk) em que o cliente espera resposta humana. */
export function chatsSemResposta(eventos: EventoChat[]): ChatPendente[] {
  const conv = new Map<string, { lead: number; talk: number | null; humano: number; entradas: number[] }>()
  for (const e of eventos) {
    if (e.entity_type !== 'lead' || !e.entity_id) continue
    const lead = Number(e.entity_id), talk = talkDe(e), k = `${lead}:${talk ?? '-'}`
    const c = conv.get(k) ?? { lead, talk, humano: 0, entradas: [] }
    if (e.type === 'outgoing_chat_message' && Number(e.created_by) > 0) c.humano = Math.max(c.humano, Number(e.created_at))
    else if (e.type === 'incoming_chat_message') c.entradas.push(Number(e.created_at))
    conv.set(k, c)
  }
  const out: ChatPendente[] = []
  for (const c of conv.values()) {
    const pend = c.entradas.filter((em) => em > c.humano).sort((a, b) => a - b)
    if (pend.length) out.push({ lead_id: c.lead, talk_id: c.talk, desde: pend[0], ultima: pend[pend.length - 1] })
  }
  return out.sort((a, b) => a.desde - b.desde || a.lead_id - b.lead_id)
}

export interface LeadChat { responsavel: number | null; status_id: number | null; nome?: string | null }
const FECHADO = new Set([142, 143])

/**
 * Itens da fila do usuário: conversas pendentes de leads ABERTOS dele, sem as de talk encerrado; depois, um item
 * por lead (desde = a espera mais antiga entre as conversas abertas). Talk de status desconhecido entra — melhor
 * um chat a mais do que esconder um cliente esperando. id negativo (-lead_id): não é tarefa, não se conclui.
 */
export function itensDeChat(
  chats: ChatPendente[], uid: number, leads: Record<string, LeadChat>, talks: Record<string, string>,
): Item[] {
  const porLead = new Map<number, { desde: number; n: number }>()
  for (const c of chats) {
    const l = leads[String(c.lead_id)]
    if (!l || Number(l.responsavel) !== Number(uid) || (l.status_id != null && FECHADO.has(Number(l.status_id)))) continue
    if (c.talk_id != null && talks[String(c.talk_id)] === 'closed') continue
    const a = porLead.get(c.lead_id)
    porLead.set(c.lead_id, { desde: a ? Math.min(a.desde, c.desde) : c.desde, n: (a?.n ?? 0) + 1 })
  }
  const out: Item[] = []
  for (const [lead_id, p] of porLead) {
    const l = leads[String(lead_id)]
    out.push({
      id: -lead_id, entity_type: 'leads', entity_id: lead_id, due: p.desde,
      texto: p.n > 1 ? `Cliente aguardando resposta em ${p.n} conversas` : 'Cliente aguardando resposta no chat',
      lead_nome: l?.nome ?? null, etapa: null, origem_pendente: false,
      momento: 'chat_sem_resposta', acao: 'chat', grupo: 'G9', urgente: true, fonte: 'chat', motivo: 'cliente falou por último',
    })
  }
  return out.sort((a, b) => a.due - b.due || a.entity_id - b.entity_id)
}

/**
 * O cache de chats da conta só vira item da fila se a LEITURA (gerado_em = início da leitura no Kommo) tiver no
 * máximo `maxIdadeS`. Velho ou malformado gera motivo — nunca é publicado como atual.
 */
export function usarChats(conta: any, agoraS: number, maxIdadeS: number): { ok: true } | { ok: false; motivo: 'chats_indisponiveis' | 'chats_atrasados' } {
  if (!conta || !Array.isArray(conta.chats) || !Number.isFinite(Number(conta.gerado_em))) return { ok: false, motivo: 'chats_indisponiveis' }
  if (agoraS - Number(conta.gerado_em) > maxIdadeS) return { ok: false, motivo: 'chats_atrasados' }
  return { ok: true }
}

/**
 * Reuso de uma resposta já montada (cache por usuário): a validade dos chats é conferida DE NOVO na hora do
 * reuso. Se a leitura dos chats (chats_em) passou de `maxIdadeS` — ou não existe —, tira só os itens de chat,
 * preserva as tarefas e marca chats_atrasados (a ausência de chat também é uma afirmação velha).
 */
export function revalidarChats<R extends { itens?: any[]; total?: number; parcial?: boolean; motivos_parcial?: string[]; chats_em?: number | null }>(
  r: R, agoraS: number, maxIdadeS: number,
): R {
  const motivos = r.motivos_parcial ?? []
  const jaSinalizado = motivos.some((m) => m === 'chats_indisponiveis' || m === 'chats_limite' || m === 'chats_atrasados')
  const vencido = r.chats_em == null || !Number.isFinite(Number(r.chats_em)) || agoraS - Number(r.chats_em) > maxIdadeS
  if (!vencido) return r
  const itens = (r.itens ?? []).filter((i) => i?.momento !== 'chat_sem_resposta')
  if (jaSinalizado && itens.length === (r.itens ?? []).length) return r
  return { ...r, itens, total: itens.length, parcial: true, motivos_parcial: jaSinalizado ? motivos : [...motivos, 'chats_atrasados'] }
}

/**
 * Status dos talks pendentes: primeiro pela LISTA (páginas de 250, as mais recentes), depois um a um até `maxUm`.
 * Erro comum (lista ou individual) = status desconhecido (o chat ENTRA); só `fatal(e)` (429/orçamento) propaga.
 */
export async function statusDosTalks(
  precisa: string[], getLista: (pagina: number) => Promise<any>, getUm: (id: string) => Promise<any>,
  maxPaginas: number, maxUm: number, fatal: (e: unknown) => boolean,
): Promise<Record<string, string>> {
  const talks: Record<string, string> = {}, alvo = new Set(precisa)
  const falta = () => [...alvo].filter((id) => !talks[id])
  for (let p = 1; p <= maxPaginas && falta().length; p++) {
    let j: any
    try { j = await getLista(p) } catch (e) { if (fatal(e)) throw e; break }
    const lista = j?._embedded?.talks ?? []
    for (const t of lista) { const id = String(t?.talk_id ?? t?.id); if (t?.status && alvo.has(id)) talks[id] = String(t.status) }
    if (lista.length < 250) break
  }
  for (const id of falta().slice(0, maxUm)) {
    try { const t = await getUm(id); if (t?.status) talks[id] = String(t.status) } catch (e) { if (fatal(e)) throw e }
  }
  return talks
}
