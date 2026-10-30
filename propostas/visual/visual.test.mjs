// node --test propostas/visual/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  ICONES, iconePara, urlIcone, baseIconesDoProjeto, analisarSlide, valorBRL, dadosComparativo, dadosMidia, dadosAssessoria,
  larguraComPainel, marcosDoDeck, requestsVisual, aplicarVisual,
} from '../../supabase/functions/_shared/propostas/visual.mjs';

const PT = 12700;
const BASE = 'https://exemplo.supabase.co/storage/v1/object/public/propostas-visual/icones/v1';

// Elemento de texto na convenção <slide>_<sufixo>, com posição em pt.
const el = (id, texto, [x, y, w, h], fonte = 12, tipo = 'ROUND_RECTANGLE') => ({
  objectId: id,
  size: { width: { magnitude: w * PT, unit: 'EMU' }, height: { magnitude: h * PT, unit: 'EMU' } },
  transform: { scaleX: 1, scaleY: 1, translateX: x * PT, translateY: y * PT, unit: 'EMU' },
  shape: { shapeType: tipo, text: texto == null ? undefined : { textElements: [{ textRun: { content: `${texto}\n`, style: { fontSize: { magnitude: fonte, unit: 'PT' } } } }] } },
});
const lista = (sid, rotulo, titulo, itens, h = 39) => ({
  objectId: sid,
  pageElements: [
    el(`${sid}_r`, rotulo, [39, 28, 640, 28], 11, 'TEXT_BOX'),
    el(`${sid}_t`, titulo, [39, 52, 640, 60], 30, 'TEXT_BOX'),
    ...itens.map((t, i) => el(`${sid}_c${i}`, `${String(i + 1).padStart(2, '0')}   ${t}`, [39, 137 + i * (h + 6), 640, h])),
    el(`${sid}_f`, 'V4 COMPANY  ·  CLIENTE TESTE', [39, 368, 640, 24], 9, 'TEXT_BOX'),
  ],
});
const investimento = (sid) => ({
  objectId: sid,
  pageElements: [
    el(`${sid}_r`, 'INVESTIMENTO · IMPLEMENTAÇÃO', [39, 28, 640, 28], 11, 'TEXT_BOX'),
    el(`${sid}_t`, 'QUAL É O INVESTIMENTO?', [39, 52, 640, 60], 30, 'TEXT_BOX'),
    el(`${sid}_i0`, null, [39, 141, 381, 42]),
    el(`${sid}_i0a`, 'Landing page focada em conversão', [48, 141, 282, 42], 12, 'TEXT_BOX'),
    el(`${sid}_i0b`, 'R$ 2.500', [321, 141, 91, 42], 14, 'TEXT_BOX'),
    el(`${sid}_p`, null, [439, 141, 241, 191]),
    el(`${sid}_p2`, 'R$ 5.200', [453, 205, 212, 49], 40, 'TEXT_BOX'),
    el(`${sid}_p4`, 'de R$ 6.500 por R$ 5.200', [453, 291, 212, 23], 10, 'TEXT_BOX'),
  ],
});
const deck = () => ({
  pageSize: { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } },
  slides: [
    { objectId: 'capa', pageElements: [] },
    lista('xA', 'PROPOSTA · IMPLEMENTAÇÃO', 'O QUE ENTREGAMOS AGORA', [
      'Landing page no modelo de portfólio',
      'CRM integrado ao WhatsApp, com IA de recepção',
      'Setup de campanha no Google Ads pronto para rodar, com 15 dias de acompanhamento',
    ]),
    investimento('xI'),
    lista('xB', 'ETAPA 2 · OPCIONAL', 'A PARTIR DE JANEIRO: TRACIONAR', [
      'Assessoria contínua com gestor de tráfego e designer: cerca de R$ 4.000 por mês',
      'Verba de mídia, paga pela empresa direto às plataformas: cerca de R$ 2.000 em Google Ads e R$ 800 em Meta Ads (remarketing), conforme combinado na reunião de hoje',
    ]),
    lista('xC', 'DECISÃO', 'PRÓXIMOS PASSOS', ['Cliente alinha a proposta com quem participa da decisão', 'Prazo de entrega da implementação: 30 Dias']),
  ],
});
const criados = (reqs) => reqs.flatMap((r) => [r.createShape?.objectId, r.createImage?.objectId, r.createSlide?.objectId]).filter(Boolean);

test('ícone por item: a ordem das regras resolve os casos ambíguos', () => {
  const casos = [
    ['01   Landing page focada em conversão, otimizada para busca por IA', 'landing'],
    ['Página otimizada para aparecer nas buscas por IA (ChatGPT, Gemini)', 'busca_ia'],
    ['CRM integrado ao WhatsApp, com IA de recepção', 'whatsapp'],
    ['Funis personalizados no CRM, com etapas até o fechamento', 'funil'],
    ['Rastreamento de ponta a ponta: UTMs, pixel e tags, e API de conversão ligando o CRM às campanhas', 'rastreamento'],
    ['Setup Google Ads + rastreamento + 15 dias de acompanhamento', 'google_ads'],
    ['Verba de mídia: R$ 2.000 em Google Ads e R$ 800 em Meta Ads', 'verba'],
    ['Prioridade em Google (intenção de busca); Meta só para remarketing', 'prioridade'],
    ['Com o aceite: compartilha a pasta do Google Drive com fotos', 'pasta'],
    ['Condição de 20% de desconto válida para fechamento até 30/10', 'desconto'],
    ['Site atual em Wix, sem foco em conversão nem nas buscas por IA', 'site'],
    ['Prazo de entrega da implementação: 30 Dias', 'prazo'],
    ['Algo sem palavra conhecida', 'padrao'],
  ];
  for (const [t, chave] of casos) assert.equal(iconePara(t), chave, t);
});

test('todo ícone do catálogo tem PNG gerado nas 3 variantes', () => {
  for (const i of ICONES) for (const v of ['amarelo', 'vinho', 'branco']) {
    assert.ok(existsSync(new URL(`./icones/${i.chave}-${v}.png`, import.meta.url)), `${i.chave}-${v}.png`);
  }
});

test('URL dos ícones vem do Storage do próprio projeto', () => {
  assert.equal(baseIconesDoProjeto('https://abc.supabase.co/'), 'https://abc.supabase.co/storage/v1/object/public/propostas-visual/icones/v1');
  assert.equal(urlIcone(`${BASE}/`, 'crm', 'vinho'), `${BASE}/crm-vinho.png`);
});

test('analisarSlide: só reconhece slide gerado (com _r e _t)', () => {
  assert.equal(analisarSlide({ objectId: 'capa', pageElements: [] }), null);
  const a = analisarSlide(deck().slides[2]);
  assert.equal(a.titulo, 'QUAL É O INVESTIMENTO?');
  assert.equal(a.linhas.length, 1);
  assert.equal(a.linhas[0].a.texto, 'Landing page focada em conversão');
  assert.ok(a.painel && a.p.p4);
});

test('dados dos gráficos saem do texto; sem dado, nada', () => {
  assert.equal(valorBRL('R$ 5.809,76'), 5809.76);
  assert.equal(valorBRL('sem preço'), null);
  const [, , inv, etapa2, decisao] = deck().slides.map(analisarSlide);
  assert.deepEqual(dadosComparativo(inv), { de: 6500, por: 5200, pct: 20 });
  assert.deepEqual(dadosMidia(etapa2), { google: 2000, meta: 800, total: 2800 });
  assert.equal(dadosAssessoria(etapa2), 4000);
  assert.equal(dadosMidia(decisao), null);
  assert.equal(dadosComparativo(decisao), null);
  // "por" maior que "de" não é desconto: sem gráfico
  const s = investimento('z');
  s.pageElements.find((e) => e.objectId === 'z_p4').shape.text.textElements[0].textRun.content = 'de R$ 5.000 por R$ 6.000';
  assert.equal(dadosComparativo(analisarSlide(s)), null);
});

test('coluna do gráfico só abre se o texto continuar cabendo no cartão', () => {
  const W = 9144000;
  const curto = analisarSlide(lista('k', 'ETAPA 2', 'T', ['Google R$ 2.000', 'Meta R$ 800']));
  assert.ok(larguraComPainel(curto, W) > 0);
  const [, , , etapa2] = deck().slides.map(analisarSlide);
  assert.equal(larguraComPainel(etapa2, W), null);
});

test('linha do tempo: marcos só do que está escrito', () => {
  const marcos = marcosDoDeck(deck().slides.map(analisarSlide).filter(Boolean));
  assert.deepEqual(marcos.map((m) => [m.chave, m.quando]), [
    ['decisao', 'Aceite'], ['implementacao', '30 dias'], ['acompanhamento', '+15 dias'], ['tracao', 'Janeiro'],
  ]);
  assert.equal(marcos[2].texto, 'Google Ads no ar');
  assert.equal(marcos[3].titulo, 'Etapa 2 · Tracionar');
  // sem prazo nem acompanhamento: menos de 3 marcos, sem slide
  const d = deck();
  d.slides = d.slides.filter((s) => s.objectId !== 'xA');
  d.slides[3] = lista('xC', 'DECISÃO', 'PRÓXIMOS PASSOS', ['Cliente decide']);
  const { resumo } = requestsVisual(d, { base: BASE });
  assert.ok(!resumo.some((r) => r.feito.some((f) => f.startsWith('linha_do_tempo'))));
});

test('requestsVisual: plano completo, IDs novos únicos e sem colisão', () => {
  const d = deck();
  const { requests, resumo } = requestsVisual(d, { base: BASE, prefixo: 'tst' });
  const porSlide = Object.fromEntries(resumo.map((r) => [r.slide, r.feito]));
  assert.deepEqual(porSlide.xA, ['etapas', 'icones:3']);
  assert.deepEqual(porSlide.xI, ['icones_linhas:1', 'comparativo_preco']);
  assert.deepEqual(porSlide.xB, ['etapas', 'grafico_midia_slide_proprio', 'icones:2']);
  assert.deepEqual(porSlide.xC, ['icones:2']);
  assert.deepEqual(porSlide.tst_vtl, ['linha_do_tempo:4']);
  const novos = criados(requests);
  assert.equal(new Set(novos).size, novos.length, 'objectId repetido');
  const existentes = new Set(d.slides.flatMap((s) => [s.objectId, ...s.pageElements.map((e) => e.objectId)]));
  for (const id of novos) assert.ok(!existentes.has(id), `colide com o deck: ${id}`);
  for (const r of requests.filter((q) => q.createImage)) assert.ok(r.createImage.url.startsWith(`${BASE}/`) && r.createImage.url.endsWith('.png'));
});

test('o número do cartão sai e o ícone entra no lugar (recuo à esquerda)', () => {
  const { requests } = requestsVisual(deck(), { base: BASE });
  const del = requests.find((r) => r.deleteText?.objectId === 'xA_c0').deleteText;
  assert.deepEqual(del.textRange, { type: 'FIXED_RANGE', startIndex: 0, endIndex: '01   '.length });
  const par = requests.find((r) => r.updateParagraphStyle?.objectId === 'xA_c0').updateParagraphStyle;
  assert.equal(par.fields, 'indentStart,indentFirstLine');
  assert.ok(par.style.indentStart.magnitude <= 23, 'recuo maior que o número que sai');
  // cartão sem número: só o recuo
  const s = lista('n', 'DIAGNÓSTICO', 'T', ['x']);
  s.pageElements[2].shape.text.textElements[0].textRun.content = 'Sem número\n';
  const r2 = requestsVisual({ slides: [s] }, { base: BASE }).requests;
  assert.ok(!r2.some((r) => r.deleteText));
  assert.ok(r2.some((r) => r.updateParagraphStyle?.objectId === 'n_c0'));
});

test('slides novos na ordem certa: mídia logo após a Etapa 2, linha do tempo antes de Próximos passos', () => {
  const d = deck();
  const { requests } = requestsVisual(d, { base: BASE, prefixo: 'tst' });
  // simula a execução dos createSlide em sequência
  const ordem = d.slides.map((s) => s.objectId);
  for (const r of requests.filter((q) => q.createSlide)) ordem.splice(r.createSlide.insertionIndex, 0, r.createSlide.objectId);
  assert.deepEqual(ordem, ['capa', 'xA', 'xI', 'xB', 'xB_vms', 'tst_vtl', 'xC']);
});

test('idempotente: slide que já tem a camada (_v…) é pulado; a linha do tempo não duplica', () => {
  const d = deck();
  for (const s of d.slides) if (s.objectId !== 'capa') s.pageElements.push(el(`${s.objectId}_vg0`, null, [0, 0, 1, 1], 12, 'ELLIPSE'));
  d.slides.push({ objectId: 'tst_vtl', pageElements: [] }, { objectId: 'xB_vms', pageElements: [] });
  const { requests } = requestsVisual(d, { base: BASE });
  assert.equal(requests.length, 0);
});

test('aplicarVisual: dry-run não grava; erro do Google não vaza o token', async () => {
  const chamadas = [];
  const ok = (corpo) => ({ ok: true, status: 200, json: async () => corpo });
  const fake = (respostaPost) => async (url, init = {}) => {
    chamadas.push([init.method || 'GET', url]);
    return init.method === 'POST' ? respostaPost : ok(deck());
  };
  const r = await aplicarVisual({ token: 'tok-secreto', apresentacaoId: 'p1', base: BASE, fetchImpl: fake(ok({})), dryRun: true });
  assert.equal(r.aplicado, false);
  assert.ok(r.total > 0);
  assert.ok(chamadas.every(([m]) => m === 'GET'));
  const ruim = { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid requests tok-secreto' } }) };
  await assert.rejects(
    aplicarVisual({ token: 'tok-secreto', apresentacaoId: 'p1', base: BASE, fetchImpl: fake(ruim) }),
    (e) => /HTTP 400/.test(e.message) && !e.message.includes('tok-secreto'),
  );
});
