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

test('dedup: id repetido entre páginas vira um item, com a versão mais recente', async () => {
  const { dedupTarefas } = await import('../../../supabase/functions/_shared/prevendas_servidor.ts')
  const r = dedupTarefas([t(1, { updated_at: 10, text: 'velho' }), t(2), t(1, { updated_at: 20, text: 'novo' })])
  assert.equal(r.length, 2); assert.equal(r.find((x) => x.id === 1)!.text, 'novo')
  const itens = montarItens([t(1, { updated_at: 10 }), t(1, { updated_at: 20 })], UID, {}, {})
  assert.equal(itens.length, 1)
})

test('P3: com orçamento curto, a espera pela recarga garante ler TODAS as páginas em várias rodadas', async () => {
  const { esperarFicha, lerPaginado } = await import('../../../supabase/functions/_shared/prevendas_servidor.ts')
  // balde: 6 fichas, recarga 2/s; relógio simulado
  let relogio = 0, fichas = 6, ultimo = 0
  const consumir = async () => { fichas = Math.min(6, fichas + (relogio - ultimo) / 1000 * 2); ultimo = relogio; if (fichas >= 1) { fichas -= 1; return true } return false }
  const dormir = async (ms: number) => { relogio += ms }
  const agora = () => relogio
  const paginas = 8
  for (let rodada = 0; rodada < 3; rodada++) {
    const r = await lerPaginado(async (n) => {
      await esperarFicha(consumir, dormir, agora, relogio + 40_000, 3_000)
      return { itens: Array.from({ length: n < paginas ? 250 : 10 }, (_, i) => t(n * 1000 + i)), temProxima: n < paginas }
    }, 12)
    assert.equal(r.motivos.length, 0, 'rodada ' + rodada)
    assert.equal(r.tarefas.length, 7 * 250 + 10)                    // todas as 8 páginas
    relogio += 1_000                                                   // próximo ciclo logo em seguida
  }
})

test('P3: sem recarga suficiente dentro da espera, o parcial vem com motivo (nunca silencioso)', async () => {
  const { esperarFicha, lerPaginado } = await import('../../../supabase/functions/_shared/prevendas_servidor.ts')
  let relogio = 0, usadas = 0
  const consumir = async () => (usadas++ < 6)                         // nunca recarrega
  const r = await lerPaginado(async (n) => {
    await esperarFicha(consumir, async (ms) => { relogio += ms }, () => relogio, 40_000, 3_000)
    return { itens: [t(n)], temProxima: true }
  }, 12)
  assert.deepEqual(r.motivos, ['vazao_tarefas']); assert.equal(r.tarefas.length, 6)
})
