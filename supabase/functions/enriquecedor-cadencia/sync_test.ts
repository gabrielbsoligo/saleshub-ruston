// deno test supabase/functions/enriquecedor-cadencia/sync_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { resolverVinculos, type ModeloRemoto } from './sync.ts'

const NOVO = 70787, VELHO = 68797, EDRIC = 70371
const rem = (id: number, name: string, ...reviews: [number, string][]): ModeloRemoto =>
  ({ id, name, _embedded: { reviews: reviews.map(([source_id, status]) => ({ source_id, status })) } })
const REMOTOS = [
  rem(63351, 'sdna_p1_auditoria_v1', [VELHO, 'approved']),
  rem(65863, 'sdna_p1_auditoria_v1', [EDRIC, 'approved']),
  rem(66785, 'sdna_p1_auditoria_v1', [NOVO, 'approved']),
  rem(66815, 'Disparo D3 v2 - Recovery - Marina', [NOVO, 'review']),
  rem(66819, 'sdna_p1_auditoria_v1_sem_sdr', [NOVO, 'approved']),
  rem(65833, 'sdna_p1_diag_geral_v1'), // sem review nenhum
]
const M1 = { id: 't1', nome: 'sdna_p1_auditoria_v1' }

Deno.test('acha a cópia de mesmo nome aprovada NO canal pedido', () => {
  const [r] = resolverVinculos([M1], REMOTOS, NOVO, [], null)
  assertEquals([r.kommo_template_id, r.review_status, r.mudou, r.erro], ['66785', 'aprovado', true, null])
  assertEquals(resolverVinculos([M1], REMOTOS, VELHO, [], null)[0].kommo_template_id, '63351')
})

Deno.test('nome parecido (sufixo _sem_sdr) não casa com o original', () => {
  const [r] = resolverVinculos([{ id: 't9', nome: 'sdna_p1_auditoria_v1_sem_sdr' }], REMOTOS, NOVO, [], null)
  assertEquals(r.kommo_template_id, '66819')
})

Deno.test('sem modelo no canal → ausente (modelo sem review também não conta)', () => {
  assertEquals(resolverVinculos([{ id: 't2', nome: 'sdna_p1_diag_geral_v1' }], REMOTOS, NOVO, [], null)[0].review_status, 'ausente')
  assertEquals(resolverVinculos([{ id: 't3', nome: 'nao_existe' }], REMOTOS, NOVO, [], null)[0].kommo_template_id, null)
})

Deno.test('em revisão / rejeitado mapeiam; aprovado ganha de outra cópia em revisão', () => {
  const r = [rem(1, 'x', [NOVO, 'review']), rem(2, 'x', [NOVO, 'approved']), rem(3, 'x', [NOVO, 'rejected'])]
  assertEquals(resolverVinculos([{ id: 'a', nome: 'x' }], r, NOVO, [], null)[0], { template_id: 'a', nome: 'x', kommo_template_id: '2', review_status: 'aprovado', erro: null, mudou: true })
  assertEquals(resolverVinculos([{ id: 'a', nome: 'x' }], [r[0]], NOVO, [], null)[0].review_status, 'em_revisao')
  assertEquals(resolverVinculos([{ id: 'a', nome: 'x' }], [r[2]], NOVO, [], null)[0].review_status, 'rejeitado')
  // duas aprovadas: a mais nova
  assertEquals(resolverVinculos([{ id: 'a', nome: 'x' }], [rem(5, 'x', [NOVO, 'approved']), rem(9, 'x', [NOVO, 'approved'])], NOVO, [], null)[0].kommo_template_id, '9')
})

Deno.test('mudou=false quando nada mudou; nome com espaço/caixa diferente casa', () => {
  const atual = [{ template_id: 't1', kommo_template_id: '66785', review_status: 'aprovado', kommo_bot_id: 81791 }]
  assertEquals(resolverVinculos([M1], [rem(66785, ' SDNA_p1_auditoria_v1 ', [NOVO, 'approved'])], NOVO, atual, null)[0].mudou, false)
})

Deno.test('bot vinculado: sumiu / desativado viram erro; sem lista de bots não acusa', () => {
  const atual = [{ template_id: 't1', kommo_template_id: '66785', review_status: 'aprovado', kommo_bot_id: 81791 }]
  assertEquals(resolverVinculos([M1], REMOTOS, NOVO, atual, [])[0].erro, 'bot 81791 não existe mais no Kommo')
  assertEquals(resolverVinculos([M1], REMOTOS, NOVO, atual, [{ id: 81791, settings: { active: false } }])[0].erro, 'bot 81791 está desativado no Kommo')
  assertEquals(resolverVinculos([M1], REMOTOS, NOVO, atual, [{ id: '81791', settings: { active: true } }])[0].erro, null)
  assertEquals(resolverVinculos([M1], REMOTOS, NOVO, atual, null)[0].erro, null)
})
