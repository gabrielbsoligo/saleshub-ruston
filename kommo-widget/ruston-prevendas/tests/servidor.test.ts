// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/servidor.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conferir, emitir, juntar, lote, type Item, type TarefaKommo } from '../../../supabase/functions/_shared/prevendas_servidor.ts'

const AGORA = 1_800_000_000, M10H = 600, UID = 7
const CFG = { antecedencia_min: 10, outbound_apos: '16:00', grupos: ['G1', 'G2', 'G3', 'G4', 'G5', 'G9'] }
const it = (id: number, dueMin: number, extra: Partial<Item> = {}): Item => ({
  id, due: AGORA + dueMin * 60, momento: 'follow_up', grupo: 'G1', urgente: false, entity_type: 'leads', entity_id: id * 10,
  texto: 't' + id, lead_nome: 'L' + id, etapa: null, acao: 'outro', fonte: 'slot', motivo: '', ...extra,
})
const viva = (i: Item, extra: Partial<TarefaKommo> = {}): TarefaKommo => ({
  id: i.id, is_completed: false, responsible_user_id: UID, complete_till: i.due, text: i.texto, entity_type: i.entity_type, entity_id: i.entity_id, ...extra,
})

test('conferir: só emite existente, aberta, do usuário e na mesma entidade', () => {
  const itens = [it(1, -5), it(2, -5), it(3, -5), it(4, -5), it(5, -5)]
  const vivas = [viva(itens[0], { complete_till: AGORA + 999, text: 'vivo' }), viva(itens[1], { is_completed: true }), viva(itens[2], { responsible_user_id: 8 }), viva(itens[3], { entity_id: 999 })]
  const c = conferir(itens, [1, 2, 3, 4, 5], vivas, UID)
  assert.deepEqual([...c.invalidas].sort(), [2, 3, 4, 5])          // 5 = excluída (não veio)
  assert.equal(c.validas.get(1)!.due, AGORA + 999); assert.equal(c.validas.get(1)!.texto, 'vivo')
})

test('juntar: descoberta ao vivo entra mesmo ausente da réplica (Ligar AGORA perdido no sync)', () => {
  const r = juntar([it(1, -5)], [it(2, 120, { momento: 'conexao', urgente: true })])
  assert.deepEqual(r.map((x) => x.id).sort(), [1, 2])
})

test('lote: a futura entra no conjunto mesmo com K elegíveis', () => {
  const itens = Array.from({ length: 30 }, (_, i) => it(i + 1, -5)).concat([it(99, 120)])
  const l = lote(itens, CFG, AGORA, M10H, 25)
  assert.equal(l.fila.length, 25); assert.equal(l.futura!.id, 99); assert.ok(l.ids.includes(99)); assert.equal(l.ids.length, 26)
})

test('emitir: nada sem conferência sai; o que sobe após invalidação é conferido na rodada seguinte', async () => {
  const itens = Array.from({ length: 30 }, (_, i) => it(i + 1, -60 + i))   // 1 é o mais atrasado
  const consultas: number[][] = []
  const verificar = async (ids: number[]) => {
    consultas.push(ids)
    // as 20 primeiras foram excluídas no Kommo; as demais existem
    return itens.filter((i) => ids.includes(i.id) && i.id > 20).map((i) => viva(i))
  }
  const r = await emitir(itens, CFG, AGORA, M10H, UID, 25, 2, verificar)
  assert.ok(r.fila.every((i) => i.id > 20))                                  // nenhuma excluída emitida
  assert.deepEqual(r.fila.map((i) => i.id), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30])
  assert.equal(consultas.length, 2)                                          // 2ª rodada conferiu as que subiram
  assert.equal(r.pendentes, 0)
})

test('emitir: o que não deu tempo de conferir vira pendente, não é emitido', async () => {
  const itens = Array.from({ length: 60 }, (_, i) => it(i + 1, -60 + i))
  const verificar = async (ids: number[]) => itens.filter((i) => ids.includes(i.id) && i.id > 25).map((i) => viva(i))
  const r = await emitir(itens, CFG, AGORA, M10H, UID, 25, 1, verificar)   // só 1 rodada: as 25 primeiras eram inválidas
  assert.equal(r.fila.length, 0); assert.ok(r.pendentes > 0)
})

test('emitir: falha do Kommo propaga (o chamador devolve 503, não emite nada)', async () => {
  await assert.rejects(() => emitir([it(1, -5)], CFG, AGORA, M10H, UID, 25, 2, async () => { throw new Error('kommo 429') }), /429/)
})
