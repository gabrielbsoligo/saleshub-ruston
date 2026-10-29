// node propostas/gerador/analise.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  citacaoNaTranscricao, extrairJson, montarPrompt, normalizarEscopo, normalizarTexto, valoresMonetarios,
} from '../../supabase/functions/_shared/propostas/analise.mjs';
import { validarEscopo } from '../../supabase/functions/_shared/propostas/slides.mjs';

const catalogo = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/catalogo-v0.json', import.meta.url), 'utf8'));

const transcricao = `Closer: Me conta como vocês vendem hoje.
Lead: Hoje quem vende sou eu, é tudo indicação, a gente controla tudo na planilha.
Lead: Queria muito usar o LinkedIn para chegar nos diretores de compras.
Closer: Perfeito. Pra estruturação fica 29.750 em 12 vezes no cartão, e a execução sai 5 mil por mês.
Closer: E de bônus eu incluo um treinamento do seu time comercial no processo novo.`;

const ctx = { catalogo, empresa: 'Empresa do Deal', transcricao };

const bruto = () => ({
  cliente: { empresa: 'Nome que o LLM inventou', modelo_venda: 'inside_sales' },
  contexto: { dores: [
    { texto: 'Vendas dependem do dono', origem: 'ia', citacao: 'hoje quem vende sou eu, é tudo indicação' },
    { texto: 'Dor inventada', origem: 'ia', citacao: 'isso nunca foi dito na reunião' },
  ] },
  escopo: {
    enfases: ['linkedin_b2b', 'enfase_que_nao_existe'],
    semanas: [
      { id: 's1', titulo: 'Semana 1', itens: [
        { catalogo_id: 's1_persona_icp', texto: 'Persona e ICP', origem: 'catalogo', citacao: null },
        { catalogo_id: 'li_icp_contas', texto: 'Contas-alvo no LinkedIn (diretores de compras)', origem: 'catalogo', citacao: null },
        { catalogo_id: 'id_inventado', texto: 'Item com id falso', origem: 'catalogo', citacao: null },
      ] },
      { id: 's3', titulo: 'Semana 3', itens: [] },
    ],
    overdeliveries: [
      { catalogo_id: null, texto: 'Treinamento do time comercial', origem: 'ia', citacao: 'eu incluo um treinamento do seu time comercial' },
    ],
  },
  plano_execucao: { incluido: true, faixa_midia: null, itens: [{ catalogo_id: 'ex_gestor_conta', texto: 'Gestor de Conta', origem: 'catalogo' }] },
  preco: {
    estruturacao: { valor_total: 29750, parcelas: 12, valor_parcela: null, condicao: null },
    execucao_mensal: { valor: 5000, valor_com_social: null, meses: null },
    evidencias: {
      valor_total: 'fica 29.750 em 12 vezes no cartão',
      parcelas: 'fica 29.750 em 12 vezes no cartão',
      execucao_valor: 'a execução sai 5 mil por mês',
    },
  },
  pendencias: ['faixa de mídia não foi falada'],
});

test('normalizarEscopo: resultado passa na validação do gerador', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.deepEqual(validarEscopo(e), []);
});

test('empresa vem do deal, não do LLM', () => {
  assert.equal(normalizarEscopo(bruto(), ctx).cliente.empresa, 'Empresa do Deal');
});

test('citação inexistente na transcrição: item sai e vira pendência', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.deepEqual(e.contexto.dores.map((d) => d.texto), ['Vendas dependem do dono']);
  assert.ok(e.pendencias.some((p) => p.includes('Dor inventada')));
});

test('catalogo_id inexistente sem citação é descartado; ênfase desconhecida some', () => {
  const e = normalizarEscopo(bruto(), ctx);
  const s1 = e.escopo.semanas.find((s) => s.id === 's1');
  assert.deepEqual(s1.itens.map((i) => i.catalogo_id), ['s1_persona_icp', 'li_icp_contas']);
  assert.ok(e.pendencias.some((p) => p.includes('Item com id falso')));
  assert.deepEqual(e.escopo.enfases, ['linkedin_b2b']);
  assert.ok(!e.escopo.semanas.some((s) => s.id === 's3'), 'semana vazia sai');
});

test('overdelivery prometido com citação real fica', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.equal(e.escopo.overdeliveries.length, 1);
  assert.equal(e.escopo.overdeliveries[0].origem, 'ia');
});

test('preço: entra só com citação conferida', () => {
  const ok = normalizarEscopo(bruto(), ctx);
  assert.equal(ok.preco.estruturacao.valor_total, 29750);
  assert.equal(ok.preco.estruturacao.parcelas, 12);
  assert.equal(ok.preco.execucao_mensal.valor, 5000);

  const b = bruto();
  b.preco.evidencias.valor_total = 'o preço é 99 mil reais';
  const chute = normalizarEscopo(b, ctx);
  assert.equal(chute.preco.estruturacao.valor_total, null);
  assert.ok(chute.pendencias.some((p) => p.includes('preço da estruturação')));
});

test('Vedor F3 #1: citação real de outro assunto não libera números inventados', () => {
  const b = bruto();
  b.preco.evidencias = { valor_total: 'Hoje quem vende sou eu', parcelas: 'Hoje quem vende sou eu', valor_parcela: 'Hoje quem vende sou eu', execucao_valor: 'Hoje quem vende sou eu', meses: 'Hoje quem vende sou eu' };
  b.preco.estruturacao = { valor_total: 999999, parcelas: 12, valor_parcela: 88888, condicao: 'à vista com desconto' };
  b.preco.execucao_mensal = { valor: 77777, valor_com_social: null, meses: 6 };
  const e = normalizarEscopo(b, ctx);
  assert.deepEqual(e.preco.estruturacao, { valor_total: null, parcelas: null, valor_parcela: null, condicao: null });
  assert.deepEqual(e.preco.execucao_mensal, { valor: null, valor_com_social: null, meses: null });
  for (const r of ['preço da estruturação', 'parcelas', 'valor da parcela', 'condição', 'preço da execução', 'meses']) {
    assert.ok(e.pendencias.some((p) => p.startsWith(r)), r);
  }
});

test('Vedor F3 #1: cada campo é conferido sozinho (um certo, outro inventado)', () => {
  const b = bruto();
  b.preco.estruturacao.valor_total = 29750;  // dito
  b.preco.execucao_mensal.valor = 6000;      // não dito (foi 5 mil)
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.estruturacao.valor_total, 29750);
  assert.equal(e.preco.execucao_mensal.valor, null);
  assert.ok(e.pendencias.some((p) => p.startsWith('preço da execução')));
});

test('Vedor F3 R2 #1: expressão monetária completa (sem subvalor, centavos exatos)', () => {
  assert.deepEqual(valoresMonetarios('R$ 29.750,00'), [29750]);
  assert.deepEqual(valoresMonetarios('5 mil por mês'), [5000]);
  assert.deepEqual(valoresMonetarios('12x de 2.479,17'), [2479.17]);
  assert.deepEqual(valoresMonetarios('29,75 mil ou 29 mil e 750 ou 5k'), [29750, 29750, 5000]);
  assert.deepEqual(valoresMonetarios('em 12 vezes, 6 meses, 12x'), []);
  const casos = [
    ['valor_total', 750, 'fica 29.750 em 12 vezes no cartão'],         // subvalor
    ['execucao_valor', 5, 'a execução sai 5 mil por mês'],             // unidade mil ignorada
  ];
  for (const [campo, valor, evid] of casos) {
    const b = bruto();
    if (campo === 'valor_total') b.preco.estruturacao.valor_total = valor; else b.preco.execucao_mensal.valor = valor;
    b.preco.evidencias[campo] = evid;
    const e = normalizarEscopo(b, ctx);
    assert.equal(campo === 'valor_total' ? e.preco.estruturacao.valor_total : e.preco.execucao_mensal.valor, null, `${campo}=${valor}`);
  }
});

test('Vedor F3 R2 #1: centavos diferentes não conferem', () => {
  const t = transcricao + '\nCloser: no cartão fica 12x de 2.479,17.';
  const b = bruto();
  b.preco.estruturacao.valor_parcela = 2479.18;
  b.preco.evidencias.valor_parcela = 'no cartão fica 12x de 2.479,17';
  assert.equal(normalizarEscopo(b, { ...ctx, transcricao: t }).preco.estruturacao.valor_parcela, null);
  b.preco.estruturacao.valor_parcela = 2479.17;
  assert.equal(normalizarEscopo(b, { ...ctx, transcricao: t }).preco.estruturacao.valor_parcela, 2479.17);
});

test('Vedor F3 R2 #1: valor da execução não valida estruturação nem social (papel do campo)', () => {
  const b = bruto();
  b.preco.estruturacao.valor_total = 5000;
  b.preco.evidencias.valor_total = 'a execução sai 5 mil por mês';
  b.preco.execucao_mensal.valor_com_social = 5000;
  b.preco.evidencias.execucao_com_social = 'a execução sai 5 mil por mês';
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.estruturacao.valor_total, null, 'estruturação com trecho mensal');
  assert.equal(e.preco.execucao_mensal.valor_com_social, null, 'mesmo valor e trecho = ambíguo');
  assert.equal(e.preco.execucao_mensal.valor, null, 'o par ambíguo cai junto');
  assert.ok(e.pendencias.some((p) => p.includes('ambíguo')));
});

test('preço em texto ou negativo vira null', () => {
  const b = bruto();
  b.preco.estruturacao.valor_total = '29.750';
  b.preco.estruturacao.parcelas = -3;
  b.preco.execucao_mensal.valor = -1;
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.estruturacao.valor_total, null);
  assert.equal(e.preco.estruturacao.parcelas, null);
  assert.equal(e.preco.execucao_mensal.valor, null);
  assert.deepEqual(validarEscopo(e), []);
});

test('modelo de venda: informado pelo chamador vence; ausente vira pendência', () => {
  assert.equal(normalizarEscopo(bruto(), { ...ctx, modeloVenda: 'pdv' }).cliente.modelo_venda, 'pdv');
  const b = bruto(); delete b.cliente.modelo_venda;
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.cliente.modelo_venda, 'inside_sales');
  assert.ok(e.pendencias.some((p) => p.includes('modelo de venda')));
});

test('resposta vazia/lixo do LLM não quebra: escopo mínimo + pendências', () => {
  const e = normalizarEscopo({}, ctx);
  assert.deepEqual(validarEscopo(e), []);
  assert.ok(e.pendencias.some((p) => p.includes('escopo vazio')));
  assert.equal(e.preco.estruturacao.valor_total, null);
});

test('extrairJson aceita cerca ```json e recusa resposta sem JSON', () => {
  assert.deepEqual(extrairJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extrairJson('não sei'), /sem JSON/);
  assert.throws(() => extrairJson(null), /vazia/);
});

test('citação: tolera acento/pontuação, exige tamanho mínimo', () => {
  const t = normalizarTexto(transcricao);
  assert.ok(citacaoNaTranscricao('Hoje quem vende sou EU — é tudo indicacao', t));
  assert.ok(!citacaoNaTranscricao('eu', t));
});

test('prompt traz regras, ids do catálogo, empresa e transcrição', () => {
  const p = montarPrompt({ transcricao, catalogo, empresa: 'Empresa do Deal' });
  for (const trecho of ['s3is_pipeline', 'li_cadencia_social_selling', 'od_cliente_oculto', 'Empresa do Deal', 'diretores de compras', 'Nunca invente']) {
    assert.ok(p.includes(trecho), trecho);
  }
  assert.ok(!p.includes('56000') && !p.includes('36120'), 'preço de referência não vai ao LLM');
});
