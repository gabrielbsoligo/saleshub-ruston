// node --test propostas/gerador/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  acharIndicePreco, formatarBRL, formatarCurto, montarValores, requestsSlidesEscopo,
  secoesEscopo, validarEscopo, LITERAIS_DECK, ESTILO,
} from './slides.mjs';
import { gerarProposta, planejar } from './gerar.mjs';
import { criarCliente, MIME } from './google.mjs';

const exemplo = () => JSON.parse(readFileSync(new URL('../exemplos/escopo-exemplo-inside-sales-linkedin.json', import.meta.url), 'utf8'));
const catalogo = JSON.parse(readFileSync(new URL('../catalogo-v0.json', import.meta.url), 'utf8'));

const slidePreco = { pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Qual é o investimento?\n' } }] } } }] };
const deckFake = { pageSize: { width: { magnitude: 1000 }, height: { magnitude: 500 } }, slides: [{}, {}, {}, slidePreco, slidePreco] };

test('formatação BRL igual à do deck (espaço comum após R$)', () => {
  assert.equal(formatarBRL(56000), 'R$ 56.000');
  assert.equal(formatarBRL(5809.76), 'R$ 5.809,76');
  assert.equal(formatarCurto(56000), '56 mil');
  assert.equal(formatarCurto(29750), '29,75 mil');
  assert.equal(formatarCurto(12500), '12,5 mil');
});

test('montarValores calcula parcela e marca pendências visíveis', () => {
  const { valores, pendencias } = montarValores(exemplo());
  assert.equal(valores.preco_estruturacao, 'R$ 29.750');
  assert.equal(valores.parcelas, '12');
  assert.equal(valores.valor_parcela, '2.479,17');
  assert.equal(valores.preco_execucao, 'R$ 5.000');
  assert.match(valores.preco_execucao_com_social, /^\[PREENCHER: /);
  assert.deepEqual(pendencias, ['preço da execução com social media']);
});

test('sem preço na transcrição: nada inventado, tudo vira pendência', () => {
  const e = exemplo();
  e.preco.estruturacao = { valor_total: null, parcelas: null, valor_parcela: null, condicao: null };
  const { valores, pendencias } = montarValores(e);
  assert.match(valores.preco_estruturacao, /PREENCHER/);
  assert.ok(pendencias.includes('preço da estruturação'));
  assert.ok(pendencias.includes('número de parcelas'));
});

test('slides de escopo entram antes do 1º slide de investimento', () => {
  assert.equal(acharIndicePreco(deckFake), 3);
  assert.equal(acharIndicePreco({ slides: [{}, {}] }), 2);
  const p = planejar(exemplo(), deckFake);
  const criados = p.requests.filter((r) => r.createSlide).map((r) => r.createSlide.insertionIndex);
  assert.deepEqual(criados, [3, 4, 5, 6, 7]); // dores, S1, S3, overdeliveries, plano
});

test('lista longa quebra em slides (cont.) e ids são únicos', () => {
  const e = exemplo();
  e.escopo.semanas[0].itens = Array.from({ length: ESTILO.itensPorSlide + 3 }, (_, i) => ({ texto: `item ${i}`, origem: 'closer' }));
  const secoes = secoesEscopo(e);
  assert.ok(secoes.some((s) => s.titulo.endsWith('(cont.)')));
  const reqs = requestsSlidesEscopo(secoes, { indice: 0, pageSize: deckFake.pageSize });
  const ids = reqs.flatMap((r) => [r.createSlide?.objectId, r.createShape?.objectId]).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.length >= 5)); // Slides API exige objectId com 5+ caracteres
});

test('validação: item da IA sem citação é barrado', () => {
  const e = exemplo();
  e.escopo.semanas[0].itens.push({ texto: 'inventado', origem: 'ia', citacao: null });
  assert.ok(validarEscopo(e).some((m) => m.includes('sem citação')));
  assert.deepEqual(validarEscopo(exemplo()), []);
});

test('catálogo: ids únicos e exemplo só usa ids que existem', () => {
  const ids = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') { if (typeof o.id === 'string' && o.texto) ids.push(o.id); Object.values(o).forEach(walk); }
  };
  walk(catalogo);
  assert.equal(new Set(ids).size, ids.length, 'id repetido no catálogo');
  const usados = [];
  const ex = exemplo();
  for (const s of ex.escopo.semanas) for (const i of s.itens) if (i.catalogo_id) usados.push(i.catalogo_id);
  for (const i of [...ex.escopo.overdeliveries, ...ex.plano_execucao.itens]) if (i.catalogo_id) usados.push(i.catalogo_id);
  for (const u of usados) assert.ok(ids.includes(u), `catalogo_id inexistente: ${u}`);
});

test('mapa de literais do deck não tem literal que contenha outro (troca ambígua)', () => {
  const lits = LITERAIS_DECK.map(([de]) => de);
  for (const a of lits) for (const b of lits) if (a !== b) assert.ok(!a.includes(b), `${a} contém ${b}`);
});

// ---- fluxo completo com fetch falso ----
function fetchFalso({ exportGrande = false } = {}) {
  const chamadas = [];
  const resp = (status, corpo, bin) => ({
    ok: status < 400, status,
    json: async () => corpo,
    arrayBuffer: async () => new TextEncoder().encode(bin || 'x').buffer,
  });
  const impl = async (url, init = {}) => {
    chamadas.push({ url, metodo: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
    if (url.includes('/copy')) return resp(200, { id: 'NOVO123', webViewLink: 'https://docs.google.com/presentation/d/NOVO123/edit', exportLinks: { [MIME.pdf]: 'https://docs.google.com/export/pdf' } });
    if (url.includes('/presentations/NOVO123?')) return resp(200, deckFake);
    if (url.includes(':batchUpdate')) return resp(200, { replies: [] });
    if (url.includes('/permissions')) return resp(200, { id: 'p' });
    if (url.includes('/export?')) return exportGrande ? resp(403, { error: { errors: [{ reason: 'exportSizeLimitExceeded' }], message: 'too large' } }) : resp(200, {}, 'PDF');
    if (url === 'https://docs.google.com/export/pdf') return resp(200, {}, 'PDF-GRANDE');
    return resp(404, {});
  };
  return { impl, chamadas };
}

test('gerarProposta: copia, preenche, compartilha por link + editor e exporta', async () => {
  const f = fetchFalso();
  const r = await gerarProposta(criarCliente('tok', f.impl), {
    templateId: 'TPL', escopo: exemplo(), editores: ['closer@v4company.com'], exportar: ['pdf'], hoje: new Date('2026-10-29T12:00:00Z'),
  });
  assert.equal(r.id, 'NOVO123');
  assert.equal(r.slidesInseridos, 5);
  assert.equal(f.chamadas[0].body.name, 'Proposta V4 — Empresa Exemplo (fictícia) — 2026-10-29');
  const perms = f.chamadas.filter((c) => c.url.includes('/permissions')).map((c) => c.body);
  assert.deepEqual(perms, [{ type: 'anyone', role: 'reader' }, { type: 'user', role: 'writer', emailAddress: 'closer@v4company.com' }]);
  assert.equal(r.arquivos.pdf.toString(), 'PDF');
  assert.ok(f.chamadas.every((c) => c.auth === 'Bearer tok'));
  // nunca toca o template: só lê via copy
  assert.ok(!f.chamadas.some((c) => c.url.includes('TPL') && !c.url.includes('/copy')));
});

test('export acima de 10 MB cai para exportLinks', async () => {
  const f = fetchFalso({ exportGrande: true });
  const r = await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), link: 'nenhum', exportar: ['pdf'] });
  assert.equal(r.arquivos.pdf.toString(), 'PDF-GRANDE');
  assert.ok(!f.chamadas.some((c) => c.url.includes('/permissions')));
});

test('escopo inválido não cria cópia', async () => {
  const f = fetchFalso();
  const e = exemplo(); delete e.cliente.empresa;
  await assert.rejects(gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: e }), /escopo inválido/);
  assert.equal(f.chamadas.length, 0);
});

test('sem token: erro claro, sem chamada', () => {
  assert.throws(() => criarCliente(''), /GOOGLE_ACCESS_TOKEN/);
});
