// node --test propostas/gerador/   (ou: node propostas/gerador/gerador.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  acharIndicePreco, formatarBRL, formatarCurto, montarValores, planejarPreparar, requestsSlidesEscopo,
  secoesEscopo, validarEscopo, verificarTemplate, LITERAIS_DECK, PLACEHOLDERS_TEMPLATE, ESTILO,
} from '../../supabase/functions/_shared/propostas/slides.mjs';
import { gerarProposta, planejar, prepararTemplate } from '../../supabase/functions/_shared/propostas/gerar.mjs';
import { criarCliente, MIME } from '../../supabase/functions/_shared/propostas/google.mjs';
import { redigir } from '../../supabase/functions/_shared/propostas/redigir.mjs';

const exemplo = () => JSON.parse(readFileSync(new URL('../exemplos/escopo-exemplo-inside-sales-linkedin.json', import.meta.url), 'utf8'));
const catalogo = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/catalogo-v0.json', import.meta.url), 'utf8'));

const caixaTexto = (objectId, content) => ({ objectId, shape: { text: { textElements: [{ textRun: { content } }] } } });
const slide = (objectId, ...textos) => ({ objectId, pageElements: textos.map((t, i) => caixaTexto(`${objectId}_e${i}`, t)) });

// Deck original (como no Google): slides de preço com os literais.
const deckOriginal = () => ({
  pageSize: { width: { magnitude: 1000 }, height: { magnitude: 500 } },
  slides: [
    slide('capa'),
    slide('caseSlide', 'Case: economia de R$ 56.000,00 no ano'),
    slide('inst'),
    slide('preco1', 'Qual é o investimento?\n', 'R$ 56.000', '56 mil', '1.830,00', '12x de', 'Condição exclusiva junto com a execução, Val. até 24/08'),
    slide('preco2', 'Produtos da Proposta', '(0 a 20k Mídia)', 'R$ 5.809,76', 'R$ 7.809,76'),
  ],
});

// Template preparado: literais trocados por placeholders nos slides de preço.
const deckTemplate = () => {
  const d = deckOriginal();
  for (const s of d.slides.slice(3)) {
    for (const el of s.pageElements) {
      const tr = el.shape.text.textElements[0].textRun;
      for (const [de, para] of LITERAIS_DECK) tr.content = tr.content.replace(de, para);
    }
  }
  return d;
};

test('formatação BRL igual à do deck', () => {
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

test('Vedor #3: preço/parcelas com tipo ou faixa inválida são barrados', () => {
  const casos = [
    (e) => { e.preco.estruturacao.valor_total = 'not-a-number'; },
    (e) => { e.preco.estruturacao.valor_total = Number.NaN; },
    (e) => { e.preco.estruturacao.valor_total = -1; },
    (e) => { e.preco.estruturacao.parcelas = -2; },
    (e) => { e.preco.estruturacao.parcelas = 1.5; },
    (e) => { e.preco.execucao_mensal.valor = '5000'; },
    (e) => { e.preco.execucao_mensal.meses = 0; },
    (e) => { e.plano_execucao.faixa_midia = 20000; },
  ];
  for (const mexer of casos) {
    const e = exemplo(); mexer(e);
    assert.ok(validarEscopo(e).length > 0, `passou: ${mexer}`);
  }
});

test('Vedor #4 / R2 #1: item da IA sem citação válida é barrado em todas as coleções', () => {
  const colecoes = [
    (e) => e.escopo.semanas[0].itens,
    (e) => e.contexto.dores,
    (e) => e.escopo.overdeliveries,
    (e) => e.plano_execucao.itens,
  ];
  const citacoesRuins = [null, undefined, '', '   ', {}, [], 42];
  for (const col of colecoes) {
    for (const citacao of citacoesRuins) {
      const e = exemplo();
      col(e).push({ texto: 'inventado', origem: 'ia', citacao });
      assert.ok(validarEscopo(e).length > 0, `passou: ${col} com citação ${JSON.stringify(citacao)}`);
    }
    const e = exemplo();
    col(e).push({ texto: '  ', origem: 'closer', citacao: null });
    assert.ok(validarEscopo(e).some((m) => m.includes('sem texto')));
    const e2 = exemplo();
    col(e2).push({ texto: 'x', origem: 'robô', citacao: null });
    assert.ok(validarEscopo(e2).some((m) => m.includes('origem inválida')));
  }
  assert.deepEqual(validarEscopo(exemplo()), []);
});

test('slides de escopo entram antes do 1º slide de investimento', () => {
  assert.equal(acharIndicePreco(deckTemplate()), 3);
  assert.equal(acharIndicePreco({ slides: [{}, {}] }), 2);
  const p = planejar(exemplo(), deckTemplate());
  const criados = p.requests.filter((r) => r.createSlide).map((r) => r.createSlide.insertionIndex);
  assert.deepEqual(criados, [3, 4, 5, 6, 7]); // dores, S1, S3, overdeliveries, plano
});

test('lista longa quebra em slides (cont.) e ids são únicos e válidos', () => {
  const e = exemplo();
  e.escopo.semanas[0].itens = Array.from({ length: ESTILO.itensPorSlide + 3 }, (_, i) => ({ texto: `item ${i}`, origem: 'closer' }));
  const secoes = secoesEscopo(e);
  assert.ok(secoes.some((s) => s.titulo.endsWith('(cont.)')));
  const reqs = requestsSlidesEscopo(secoes, { indice: 0, pageSize: deckOriginal().pageSize });
  const ids = reqs.flatMap((r) => [r.createSlide?.objectId, r.createShape?.objectId]).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9_][a-zA-Z0-9_\-:]{4,49}$/.test(id)));
});

test('Vedor #6: prefixo muda a cada geração e colisão com o template é recusada', () => {
  const a = planejar(exemplo(), deckTemplate()).requests.find((r) => r.createSlide).createSlide.objectId;
  const b = planejar(exemplo(), deckTemplate()).requests.find((r) => r.createSlide).createSlide.objectId;
  assert.notEqual(a, b);
  const deck = deckTemplate();
  deck.slides.push(slide('gpfixo_s0'));
  assert.throws(() => planejar(exemplo(), deck, { prefixo: 'gpfixo' }), /objectId já existe/);
});

test('Vedor #2: template não preparado ou parcial é recusado', () => {
  assert.throws(() => planejar(exemplo(), deckOriginal()), /template incompatível/);
  const parcial = deckTemplate();
  parcial.slides[4].pageElements[2].shape.text.textElements[0].textRun.content = 'R$ 5.809,76';
  const erros = verificarTemplate(parcial);
  assert.ok(erros.some((m) => m.includes('{{preco_execucao}}')));
  assert.ok(erros.some((m) => m.includes('preço antigo')));
  assert.deepEqual(verificarTemplate(deckTemplate()), []);
});

test('Vedor #5: preparar só mexe nos slides de preço', () => {
  const p = planejarPreparar(deckOriginal());
  assert.deepEqual(p.erros, []);
  assert.deepEqual(p.pageObjectIds, ['preco1', 'preco2']);
  assert.ok(p.requests.every((r) => r.replaceAllText.pageObjectIds.join() === 'preco1,preco2'));
});

test('Vedor #5: preparar recusa literal ausente ou colado a outro número', () => {
  const d = deckOriginal();
  d.slides[3].pageElements[1].shape.text.textElements[0].textRun.content = 'R$ 56.000,00';
  assert.ok(planejarPreparar(d).erros.some((m) => m.includes('colado')));
  const d2 = deckOriginal();
  d2.slides[4].pageElements[2].shape.text.textElements[0].textRun.content = 'R$ 6.000,00';
  assert.ok(planejarPreparar(d2).erros.some((m) => m.includes('ausente')));
  assert.ok(planejarPreparar({ slides: [slide('x', 'nada')] }).erros.length > 0);
});

test('texto em tabela também é lido', () => {
  const d = deckTemplate();
  const t = { objectId: 'tab1', table: { tableRows: [{ tableCells: [{ text: { textElements: [{ textRun: { content: 'Qual é o investimento?' } }] } }] }] } };
  d.slides.unshift({ objectId: 'tabslide', pageElements: [t] });
  assert.equal(acharIndicePreco(d), 0);
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

test('mapa de literais: nenhum contém outro e todos os placeholders são distintos', () => {
  const lits = LITERAIS_DECK.map(([de]) => de);
  for (const a of lits) for (const b of lits) if (a !== b) assert.ok(!a.includes(b), `${a} contém ${b}`);
  assert.equal(PLACEHOLDERS_TEMPLATE.length, LITERAIS_DECK.length);
});

// ---- fluxo completo com fetch falso ----
function fetchFalso({ exportGrande = false, deck = deckTemplate(), trocas = 1, apagarStatus = 204, aclInicial = [], falhaEditor = null, aclPasta = [] } = {}) {
  const chamadas = [];
  // ACL simulada da cópia: dono + o que veio herdado/padrão do destino.
  let acl = [{ id: 'own', type: 'user', role: 'owner', emailAddress: 'gerador@v4company.com' }, ...aclInicial.map((p) => ({ ...p }))];
  let seq = 0;
  const aclNoBatch = [];
  const resp = (status, corpo, bin) => ({
    ok: status < 400, status,
    json: async () => corpo,
    arrayBuffer: async () => new TextEncoder().encode(bin || 'x').buffer,
  });
  const impl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    chamadas.push({ url, metodo: init.method || 'GET', body, auth: init.headers?.Authorization });
    if (url.includes('/copy')) return resp(200, { id: 'NOVO123', webViewLink: 'https://docs.google.com/presentation/d/NOVO123/edit', exportLinks: { [MIME.pdf]: 'https://docs.google.com/export/pdf' } });
    if (url.includes('/presentations/') && !url.includes(':batchUpdate')) return resp(200, deck);
    if (url.includes(':batchUpdate')) aclNoBatch.push(acl.map((p) => `${p.type}:${p.role}`));
    if (url.includes(':batchUpdate')) return resp(200, { replies: body.requests.map((r) => (r.replaceAllText ? { replaceAllText: { occurrencesChanged: trocas } } : {})) });
    if (url.includes('/files/PASTA') && url.includes('/permissions')) return resp(200, { permissions: aclPasta });
    if (url.includes('fields=parents') && (init.method || 'GET') === 'GET') return resp(200, { parents: ['ROOTID'] });
    if (init.method === 'PATCH' && url.includes('addParents=')) {
      for (const p of aclPasta) acl.push({ ...p, permissionDetails: [{ inherited: true }] });
      return resp(200, { id: 'NOVO123', parents: ['PASTA'] });
    }
    if (url.includes('/permissions')) {
      const m = init.method || 'GET';
      if (m === 'GET') return resp(200, { permissions: acl.map((p) => ({ ...p })) });
      if (m === 'POST') {
        if (falhaEditor && body.type === 'user') return resp(falhaEditor, { error: { message: 'editor recusado' } });
        const nova = { id: `p${++seq}`, ...body };
        acl.push(nova);
        return resp(200, { id: nova.id });
      }
      if (m === 'DELETE') {
        const id = url.split('/permissions/')[1].split('?')[0];
        const alvo = acl.find((p) => p.id === id);
        if (alvo?.permissionDetails?.some((d) => d.inherited)) return resp(403, { error: { message: 'herdada' } });
        acl = acl.filter((p) => p.id !== id);
        return resp(204, {});
      }
    }
    if (url.includes('/export?')) return exportGrande ? resp(403, { error: { errors: [{ reason: 'exportSizeLimitExceeded' }], message: 'too large' } }) : resp(200, {}, 'PDF');
    if (url === 'https://docs.google.com/export/pdf') return resp(200, {}, 'PDF-GRANDE');
    if (init.method === 'DELETE') return resp(apagarStatus, apagarStatus < 400 ? {} : { error: { message: 'forbidden' } });
    return resp(404, {});
  };
  return { impl, chamadas, acl: () => acl, aclNoBatch };
}

test('gerarProposta: copia, preenche, compartilha com o domínio V4 + editor e exporta', async () => {
  const f = fetchFalso();
  const r = await gerarProposta(criarCliente('tok', f.impl), {
    templateId: 'TPL', escopo: exemplo(), editores: ['closer@v4company.com'], dominio: 'v4company.com', exportar: ['pdf'], hoje: new Date('2026-10-29T12:00:00Z'),
  });
  assert.equal(r.id, 'NOVO123');
  assert.equal(r.slidesInseridos, 5);
  assert.equal(f.chamadas[0].body.name, 'Proposta V4 — Empresa Exemplo (fictícia) — 2026-10-29');
  const perms = f.chamadas.filter((c) => c.url.includes('/permissions') && c.metodo === 'POST');
  assert.deepEqual(perms.map((c) => c.body), [{ type: 'domain', role: 'reader', domain: 'v4company.com', allowFileDiscovery: false }, { type: 'user', role: 'writer', emailAddress: 'closer@v4company.com' }]);
  // Vedor #1: sendNotificationEmail só para user/group
  assert.ok(!perms[0].url.includes('sendNotificationEmail'));
  assert.ok(perms[1].url.includes('sendNotificationEmail=false'));
  assert.ok(!perms.some((c) => c.body.type === 'anyone'));
  assert.equal(new TextDecoder().decode(r.arquivos.pdf), 'PDF');
  assert.ok(f.chamadas.every((c) => c.auth === 'Bearer tok'));
  assert.ok(!f.chamadas.some((c) => c.url.includes('TPL') && !c.url.includes('/copy')));
});

test('Vedor #2: template original → cópia apagada, nada compartilhado', async () => {
  const f = fetchFalso({ deck: deckOriginal() });
  await assert.rejects(gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo() }), /template incompatível/);
  assert.ok(!f.chamadas.some((c) => c.url.includes('/permissions') && c.metodo === 'POST'));
  assert.ok(!f.chamadas.some((c) => c.url.includes(':batchUpdate')));
  assert.ok(f.chamadas.some((c) => c.metodo === 'DELETE' && c.url.includes('NOVO123')));
});

test('Vedor #2: zero trocas no batchUpdate → cópia apagada, nada compartilhado', async () => {
  const f = fetchFalso({ trocas: 0 });
  await assert.rejects(gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo() }), /sem troca/);
  assert.ok(!f.chamadas.some((c) => c.url.includes('/permissions') && c.metodo === 'POST'));
  assert.ok(f.chamadas.some((c) => c.metodo === 'DELETE'));
});

test('R2 #2: falha ao apagar a cópia preserva o erro original e informa o id', async () => {
  const f = fetchFalso({ deck: deckOriginal(), apagarStatus: 403 });
  const err = await gerarProposta(criarCliente('segredo-nao-pode-vazar', f.impl), { templateId: 'TPL', escopo: exemplo() }).catch((e) => e);
  assert.match(err.message, /template incompatível/);
  assert.match(err.message, /NOVO123 NÃO foi apagada/);
  assert.deepEqual({ ...err.limpeza, erro: undefined }, { copiaId: 'NOVO123', apagada: false, erro: undefined });
  assert.ok(!err.message.includes('segredo-nao-pode-vazar'));
  assert.ok(!f.chamadas.some((c) => c.url.includes('/permissions') && c.metodo === 'POST'));
});

test('R2 #2: remoção bem-sucedida fica registrada no erro', async () => {
  const f = fetchFalso({ deck: deckOriginal() });
  const err = await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo() }).catch((e) => e);
  assert.deepEqual(err.limpeza, { copiaId: 'NOVO123', apagada: true });
});

test('Vedor F3 #2: cópia vai para a raiz (não herda a pasta do template) e ACL final é só dono + domínio leitor + closer', async () => {
  const f = fetchFalso({ aclInicial: [
    { id: 'pub', type: 'anyone', role: 'reader' },
    { id: 'domw', type: 'domain', role: 'writer', domain: 'v4company.com' },
  ] });
  await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), editores: ['closer@v4company.com'], dominio: 'v4company.com' });
  assert.deepEqual(f.chamadas[0].body.parents, ['root']);
  const final = f.acl().map((p) => `${p.type}:${p.role}`).sort();
  assert.deepEqual(final, ['domain:reader', 'user:owner', 'user:writer']);
});

test('Vedor F3 #2: acesso herdado incompatível → recusa e apaga a cópia', async () => {
  const f = fetchFalso({ aclInicial: [{ id: 'her', type: 'anyone', role: 'reader', permissionDetails: [{ inherited: true }] }] });
  const err = await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), dominio: 'v4company.com' })
    .catch((e) => e);
  assert.match(err.message, /acesso herdado incompatível/);
  assert.equal(err.limpeza.apagada, true);
  assert.ok(!f.chamadas.some((c) => c.url.includes(':batchUpdate')), 'não escreveu escopo/preço numa cópia exposta');
});

test('Vedor F3 R2 #2: cópia é privada ANTES de receber escopo/preço (padrão do domínio removido)', async () => {
  const f = fetchFalso({ aclInicial: [{ id: 'padrao', type: 'domain', role: 'reader', domain: 'v4company.com' }, { id: 'pub', type: 'anyone', role: 'reader' }] });
  await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), editores: ['closer@v4company.com'], dominio: 'v4company.com' });
  assert.ok(f.chamadas[0].url.includes('ignoreDefaultVisibility=true'));
  assert.deepEqual(f.aclNoBatch, [['user:owner']]);
});

test('Vedor F3 R2 #2: pasta de destino pública é recusada antes de copiar', async () => {
  const f = fetchFalso({ aclPasta: [{ id: 'x', type: 'anyone', role: 'reader' }] });
  await assert.rejects(gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), dominio: 'v4company.com', pastaId: 'PASTA' }), /pasta de destino/);
  assert.ok(!f.chamadas.some((c) => c.url.includes('/copy')));
});

test('Vedor F3 R2 #2: pasta válida → move só no fim e confere de novo', async () => {
  const f = fetchFalso({ aclPasta: [{ id: 'own', type: 'user', role: 'owner', emailAddress: 'gerador@v4company.com' }, { id: 'd', type: 'domain', role: 'reader', domain: 'v4company.com' }] });
  await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), dominio: 'v4company.com', pastaId: 'PASTA' });
  const idxBatch = f.chamadas.findIndex((c) => c.url.includes(':batchUpdate'));
  const idxMove = f.chamadas.findIndex((c) => c.metodo === 'PATCH');
  assert.ok(idxMove > idxBatch);
  assert.ok(f.chamadas[idxMove].url.includes('addParents=PASTA') && f.chamadas[idxMove].url.includes('removeParents=ROOTID'));
  assert.deepEqual(f.chamadas.find((c) => c.url.includes('/copy')).body.parents, ['root']);
});

test('Vedor F3 #5: falha ao dar acesso ao editor → cópia apagada (dentro da compensação)', async () => {
  const f = fetchFalso({ falhaEditor: 403 });
  const err = await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), editores: ['closer@v4company.com'], dominio: 'v4company.com' })
    .catch((e) => e);
  assert.match(err.message, /editor recusado/);
  assert.deepEqual(err.limpeza, { copiaId: 'NOVO123', apagada: true });
  assert.ok(f.chamadas.some((c) => c.metodo === 'DELETE' && c.url.endsWith('/files/NOVO123?supportsAllDrives=true')));
});

test('Vedor F3 #7: erro do Google não carrega o token', async () => {
  const fetchEco = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Credentials: Bearer tok-secreto-123456 ya29.abcdefghijkl' } }) });
  const err = await criarCliente('tok-secreto-123456', fetchEco).apresentacao('X').catch((e) => e);
  assert.ok(!err.message.includes('tok-secreto-123456'));
  assert.ok(!err.message.includes('ya29.abcdefghijkl'));
  assert.match(err.message, /HTTP 401/);
});

test('redigir: chaves conhecidas e formatos comuns', () => {
  const t = redigir('key sk-proj-ABCDEFGH123 e sk-ant-api03-XYZ12345678 jwt eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.sig e api_key=abcdefgh1234 e segredo-local-xyz', ['segredo-local-xyz']);
  for (const v of ['sk-proj-ABCDEFGH123', 'sk-ant-api03-XYZ12345678', 'eyJhbGciOiJIUzI1NiJ9', 'abcdefgh1234', 'segredo-local-xyz']) assert.ok(!t.includes(v), v);
});

test('prepararTemplate: lê o deck e restringe as trocas aos slides de preço', async () => {
  const f = fetchFalso({ deck: deckOriginal() });
  const r = await prepararTemplate(criarCliente('tok', f.impl), 'COPIA');
  assert.equal(r.slidesDePreco, 2);
  const batch = f.chamadas.find((c) => c.url.includes(':batchUpdate'));
  assert.ok(batch.body.requests.every((q) => q.replaceAllText.pageObjectIds.length === 2));
});

test('prepararTemplate recusa deck incompatível sem alterar nada', async () => {
  const f = fetchFalso({ deck: deckTemplate() }); // já preparado: literais ausentes
  await assert.rejects(prepararTemplate(criarCliente('tok', f.impl), 'COPIA'), /nada alterado/);
  assert.ok(!f.chamadas.some((c) => c.url.includes(':batchUpdate')));
});

test('export acima de 10 MB cai para exportLinks', async () => {
  const f = fetchFalso({ exportGrande: true });
  const r = await gerarProposta(criarCliente('tok', f.impl), { templateId: 'TPL', escopo: exemplo(), exportar: ['pdf'] });
  assert.equal(new TextDecoder().decode(r.arquivos.pdf), 'PDF-GRANDE');
  assert.ok(!f.chamadas.some((c) => c.url.includes('/permissions') && c.metodo === 'POST'));
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
