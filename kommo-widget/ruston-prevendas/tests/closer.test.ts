// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/closer.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aplicarCloser, decidirModo, foraDaFila, paraConfirmar } from '../../../supabase/functions/_shared/prevendas_closer.ts'

const item = (id: number, eid: number, etype = 'leads') => ({
  id, entity_type: etype, entity_id: eid, due: 100, texto: '', lead_nome: null, etapa: null, origem_pendente: false,
  momento: 'follow_up' as const, acao: 'outro', grupo: 'G9', urgente: false, fonte: 'tipo', motivo: '',
})

test('modo: papel decide no servidor; override só para gestor', () => {
  assert.equal(decidirModo('closer', undefined), 'closer')
  assert.equal(decidirModo('sdr', 'closer'), 'sdr')            // SDR não força o modo
  assert.equal(decidirModo('closer', 'sdr'), 'closer')         // closer também não
  assert.equal(decidirModo('gestor', 'closer'), 'closer')
  assert.equal(decidirModo('gestor', 'xpto'), 'sdr')
  assert.equal(decidirModo(null, 'closer'), 'sdr')
})

test('foraDaFila: Incoming/assinado só no funil Closer; ganho/perdido em qualquer funil', () => {
  assert.equal(foraDaFila({ status_id: 84456015, pipeline_id: 11010459 }), true)
  assert.equal(foraDaFila({ status_id: 110112424, pipeline_id: 11010459 }), true)
  assert.equal(foraDaFila({ status_id: 84456015, pipeline_id: 999 }), false)
  assert.equal(foraDaFila({ status_id: 142, pipeline_id: 14062096 }), true)
  assert.equal(foraDaFila({ status_id: 102174784, pipeline_id: 11010459 }), false)
  assert.equal(foraDaFila(null), false)
})

test('exclusão SÓ com etapa confirmada ao vivo; sem confirmação vira etapa_pendente (nunca some)', () => {
  const itens = [item(1, 10), item(2, 20), item(3, 30), item(4, 40, 'contacts')]
  const rep = { 10: { status_id: 142, pipeline_id: 11010459 }, 20: { status_id: 142, pipeline_id: 11010459 }, 30: { status_id: 102174784, pipeline_id: 11010459 } }
  assert.deepEqual(paraConfirmar(itens, rep), [10, 20])
  const vivos = { 10: { status_id: 142, pipeline_id: 11010459 } }           // 20 não coube no orçamento
  const r = aplicarCloser(itens, rep, vivos, {})
  assert.deepEqual(r.map((i) => i.id), [2, 3, 4])                           // só o 10 (confirmado) saiu
  assert.equal(r[0].etapa_pendente, true); assert.equal(r[1].etapa_pendente, false)
  assert.equal(r[2].status_id, null)                                        // contato: sem etapa
})

test('lead reaberto: réplica diz ganho, ao vivo diz ALTA → aparece, com a etapa viva', () => {
  const r = aplicarCloser([item(1, 10)], { 10: { status_id: 142, pipeline_id: 11010459 } }, { 10: { status_id: 102174784, pipeline_id: 11010459 } }, {})
  assert.equal(r.length, 1); assert.equal(r[0].status_id, 102174784); assert.equal(r[0].etapa_pendente, false)
})

test('compromisso anotado por lead (a função do banco já filtra pelo closer efetivo)', () => {
  const r = aplicarCloser([item(1, 10), item(2, 20)], {}, {}, { 10: 5000 })
  assert.equal(r[0].reuniao_em, 5000); assert.equal(r[1].reuniao_em, null)
})
