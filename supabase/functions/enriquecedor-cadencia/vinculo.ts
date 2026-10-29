// Qual Salesbot dispara um modelo — e por qual número de WhatsApp (canal/source do Kommo).
//
// O bot é quem fixa o modelo E o canal (cada passo do Salesbot guarda o source), e
// cada aprovação de modelo na Meta é por canal. Por isso o vínculo é por par
// (modelo do hub, canal): enriquecedor_cadencia_vinculos (migration_177).
//
// Regras:
// - Há canal ativo e o modelo tem vínculo nele → o vínculo manda. Modelo não aprovado
//   NAQUELE canal, sem bot, bot com erro no último sync ou bot ainda não confirmado
//   por uma pessoa (vínculo copiado na troca de número), NÃO dispara (nada de cair no legado: a configuração
//   explícita ganha — é o que pega o "aprovado" falso de canal apagado).
// - Sem canal ativo, ou modelo sem vínculo no canal ativo → legado (colunas antigas
//   review_status + kommo_bots_por_responsavel/kommo_bot_id), até o painel ser validado.
//   Remover o legado só depois da fatia 4 validada.
// Sem dependências: testado em vinculo_test.ts.

export type ModeloLegado = {
  id: string
  nome?: string
  review_status?: string | null
  kommo_bot_id?: number | string | null
  kommo_bots_por_responsavel?: Record<string, number | string> | null
}

export type Vinculo = {
  template_id: string
  source_id: number | string
  kommo_template_id?: string | null
  kommo_bot_id?: number | string | null
  review_status?: string | null
  /** problema do bot achado no último sync (sumiu/desativado) */
  erro?: string | null
  /** quando uma pessoa confirmou que o bot manda este modelo neste canal; null = a confirmar */
  bot_verificado_em?: string | null
}

export type Escolha = {
  botId: number | null
  /** canal por onde sai; null no legado (o canal fica dentro do bot e o hub não sabe) */
  sourceId: number | null
  origem: 'vinculo' | 'legado'
  /** motivo de NÃO disparar; null = pode disparar */
  motivo: string | null
}

// Legado: bot do WhatsApp do responsável do card. Mapa {kommoUserId: botId}; vazio =
// kommo_bot_id único. Com mapa e sem bot do responsável: NÃO dispara por outro número.
export function botDoResponsavel(tpl: ModeloLegado | null | undefined, uid: number | null): number | null {
  const mapa = (tpl?.kommo_bots_por_responsavel ?? {}) as Record<string, number | string>
  if (!Object.keys(mapa).length) return tpl?.kommo_bot_id ? Number(tpl.kommo_bot_id) : null
  const b = uid ? mapa[String(uid)] : null
  return b ? Number(b) : null
}

export function escolherBot(
  tpl: ModeloLegado,
  uid: number | null,
  canalAtivo: number | null,
  vinculos: Vinculo[],
  quem?: string | null,
): Escolha {
  const v = canalAtivo != null
    ? vinculos.find((x) => x.template_id === tpl.id && Number(x.source_id) === Number(canalAtivo))
    : undefined
  if (v) {
    const botId = v.kommo_bot_id ? Number(v.kommo_bot_id) : null
    const base = { botId, sourceId: Number(canalAtivo), origem: 'vinculo' as const }
    if (v.review_status !== 'aprovado') {
      return { ...base, motivo: `modelo ${tpl.nome ?? tpl.id} sem aprovação da Meta no canal ${canalAtivo} (${v.review_status ?? 'nao_verificado'})` }
    }
    if (!botId) return { ...base, motivo: `modelo ${tpl.nome ?? tpl.id} sem bot vinculado no canal ${canalAtivo}` }
    if (v.erro) return { ...base, motivo: `modelo ${tpl.nome ?? tpl.id} no canal ${canalAtivo}: ${v.erro}` }
    if (!v.bot_verificado_em) return { ...base, motivo: `modelo ${tpl.nome ?? tpl.id}: bot ${botId} ainda não confirmado no canal ${canalAtivo}` }
    return { ...base, motivo: null }
  }
  const botId = botDoResponsavel(tpl, uid)
  const base = { botId, sourceId: null, origem: 'legado' as const }
  if (tpl.review_status !== 'aprovado') return { ...base, motivo: 'template sem aprovação da Meta' }
  if (!botId) return { ...base, motivo: `sem bot deste modelo no WhatsApp do responsável do card (${quem ?? uid ?? 'sem responsável'})` }
  return { ...base, motivo: null }
}
