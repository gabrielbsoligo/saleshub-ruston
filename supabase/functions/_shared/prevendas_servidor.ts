// Núcleo PURO do prevendas-fila (sem rede): junta réplica + descobertas, ordena, seleciona o lote a conferir,
// aplica a conferência do Kommo e decide o que pode ser EMITIDO. Só sai o que o Kommo confirmou
// (existe, aberta, do usuário, mesma entidade). Testado em kommo-widget/ruston-prevendas/tests/servidor.test.ts.
import { ordenar, type CfgOrdem, type ItemOrdem } from './prevendas_ordem.ts'

export interface Item extends ItemOrdem {
  entity_type: string
  entity_id: number
  texto: string
  lead_nome: string | null
  etapa: string | null
  acao: string
  fonte: string
  motivo: string
}

export interface TarefaKommo {
  id: number
  is_completed: boolean
  responsible_user_id: number
  complete_till: number | null
  text: string | null
  entity_type: string | null
  entity_id: number | null
}

/** Junta a réplica com tarefas descobertas ao vivo (que a réplica pode ter perdido). Descoberta vence. */
export function juntar(replica: Item[], descobertas: Item[]): Item[] {
  const m = new Map<number, Item>()
  for (const r of replica) m.set(r.id, r)
  for (const d of descobertas) m.set(d.id, { ...(m.get(d.id) ?? {}), ...d })
  return [...m.values()]
}

/** Lote a conferir: as K primeiras da fila e, SEPARADAMENTE, a próxima futura (nunca cortada pelo K). */
export function lote(itens: Item[], cfg: CfgOrdem, agora: number, minuto: number, k: number) {
  const o = ordenar(itens, cfg, agora, minuto)
  const fila = o.fila.slice(0, k)
  return { fila, futura: o.futura, ids: [...fila.map((i) => i.id), ...(o.futura ? [o.futura.id] : [])], totalFila: o.fila.length }
}

/**
 * Conferência: válida = existe no Kommo, aberta, responsável = uid, MESMA entidade (tipo e id).
 * Válidas ganham prazo/texto vivos. Devolve os ids inválidos (que devem sair) e as válidas atualizadas.
 */
export function conferir(itens: Item[], ids: number[], vivas: TarefaKommo[], uid: number) {
  const porId = new Map(vivas.map((v) => [Number(v.id), v]))
  const alvo = new Set(ids)
  const invalidas = new Set<number>()
  const validas = new Map<number, Item>()
  for (const it of itens) {
    if (!alvo.has(it.id)) continue
    const v = porId.get(it.id)
    const mesmaEntidade = v && String(v.entity_type ?? '') === String(it.entity_type) && Number(v.entity_id) === Number(it.entity_id)
    if (!v || v.is_completed || Number(v.responsible_user_id) !== Number(uid) || !mesmaEntidade) { invalidas.add(it.id); continue }
    validas.set(it.id, { ...it, due: Number(v.complete_till) || 0, texto: v.text ?? it.texto })
  }
  return { invalidas, validas }
}

/**
 * Laço de emissão: ordena → confere o lote → remove inválidas → reordena e confere o que subiu, até `rodadas`.
 * `verificar(ids)` consulta o Kommo. Só itens confirmados são emitidos; o resto vira contagem `pendentes`.
 */
export async function emitir(
  itens: Item[], cfg: CfgOrdem, agora: number, minuto: number, uid: number, k: number, rodadas: number,
  verificar: (ids: number[]) => Promise<TarefaKommo[]>,
) {
  let base = itens
  const confirmadas = new Map<number, Item>()
  let sel = lote(base, cfg, agora, minuto, k)
  for (let r = 0; r < rodadas; r++) {
    const faltam = sel.ids.filter((id) => !confirmadas.has(id))
    if (!faltam.length) break
    const vivas = await verificar(faltam)
    const c = conferir(base, faltam, vivas, uid)
    for (const [id, it] of c.validas) confirmadas.set(id, it)
    base = base.filter((i) => !c.invalidas.has(i.id)).map((i) => confirmadas.get(i.id) ?? i)
    sel = lote(base, cfg, agora, minuto, k)
  }
  // emite só o que foi confirmado, na ordem final; o que não deu tempo de conferir fica pendente
  const fila = sel.fila.filter((i) => confirmadas.has(i.id))
  const futura = sel.futura && confirmadas.has(sel.futura.id) ? sel.futura : null
  return { fila, futura, pendentes: Math.max(0, sel.totalFila - fila.length), total: base.length }
}
