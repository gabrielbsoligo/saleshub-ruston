// Núcleo PURO da fila do CLOSER (PROPOSTA.md §7, rev. 2.1; decisões do Gabriel em §7.5).
// O servidor só decide o MODO, anota etapa/compromisso nos itens e exclui o que está fora da fila com etapa
// CONFIRMADA AO VIVO. A ordem (unidade = lead, tarefa representativa, níveis por etapa) é do widget.
// Testado em kommo-widget/ruston-prevendas/tests/closer.test.ts.
import type { Item } from './prevendas_servidor.ts'

export const FUNIL_CLOSER = 11010459
// fora da fila do closer: Incoming leads e CONTRATO ASSINADO (no funil Closer); ganho/perdido em qualquer funil
const FORA_NO_FUNIL = new Set([84456015, 110112424])
const FECHADO = new Set([142, 143])

export type Modo = 'sdr' | 'closer'
/** Modo pelo papel do usuário no SERVIDOR. Override de teste (`pedido`) só para gestor. */
export function decidirModo(papel: string | null | undefined, pedido: unknown): Modo {
  if (papel === 'gestor' && (pedido === 'sdr' || pedido === 'closer')) return pedido
  return papel === 'closer' ? 'closer' : 'sdr'
}

export interface EtapaLead { status_id?: number | null; pipeline_id?: number | null }
/** A etapa (réplica ou API) tira o lead da fila do closer? */
export function foraDaFila(l: EtapaLead | null | undefined): boolean {
  if (!l || l.status_id == null) return false
  const st = Number(l.status_id)
  return FECHADO.has(st) || (Number(l.pipeline_id) === FUNIL_CLOSER && FORA_NO_FUNIL.has(st))
}

/** Leads que só podem sair da fila depois de conferidos AO VIVO (a réplica diz que estão fora). */
export function paraConfirmar(itens: Item[], leads: Record<string, EtapaLead>): number[] {
  const ids = new Set<number>()
  for (const i of itens) if (i.entity_type === 'leads' && foraDaFila(leads[String(i.entity_id)])) ids.add(Number(i.entity_id))
  return [...ids]
}

export interface ItemCloser extends Item {
  status_id: number | null; pipeline_id: number | null; etapa_pendente: boolean; reuniao_em: number | null
}
/**
 * Anota etapa e compromisso. `vivos` = etapas conferidas ao vivo (vence a réplica). Lead que a réplica põe fora
 * da fila: sai SÓ se `vivos` confirmar; sem confirmação, fica com etapa_pendente (nunca é escondido).
 */
export function aplicarCloser(
  itens: Item[], leads: Record<string, EtapaLead>, vivos: Record<string, EtapaLead>, compromissos: Record<string, number>,
): ItemCloser[] {
  const out: ItemCloser[] = []
  for (const i of itens) {
    const ehLead = i.entity_type === 'leads'
    const id = String(i.entity_id)
    const vivo = ehLead ? vivos[id] : undefined
    const l = ehLead ? (vivo ?? leads[id]) : undefined
    let pendente = false
    if (ehLead && foraDaFila(l)) {
      if (vivo) continue                       // confirmado ao vivo: fora da fila
      pendente = true                          // só a réplica diz: fica, com etapa provisória
    }
    out.push({
      ...i,
      status_id: l?.status_id != null ? Number(l.status_id) : null,
      pipeline_id: l?.pipeline_id != null ? Number(l.pipeline_id) : null,
      etapa_pendente: pendente,
      reuniao_em: ehLead && compromissos[id] != null ? Number(compromissos[id]) : null,
    })
  }
  return out
}
