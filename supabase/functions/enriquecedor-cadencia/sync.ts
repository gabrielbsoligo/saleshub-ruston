// sync-vinculos: resolve, por canal, qual modelo do Kommo corresponde a cada modelo do hub.
//
// Ao trocar de número, os modelos são COPIADOS no Kommo com o MESMO nome e a aprovação
// da Meta é por canal (_embedded.reviews[].source_id). Então o vínculo (modelo, canal)
// sai sozinho: o modelo remoto de mesmo nome com review naquele canal. O bot NÃO é
// adivinhado (a API pública não mostra o conteúdo do bot): fica o que foi vinculado,
// e aqui só se confere se ele ainda existe e está ativo (GET /api/v4/bots).
// Sem dependências: testado em sync_test.ts.

export const MAPA_REVIEW: Record<string, string> = {
  approved: 'aprovado', rejected: 'rejeitado', review: 'em_revisao', pending: 'em_revisao', paused: 'rejeitado',
}

export type ModeloHub = { id: string; nome: string }
export type ModeloRemoto = { id: number | string; name?: string; _embedded?: { reviews?: { source_id: number | string; status: string }[] } }
export type BotRemoto = { id: number | string; name?: string; settings?: { active?: boolean } }
export type VinculoAtual = { template_id: string; kommo_template_id?: string | null; kommo_bot_id?: number | string | null; review_status?: string | null }

export type Resolucao = {
  template_id: string
  nome: string
  kommo_template_id: string | null
  review_status: string
  /** problema do bot vinculado (sumiu / inativo); null = ok ou sem bot */
  erro: string | null
  mudou: boolean
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase()

// Melhor modelo remoto de um nome num canal: aprovado ganha; empate = id mais novo.
function melhorNoCanal(remotos: ModeloRemoto[], nome: string, sourceId: number) {
  const ordem = ['aprovado', 'em_revisao', 'rejeitado']
  let melhor: { id: string; status: string } | null = null
  for (const r of remotos) {
    if (norm(r.name) !== norm(nome)) continue
    const rv = (r._embedded?.reviews ?? []).find((x) => Number(x.source_id) === sourceId)
    if (!rv) continue
    const status = MAPA_REVIEW[norm(rv.status)] ?? 'em_revisao'
    const cand = { id: String(r.id), status }
    if (!melhor) { melhor = cand; continue }
    const a = ordem.indexOf(cand.status), b = ordem.indexOf(melhor.status)
    if (a < b || (a === b && Number(cand.id) > Number(melhor.id))) melhor = cand
  }
  return melhor
}

export function resolverVinculos(
  modelos: ModeloHub[],
  remotos: ModeloRemoto[],
  sourceId: number,
  atuais: VinculoAtual[],
  bots: BotRemoto[] | null,
): Resolucao[] {
  const atualPor = new Map(atuais.map((v) => [v.template_id, v]))
  const botPor = bots ? new Map(bots.map((b) => [Number(b.id), b])) : null
  return modelos.map((m) => {
    const atual = atualPor.get(m.id)
    const achado = melhorNoCanal(remotos, m.nome, sourceId)
    const kommo_template_id = achado?.id ?? null
    const review_status = achado?.status ?? 'ausente'
    let erro: string | null = null
    const botId = atual?.kommo_bot_id ? Number(atual.kommo_bot_id) : null
    if (botId && botPor) {
      const b = botPor.get(botId)
      if (!b) erro = `bot ${botId} não existe mais no Kommo`
      else if (b.settings?.active === false) erro = `bot ${botId} está desativado no Kommo`
    }
    const mudou = !atual || String(atual.kommo_template_id ?? '') !== String(kommo_template_id ?? '') || atual.review_status !== review_status
    return { template_id: m.id, nome: m.nome, kommo_template_id, review_status, erro, mudou }
  })
}
