// deno test supabase/functions/enriquecedor-cadencia/vinculo_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { AGUARDANDO_CONFERENCIA, botDoResponsavel, escolherBot, patchVincular, type ModeloLegado, type Vinculo } from './vinculo.ts'

const LARY = 14559996, EDRIC = 15444836, NOVO = 70787, VELHO = 68797
const tpl: ModeloLegado = {
  id: 't1', nome: 'sdna_p1_auditoria_v1', review_status: 'aprovado',
  kommo_bot_id: 81791, kommo_bots_por_responsavel: { [LARY]: 81791, [EDRIC]: 82983 },
}
const vinc = (p: Partial<Vinculo> = {}): Vinculo => ({ template_id: 't1', source_id: NOVO, kommo_template_id: '66785', kommo_bot_id: 81791, review_status: 'aprovado', bot_verificado_em: '2026-10-29T12:00:00Z', ...p })

Deno.test('legado: mapa por responsável, kommo_bot_id único e sem bot', () => {
  assertEquals(botDoResponsavel(tpl, EDRIC), 82983)
  assertEquals(botDoResponsavel(tpl, 999), null)
  assertEquals(botDoResponsavel({ id: 'x', kommo_bot_id: 5 }, 999), 5)
  assertEquals(botDoResponsavel(null, 1), null)
})

Deno.test('vínculo aprovado no canal ativo manda — mesmo bot pra qualquer responsável', () => {
  const e = escolherBot(tpl, EDRIC, NOVO, [vinc({ kommo_bot_id: 90001 })])
  assertEquals(e, { botId: 90001, sourceId: NOVO, origem: 'vinculo', motivo: null })
  // responsável sem bot no mapa legado: com vínculo, dispara igual
  assertEquals(escolherBot(tpl, 123, NOVO, [vinc()]).motivo, null)
})

Deno.test('vínculo não aprovado ou sem bot BLOQUEIA — não cai no legado', () => {
  const r = escolherBot(tpl, LARY, NOVO, [vinc({ review_status: 'em_revisao' })])
  assertEquals(r.origem, 'vinculo')
  assertEquals(r.motivo?.includes('sem aprovação da Meta no canal 70787'), true)
  const s = escolherBot(tpl, LARY, NOVO, [vinc({ kommo_bot_id: null })])
  assertEquals(s.motivo?.includes('sem bot vinculado no canal 70787'), true)
  assertEquals(escolherBot(tpl, LARY, NOVO, [vinc({ review_status: null })]).motivo?.includes('nao_verificado'), true)
})

Deno.test('vínculo de OUTRO canal ou outro modelo é ignorado → legado', () => {
  const e = escolherBot(tpl, LARY, NOVO, [vinc({ source_id: VELHO }), vinc({ template_id: 't2' })])
  assertEquals(e, { botId: 81791, sourceId: null, origem: 'legado', motivo: null })
})

Deno.test('sem canal ativo → legado, mesmo havendo vínculos', () => {
  assertEquals(escolherBot(tpl, EDRIC, null, [vinc()]).origem, 'legado')
  assertEquals(escolherBot(tpl, EDRIC, null, [vinc()]).botId, 82983)
})

Deno.test('legado preserva os motivos antigos', () => {
  assertEquals(escolherBot({ ...tpl, review_status: 'em_revisao' }, LARY, null, []).motivo, 'template sem aprovação da Meta')
  assertEquals(escolherBot(tpl, 999, null, [], 'Ana').motivo, 'sem bot deste modelo no WhatsApp do responsável do card (Ana)')
})

Deno.test('source_id vindo do banco como string casa com canal numérico', () => {
  assertEquals(escolherBot(tpl, LARY, NOVO, [vinc({ source_id: '70787', kommo_bot_id: '81791' })]).botId, 81791)
})

Deno.test('bot com erro no último sync (sumiu/desativado) bloqueia', () => {
  const e = escolherBot(tpl, LARY, NOVO, [vinc({ erro: 'bot 81791 não existe mais no Kommo' })])
  assertEquals(e.motivo, 'modelo sdna_p1_auditoria_v1 no canal 70787: bot 81791 não existe mais no Kommo')
})

Deno.test('bot copiado na troca de número e ainda não confirmado bloqueia', () => {
  const e = escolherBot(tpl, LARY, NOVO, [vinc({ bot_verificado_em: null })])
  assertEquals(e.motivo, 'modelo sdna_p1_auditoria_v1: bot 81791 ainda não confirmado no canal 70787')
})

Deno.test('patchVincular: trocar só o modelo do Kommo invalida a confirmação do bot', () => {
  const T = '2026-10-29T18:00:00Z'
  assertEquals(patchVincular('66785', { kommo_template_id: '66819' }, T),
    { updated_at: T, erro: AGUARDANDO_CONFERENCIA, kommo_template_id: '66819', review_status: 'nao_verificado', bot_verificado_em: null })
  // mesmo modelo de novo: nada de identidade muda (continua bloqueado até o sync)
  assertEquals(patchVincular('66785', { kommo_template_id: '66785' }, T), { updated_at: T, erro: AGUARDANDO_CONFERENCIA })
})

Deno.test('patchVincular: bot informado confirma o par; tirar o bot zera a confirmação; nunca grava liberado', () => {
  const T = '2026-10-29T18:00:00Z'
  assertEquals(patchVincular('66785', { bot_id: 81791 }, T), { updated_at: T, erro: AGUARDANDO_CONFERENCIA, kommo_bot_id: 81791, bot_verificado_em: T })
  assertEquals(patchVincular(null, { bot_id: '81791', kommo_template_id: '66819' }, T).bot_verificado_em, T)
  assertEquals(patchVincular('66785', { bot_id: null }, T), { updated_at: T, erro: AGUARDANDO_CONFERENCIA, kommo_bot_id: null, bot_verificado_em: null })
  // gravado assim, o carteiro bloqueia até o sync limpar o erro
  assertEquals(escolherBot(tpl, LARY, NOVO, [vinc({ erro: AGUARDANDO_CONFERENCIA })]).motivo, `modelo sdna_p1_auditoria_v1 no canal 70787: ${AGUARDANDO_CONFERENCIA}`)
})
