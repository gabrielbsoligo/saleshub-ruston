// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/servidor.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadsFaltando, montarItens } from '../../../supabase/functions/_shared/prevendas_servidor.ts'

const UID = 7
const t = (id: number, extra = {}) => ({ id, is_completed: false, responsible_user_id: UID, task_type_id: 1, complete_till: 1000 + id, text: 't' + id, entity_type: 'leads', entity_id: id * 10, ...extra })

test('classifica com o texto/tipo VIVOS (edição para "Ligar AGORA" vira conexão urgente)', () => {
  const [i] = montarItens([t(1, { text: 'CADENCIA: lead respondeu com interesse ("oi"). Ligar AGORA', complete_till: 999999 })], UID, { 10: { nome: 'L', origem: 'Recomendação' } }, {})
  assert.equal(i.momento, 'conexao'); assert.equal(i.urgente, true); assert.equal(i.grupo, 'G1'); assert.equal(i.due, 999999)
})

test('defesa em profundidade: concluída ou de outro dono não vira item', () => {
  const r = montarItens([t(1), t(2, { is_completed: true }), t(3, { responsible_user_id: 8 })], UID, {}, {})
  assert.deepEqual(r.map((x) => x.id), [1])
})

test('slot da cadência e origem do lead', () => {
  const [i] = montarItens([t(5, { task_type_id: 3732751 })], UID, { 50: { nome: 'X', etapa: 'REUNIÃO MARCADA', origem: 'Leadbroker' } }, { 5: 'T5' })
  assert.equal(i.momento, 'anti_noshow'); assert.equal(i.acao, 'ligar'); assert.equal(i.grupo, 'G4'); assert.equal(i.lead_nome, 'X'); assert.equal(i.origem_pendente, false)
})

test('lead sem dados fica com origem_pendente (não "sem origem")', () => {
  const [i] = montarItens([t(9)], UID, {}, {})
  assert.equal(i.origem_pendente, true)
  const [c] = montarItens([t(9, { entity_type: 'contacts' })], UID, {}, {})
  assert.equal(c.origem_pendente, false)      // contato não tem origem de lead
})

test('leadsFaltando: só leads ausentes, sem repetir', () => {
  assert.deepEqual(leadsFaltando([t(1), t(2), t(1), t(3, { entity_type: 'contacts' })], { 10: {} }), [20])
})
