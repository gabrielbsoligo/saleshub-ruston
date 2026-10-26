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
const CFG = { antecedencia_min: 10, grupos: ['G1', 'G2', 'G3', 'G5', 'G9'] }
const M10H = 10 * 60, M17H = 17 * 60
const it = (id, momento, grupo, dueMin, urgente = false) => ({ id, momento, grupo, due: AGORA + dueMin * 60, urgente })
const ids = (r) => [...r.fila].map((x) => x.id)   // copia para o realm do teste

test('ordem por momento: anti no-show (inclui pré-reunião) > speed > conexão > follow-up > recuperar > prospecção', () => {
  const r = Fila.ordenar([
    it(7, 'prospeccao', 'G1', -5), it(5, 'recuperar', 'G9', -5),
    it(4, 'follow_up', 'G9', -5), it(3, 'conexao', 'G9', -5), it(2, 'speed_to_lead', 'G2', -5), it(1, 'anti_noshow', 'G9', -5),
  ], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [1, 2, 3, 4, 5, 7])
})

test('dentro do follow-up a origem desempata antes do vencimento', () => {
  const r = Fila.ordenar([it(1, 'follow_up', 'G5', -60), it(2, 'follow_up', 'G1', -1), it(3, 'follow_up', 'G2', -30)], CFG, AGORA, M10H)
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

test('decisão 26/10: sem corte de horário — outbound entra pela ordem, a qualquer hora', () => {
  const itens = [it(1, 'prospeccao', 'G5', -5), it(2, 'follow_up', 'G1', -5)]
  assert.deepEqual(ids(Fila.ordenar(itens, CFG, AGORA, M10H)), [2, 1])
  assert.deepEqual(ids(Fila.ordenar(itens, CFG, AGORA, M17H)), [2, 1])
})


test('sem origem (G9) fica entre a prospecção quente e o outbound', () => {
  const r = Fila.ordenar([it(1, 'prospeccao', 'G5', -5), it(2, 'prospeccao', 'G9', -5), it(3, 'prospeccao', 'G1', -5)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [3, 2, 1])
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

test('marcas locais escondem tarefas até expirar', () => {
  const t = [{ id: 1 }, { id: 2 }]
  assert.deepEqual([...Fila.semMarcadas(t, { 1: 1000 }, 1500, 1000)].map((x) => x.id), [2])
  assert.deepEqual([...Fila.semMarcadas(t, { 1: 1000 }, 2500, 1000)].map((x) => x.id), [1, 2])   // expirou
})

test('regras de frescor: leitura só substitui se for mais nova; falha só sai com leitura posterior', () => {
  assert.equal(Fila.leituraMaisNova(100, 0), true)
  assert.equal(Fila.leituraMaisNova(100, 100), false)
  assert.equal(Fila.leituraMaisNova(99, 100), false)
  assert.equal(Fila.leituraMaisNova(101, 100), true)
  const f = { em: 200, msg: 'x' }
  assert.equal(Fila.falhaApos(f, 150), f)
  assert.equal(Fila.falhaApos(f, 200), f)
  assert.equal(Fila.falhaApos(f, 201), null)
  assert.equal(Fila.falhaApos(null, 1), null)
})

test('decisão 26/10: chat sem resposta é nível 0, acima do anti no-show', () => {
  assert.equal(Fila.nivel({ momento: 'chat_sem_resposta' }), 0)
  const r = Fila.ordenar([it(1, 'anti_noshow', 'G9', -5), it(2, 'chat_sem_resposta', 'G9', -1)], CFG, AGORA, M10H)
  assert.deepEqual(ids(r), [2, 1])
})

test('telefone: rótulo "sua ligação" só para chamada integrada E pedida (nunca autoriza atender sozinho)', () => {
  assert.equal(Fila.chamadaPedida(true, 2000, 1000), true)
  assert.equal(Fila.chamadaPedida(false, 2000, 1000), false)    // sem o header da 4com
  assert.equal(Fila.chamadaPedida(true, 500, 1000), false)      // janela vencida
  assert.equal(Fila.chamadaPedida(true, 0, 1000), false)        // ninguém pediu
  assert.match(Fila.mensagemVoz('sem_permissao'), /dono deste lead/)
  assert.match(Fila.mensagemVoz('xpto'), /xpto/)
})

// ---------------- modo CLOSER (PROPOSTA §7) ----------------
const FC = 11010459, ALTA = 102174784, BAIXA = 102174776, CONTRATO = 84456095, PROP = 110113248
const CC = { etapas: [], antecedencia_closer_min: 120, lookahead: 15 }
const t = (id, eid, dueMin, extra = {}) => ({ id, etype: 'leads', eid, due: AGORA + dueMin * 60, momento: 'follow_up', pipeline_id: FC, status_id: ALTA, ...extra })
const eids = (r) => [...r.fila].map((x) => x.eid)

test('closer: um card por lead; o resto vira contagem; ordem pelas etapas da decisão 26/10', () => {
  const r = Fila.ordenarCloser([
    t(1, 10, -60, { status_id: BAIXA }), t(2, 10, -50, { status_id: BAIXA }), t(3, 10, -40, { status_id: BAIXA }),
    t(4, 20, -5, { status_id: CONTRATO }), t(5, 30, -5, { status_id: PROP }), t(6, 40, -500),
  ], CC, AGORA)
  assert.deepEqual(eids(r), [20, 30, 40, 10])               // CONTRATO, PROPOSTA, ALTA, BAIXA (última)
  const baixa = r.fila[3]; assert.equal(baixa.id, 1); assert.equal(baixa.pendentes, 2)   // representativa = a mais antiga
})

test('closer: reunião na janela (2 h antes a 30 min depois) passa à frente do backlog de contrato', () => {
  const r = Fila.ordenarCloser([t(1, 20, -600, { status_id: CONTRATO }), t(2, 30, -5, { status_id: BAIXA, reuniao_em: AGORA + 90 * 60 })], CC, AGORA)
  assert.deepEqual(eids(r), [30, 20]); assert.equal(r.fila[0].nivelCloser, 0.5)
  const passou = Fila.ordenarCloser([t(1, 20, -600, { status_id: CONTRATO }), t(2, 30, -5, { status_id: BAIXA, reuniao_em: AGORA - 31 * 60 })], CC, AGORA)
  assert.deepEqual(eids(passou), [20, 30])                 // passou há mais de 30 min: volta para a etapa
  const longe = Fila.ordenarCloser([t(2, 30, -5, { status_id: BAIXA, reuniao_em: AGORA + 3 * 3600 })], CC, AGORA)
  assert.equal(longe.fila[0].nivelCloser, 7)               // fora da janela: nível da etapa
})

test('closer: na reunião, a representativa é a tarefa mais próxima dela (não o follow antigo)', () => {
  const r = Fila.ordenarCloser([t(1, 30, -3000), t(2, 30, 5, { reuniao_em: AGORA + 60 * 60 }), t(3, 30, -20)].map((x) => ({ ...x, reuniao_em: AGORA + 60 * 60 })), CC, AGORA)
  assert.equal(r.fila.length, 1); assert.equal(r.fila[0].id, 2); assert.equal(r.fila[0].pendentes, 2)
})

test('closer: reunião sem tarefa elegível não cria card; +5 min sem vencida entra; futura só de lead fora da fila', () => {
  const r = Fila.ordenarCloser([t(1, 30, 60, { reuniao_em: AGORA + 30 * 60 }), t(2, 40, 5), t(3, 40, 300)], CC, AGORA)
  assert.deepEqual(eids(r), [40]); assert.equal(r.fila[0].pendentes, 0)
  assert.equal(r.futura.eid, 30)                            // a do lead 40 (futura) não conta: ele já está na fila
})

test('closer: chat no topo; etapa pendente, outros funis e contato no nível 8; lead e contato de mesmo id = 2 cards', () => {
  const r = Fila.ordenarCloser([
    t(1, 10, -5, { pipeline_id: 14062116, status_id: 1 }),                // funil de disparo (decisão 4)
    t(2, 20, -5, { etapa_pendente: true }),
    { id: 3, etype: 'contacts', eid: 30, due: AGORA - 5, momento: 'follow_up' },
    t(4, 30, -5, { status_id: BAIXA }),
    { id: -50, etype: 'leads', eid: 50, due: AGORA - 900, momento: 'chat_sem_resposta', urgente: true },
    t(5, 50, -5, { status_id: CONTRATO }),
  ], CC, AGORA)
  assert.equal(r.fila[0].id, -50); assert.equal(r.fila[0].nivelCloser, 0); assert.equal(r.fila[0].pendentes, 1)
  assert.deepEqual([...r.fila].map((x) => Fila.chaveEnt(x)), ['leads:50', 'leads:30', 'leads:10', 'leads:20', 'contacts:30'])
  assert.deepEqual([...r.fila].slice(2).map((x) => x.nivelCloser), [8, 8, 8])
})

test('closer: etapas configuráveis (setting etapas_closer)', () => {
  const r = Fila.ordenarCloser([t(1, 10, -5, { status_id: CONTRATO }), t(2, 20, -5, { status_id: BAIXA })], { ...CC, etapas: [BAIXA, CONTRATO] }, AGORA)
  assert.deepEqual(eids(r), [20, 10])
})
