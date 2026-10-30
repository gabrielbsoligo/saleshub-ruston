// Integração da camada visual v2 ao gerador (30/10): título curto do entregável,
// "Título: detalhe" no deck curto e aplicarCamadaVisual (padrões e falhas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tituloCurto } from '../../supabase/functions/_shared/propostas/analise.mjs';
import { itemEntregavel, secoesCurto } from '../../supabase/functions/_shared/propostas/deck-curto.mjs';
import { aplicarCamadaVisual, dataBR, PENDENCIA_CASE } from '../../supabase/functions/_shared/propostas/camada-visual.mjs';

test('tituloCurto: até 5 palavras, sem dois-pontos, diferente do texto', () => {
  assert.equal(tituloCurto('CRM com IA', 'CRM integrado ao WhatsApp'), 'CRM com IA');
  assert.equal(tituloCurto('  Landing page. ', 'Página enxuta', 'eu faço a landing page para vocês'), 'Landing page');
  assert.equal(tituloCurto('Setup de campanha no Google Ads', 'x'), null); // 6 palavras
  // Vedor: título sem relação com o texto nem com a citação
  assert.equal(tituloCurto('CRM com IA', 'Landing page de captação', 'eu faço a landing page para vocês'), null);
  assert.equal(tituloCurto('Landing page', 'Página enxuta', 'uma página bem enxuta'), null);
  // Vedor: teto de 44 caracteres (contrato com o parse da camada visual)
  assert.equal(tituloCurto('Implementação completa de automações comerciais', 'automações comerciais no WhatsApp'), null);
  assert.equal(tituloCurto('CRM: IA', 'x'), null);
  assert.equal(tituloCurto('CRM (ex.: Kommo)', 'x'), null);
  assert.equal(tituloCurto('Landing page', 'Landing page'), null);
  assert.equal(tituloCurto(null, 'x'), null);
  assert.equal(tituloCurto(42, 'x'), null);
});

test('itemEntregavel: "Título: detalhe"; sem título ou texto que já começa pelo título, só o texto', () => {
  assert.equal(itemEntregavel({ titulo: 'CRM com IA', texto: 'CRM integrado ao WhatsApp' }), 'CRM com IA: CRM integrado ao WhatsApp');
  assert.equal(itemEntregavel({ titulo: null, texto: 'Página enxuta' }), 'Página enxuta');
  assert.equal(itemEntregavel({ titulo: 'Landing page', texto: 'Landing Page focada em conversão' }), 'Landing Page focada em conversão');
  assert.equal(itemEntregavel({ titulo: 'Gestão de anúncios', texto: 'Gestao de anuncios no Google' }), 'Gestao de anuncios no Google');
  assert.equal(itemEntregavel({ titulo: 'Plano 10', texto: 'Plano 20 dias de mídia' }), 'Plano 10: Plano 20 dias de mídia');
});

test('deck curto: entregáveis com título; linha de investimento usa o título', () => {
  const escopo = {
    cliente: { empresa: 'ACME' }, oferta: { tipo: 'implementacao' }, contexto: {},
    entregaveis: [
      { titulo: 'Landing page', texto: 'Página enxuta focada em conversão', valor: 2500, recorrencia: 'unico', origem: 'ia', citacao: 'x' },
      { titulo: 'CRM com IA', texto: 'CRM integrado ao WhatsApp', valor: 4000, recorrencia: 'unico', origem: 'ia', citacao: 'x' },
    ],
    preco: { oferta: { valor_tabela: 6500 } }, pendencias: [],
  };
  const secoes = secoesCurto(escopo);
  const lista = secoes.find((s) => s.titulo === 'O que entregamos');
  assert.deepEqual(lista.itens, ['Landing page: Página enxuta focada em conversão', 'CRM com IA: CRM integrado ao WhatsApp']);
  const inv = JSON.stringify(secoes.find((s) => s.tipo === 'investimento'));
  assert.match(inv, /"texto":"Landing page"/);
  assert.match(inv, /"texto":"CRM com IA"/);
});

const ok = (extra = {}) => async (args) => ({ aplicado: true, semIcones: false, resumo: [], total: 10, args, ...extra });
const base = { token: 'ya29.tokenzinho-secreto-123', apresentacaoId: 'abc', supabaseUrl: 'https://x.supabase.co/', tipo: 'implementacao', modeloVenda: 'inside_sales', hoje: new Date('2026-10-30T15:00:00Z') };

test('camada: padrões do Gabriel (capa substitui, case desligado) e dados passados', async () => {
  let recebido;
  const r = await aplicarCamadaVisual({ ...base, aplicar: async (a) => { recebido = a; return ok()(a); }, log: () => {} });
  assert.equal(r.aplicado, true);
  assert.deepEqual(r.pendencias, []);
  assert.equal(recebido.capa, 'substituir');
  assert.equal(recebido.caso, 'nao');
  assert.equal(recebido.tipo, 'implementacao');
  assert.equal(recebido.modeloVenda, 'inside_sales');
  assert.equal(recebido.data, '30/10/2026');
  assert.equal(recebido.assets, 'https://x.supabase.co/storage/v1/object/public/propostas-visual');
  assert.equal(recebido.token, base.token);
});

test('camada: case só com opt-in, e com pendência de confirmar com a franqueadora', async () => {
  let recebido;
  const comCase = async (a) => { recebido = a; return { aplicado: true, resumo: [{ feito: ['case:cvc-corp:4'] }] }; };
  const r = await aplicarCamadaVisual({ ...base, incluirCase: true, aplicar: comCase, log: () => {} });
  assert.equal(recebido.caso, 'sim');
  assert.deepEqual(r.pendencias, [PENDENCIA_CASE]);
  const semAfinidade = await aplicarCamadaVisual({ ...base, incluirCase: true, aplicar: ok(), log: () => {} });
  assert.match(semAfinidade.pendencias[0], /nenhum case oficial combina/);
  const semFoto = await aplicarCamadaVisual({ ...base, incluirCase: true, aplicar: ok({ semIcones: true, erroIcones: 'image fetch', resumo: [{ feito: ['case:x:3'] }] }), log: () => {} });
  assert.ok(semFoto.pendencias.some((p) => /a foto não carregou/.test(p)));
  assert.ok(!semFoto.pendencias.includes(PENDENCIA_CASE));
});

test('camada: sem imagens vira pendência; erro vira pendência redigida e nunca lança', async () => {
  const logs = [];
  const s = await aplicarCamadaVisual({ ...base, aplicar: ok({ semIcones: true, erroIcones: 'HTTP 400 image url' }), log: (m) => logs.push(m) });
  assert.deepEqual(s.pendencias, ['camada visual sem imagens: HTTP 400 image url']);
  const falha = async () => { throw new Error(`slides.batchUpdate: HTTP 500 Bearer ${base.token}`); };
  const e = await aplicarCamadaVisual({ ...base, aplicar: falha, log: (m) => logs.push(m) });
  assert.equal(e.aplicado, false);
  assert.match(e.pendencias[0], /^camada visual não aplicada: /);
  for (const t of [...logs, ...e.pendencias]) assert.ok(!t.includes(base.token), 'token vazou');
});

test('dataBR usa o fuso de Brasília', () => {
  assert.equal(dataBR(new Date('2026-10-31T01:30:00Z')), '30/10/2026');
});

test('camada (Vedor): erro que não é Error tem motivo; fetchImpl com teto chega ao aplicarVisual', async () => {
  const s = await aplicarCamadaVisual({ ...base, aplicar: async () => { throw 'quebrou'; }, log: () => {} });
  assert.deepEqual(s.pendencias, ['camada visual não aplicada: quebrou']);
  const v = await aplicarCamadaVisual({ ...base, aplicar: async () => { throw {}; }, log: () => {} });
  assert.match(v.pendencias[0], /^camada visual não aplicada: \S/);
  let recebido;
  await aplicarCamadaVisual({ ...base, aplicar: async (a) => { recebido = a; return { aplicado: true }; }, log: () => {} });
  assert.equal(typeof recebido.fetchImpl, 'function');
});
