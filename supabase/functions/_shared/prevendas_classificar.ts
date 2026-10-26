// Classificador de tarefas de pré-vendas (momento, ação, grupo de origem).
// Função PURA, sem Deno/rede: usada pelo endpoint prevendas-classificar (widget) e, no futuro,
// pelo kommo-call-note (baixa por AÇÃO = ligar, nunca por tipo de momento).
// Ver kommo-widget/ruston-prevendas/PROPOSTA.md §2.4.

export type Momento =
  | 'chat_sem_resposta'   // não vem de tarefa: prevendas_chats.ts (decisão 26/10, nível 0)
  | 'anti_noshow' | 'speed_to_lead' | 'conexao' | 'follow_up' | 'recuperar'
  | 'prospeccao' | 'sem_classificacao'
export type Acao = 'ligar' | 'whatsapp' | 'email' | 'outro'
export type Grupo = 'G1' | 'G2' | 'G3' | 'G5' | 'G9'

export interface Tarefa {
  id: number
  task_type_id: number | null
  text: string | null
}
export interface LeadInfo {
  etapa: string | null        // nome da etapa (status) do lead — só exibição
  origem: string | null       // valor do campo "Origem do lead" (975168)
}
export interface Classificacao {
  momento: Momento
  acao: Acao
  grupo: Grupo
  urgente: boolean            // entra na fila assim que criada (speed to lead, "Ligar AGORA")
  fonte: 'slot' | 'produtor' | 'tipo' | 'nenhuma'
  motivo: string
}

// tipos legados da conta (GET /api/v4/account?with=task_types)
export const TIPO = { FOLLOW_UP: 1, LIGACAO: 3732751, WHATSAPP: 3732759, EMAIL: 3732747, SEM_TAREFA: 3920343, ALERTA: 3928475, CLIENTE_OCULTO: 4299552 }

// slots da cadência de reunião (kommo.plan_reconcile, migration 155). Decisão 26/10: pré-reunião = anti no-show.
const SLOTS: Record<string, { momento: Momento; acao: Acao }> = {
  T0: { momento: 'anti_noshow', acao: 'outro' },     // cliente oculto (closer)
  T1: { momento: 'anti_noshow', acao: 'whatsapp' },  // gerar valor
  T2: { momento: 'anti_noshow', acao: 'whatsapp' },
  T3: { momento: 'anti_noshow', acao: 'whatsapp' },  // vídeo véspera
  T4: { momento: 'anti_noshow', acao: 'whatsapp' },  // closer, manhã da reunião
  T5: { momento: 'anti_noshow', acao: 'ligar' },     // -15 min
  T6: { momento: 'anti_noshow', acao: 'ligar' },     // +5 min
  R1: { momento: 'recuperar', acao: 'ligar' },
  R2: { momento: 'recuperar', acao: 'whatsapp' },
  R3: { momento: 'recuperar', acao: 'ligar' },
}

// Origem do lead (975168) → grupo. Valor fora do mapa ou vazio = G9 (NUNCA outbound).
// Decisão 26/10: Leadbroker, Blackbox e Foodbox contam como INBOUND (não há opção "Inbound" no campo).
export const GRUPO_POR_ORIGEM: Record<string, Grupo> = {
  'recomendacao': 'G1', 'indicacao de cliente': 'G1', 'networking': 'G1', 'evento': 'G1',
  'inbound': 'G2', 'leadbroker': 'G2', 'blackbox': 'G2', 'foodbox': 'G2',
  'recovery': 'G3', 'reativacao': 'G3',
  'outbound': 'G5', 'thunderbolt': 'G5', 'usa': 'G5',
}

export const norm = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export function grupoDaOrigem(origem: string | null | undefined, mapa: Record<string, Grupo> = GRUPO_POR_ORIGEM): Grupo {
  const k = norm(origem)
  return (k && mapa[k]) || 'G9'
}

export function acaoDoTipo(tipo: number | null): Acao {
  if (tipo === TIPO.LIGACAO) return 'ligar'
  if (tipo === TIPO.WHATSAPP) return 'whatsapp'
  if (tipo === TIPO.EMAIL) return 'email'
  return 'outro'
}

/**
 * Ordem de decisão (a primeira que casar vence):
 *  1) slot da cadência  2) produtor conhecido (texto/tipo)  3) tipo novo de momento (config)
 *  4) nenhuma → sem_classificacao. A ETAPA do lead NÃO define o momento (descreve o lead, não a tarefa;
 *     PROPOSTA §2.4) — só é exibida. Um mapa explícito etapa→momento por pipeline exige aprovação do Gabriel.
 * A AÇÃO vem do slot/produtor; senão, do tipo legado. A origem nunca altera a ação.
 */
export function classificar(
  t: Tarefa,
  slot: string | null,
  lead: LeadInfo | null,
  tiposMomento: Record<number, Momento> = {},
): Classificacao {
  const grupo = grupoDaOrigem(lead?.origem)
  const texto = String(t.text ?? '').trim()
  const tipo = t.task_type_id ?? null

  if (slot && SLOTS[slot]) {
    const s = SLOTS[slot]
    return { momento: s.momento, acao: s.acao, grupo, urgente: false, fonte: 'slot', motivo: `cadência ${slot}` }
  }
  if (tipo === TIPO.FOLLOW_UP && texto === 'Retorno') {
    return { momento: 'follow_up', acao: 'outro', grupo, urgente: false, fonte: 'produtor', motivo: 'retorno combinado' }
  }
  if (/^CADENCIA: lead respondeu/i.test(texto)) {
    return { momento: 'conexao', acao: 'ligar', grupo, urgente: true, fonte: 'produtor', motivo: 'lead respondeu com interesse' }
  }
  if (/^CADENCIA: classificar/i.test(texto)) {
    return { momento: 'follow_up', acao: 'outro', grupo, urgente: false, fonte: 'produtor', motivo: 'classificar resposta' }
  }
  if (tipo === TIPO.SEM_TAREFA || tipo === TIPO.ALERTA) {
    return { momento: 'sem_classificacao', acao: 'outro', grupo, urgente: false, fonte: 'produtor', motivo: tipo === TIPO.ALERTA ? 'alerta' : 'lead sem tarefa' }
  }
  if (tipo != null && tiposMomento[tipo]) {
    const m = tiposMomento[tipo]
    return { momento: m, acao: acaoDoTipo(tipo), grupo, urgente: m === 'speed_to_lead', fonte: 'tipo', motivo: 'tipo de momento' }
  }
  return { momento: 'sem_classificacao', acao: acaoDoTipo(tipo), grupo, urgente: false, fonte: 'nenhuma', motivo: 'sem regra' }
}

/** cadencia_task_ids pode vir como objeto {slot: id} ou array vazio. Devolve id→slot. */
export function mapaSlots(linhas: { cadencia_task_ids: unknown }[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const l of linhas) {
    const v = l.cadencia_task_ids
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    for (const [slot, id] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(id)
      if (Number.isFinite(n) && n > 0) m.set(n, slot)
    }
  }
  return m
}
