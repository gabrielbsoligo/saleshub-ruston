// Ordem da fila de pré-vendas — PORT do bloco "Fila" de kommo-widget/ruston-prevendas/script.js.
// Usado pelo servidor (prevendas-fila) para decidir QUAIS tarefas conferir no Kommo e emitir.
// A paridade com o widget é garantida pelo teste tests/paridade.test.cjs (mesmas saídas em casos aleatórios).

export interface ItemOrdem {
  id: number
  due: number           // unix s; 0 = sem prazo
  momento: string
  grupo: string
  urgente: boolean
  [k: string]: unknown
}
export interface CfgOrdem { antecedencia_min?: number; outbound_apos?: string; grupos?: string[] }

const NIVEL: Record<string, number> = { anti_noshow: 1, speed_to_lead: 2, conexao: 3, follow_up: 4, recuperar: 5, pre_reuniao: 6, sem_classificacao: 9 }
const GRUPOS_PADRAO = ['G1', 'G2', 'G3', 'G4', 'G5', 'G9']
const COM_ORIGEM: Record<number, 1> = { 4: 1, 5: 1, 7: 1 }

export function nivel(item: { momento: string; grupo?: string }): number {
  if (item.momento === 'prospeccao') return item.grupo === 'G5' ? 8 : (item.grupo === 'G9' ? 7.5 : 7)
  const n = NIVEL[item.momento]
  return n == null ? 9 : n
}

export function minutos(hhmm: unknown): number {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return 16 * 60
  return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2])
}

export function ordenar<T extends ItemOrdem>(itens: T[], cfg: CfgOrdem, agora: number, minutoDoDia: number): { fila: T[]; futura: T | null } {
  const limite = agora + (cfg.antecedencia_min == null ? 10 : cfg.antecedencia_min) * 60
  const grupos = cfg.grupos && cfg.grupos.length ? cfg.grupos : GRUPOS_PADRAO
  const gi = (g: string) => { const i = grupos.indexOf(g); return i === -1 ? grupos.length : i }
  const elegiveis: { item: T; nivel: number }[] = [], futuras: { item: T; nivel: number }[] = []
  for (const it of itens) {
    const x = { item: it, nivel: nivel(it) }
    if (it.urgente || !it.due || it.due <= limite) elegiveis.push(x); else futuras.push(x)
  }
  const depoisDoCorte = minutoDoDia >= minutos(cfg.outbound_apos)
  const temPrioritaria = elegiveis.some((x) => x.nivel < 8)
  const fila = elegiveis.filter((x) => {
    if (x.nivel !== 8 || depoisDoCorte || !temPrioritaria) return true
    futuras.push(x)
    return false
  })
  fila.sort((a, b) => {
    if (a.nivel !== b.nivel) return a.nivel - b.nivel
    if (COM_ORIGEM[Math.floor(a.nivel)]) { const g = gi(a.item.grupo) - gi(b.item.grupo); if (g) return g }
    const da = a.item.due || 0, db = b.item.due || 0
    if (da !== db) return da - db
    return a.item.id - b.item.id
  })
  futuras.sort((a, b) => ((a.item.due || 0) - (b.item.due || 0)) || (a.item.id - b.item.id))
  return { fila: fila.map((x) => x.item), futura: futuras.length ? futuras[0].item : null }
}
