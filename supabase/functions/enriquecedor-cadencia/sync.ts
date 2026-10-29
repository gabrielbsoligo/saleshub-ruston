// sync-vinculos: confere, por canal, os vínculos (modelo do hub → modelo do Kommo + bot).
//
// O vínculo é uma identidade escolhida por alguém (bot X manda o modelo Y no canal Z):
// o sync NUNCA troca o modelo do Kommo de um vínculo — o mesmo nome no canal não prova
// que o bot manda aquela cópia (a API pública não mostra o conteúdo do bot). Ele só:
// - relê o status da Meta do modelo VINCULADO naquele canal (sumiu = 'ausente');
// - aponta, como sugestão, a cópia aprovada de mesmo nome quando é outra (revincular
//   à mão, conferindo o bot);
// - confere se o bot existe e está ativo (GET /api/v4/bots). Sem a lista de bots
//   (falha na API), mantém o erro anterior — nunca desbloqueia sem verificação nova.
// Sem dependências: testado em sync_test.ts.

export const MAPA_REVIEW: Record<string, string> = {
  approved: 'aprovado', rejected: 'rejeitado', review: 'em_revisao', pending: 'em_revisao', paused: 'rejeitado',
}

export type ModeloHub = { id: string; nome: string }
export type ModeloRemoto = { id: number | string; name?: string; _embedded?: { reviews?: { source_id: number | string; status: string }[] } }
export type BotRemoto = { id: number | string; name?: string; settings?: { active?: boolean } }
export type VinculoAtual = {
  template_id: string
  kommo_template_id?: string | null
  kommo_bot_id?: number | string | null
  review_status?: string | null
  erro?: string | null
}

export type Resolucao = {
  template_id: string
  nome: string
  /** o vinculado (nunca trocado aqui) */
  kommo_template_id: string | null
  review_status: string
  erro: string | null
  /** cópia aprovada de mesmo nome no canal, quando difere da vinculada */
  sugestao: string | null
  mudou: boolean
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()
const statusNoCanal = (r: ModeloRemoto | undefined, sourceId: number) => {
  const rv = (r?._embedded?.reviews ?? []).find((x) => Number(x.source_id) === sourceId)
  return rv ? (MAPA_REVIEW[norm(rv.status)] ?? 'em_revisao') : null
}

// Melhor cópia de um nome num canal: aprovada ganha; empate = id mais novo.
export function melhorNoCanal(remotos: ModeloRemoto[], nome: string, sourceId: number) {
  const ordem = ['aprovado', 'em_revisao', 'rejeitado']
  let melhor: { id: string; status: string } | null = null
  for (const r of remotos) {
    if (norm(r.name) !== norm(nome)) continue
    const status = statusNoCanal(r, sourceId)
    if (!status) continue
    const cand = { id: String(r.id), status }
    if (!melhor) { melhor = cand; continue }
    const a = ordem.indexOf(cand.status), b = ordem.indexOf(melhor.status)
    if (a < b || (a === b && Number(cand.id) > Number(melhor.id))) melhor = cand
  }
  return melhor
}

/** Confere os vínculos EXISTENTES de um canal. `bots` null = a lista de bots falhou. */
export function conferirVinculos(
  modelos: ModeloHub[],
  remotos: ModeloRemoto[],
  sourceId: number,
  atuais: VinculoAtual[],
  bots: BotRemoto[] | null,
): Resolucao[] {
  const modeloPor = new Map(modelos.map((m) => [m.id, m]))
  const remotoPor = new Map(remotos.map((r) => [String(r.id), r]))
  const botPor = bots ? new Map(bots.map((b) => [Number(b.id), b])) : null
  return atuais.filter((v) => modeloPor.has(v.template_id)).map((v) => {
    const m = modeloPor.get(v.template_id)!
    const kid = v.kommo_template_id ? String(v.kommo_template_id) : null
    const review_status = kid ? (statusNoCanal(remotoPor.get(kid), sourceId) ?? 'ausente') : 'nao_verificado'
    const melhor = melhorNoCanal(remotos, m.nome, sourceId)
    const sugestao = melhor && melhor.status === 'aprovado' && melhor.id !== kid ? melhor.id : null
    let erro: string | null = v.erro ?? null
    const botId = v.kommo_bot_id ? Number(v.kommo_bot_id) : null
    if (botPor) {
      const b = botId ? botPor.get(botId) : null
      erro = !botId ? null
        : !b ? `bot ${botId} não existe mais no Kommo`
        : b.settings?.active === false ? `bot ${botId} está desativado no Kommo`
        : null
    }
    const mudou = v.review_status !== review_status || (v.erro ?? null) !== erro
    return { template_id: v.template_id, nome: m.nome, kommo_template_id: kid, review_status, erro, sugestao, mudou }
  })
}

/** Modelos sem vínculo no canal, com a cópia que existe lá (candidatos a vincular). */
export function semVinculo(modelos: ModeloHub[], remotos: ModeloRemoto[], sourceId: number, atuais: VinculoAtual[]) {
  const tem = new Set(atuais.map((v) => v.template_id))
  return modelos.filter((m) => !tem.has(m.id)).map((m) => {
    const melhor = melhorNoCanal(remotos, m.nome, sourceId)
    return { nome: m.nome, kommo_template_id: melhor?.id ?? null, review: melhor?.status ?? 'ausente' }
  })
}
