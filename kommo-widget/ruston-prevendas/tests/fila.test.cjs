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

test('modo local: só reconhece o "Ligar AGORA"', () => {
  assert.equal(Fila.classificarLocal({ text: 'CADENCIA: lead respondeu com interesse' }).urgente, true)
  assert.equal(Fila.classificarLocal({ text: 'qualquer' }).momento, 'sem_classificacao')
})

test('P10: tarefa de nível 9 não segura o outbound antes das 16h', () => {
  const r = Fila.ordenar([it(1, 'prospeccao', 'G5', -5), it(2, 'sem_classificacao', 'G9', -5)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [1, 2])
})

test('P9: sem nada vencido, a próxima futura é navegável (e pula a entidade aberta)', () => {
  const fut = { id: 5, etype: 'leads', eid: 50, due: AGORA + 3600 }
  const p = Fila.proximoDe([], fut, null)
  assert.equal(p.item.id, 5); assert.equal(p.futura, true)
  assert.equal(Fila.proximoDe([], fut, { etype: 'leads', eid: 50 }), null)
  const f1 = { id: 1, etype: 'leads', eid: 10 }, f2 = { id: 2, etype: 'leads', eid: 20 }
  assert.equal(Fila.proximoDe([f1, f2], fut, { etype: 'leads', eid: 10 }).item.id, 2)
})

test('P7: backlog grande não inunda nem repete notificações', () => {
  const tarefas = []
  for (let i = 1; i <= 805; i++) tarefas.push({ id: i, due: AGORA - 2 * 86400 })        // backlog antigo
  for (let i = 900; i < 912; i++) tarefas.push({ id: i, due: AGORA + 60 })              // vencendo agora (12)
  let visto = {}
  const c1 = Fila.paraNotificar(tarefas, visto, AGORA, 15, 5)
  assert.equal(c1.mostrar.length, 5); assert.equal(c1.resumidas, 7)                       // backlog não notifica
  visto = c1.visto
  const c2 = Fila.paraNotificar(tarefas, visto, AGORA + 45, 15, 5)
  assert.equal(c2.mostrar.length, 0); assert.equal(c2.resumidas, 0)                       // nada repete
  // o visto guarda só ids abertos: quando a tarefa fecha, sai
  const c3 = Fila.paraNotificar(tarefas.filter((t) => t.id !== 900), c2.visto, AGORA + 90, 15, 5)
  assert.equal(c3.visto[900], undefined); assert.equal(c3.visto[901], 1)
})

test('P1: liderança entre abas', () => {
  assert.equal(Fila.devoLiderar(null, 'a', 1000), true)
  assert.equal(Fila.devoLiderar({ aba: 'b', ate: 5000 }, 'a', 1000), false)
  assert.equal(Fila.devoLiderar({ aba: 'b', ate: 500 }, 'a', 1000), true)       // expirou
  assert.equal(Fila.devoLiderar({ aba: 'a', ate: 5000 }, 'a', 1000), true)      // já é desta aba
})
