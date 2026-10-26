// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/chats.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatsSemResposta, itensDeChat } from '../../../supabase/functions/_shared/prevendas_chats.ts'

const ent = (lead: number, em: number, talk = 900 + lead) => ({ type: 'incoming_chat_message', entity_type: 'lead', entity_id: lead, created_at: em, created_by: 0, value_after: [{ message: { talk_id: talk } }] })
const sai = (lead: number, em: number, por: number) => ({ type: 'outgoing_chat_message', entity_type: 'lead', entity_id: lead, created_at: em, created_by: por, value_after: [{ message: { talk_id: 900 + lead } }] })

test('cliente falou por último e ninguém respondeu → pendente desde a 1ª mensagem sem resposta', () => {
  const r = chatsSemResposta([ent(1, 100), ent(1, 110), sai(2, 50, 7), ent(2, 40)])
  assert.deepEqual(r, [{ lead_id: 1, talk_id: 901, desde: 100, ultima: 110 }])
})

test('resposta de BOT (created_by 0) não conta; resposta humana conta', () => {
  assert.equal(chatsSemResposta([ent(1, 100), sai(1, 105, 0)]).length, 1)        // autoresposta/Salesbot
  assert.equal(chatsSemResposta([ent(1, 100), sai(1, 105, 42)]).length, 0)       // SDR respondeu
  const r = chatsSemResposta([ent(1, 100), sai(1, 105, 42), ent(1, 200), sai(1, 210, 0)])
  assert.deepEqual(r, [{ lead_id: 1, talk_id: 901, desde: 200, ultima: 200 }])  // nova mensagem depois da humana
})

test('ignora eventos sem lead (contato/empresa) e ordena pelo mais antigo esperando', () => {
  const r = chatsSemResposta([{ ...ent(5, 300), entity_type: 'contact' }, ent(3, 200), ent(4, 100)])
  assert.deepEqual(r.map((c) => c.lead_id), [4, 3])
})

test('itensDeChat: só leads abertos do usuário, talk encerrado sai, talk desconhecido entra', () => {
  const chats = chatsSemResposta([ent(1, 100), ent(2, 100), ent(3, 100), ent(4, 100), ent(5, 100)])
  const leads = {
    1: { responsavel: 11, status_id: 5, nome: 'Um' },
    2: { responsavel: 99, status_id: 5 },              // de outro SDR
    3: { responsavel: 11, status_id: 143 },            // perdido
    4: { responsavel: 11, status_id: 5 },              // talk encerrado
    5: { responsavel: 11, status_id: 5 },              // talk sem status consultado
  }
  const itens = itensDeChat(chats, 11, leads, { 904: 'closed', 901: 'in_work' })
  assert.deepEqual(itens.map((i) => i.entity_id), [1, 5])
  assert.equal(itens[0].id, -1); assert.equal(itens[0].momento, 'chat_sem_resposta'); assert.equal(itens[0].due, 100)
  assert.equal(itens[0].acao, 'chat'); assert.equal(itens[0].lead_nome, 'Um')
})
