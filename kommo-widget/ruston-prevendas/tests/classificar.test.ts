// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classificar, grupoDaOrigem, mapaSlots, momentoDaEtapa, TIPO } from '../../../supabase/functions/_shared/prevendas_classificar.ts'

const t = (id: number, tipo: number | null, text = '') => ({ id, task_type_id: tipo, text })

test('slot da cadência vence tudo e define a ação', () => {
  const lead = { etapa: 'FOLLOW 2', origem: 'Outbound' }
  assert.deepEqual(
    [classificar(t(1, TIPO.LIGACAO), 'T5', lead).momento, classificar(t(1, TIPO.LIGACAO), 'T5', lead).acao],
    ['anti_noshow', 'ligar'])
  // T4 e R2 são WhatsApp: nunca "ligar" (uma ligação não pode concluir)
  assert.equal(classificar(t(2, TIPO.WHATSAPP), 'T4', lead).acao, 'whatsapp')
  assert.equal(classificar(t(3, TIPO.WHATSAPP), 'R2', lead).acao, 'whatsapp')
  assert.equal(classificar(t(3, TIPO.WHATSAPP), 'R2', lead).momento, 'recuperar')
  assert.equal(classificar(t(4, TIPO.LIGACAO), 'R1', lead).acao, 'ligar')
})

test('produtores conhecidos', () => {
  const c = classificar(t(5, 1, 'CADENCIA: lead respondeu com interesse ("oi"). Ligar AGORA'), null, null)
  assert.equal(c.momento, 'conexao'); assert.equal(c.acao, 'ligar'); assert.equal(c.urgente, true)
  assert.equal(classificar(t(6, 1, 'Retorno'), null, null).momento, 'follow_up')
  assert.equal(classificar(t(7, TIPO.SEM_TAREFA, 'SEM TAREFA — x'), null, { etapa: 'FOLLOW 1', origem: null }).momento, 'sem_classificacao')
})

test('tipo novo de momento (config) e etapa do lead', () => {
  assert.equal(classificar(t(8, 999), null, null, { 999: 'speed_to_lead' }).urgente, true)
  assert.equal(classificar(t(9, 1, 'ligar'), null, { etapa: 'SPEED TO LEAD', origem: 'Inbound' }).momento, 'speed_to_lead')
  assert.equal(classificar(t(10, 1), null, { etapa: 'CONEXÃO REALIZADA', origem: null }).momento, 'conexao')
  assert.equal(classificar(t(11, 1), null, { etapa: 'NOSHOW', origem: null }).momento, 'recuperar')
  assert.equal(classificar(t(12, 1), null, { etapa: 'ENTRADA', origem: 'Outbound' }).momento, 'prospeccao')
  assert.equal(classificar(t(13, 1), null, { etapa: 'REUNIÃO MARCADA', origem: null }).momento, 'sem_classificacao')
  assert.equal(momentoDaEtapa('Follow 3'), 'follow_up')
  assert.equal(momentoDaEtapa('No-Show'), 'recuperar')
})

test('origem → grupo; vazio/desconhecido = G9 (nunca outbound)', () => {
  assert.equal(grupoDaOrigem('Recomendação'), 'G1')
  assert.equal(grupoDaOrigem('Leadbroker'), 'G4')
  assert.equal(grupoDaOrigem('Outbound'), 'G5')
  assert.equal(grupoDaOrigem(''), 'G9')
  assert.equal(grupoDaOrigem(null), 'G9')
  assert.equal(grupoDaOrigem('Foodbox'), 'G9')
})

test('mapaSlots aceita objeto e ignora array vazio', () => {
  const m = mapaSlots([{ cadencia_task_ids: { T5: 4104425, T6: '4104427' } }, { cadencia_task_ids: [] }, { cadencia_task_ids: null }])
  assert.equal(m.get(4104425), 'T5'); assert.equal(m.get(4104427), 'T6'); assert.equal(m.size, 2)
})
