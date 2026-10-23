// Núcleo PURO do prevendas-fila (sem rede): transforma a lista VIVA de tarefas do Kommo (autoritativa) em itens
// classificados, usando dados de lead (réplica ou API) e slots da cadência. Classifica SEMPRE com o texto/tipo
// vivos. Testado em kommo-widget/ruston-prevendas/tests/servidor.test.ts.
import { classificar, type Momento } from './prevendas_classificar.ts'

export interface TarefaKommo {
  id: number
  is_completed?: boolean
  responsible_user_id?: number
  task_type_id?: number | null
  complete_till?: number | null
  text?: string | null
  entity_type?: string | null
  entity_id?: number | null
  updated_at?: number | null
}
export interface LeadDados { nome?: string | null; etapa?: string | null; origem?: string | null }

export interface Item {
  id: number; entity_type: string; entity_id: number; due: number; texto: string
  lead_nome: string | null; etapa: string | null; origem_pendente: boolean
  momento: Momento; acao: string; grupo: string; urgente: boolean; fonte: string; motivo: string
}

/** Consolida por id (paginação por offset pode repetir): fica a versão com updated_at maior (empate: a última). */
export function dedupTarefas(tarefas: TarefaKommo[]): TarefaKommo[] {
  const m = new Map<number, TarefaKommo>()
  for (const t of tarefas) {
    const id = Number(t.id), atual = m.get(id)
    if (!atual || Number(t.updated_at ?? 0) >= Number(atual.updated_at ?? 0)) m.set(id, t)
  }
  return [...m.values()]
}

/** Ids de lead que faltam (nem na réplica nem já buscados) — para buscar na API em lotes. */
export function leadsFaltando(tarefas: TarefaKommo[], conhecidos: Record<string, LeadDados>): number[] {
  const ids = new Set<number>()
  for (const t of tarefas) if (t.entity_type === 'leads' && t.entity_id && !conhecidos[String(t.entity_id)]) ids.add(Number(t.entity_id))
  return [...ids]
}

/**
 * Só tarefas abertas do próprio usuário (a lista já vem filtrada pelo Kommo; aqui é defesa em profundidade).
 * Lead sem dados (nem réplica nem API, por falta de orçamento) fica com origem_pendente=true — não é tratado
 * como "origem não informada".
 */
export function montarItens(
  tarefas: TarefaKommo[], uid: number, leads: Record<string, LeadDados>, slots: Record<string, string>,
  tiposMomento: Record<number, Momento> = {},
): Item[] {
  const out: Item[] = []
  for (const t of dedupTarefas(tarefas)) {
    if (t.is_completed || Number(t.responsible_user_id) !== Number(uid) || !t.entity_id) continue
    const ehLead = t.entity_type === 'leads'
    const l = ehLead ? leads[String(t.entity_id)] : undefined
    const c = classificar(
      { id: Number(t.id), task_type_id: t.task_type_id == null ? null : Number(t.task_type_id), text: t.text ?? null },
      slots[String(t.id)] ?? null,
      ehLead && l ? { etapa: l.etapa ?? null, origem: l.origem ?? null } : null,
      tiposMomento,
    )
    out.push({
      id: Number(t.id), entity_type: t.entity_type ?? 'leads', entity_id: Number(t.entity_id),
      due: Number(t.complete_till) || 0, texto: t.text ?? '',
      lead_nome: l?.nome ?? null, etapa: l?.etapa ?? null, origem_pendente: ehLead && !l,
      ...c,
    })
  }
  return out
}

// ---------------- vazão e paginação (puras, com dependências injetadas) ----------------
export class Interrupcao extends Error {
  tipo: 'ficha' | 'tempo'
  constructor(tipo: 'ficha' | 'tempo') { super(tipo); this.tipo = tipo }
}

/**
 * Espera uma ficha do orçamento da conta por até `esperaMs` (sondando a cada `passoMs`), respeitando o prazo
 * total da execução. Garante progresso sob concorrência sem estourar o limite: a recarga do balde libera fichas.
 */
export async function esperarFicha(
  consumir: () => Promise<boolean>, dormir: (ms: number) => Promise<void>, agora: () => number,
  prazoFinal: number, esperaMs: number, passoMs = 300,
): Promise<void> {
  const limite = agora() + esperaMs
  for (;;) {
    if (agora() > prazoFinal) throw new Interrupcao('tempo')
    if (await consumir()) return
    if (agora() > limite) throw new Interrupcao('ficha')
    await dormir(passoMs)
  }
}

/** Lê todas as páginas (até `max`); interrupção depois da 1ª página vira parcial com motivo, nunca silenciosa. */
export async function lerPaginado(
  getPagina: (n: number) => Promise<{ itens: TarefaKommo[]; temProxima: boolean }>, max: number,
): Promise<{ tarefas: TarefaKommo[]; motivos: string[] }> {
  const tarefas: TarefaKommo[] = [], motivos: string[] = []
  for (let n = 1; n <= max; n++) {
    let p
    try { p = await getPagina(n) }
    catch (e) {
      if (e instanceof Interrupcao && tarefas.length) { motivos.push(e.tipo === 'ficha' ? 'vazao_tarefas' : 'tempo_tarefas'); break }
      throw e
    }
    tarefas.push(...p.itens)
    if (!p.temProxima) break
    if (n === max) motivos.push('limite_paginas')
  }
  return { tarefas, motivos }
}
