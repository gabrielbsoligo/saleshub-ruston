// node --test kommo-widget/ruston-prevendas/tests/fila.test.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
// script.js é AMD no Kommo; aqui roda num contexto isolado com um 'module' falso para expor o bloco Fila
const vm = require('node:vm')
const path = require('node:path')
const ctx = { module: { exports: {} } }
vm.runInNewContext(require('node:fs').readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'), ctx)
const Fila = ctx.module.exports

const AGORA = 1_800_000_000
const CFG = { antecedencia_min: 10, outbound_apos: '16:00', grupos: ['G1', 'G2', 'G3', 'G4', 'G5', 'G9'] }
const M10H = 10 * 60, M17H = 17 * 60
const it = (id, momento, grupo, dueMin, urgente = false) => ({ id, momento, grupo, due: AGORA + dueMin * 60, urgente })
const ids = (r) => [...r.fila].map((x) => x.id)   // copia para o realm do teste

test('ordem por momento: anti no-show > speed > conexão > follow-up > recuperar > pré-reunião > prospecção', () => {
  const r = Fila.ordenar([
    it(7, 'prospeccao', 'G1', -5), it(6, 'pre_reuniao', 'G9', -5), it(5, 'recuperar', 'G9', -5),
    it(4, 'follow_up', 'G9', -5), it(3, 'conexao', 'G9', -5), it(2, 'speed_to_lead', 'G2', -5), it(1, 'anti_noshow', 'G9', -5),
  ], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [1, 2, 3, 4, 5, 6, 7])
})

test('dentro do follow-up a origem desempata antes do vencimento', () => {
  const r = Fila.ordenar([it(1, 'follow_up', 'G5', -60), it(2, 'follow_up', 'G1', -1), it(3, 'follow_up', 'G4', -30)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [2, 3, 1])
})

test('mesmo nível e grupo: mais atrasada primeiro; depois id', () => {
  const r = Fila.ordenar([it(9, 'anti_noshow', 'G9', -1), it(8, 'anti_noshow', 'G9', -20), it(7, 'anti_noshow', 'G9', -20)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [7, 8, 9])
})

test('elegibilidade: só vencidas ou vencendo em até 10 min; urgentes entram na hora', () => {
  const r = Fila.ordenar([it(1, 'follow_up', 'G1', 30), it(2, 'conexao', 'G9', 120, true), it(3, 'follow_up', 'G1', 9)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [2, 3])
  assert.equal(r.futura.id, 1)
})

test('outbound (G5) espera o corte das 16h se houver outra coisa', () => {
  const itens = [it(1, 'prospeccao', 'G5', -5), it(2, 'follow_up', 'G1', -5)]
  assert.deepEqual(ids(Fila.ordenar(itens, CFG, AGORA, M10H)), [2])
  assert.deepEqual(ids(Fila.ordenar(itens, CFG, AGORA, M17H)), [2, 1])
})

test('outbound entra antes das 16h se a fila estiver vazia', () => {
  assert.deepEqual(ids(Fila.ordenar([it(1, 'prospeccao', 'G5', -5)], CFG, AGORA, M10H)), [1])
})

test('sem origem (G9) é neutro: não herda a janela do outbound', () => {
  const r = Fila.ordenar([it(1, 'prospeccao', 'G9', -5), it(2, 'prospeccao', 'G5', -5), it(3, 'pre_reuniao', 'G9', -5)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [3, 1])           // G9 aparece às 10h; G5 espera
  assert.equal(Fila.nivel({ momento: 'prospeccao', grupo: 'G9' }), 7.5)
  assert.equal(Fila.nivel({ momento: 'prospeccao', grupo: 'G1' }), 7)
  assert.equal(Fila.nivel({ momento: 'prospeccao', grupo: 'G5' }), 8)
})

test('fila vazia devolve a próxima futura', () => {
  const r = Fila.ordenar([it(1, 'follow_up', 'G1', 120), it(2, 'follow_up', 'G1', 60)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [])
  assert.equal(r.futura.id, 2)
})

test('candidatas: recentes/urgentes primeiro; backlog antigo não empurra a de agora para fora', () => {
  const tarefas = []
  for (let i = 0; i < 600; i++) tarefas.push({ id: i + 1, complete_till: AGORA - 30 * 86400 - i, created_at: AGORA - 40 * 86400 })
  tarefas.push({ id: 9001, complete_till: AGORA - 60, created_at: AGORA - 3 * 86400 })          // anti no-show de agora
  tarefas.push({ id: 9002, complete_till: AGORA + 7200, created_at: AGORA - 5 * 60 })          // criada agora (Ligar AGORA)
  tarefas.push({ id: 9003, complete_till: AGORA + 86400, created_at: AGORA - 86400 })          // futura distante: fora
  const c = Fila.candidatas(tarefas, AGORA, 10, 500)
  const lista = c.lista.map((t) => t.id)
  assert.ok(lista.includes(9001)); assert.ok(lista.includes(9002)); assert.ok(!lista.includes(9003))
  assert.equal(lista.length, 500); assert.equal(c.parcial, true)
})

test('modo local: só reconhece o "Ligar AGORA"', () => {
  assert.equal(Fila.classificarLocal({ text: 'CADENCIA: lead respondeu com interesse' }).urgente, true)
  assert.equal(Fila.classificarLocal({ text: 'qualquer' }).momento, 'sem_classificacao')
})
