// node propostas/gerador/analise.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  citacaoNaTranscricao, extrairJson, montarPrompt, normalizarEscopo, normalizarTexto,
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
    citacoes: ['fica 29.750 em 12 vezes no cartão', 'a execução sai 5 mil por mês'],
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
  b.preco.citacoes = ['o preço é 99 mil reais'];
  const chute = normalizarEscopo(b, ctx);
  assert.equal(chute.preco.estruturacao.valor_total, null);
  assert.ok(chute.pendencias.some((p) => p.includes('preço sugerido')));
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
