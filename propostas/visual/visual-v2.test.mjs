// node --test propostas/visual/visual-v2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { normalizarEscopo } from '../../supabase/functions/_shared/propostas/analise.mjs';
import { requestsDeckCurto } from '../../supabase/functions/_shared/propostas/deck-curto.mjs';
import { analisarSlide } from '../../supabase/functions/_shared/propostas/visual.mjs';
import {
  requestsVisualV2, aplicarVisualV2, assetsDoProjeto, tituloCurto, primeiraOracao, validadeDoTexto, escolherCaso,
  numerosDoDeck, cabe, AVISO_CASO, planoGradeEntregas, planoGradeDiagnostico, planoPassos, mockupsDoDeck,
  tituloDeclarado, nomeDoTipo, modeloDoCatalogo, planoBV2, requestsCapa,
} from '../../supabase/functions/_shared/propostas/visual-v2.mjs';

const PT = 12700;
const ASSETS = 'https://exemplo.supabase.co/storage/v1/object/public/propostas-visual';
const W = 9144000;
const H = 5143500;
const CASOS = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/casos-v0.json', import.meta.url), 'utf8'));

const el = (id, texto, [x, y, w, h], fonte = 12, tipo = 'ROUND_RECTANGLE') => ({
  objectId: id,
  size: { width: { magnitude: w * PT, unit: 'EMU' }, height: { magnitude: h * PT, unit: 'EMU' } },
  transform: { scaleX: 1, scaleY: 1, translateX: x * PT, translateY: y * PT, unit: 'EMU' },
  shape: { shapeType: tipo, text: texto == null ? undefined : { textElements: [{ textRun: { content: `${texto}\n`, style: { fontSize: { magnitude: fonte, unit: 'PT' } } } }] } },
});
const lista = (sid, rotulo, titulo, itens, h = 32) => ({
  objectId: sid,
  pageElements: [
    el(`${sid}_r`, rotulo, [39, 28, 640, 28], 11, 'TEXT_BOX'),
    el(`${sid}_t`, titulo, [39, 52, 640, 60], 30, 'TEXT_BOX'),
    ...itens.map((t, i) => el(`${sid}_c${i}`, `${String(i + 1).padStart(2, '0')}   ${t}`, [39, 137 + i * (h + 5), 640, h])),
    el(`${sid}_f`, 'V4 COMPANY  ·  MARCENARIA TESTE', [39, 368, 640, 24], 9, 'TEXT_BOX'),
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
    el(`${sid}_p0`, 'CONDIÇÃO PARA FECHAMENTO ATÉ 30/10', [453, 149, 212, 23], 10, 'TEXT_BOX'),
    el(`${sid}_p1`, '20% DE DESCONTO', [453, 174, 212, 26], 20, 'TEXT_BOX'),
    el(`${sid}_p2`, 'R$ 5.200', [453, 205, 212, 49], 40, 'TEXT_BOX'),
    el(`${sid}_p4`, 'de R$ 6.500 por R$ 5.200', [453, 291, 212, 23], 10, 'TEXT_BOX'),
  ],
});
const deck = () => ({
  pageSize: { width: { magnitude: W, unit: 'EMU' }, height: { magnitude: H, unit: 'EMU' } },
  slides: [
    { objectId: 'capaV4', pageElements: [] },
    lista('xD', 'DIAGNÓSTICO', 'O QUE OUVIMOS DA MARCENARIA', ['Sem CRM: não dá para saber de onde veio cada lead', 'Atendimento comercial feito por uma pessoa só', 'Site atual em Wix, sem foco em conversão']),
    lista('xA', 'PROPOSTA · IMPLEMENTAÇÃO', 'O QUE ENTREGAMOS AGORA', [
      'Landing page no modelo de portfólio', 'CRM integrado ao WhatsApp, com IA de recepção', 'Funis personalizados no CRM',
      'Setup de campanha no Google Ads pronto para rodar, com 15 dias de acompanhamento',
    ]),
    investimento('xI'),
    lista('xC', 'DECISÃO', 'PRÓXIMOS PASSOS', ['Cliente alinha a proposta com quem decide', 'Condição de 20% válida para fechamento até 30/10', 'Prazo de entrega da implementação: 30 Dias']),
  ],
});
const criados = (reqs) => reqs.flatMap((r) => [r.createShape?.objectId, r.createImage?.objectId, r.createSlide?.objectId]).filter(Boolean);

// Executa no "Slides" os requests que mudam a estrutura (para ordem, idempotência e integração).
function simular(apresentacao, requests) {
  const slides = apresentacao.slides.map((s) => ({ ...s, pageElements: [...s.pageElements] }));
  const porId = new Map();
  const pagina = (id) => slides.find((s) => s.objectId === id);
  for (const r of requests) {
    if (r.deleteObject) {
      const i = slides.findIndex((s) => s.objectId === r.deleteObject.objectId);
      if (i >= 0) slides.splice(i, 1);
      else for (const s of slides) s.pageElements = s.pageElements.filter((e) => e.objectId !== r.deleteObject.objectId);
    }
    if (r.createSlide) slides.splice(r.createSlide.insertionIndex, 0, { objectId: r.createSlide.objectId, pageElements: [] });
    const novo = r.createShape || r.createImage;
    if (novo) {
      const ep = novo.elementProperties;
      const e = { objectId: novo.objectId, size: ep.size, transform: ep.transform, shape: r.createShape ? { shapeType: r.createShape.shapeType, text: { textElements: [] } } : undefined };
      pagina(ep.pageObjectId).pageElements.push(e);
      porId.set(novo.objectId, e);
    }
    if (r.insertText) porId.get(r.insertText.objectId)?.shape.text.textElements.push({ textRun: { content: r.insertText.text } });
  }
  return { ...apresentacao, slides };
}

test('título curto = nome do ícone (catálogo), nunca texto novo', () => {
  assert.equal(tituloCurto('01   Landing page focada em conversão'), 'Landing page');
  assert.equal(tituloCurto('Página otimizada para aparecer nas buscas por IA (ChatGPT, Gemini) e no Google orgânico'), 'Busca por IA');
  assert.equal(tituloCurto('CRM integrado ao WhatsApp, com IA de recepção'), 'CRM + WhatsApp');
  // sem ícone conhecido: as primeiras palavras do próprio texto, até a pontuação
  assert.equal(tituloCurto('Algo bem diferente: com detalhe'), 'Algo bem diferente');
});

test('título curto: palavra-chave fora do sujeito não vira cabeçalho (sondas do Vedor)', () => {
  assert.equal(tituloCurto('Treinamento do time comercial no CRM'), 'Treinamento do time comercial');
  assert.equal(tituloCurto('Revisão mensal das metas com a empresa'), 'Revisão mensal das metas');
  assert.equal(tituloCurto('Automação de follow-up para leads parados há 30 dias'), 'Automação de follow-up');
  assert.notEqual(tituloCurto('Relatório semanal enviado ao cliente por WhatsApp'), 'CRM + WhatsApp');
  // Authoral: nome do ícone; com "Título: detalhe" (até 5 palavras), vale o título escrito
  const authoral = [
    ['Landing page focada em conversão, no modelo de portfólio, com os melhores projetos entregues', 'Landing page'],
    ['Funis personalizados no CRM (ex.: arquitetos e parceiros; cliente final), com etapas até o fechamento', 'Funis'],
    ['Rastreamento de ponta a ponta: UTMs, pixel e tags, e API de conversão ligando o CRM às campanhas', 'Rastreamento de ponta a ponta'],
    ['Setup de campanha no Google Ads pronto para rodar, com 15 dias de acompanhamento', 'Google Ads'],
  ];
  for (const [t, esperado] of authoral) assert.equal(tituloCurto(t), esperado, t);
});

test('primeira oração em destaque só quando curta; validade lida do texto', () => {
  assert.equal(primeiraOracao('01   Sem CRM: não dá para saber'), 'Sem CRM');
  assert.equal(primeiraOracao('Marcenaria com 43 anos (JM Marcenaria) e showroom'), 'Marcenaria com 43 anos');
  assert.equal(primeiraOracao('Texto sem pontuação nenhuma até o fim'), null);
  assert.equal(validadeDoTexto('Condição de 20% válida para fechamento até 30/10'), '30/10');
  assert.equal(validadeDoTexto('Proposta válida até 05/11/2026'), '05/11/2026');
  assert.equal(validadeDoTexto('Retorno ao Gabriel hoje, 30/10, até 15h'), null);
});

test('catálogo de cases: fonte oficial, imagem publicada, números com valor "depois"', () => {
  assert.match(CASOS.fonte, /ee-2026-v4company\.vercel\.app/);
  assert.equal(CASOS.casos.length, 6);
  for (const c of CASOS.casos) {
    assert.ok(existsSync(new URL(`./casos/${c.imagem}`, import.meta.url)), c.imagem);
    assert.ok(c.largura > 0 && c.altura > 0 && c.frase && c.numeros.some((n) => n.depois), c.id);
  }
});

test('case escolhido por afinidade com o problema; sem afinidade, sem case', () => {
  assert.equal(escolherCaso('Sem CRM, leads aleatórios, atendimento comercial lento').caso.id, 'valec-renault');
  assert.equal(escolherCaso('E-commerce com checkout ruim, conversão baixa e rastreamento GA4 quebrado').caso.modelo, 'e-commerce');
  assert.equal(escolherCaso('Texto sem relação nenhuma'), null);
  // só sinais genéricos (comercial, lead) não bastam: precisa de 3 e de 1 específico
  assert.equal(escolherCaso('Atendimento comercial lento; leads chegam e esfriam'), null);
});

test('números do slide-resumo saem do deck; sem dado, sem número', () => {
  const ns = numerosDoDeck(deck().slides.map(analisarSlide).filter(Boolean));
  assert.deepEqual(ns.map((n) => [n.rotulo, n.valor]), [['INVESTIMENTO', 'R$ 5.200'], ['PRAZO', '30 dias'], ['ENTREGAS', '4'], ['CONDIÇÃO', 'até 30/10']]);
  assert.equal(ns[0].sub, '20% de desconto');
  assert.deepEqual(numerosDoDeck([analisarSlide(lista('z', 'DIAGNÓSTICO', 'T', ['nada']))]), []);
});

test('grades só quando o texto cabe; senão o slide fica em lista (v1 com vidro)', () => {
  assert.ok(cabe('x'.repeat(30), 200, 20, 10));
  assert.ok(!cabe('x '.repeat(200), 100, 30, 10));
  const a = analisarSlide(deck().slides[2]);
  assert.equal(planoGradeEntregas(a, W, H).cols, 2); // 4 entregas: 2x2
  const slideLongo = lista('L', 'PROPOSTA · X', 'T', Array.from({ length: 6 }, () => 'palavra '.repeat(60)));
  assert.equal(planoGradeEntregas(analisarSlide(slideLongo), W, H), null);
  assert.equal(planoGradeDiagnostico(analisarSlide(lista('M', 'DIAGNÓSTICO', 'T', Array(9).fill('x'))), W, H), null);
  assert.equal(planoPassos(analisarSlide(lista('P', 'DECISÃO', 'PRÓXIMOS PASSOS', Array(6).fill('x'))), W, H), null);
  const { resumo } = requestsVisualV2({ pageSize: deck().pageSize, slides: [slideLongo] }, { assets: ASSETS });
  assert.ok(resumo[0].feito.includes('lista_vidro'));
});

test('mockups só das entregas com forma visível (no máximo 3, sem repetir desenho)', () => {
  const a = analisarSlide(deck().slides[2]);
  assert.deepEqual(mockupsDoDeck(a).map((m) => [m.desenho, m.nome]), [['navegador', 'Landing page'], ['celular', 'CRM + WhatsApp'], ['quadro', 'Funis']]);
  assert.deepEqual(mockupsDoDeck(analisarSlide(lista('q', 'PROPOSTA', 'T', ['Algo', 'Outro']))), []);
});

test('plano v2: layouts, slides novos na ordem certa, IDs únicos e sem colisão', () => {
  const d = deck();
  const { requests, resumo } = requestsVisualV2(d, { assets: ASSETS, prefixo: 'tst', data: '30/10/2026', caso: 'sim', capa: 'depois' });
  const por = Object.fromEntries(resumo.map((r) => [r.slide, r.feito]));
  assert.deepEqual(por.xD, ['grade_diagnostico']);
  assert.deepEqual(por.xA, ['titulos:titulo=0,icone=4,texto=0', 'grade_entregas']);
  assert.deepEqual(por.xI, ['icones_linhas:1', 'comparativo_preco']);
  assert.deepEqual(por.xC, ['passos+validade']);
  const novos = criados(requests);
  assert.equal(new Set(novos).size, novos.length, `repetidos: ${novos.filter((x, i) => novos.indexOf(x) !== i)}`);
  const existentes = new Set(d.slides.flatMap((s) => [s.objectId, ...s.pageElements.map((e) => e.objectId)]));
  for (const id of novos) assert.ok(!existentes.has(id), id);
  const ap = simular(d, requests);
  assert.deepEqual(ap.slides.map((s) => s.objectId), ['capaV4', 'tst_vcapa', 'xD', 'xA', 'tst_vmock', 'tst_vcase', 'tst_vnum', 'xI', 'tst_vtl', 'xC']);
  // nada de assets de fora: todo fundo/imagem vem da raiz do projeto
  for (const r of requests) {
    const url = r.createImage?.url || r.updatePageProperties?.pageProperties?.pageBackgroundFill?.stretchedPictureFill?.contentUrl;
    if (url) assert.ok(url.startsWith(`${ASSETS}/`), url);
  }
  // capa: nome do cliente do rodapé e a data passada
  const textos = requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  assert.ok(textos.includes('MARCENARIA TESTE'));
  assert.ok(textos.some((t) => t.includes('30/10/2026')));
});

test('idempotente: rodar de novo sobre o resultado não gera pedido', () => {
  const ap = simular(deck(), requestsVisualV2(deck(), { assets: ASSETS, prefixo: 'tst' }).requests);
  const { requests } = requestsVisualV2(ap, { assets: ASSETS, prefixo: 'tst2' });
  assert.deepEqual(requests, []);
});

test('integração com o deck curto (main): plano completo sem colisão', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixture-deck-curto.json', import.meta.url), 'utf8'));
  const catalogo = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/catalogo-v1.json', import.meta.url), 'utf8'));
  const e = normalizarEscopo(fx.escopo, { catalogo, empresa: 'Marcenaria Exemplo', transcricao: fx.transcricao, dataReuniao: '2026-10-30' });
  const base0 = { pageSize: deck().pageSize, slides: [{ objectId: 'capa', pageElements: [] }] };
  const ap = simular(base0, requestsDeckCurto(e, base0, { manter: ['capa'], prefixo: 'gpT' }).requests);
  const { requests, resumo } = requestsVisualV2(ap, { assets: ASSETS, prefixo: 'vT', capa: 'depois' });
  const r = JSON.stringify(resumo);
  for (const f of ['grade_entregas', 'comparativo_preco', 'capa_cliente']) assert.ok(r.includes(f), `${f}: ${r}`);
  const novos = criados(requests);
  assert.equal(new Set(novos).size, novos.length);
  const final = simular(ap, requests);
  assert.deepEqual(final.slides.slice(0, 2).map((x) => x.objectId), ['capa', 'vT_vcapa']);
  assert.ok(!JSON.stringify(resumo).includes('case:'), 'implementação sem opt-in: sem case');
});

test('capa: substituindo a institucional (padrão), depois, antes ou nenhuma', () => {
  const ordem = (capa) => simular(deck(), requestsVisualV2(deck(), { assets: ASSETS, prefixo: 'k', capa }).requests).slides.slice(0, 2).map((x) => x.objectId);
  assert.deepEqual(ordem(undefined), ['k_vcapa', 'xD']);
  assert.deepEqual(ordem('depois'), ['capaV4', 'k_vcapa']);
  assert.deepEqual(ordem('antes'), ['k_vcapa', 'capaV4']);
  assert.deepEqual(ordem('substituir'), ['k_vcapa', 'xD']);
  assert.deepEqual(ordem('nao'), ['capaV4', 'xD']);
});

test('case: desligado por padrão; opt-in fora de Estruturação leva o aviso; auto só em Estruturação', () => {
  const textos = (o, d = deck()) => requestsVisualV2(d, { assets: ASSETS, prefixo: 'c', ...o }).requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  assert.ok(!textos({}).some((t) => /VALEC/.test(t)), 'padrão: sem case');
  assert.ok(textos({ caso: 'sim' }).includes(AVISO_CASO));
  assert.ok(!textos({ caso: 'auto' }).some((t) => /VALEC/.test(t)), 'auto em implementação: sem case');
  const d = deck();
  d.slides[2] = lista('xA', 'PROPOSTA · ESTRUTURAÇÃO ESTRATÉGICA', 'O QUE ENTREGAMOS', ['Persona e ICP', 'CRM integrado ao WhatsApp', 'Landing page']);
  assert.ok(!textos({}, d).some((x) => /VALEC/.test(x)), 'Estruturação também começa sem case');
  const t = textos({ caso: 'auto' }, d);
  assert.ok(t.some((x) => /VALEC/.test(x)) && !t.includes(AVISO_CASO));
  assert.ok(!textos({ caso: 'sim' }, d).includes(AVISO_CASO), 'sim numa Estruturação: sem aviso');
});

test('tipo do gerador vale no lugar do rótulo do deck (capa e case)', () => {
  const textos = (o) => requestsVisualV2(deck(), { assets: ASSETS, prefixo: 't', ...o }).requests.filter((r) => r.insertText).map((r) => r.insertText.text);
  // rótulo do deck diz Implementação, a oferta é Estruturação: case auto entra sem aviso e a capa diz Estruturação
  const t = textos({ tipo: 'estruturacao', caso: 'auto' });
  assert.ok(t.some((x) => /VALEC/.test(x)) && !t.includes(AVISO_CASO));
  assert.ok(t.includes('PROPOSTA COMERCIAL  ·  ESTRUTURAÇÃO'));
  assert.ok(textos({ tipo: 'implementacao_e_execucao' }).includes('PROPOSTA COMERCIAL  ·  IMPLEMENTAÇÃO E EXECUÇÃO'));
  assert.ok(textos({ caso: 'sim', tipo: 'execucao' }).includes(AVISO_CASO));
  // tipo desconhecido ou ausente: fica o rótulo do deck
  assert.ok(textos({ tipo: 'outro' }).includes('PROPOSTA COMERCIAL  ·  IMPLEMENTAÇÃO'));
  assert.equal(nomeDoTipo(null, []), '');
});

test('modelo de venda: +1 ao case do mesmo modelo, sem dispensar o sinal específico', () => {
  assert.equal(modeloDoCatalogo('E-commerce de moda'), 'e-commerce');
  assert.equal(modeloDoCatalogo('loja física / showroom'), 'pdv');
  assert.equal(modeloDoCatalogo('Inside Sales'), 'inside-sales');
  assert.equal(modeloDoCatalogo('recorrente'), null);
  assert.equal(modeloDoCatalogo(null), null);
  const casos = [
    { id: 'a', modelo: 'pdv', desafio: 'CRM e comercial com WhatsApp', segmento: 'x' },
    { id: 'b', modelo: 'inside-sales', desafio: 'CRM e comercial com WhatsApp', segmento: 'y' },
  ];
  const texto = 'Time comercial sem CRM, atendimento no WhatsApp';
  assert.equal(escolherCaso(texto, casos).caso.id, 'a', 'empate: o primeiro');
  assert.equal(escolherCaso(texto, casos, { modeloVenda: 'inside sales B2B' }).caso.id, 'b');
  assert.equal(escolherCaso(texto, casos, { modeloVenda: 'inside sales' }).nota, 4);
  // só genéricos + modelo: continua sem case
  const gen = [{ id: 'g', modelo: 'pdv', desafio: 'comercial lead conversão', segmento: '' }];
  assert.equal(escolherCaso('comercial lead conversão', gen, { modeloVenda: 'pdv' }), null);
});

test('entregável "Título curto: detalhe": título declarado e detalhe sem repetir', () => {
  assert.deepEqual(tituloDeclarado('01   CRM com WhatsApp: funis por origem, com etapas até o fechamento'), { titulo: 'CRM com WhatsApp', detalhe: 'funis por origem, com etapas até o fechamento' });
  assert.equal(tituloDeclarado('Funis personalizados no CRM (ex.: arquitetos e parceiros)'), null, 'dois-pontos dentro de parênteses');
  assert.equal(tituloDeclarado('Um título comprido demais com seis palavras: detalhe'), null, 'mais de 5 palavras');
  assert.equal(tituloDeclarado('Ex.: algo'), null, 'abreviação');
  assert.equal(tituloDeclarado('Sem dois-pontos aqui'), null);
  const a = analisarSlide(lista('h', 'PROPOSTA · IMPLEMENTAÇÃO', 'O QUE ENTREGAMOS', ['Landing page: página de captação com formulário', 'Relatório semanal por WhatsApp', 'Rastreamento GA4: eventos de formulário e clique']));
  const p = planoGradeEntregas(a, W, H);
  assert.deepEqual(p.titulos, ['Landing page', tituloCurto('Relatório semanal por WhatsApp'), 'Rastreamento GA4']);
  assert.deepEqual([p.origens[0], p.origens[2]], ['titulo', 'titulo']);
  assert.notEqual(p.origens[1], 'titulo');
  assert.equal(p.detalhes[0], 'página de captação com formulário');
  assert.equal(p.detalhes[1], 'Relatório semanal por WhatsApp');
});

test('capa nova leva a marca V4: arte à direita e "V4 COMPANY" em texto; logo após a institucional, sem a arte', () => {
  const capa = (o) => requestsVisualV2(deck(), { assets: ASSETS, prefixo: 'm', ...o }).requests;
  const temArte = (rs) => rs.some((r) => r.createImage?.objectId === 'm_vcapa_vf' && r.createImage.url === `${ASSETS}/marca/v1/v4-capa.png`);
  const temNome = (rs) => rs.some((r) => r.insertText?.objectId === 'm_vcapa_vw' && r.insertText.text === 'V4 COMPANY');
  for (const c of [undefined, 'substituir', 'antes']) assert.ok(temArte(capa({ capa: c })) && temNome(capa({ capa: c })), String(c));
  assert.ok(!temArte(capa({ capa: 'depois' })) && temNome(capa({ capa: 'depois' })));
  // plano B: sem a arte, o texto da marca fica
  const b = planoBV2(capa({}));
  assert.ok(!temArte(b) && temNome(b));
  // arte encostada à direita, na altura do slide; o nome do cliente não invade
  const img = capa({}).find((r) => r.createImage?.objectId === 'm_vcapa_vf').createImage.elementProperties;
  const nome = capa({}).find((r) => r.createShape?.objectId === 'm_vcapa_vn').createShape.elementProperties;
  const larg = (e) => e.size.width.magnitude * (e.transform.scaleX ?? 1);
  assert.ok(Math.abs(img.transform.translateX + larg(img) - W) < 2);
  assert.ok(nome.transform.translateX + larg(nome) <= img.transform.translateX);
});

test('números: entregas somam "(cont.)" e ignoram [PREENCHER]; textos sem inventar', () => {
  const d = deck();
  d.slides.splice(3, 0, lista('xA2', 'PROPOSTA · IMPLEMENTAÇÃO', 'O QUE ENTREGAMOS AGORA (CONT.)', ['Rastreamento', '[PREENCHER] entregáveis combinados']));
  const ns = numerosDoDeck(d.slides.map(analisarSlide).filter(Boolean));
  assert.equal(ns.find((n) => n.rotulo === 'ENTREGAS').valor, '5');
  assert.ok(!JSON.stringify(ns).includes('setup'));
});

test('título grande demais para a grade: fonte menor, nunca quebra', () => {
  const d = lista('g', 'PROPOSTA · X', 'T', ['Acompanhamento semanal', 'Implementação completa', 'Rastreamento total', 'Landing page', 'Google Ads', 'Funis no CRM']);
  const p = planoGradeEntregas(analisarSlide(d), W, H);
  assert.ok(p && [16, 14, 12].includes(p.tamTitulo));
  for (const t of p.titulos) assert.ok(t.length * p.tamTitulo * 0.5 <= p.cw / PT - 60, t);
});

test('aplicarVisualV2: falha de imagem repete sem imagens E sem fundos de imagem', async () => {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method !== 'POST') return { ok: true, status: 200, json: async () => deck() };
    const lote = JSON.parse(init.body).requests;
    posts.push(lote);
    return posts.length === 1
      ? { ok: false, status: 400, json: async () => ({ error: { message: 'There was a problem retrieving the image' } }) }
      : { ok: true, status: 200, json: async () => ({}) };
  };
  const r = await aplicarVisualV2({ token: 't', apresentacaoId: 'p', assets: ASSETS, fetchImpl, caso: 'sim' });
  assert.ok(JSON.stringify(posts[0]).includes('_vcase'));
  assert.equal(r.semIcones, true);
  assert.ok(!posts[1].some((q) => q.createImage || q.updatePageProperties?.pageProperties?.pageBackgroundFill?.stretchedPictureFill));
  for (const sid of posts[1].filter((q) => q.createSlide).map((q) => q.createSlide.objectId)) {
    assert.ok(posts[1].some((q) => q.updatePageProperties?.objectId === sid && q.updatePageProperties.pageProperties.pageBackgroundFill.solidFill), `sem fundo: ${sid}`);
  }
  assert.ok(!JSON.stringify(posts[1]).includes('_vcase'), 'case sai inteiro no plano B');
  assert.equal(assetsDoProjeto('https://abc.supabase.co/'), 'https://abc.supabase.co/storage/v1/object/public/propostas-visual');
});

test('título declarado que não cabe na grade: só aquele item volta ao fallback; a grade fica', () => {
  const itens = ['Landing page: página de portfólio', 'Rastreamento de ponta a ponta: UTMs, pixel e API de conversão', 'CRM: funis por origem',
    'Google Ads: campanha pronta para rodar', 'Funis: arquitetos e cliente final', 'Treinamento: time comercial no CRM'];
  const p = planoGradeEntregas(analisarSlide(lista('z', 'PROPOSTA · IMPLEMENTAÇÃO', 'T', itens)), W, H);
  assert.ok(p, 'grade');
  assert.equal(p.titulos[1], 'Rastreamento');
  assert.equal(p.detalhes[1], itens[1], 'fallback: detalhe completo');
  assert.equal(p.origens[1], 'icone');
  assert.equal(p.titulos[0], 'Landing page');
  assert.equal(p.detalhes[0], 'página de portfólio');
});

test('capa: nome longo do cliente diminui e cabe na caixa (não encosta no traço)', () => {
  const tam = (cliente) => requestsCapa({ sid: 's', indice: 0, W, H, assets: ASSETS, cliente, tipo: '', data: null })
    .find((r) => r.updateTextStyle?.objectId === 's_vn').updateTextStyle.style.fontSize.magnitude;
  assert.equal(tam('Authoral Ambientes Planejados'), 48);
  assert.equal(tam('Acme'), 58);
  assert.ok(tam('Indústria e Comércio de Móveis Planejados Exemplo Ltda') <= 34);
});

test('bônus de modelo nunca é o 3º sinal (sondas do Vedor)', () => {
  assert.equal(escolherCaso('Vendas na loja e conversão baixa', CASOS.casos, { modeloVenda: 'pdv' }), null);
  assert.equal(escolherCaso('Landing page com conversão baixa', CASOS.casos, { modeloVenda: 'e-commerce' }), null);
});

test('capa: kicker longo não invade o nome, em 16:9 e em 4:3', () => {
  for (const [w, h] of [[W, H], [9144000, 6858000]]) {
    const rs = requestsCapa({ sid: 's', indice: 0, W: w, H: h, assets: ASSETS, cliente: 'Acme', tipo: 'Implementação e Execução', data: null });
    const caixaDe = (id) => rs.find((r) => r.createShape?.objectId === id).createShape.elementProperties;
    const k = caixaDe('s_vk'); const n = caixaDe('s_vn');
    assert.ok(k.transform.translateY + k.size.height.magnitude * (k.transform.scaleY ?? 1) <= n.transform.translateY + 1, `${w}x${h}`);
    assert.ok(rs.some((r) => r.updateShapeProperties?.objectId === 's_vk' && r.updateShapeProperties.shapeProperties.contentAlignment === 'BOTTOM'));
    const tamK = rs.find((r) => r.updateTextStyle?.objectId === 's_vk').updateTextStyle.style.fontSize.magnitude;
    assert.ok(tamK <= 10, `${w}x${h}: ${tamK}`);
  }
});

test('empate de nota entre cases qualificados: vence o do modelo do deal (sonda do Vedor)', () => {
  const casos = [
    { id: 'p', modelo: 'pdv', desafio: 'CRM comercial leads conversão google', segmento: '' },
    { id: 'i', modelo: 'inside-sales', desafio: 'CRM comercial leads google', segmento: '' },
  ];
  const r = escolherCaso('crm comercial leads conversão google', casos, { modeloVenda: 'inside sales' });
  assert.equal(r.caso.id, 'i');
  assert.equal(escolherCaso('crm comercial leads conversão google', casos).caso.id, 'p');
});
