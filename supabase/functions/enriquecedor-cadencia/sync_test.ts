// deno test supabase/functions/enriquecedor-cadencia/sync_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { conferirVinculos, melhorNoCanal, semVinculo, type ModeloRemoto, type VinculoAtual } from './sync.ts'

const NOVO = 70787, VELHO = 68797, EDRIC = 70371
const rem = (id: number, name: string, ...reviews: [number, string][]): ModeloRemoto =>
  ({ id, name, _embedded: { reviews: reviews.map(([source_id, status]) => ({ source_id, status })) } })
const REMOTOS = [
  rem(63351, 'sdna_p1_auditoria_v1', [VELHO, 'approved']),
  rem(65863, 'sdna_p1_auditoria_v1', [EDRIC, 'approved']),
  rem(66785, 'sdna_p1_auditoria_v1', [NOVO, 'approved']),
  rem(66819, 'sdna_p1_auditoria_v1_sem_sdr', [NOVO, 'approved']),
  rem(65833, 'sdna_p1_diag_geral_v1'), // sem review nenhum
]
const M1 = { id: 't1', nome: 'sdna_p1_auditoria_v1' }
const BOTS = [{ id: 81791, settings: { active: true } }]
const v = (p: Partial<VinculoAtual> = {}): VinculoAtual => ({ template_id: 't1', kommo_template_id: '66785', kommo_bot_id: 81791, review_status: 'aprovado', erro: null, ...p })

Deno.test('melhorNoCanal: cópia de mesmo nome NO canal; sufixo não casa; aprovado ganha; empate = mais novo', () => {
  assertEquals(melhorNoCanal(REMOTOS, 'sdna_p1_auditoria_v1', NOVO)?.id, '66785')
  assertEquals(melhorNoCanal(REMOTOS, 'sdna_p1_auditoria_v1', VELHO)?.id, '63351')
  assertEquals(melhorNoCanal(REMOTOS, 'sdna_p1_auditoria_v1_sem_sdr', NOVO)?.id, '66819')
  assertEquals(melhorNoCanal(REMOTOS, 'sdna_p1_diag_geral_v1', NOVO), null)
  const r = [rem(1, 'x', [NOVO, 'review']), rem(2, 'x', [NOVO, 'approved']), rem(3, 'x', [NOVO, 'rejected'])]
  assertEquals(melhorNoCanal(r, ' X ', NOVO), { id: '2', status: 'aprovado' })
  assertEquals(melhorNoCanal([rem(5, 'x', [NOVO, 'approved']), rem(9, 'x', [NOVO, 'approved'])], 'x', NOVO)?.id, '9')
})

Deno.test('vínculo ok: status do modelo VINCULADO, sem mudança', () => {
  assertEquals(conferirVinculos([M1], REMOTOS, NOVO, [v()], BOTS)[0],
    { template_id: 't1', nome: 'sdna_p1_auditoria_v1', kommo_template_id: '66785', review_status: 'aprovado', erro: null, sugestao: null, mudou: false })
})

Deno.test('NUNCA troca o modelo vinculado: rejeitado fica rejeitado e a cópia aprovada vira só sugestão', () => {
  const r = [rem(1, 'x', [NOVO, 'rejected']), rem(2, 'x', [NOVO, 'approved'])]
  const [res] = conferirVinculos([{ id: 't1', nome: 'x' }], r, NOVO, [v({ kommo_template_id: '1', kommo_bot_id: 999 })], [{ id: 999 }])
  assertEquals([res.kommo_template_id, res.review_status, res.sugestao, res.mudou], ['1', 'rejeitado', '2', true])
})

Deno.test('modelo vinculado sumiu do canal → ausente; vínculo sem id → nao_verificado', () => {
  assertEquals(conferirVinculos([M1], REMOTOS, NOVO, [v({ kommo_template_id: '63351' })], BOTS)[0].review_status, 'ausente')
  const [s] = conferirVinculos([M1], REMOTOS, NOVO, [v({ kommo_template_id: null })], BOTS)
  assertEquals([s.review_status, s.sugestao], ['nao_verificado', '66785'])
})

Deno.test('bot sumiu / desativado viram erro; bot volta a existir limpa o erro', () => {
  assertEquals(conferirVinculos([M1], REMOTOS, NOVO, [v()], [])[0].erro, 'bot 81791 não existe mais no Kommo')
  assertEquals(conferirVinculos([M1], REMOTOS, NOVO, [v()], [{ id: '81791', settings: { active: false } }])[0].erro, 'bot 81791 está desativado no Kommo')
  assertEquals(conferirVinculos([M1], REMOTOS, NOVO, [v({ erro: 'bot 81791 não existe mais no Kommo' })], BOTS)[0].erro, null)
})

Deno.test('falha na lista de bots MANTÉM o erro anterior (bloqueado continua bloqueado)', () => {
  const [r] = conferirVinculos([M1], REMOTOS, NOVO, [v({ erro: 'bot 81791 está desativado no Kommo' })], null)
  assertEquals([r.erro, r.mudou], ['bot 81791 está desativado no Kommo', false])
  assertEquals(conferirVinculos([M1], REMOTOS, NOVO, [v()], null)[0].erro, null)
})

Deno.test('semVinculo lista candidatos com a cópia do canal; vínculo de modelo que não está na lista é ignorado', () => {
  const ms = [M1, { id: 't9', nome: 'sdna_p1_auditoria_v1_sem_sdr' }, { id: 't3', nome: 'nao_existe' }]
  assertEquals(semVinculo(ms, REMOTOS, NOVO, [v()]), [
    { nome: 'sdna_p1_auditoria_v1_sem_sdr', kommo_template_id: '66819', review: 'aprovado' },
    { nome: 'nao_existe', kommo_template_id: null, review: 'ausente' },
  ])
  assertEquals(conferirVinculos([], REMOTOS, NOVO, [v()], BOTS), [])
})
