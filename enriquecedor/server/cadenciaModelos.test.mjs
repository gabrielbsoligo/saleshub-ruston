// node --test enriquecedor/server/cadenciaModelos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { disponibilidade, escolherPadrao, variaveisDe } from './cadenciaModelos.mjs';

const CANAL = 70787;
const A5 = ['nome1', 'sdr', 'fantasia', 'fraseFalha', 'fraseImpacto'];
const D4 = ['nome1', 'sdr', 'fantasia', 'pontos'];
const leg = { review_status: 'aprovado', kommo_bot_id: 1 };
// Espelho do banco de teste em 29/10/2026 (originais com bot legado; _sem_sdr inativos não entram).
const TPLS = [
  { id: 'a1', nome: 'sdna_p1_auditoria_v1', passo: 1, chaves_vars: A5, ...leg },
  { id: 'a2', nome: 'sdna_p1_auditoria_v2', passo: 1, chaves_vars: A5, ...leg },
  { id: 'dg', nome: 'sdna_p1_diag_geral_v1', passo: 1, chaves_vars: D4, padrao: true, ...leg },
  { id: 'ds', nome: 'sdna_p1_diag_sjc_v2', passo: 1, chaves_vars: D4, padrao: true, cidades: ['SAO JOSE DOS CAMPOS'], ...leg },
  { id: 's2', nome: 'sdna_p2_segunda_falha_v1', passo: 2, chaves_vars: ['nome1', 'fantasia', 'rotuloSecundaria'], ...leg },
  { id: 'ap', nome: 'sdna_p2_aprofunda_v1', passo: 2, chaves_vars: ['nome1', 'fantasia'], ...leg },
  { id: 'b1', nome: 'sdna_p3_breakup_v1', passo: 3, chaves_vars: ['nome1', 'fantasia'], ...leg },
  { id: 'b2', nome: 'sdna_p3_breakup_v2', passo: 3, chaves_vars: ['nome1', 'fantasia'], ...leg },
];
const nome = (t) => t?.nome ?? null;

test('mesmo resultado da regra antiga com os dados de hoje', () => {
  assert.equal(nome(escolherPadrao(TPLS, 1, { cidade: 'São José dos Campos' })), 'sdna_p1_diag_sjc_v2');
  assert.equal(nome(escolherPadrao(TPLS, 1, { cidade: 'Taubaté', rot: 1 })), 'sdna_p1_diag_geral_v1');
  assert.equal(nome(escolherPadrao(TPLS, 2, { temSecundaria: true })), 'sdna_p2_segunda_falha_v1');
  assert.equal(nome(escolherPadrao(TPLS, 2, { temSecundaria: false })), 'sdna_p2_aprofunda_v1');
  assert.equal(nome(escolherPadrao(TPLS, 3, { rot: 0 })), 'sdna_p3_breakup_v1');
  assert.equal(nome(escolherPadrao(TPLS, 3, { rot: 1 })), 'sdna_p3_breakup_v2');
});

test('sem padrão no passo 1: rotação entre os gerais (modelo de outra cidade fica fora)', () => {
  const sem = TPLS.map((t) => ({ ...t, padrao: false }));
  assert.equal(nome(escolherPadrao(sem, 1, { cidade: 'Taubaté', rot: 0 })), 'sdna_p1_auditoria_v1');
  assert.equal(nome(escolherPadrao(sem, 1, { cidade: 'Taubaté', rot: 1 })), 'sdna_p1_auditoria_v2');
  assert.equal(nome(escolherPadrao(sem, 1, { cidade: 'Taubaté', rot: 2 })), 'sdna_p1_diag_geral_v1');
  assert.equal(nome(escolherPadrao(sem, 1, { cidade: 'sao jose dos campos' })), 'sdna_p1_diag_sjc_v2');
});

test('modelo novo vira padrão só por dado (sem código): dois padrões gerais alternam', () => {
  const novo = [...TPLS, { id: 'n', nome: 'sdna_p1_diag_geral_v1_sem_sdr', passo: 1, chaves_vars: ['nome1', 'fantasia', 'pontos'], padrao: true, ...leg }];
  assert.equal(nome(escolherPadrao(novo, 1, { rot: 0 })), 'sdna_p1_diag_geral_v1');
  assert.equal(nome(escolherPadrao(novo, 1, { rot: 1 })), 'sdna_p1_diag_geral_v1_sem_sdr');
});

test('indisponível sai da escolha; passo 2 sem modelo de 2ª falha cai no outro', () => {
  const ok = (t) => t.id !== 'dg' && t.id !== 's2';
  assert.equal(nome(escolherPadrao(TPLS, 1, { cidade: 'Taubaté', rot: 0, ok })), 'sdna_p1_auditoria_v1');
  assert.equal(nome(escolherPadrao(TPLS, 2, { temSecundaria: true, ok })), 'sdna_p2_aprofunda_v1');
  assert.equal(escolherPadrao(TPLS, 3, { ok: () => false }), null);
});

test('disponibilidade: vínculo do canal manda; sem vínculo, legado; sem chaves_vars nunca', () => {
  const t = TPLS[0];
  const v = (p = {}) => ({ template_id: 'a1', source_id: CANAL, review_status: 'aprovado', kommo_bot_id: 9, erro: null, bot_verificado_em: '2026-10-29T12:00:00Z', ...p });
  assert.deepEqual(disponibilidade(t, CANAL, [v()]), { disponivel: true, motivo: null, origem: 'vinculo' });
  assert.equal(disponibilidade(t, CANAL, [v({ review_status: 'ausente' })]).disponivel, false);
  assert.equal(disponibilidade(t, CANAL, [v({ kommo_bot_id: null })]).motivo, 'sem bot no canal 70787');
  assert.equal(disponibilidade(t, CANAL, [v({ erro: 'bot 9 está desativado no Kommo' })]).disponivel, false);
  assert.equal(disponibilidade(t, CANAL, [v({ bot_verificado_em: null })]).motivo, 'bot ainda não confirmado no canal 70787');
  assert.equal(disponibilidade(t, CANAL, [v({ source_id: 1 })]).origem, 'legado');
  assert.equal(disponibilidade(t, null, [v({ review_status: 'ausente' })]).disponivel, true);
  assert.equal(disponibilidade({ ...t, review_status: 'em_revisao' }, null, []).disponivel, false);
  assert.equal(disponibilidade({ ...t, kommo_bot_id: null, kommo_bots_por_responsavel: {} }, null, []).motivo, 'sem bot');
  assert.equal(disponibilidade({ ...t, chaves_vars: null }, null, []).disponivel, false);
});

test('variaveisDe segue chaves_vars', () => {
  assert.deepEqual(variaveisDe(TPLS[4], { nome1: 'Jorge', fantasia: 'Alumitec', rotuloSecundaria: 'o site sem pixel', sdr: 'Lary' }), ['Jorge', 'Alumitec', 'o site sem pixel']);
  assert.deepEqual(variaveisDe({ chaves_vars: ['nome1', 'pontos'] }, { nome1: 'Ana' }), ['Ana', '']);
});
