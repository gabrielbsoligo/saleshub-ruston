// =============================================================
// Gerador de Propostas — camada visual v2 ("nota 9")
// =============================================================
// Mesma entrada da v1 (deck já gerado, reconhecido pelos sufixos _r/_t/_c/_i/_p/_f),
// mas REDIAGRAMA em vez de só enfeitar, no padrão do deck EE 2026:
//  - fundo vinho com brilho vermelho (PNG) em todo slide gerado, alternando;
//  - cartões de vidro (branco translúcido + borda vermelha fina);
//  - "O que entregamos": grade de cartões com ícone, título curto e detalhe;
//  - Diagnóstico/Contexto: grade de cartões com a 1ª oração em destaque;
//  - Próximos passos: passos numerados na horizontal + selo da validade;
//  - slides novos: capa do cliente, "como fica na prática" (mockups em shapes),
//    case V4 do mesmo tipo de problema (casos-v0.json, fonte oficial),
//    "a proposta em números" (só números que já estão no deck).
// Mantém da v1: ícones nas linhas de investimento, barras tabela × condição,
// pílulas Etapa 1/2, gráfico de mídia e linha do tempo.
//
// Regras: nada inventado (título curto = nome do ícone; números = os do deck;
// case = catálogo oficial); tudo shape/texto/imagem nativa, editável; se um
// layout não couber, o slide cai no layout de lista da v1. Idempotente (_v…).
// =============================================================

import { ESTILO, formatarBRL, linhasDoTexto } from './slides.mjs';
import {
  ICONES, analisarSlide, iconePara, normalizar, urlIcone, valorBRL,
  dadosComparativo, requestsComparativo, requestsIconesLinhas, requestsIconesCartoes, requestsEtapas,
  dadosMidia, dadosAssessoria, larguraComPainel, requestsMidia, requestsSlideMidia, marcosDoDeck, requestsLinhaDoTempo,
  primitivas as P, aplicarVisual,
} from './visual.mjs';
import CASOS from './casos-v0.json' with { type: 'json' };

const { PT, pt, cor, forma, aparencia, texto, caixa, cabecalho, props } = P;
const BRANCO_SUAVE = cor('#E9DCDA');
const ETAPA2 = /etapa 2|proxima etapa/;

export const VERSAO_ASSETS = 'v1';
// Raiz pública dos assets (bucket propostas-visual): icones/, fundos/, casos/.
export const assetsDoProjeto = (supabaseUrl) => `${String(supabaseUrl).replace(/\/+$/, '')}/storage/v1/object/public/propostas-visual`;
const urlFundo = (assets, nome) => `${assets}/fundos/${VERSAO_ASSETS}/fundo-${nome}.png`;
const urlCaso = (assets, arquivo) => `${assets}/casos/${VERSAO_ASSETS}/${arquivo}`;

// ---------- peças ----------
const fundo = (pagina, url) => ({
  updatePageProperties: {
    objectId: pagina,
    pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: url } } },
    fields: 'pageBackgroundFill.stretchedPictureFill.contentUrl',
  },
});
const vidro = (id, forte = false) => aparencia(id, { fundo: ESTILO.branco, alfa: forte ? 0.1 : 0.055, contorno: ESTILO.vermelhoClaro, alfaContorno: 0.5, espessura: 0.75 });
const imagemRet = (id, pagina, url, x, y, w, h) => ({ createImage: { objectId: id, url, elementProperties: props(pagina, x, y, w, h) } });
const ico = (id, pagina, assets, chave, x, y, s, variante = 'amarelo') => ({ createImage: { objectId: id, url: urlIcone(`${assets}/icones/${VERSAO_ASSETS}`, chave, variante), elementProperties: props(pagina, x, y, s, s) } });
const semNumero = (t) => String(t).replace(/^\s*\d+\s+/, '');
const destaque = (id, ini, fim, rgb = ESTILO.branco) => ({
  updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: ini, endIndex: fim }, style: { bold: true, foregroundColor: { opaqueColor: { rgbColor: rgb } } }, fields: 'bold,foregroundColor' },
});
const espacoLinhas = (id, pct = 115) => ({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { lineSpacing: pct }, fields: 'lineSpacing' } });

// Cabe? IBM Plex ~0,5 em por caractere; altura de linha 1,25.
export function cabe(textoAlvo, larguraPt, alturaPt, fonte) {
  const porLinha = Math.max(1, Math.floor(larguraPt / (fonte * 0.56)));
  return linhasDoTexto(textoAlvo, porLinha) * fonte * 1.25 <= alturaPt;
}
const fonteQueCabe = (textos, w, h, fontes = [11, 10, 9]) => fontes.find((f) => textos.every((t) => cabe(t, w, h, f))) ?? null;

// Título curto do entregável: o nome do ícone (já é do catálogo), nunca texto novo.
export function tituloCurto(t) {
  const i = ICONES.find((x) => x.chave === iconePara(t));
  if (i?.nome && i.chave !== 'padrao') return i.nome.charAt(0).toUpperCase() + i.nome.slice(1);
  const corte = semNumero(t).split(/[:;,(]/)[0].trim();
  return corte.split(/\s+/).slice(0, 4).join(' ');
}

// 1ª oração (até ":", ";", "," ou " (") para o negrito, se for curta.
export function primeiraOracao(t) {
  const m = semNumero(t).match(/^(.{4,60}?)(?=[:;,]\s|\s\()/);
  return m ? m[1] : null;
}

const geo = (W, H) => ({ m: Math.round(W * 0.055), topo: Math.round(H * 0.33), base: Math.round(H * 0.89) });

// "O que entregamos": grade 2 ou 3 colunas. null se não couber (fica a lista da v1).
export function planoGradeEntregas(a, W, H) {
  const n = a.cartoes.length;
  if (n < 2 || n > 6) return null;
  const { m, topo, base } = geo(W, H);
  const cols = n === 2 || n === 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const gap = pt(12);
  const cw = (W - 2 * m - gap * (cols - 1)) / cols;
  const ch = (base - topo - gap * (rows - 1)) / rows;
  const detalhes = a.cartoes.map((c) => semNumero(c.texto));
  const fonte = fonteQueCabe(detalhes, cw / PT - 24, ch / PT - 58, [11, 10, 9]);
  if (!fonte) return null;
  return { cols, rows, gap, cw, ch, fonte, detalhes };
}

export function requestsGradeEntregas(a, plano, W, H, assets) {
  const { m, topo } = geo(W, H);
  const reqs = [];
  a.cartoes.forEach((c, i) => {
    const x = m + (i % plano.cols) * (plano.cw + plano.gap);
    const y = topo + Math.floor(i / plano.cols) * (plano.ch + plano.gap);
    const id = `${a.sid}_vg${i}`;
    const chave = iconePara(c.texto);
    reqs.push(
      forma(`${id}c`, a.sid, 'ROUND_RECTANGLE', x, y, plano.cw, plano.ch), vidro(`${id}c`),
      forma(`${id}o`, a.sid, 'ELLIPSE', x + pt(12), y + pt(12), pt(34), pt(34)),
      aparencia(`${id}o`, { fundo: ESTILO.vermelhoClaro, alfa: 0.22 }),
      ico(`${id}i`, a.sid, assets, chave, x + pt(19), y + pt(19), pt(20)),
      ...caixa(`${id}t`, a.sid, x + pt(52), y + pt(12), plano.cw - pt(60), pt(34), tituloCurto(c.texto), { fonte: ESTILO.fonteTitulo, tamanho: 16 }),
      ...caixa(`${id}d`, a.sid, x + pt(6), y + pt(52), plano.cw - pt(12), plano.ch - pt(56), plano.detalhes[i], { rgb: BRANCO_SUAVE, tamanho: plano.fonte }),
      { updateShapeProperties: { objectId: `${id}d`, shapeProperties: { contentAlignment: 'TOP' }, fields: 'contentAlignment' } },
      { deleteObject: { objectId: c.id } },
    );
  });
  return reqs;
}

// Diagnóstico/Contexto: grade de até 4 colunas, 1ª oração em negrito branco.
export function planoGradeDiagnostico(a, W, H) {
  const n = a.cartoes.length;
  if (n < 2 || n > 8) return null;
  const { m, topo, base } = geo(W, H);
  const cols = n <= 4 ? n : Math.ceil(n / 2);
  const rows = Math.ceil(n / cols);
  const gap = pt(10);
  const cw = (W - 2 * m - gap * (cols - 1)) / cols;
  const ch = (base - topo - gap * (rows - 1)) / rows;
  const textos = a.cartoes.map((c) => semNumero(c.texto));
  const fonte = fonteQueCabe(textos, cw / PT - 16, ch / PT - 38, [11, 10, 9.5, 9]);
  if (!fonte) return null;
  return { cols, rows, gap, cw, ch, fonte, textos };
}

export function requestsGradeDiagnostico(a, plano, W, H, assets) {
  const { m, topo } = geo(W, H);
  const reqs = [];
  a.cartoes.forEach((c, i) => {
    const x = m + (i % plano.cols) * (plano.cw + plano.gap);
    const y = topo + Math.floor(i / plano.cols) * (plano.ch + plano.gap);
    const id = `${a.sid}_vg${i}`;
    const t = plano.textos[i];
    const forte = primeiraOracao(t);
    reqs.push(
      forma(`${id}c`, a.sid, 'ROUND_RECTANGLE', x, y, plano.cw, plano.ch), vidro(`${id}c`),
      ico(`${id}i`, a.sid, assets, iconePara(c.texto), x + pt(10), y + pt(10), pt(20)),
      forma(`${id}b`, a.sid, 'RECTANGLE', x + plano.cw - pt(26), y + pt(16), pt(14), pt(2)),
      aparencia(`${id}b`, { fundo: ESTILO.vermelhoClaro }),
      ...caixa(`${id}d`, a.sid, x + pt(4), y + pt(34), plano.cw - pt(8), plano.ch - pt(38), t, { rgb: ESTILO.cinza, tamanho: plano.fonte }),
      { updateShapeProperties: { objectId: `${id}d`, shapeProperties: { contentAlignment: 'TOP' }, fields: 'contentAlignment' } },
      espacoLinhas(`${id}d`),
    );
    if (forte) reqs.push(destaque(`${id}d`, 0, forte.length));
    reqs.push({ deleteObject: { objectId: c.id } });
  });
  return reqs;
}

// Próximos passos: passos numerados na horizontal + selo com a validade (se escrita).
export function validadeDoTexto(t) {
  const m = normalizar(t).match(/(?:valid[ao]|vale|fechamento)[^\n]*?ate\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
  return m ? m[1] : null;
}

// Altura do texto de cada passo: termina antes do selo da validade (0,79 H).
const ALTURA_PASSO = 98;

export function planoPassos(a, W, H) {
  const n = a.cartoes.length;
  if (n < 2 || n > 5) return null;
  const { m } = geo(W, H);
  const colW = (W - 2 * m) / n;
  const textos = a.cartoes.map((c) => semNumero(c.texto));
  const fonte = fonteQueCabe(textos, colW / PT - 24, ALTURA_PASSO, [11, 10, 9]);
  if (!fonte) return null;
  return { n, colW, fonte, textos, validade: textos.map(validadeDoTexto).find(Boolean) || null };
}

export function requestsPassos(a, plano, W, H) {
  const { m } = geo(W, H);
  const yL = Math.round(H * 0.43);
  const d = pt(38);
  const reqs = [
    forma(`${a.sid}_vpl`, a.sid, 'RECTANGLE', m + plano.colW / 2, yL - pt(1), plano.colW * (plano.n - 1), pt(2)),
    aparencia(`${a.sid}_vpl`, { fundo: ESTILO.vermelhoClaro, alfa: 0.6 }),
  ];
  plano.textos.forEach((t, i) => {
    const cx = m + plano.colW * (i + 0.5);
    const id = `${a.sid}_vp${i}`;
    reqs.push(
      forma(`${id}n`, a.sid, 'ELLIPSE', cx - d / 2, yL - d / 2, d, d),
      aparencia(`${id}n`, i === plano.n - 1 ? { fundo: ESTILO.amarelo } : { fundo: ESTILO.fundo, contorno: ESTILO.vermelhoClaro, espessura: 1.5 }),
      ...texto(`${id}n`, String(i + 1), { rgb: i === plano.n - 1 ? ESTILO.fundo : ESTILO.branco, fonte: ESTILO.fonteTitulo, tamanho: 16, alinhar: 'CENTER' }),
      ...caixa(`${id}t`, a.sid, cx - plano.colW / 2 + pt(6), yL + d / 2 + pt(8), plano.colW - pt(12), pt(ALTURA_PASSO), t, { tamanho: plano.fonte, alinhar: 'CENTER' }),
      { updateShapeProperties: { objectId: `${id}t`, shapeProperties: { contentAlignment: 'TOP' }, fields: 'contentAlignment' } },
      { deleteObject: { objectId: a.cartoes[i].id } },
    );
  });
  if (plano.validade) {
    const sw = pt(250);
    reqs.push(
      forma(`${a.sid}_vpv`, a.sid, 'ROUND_RECTANGLE', W - m - sw, Math.round(H * 0.79), sw, pt(30)),
      aparencia(`${a.sid}_vpv`, { fundo: ESTILO.amarelo }),
      ...texto(`${a.sid}_vpv`, `CONDIÇÃO VÁLIDA ATÉ ${plano.validade}`, { rgb: ESTILO.fundo, fonte: ESTILO.fonteTitulo, tamanho: 15, alinhar: 'CENTER' }),
    );
  }
  return reqs;
}

// Cartões de lista que ficam (ex.: Etapa 2): viram vidro, com ícone no lugar do número.
const requestsListaVidro = (a, assets) => [
  ...a.cartoes.map((c) => vidro(c.id)),
  ...requestsIconesCartoes(a, `${assets}/icones/${VERSAO_ASSETS}`),
];

// ---------- slides novos ----------
const clienteDoDeck = (analisados) => {
  const f = analisados.find((a) => a.rodape)?.rodape.texto || '';
  const nome = f.split('·').slice(1).join('·').trim();
  return nome || null;
};
const tipoDoDeck = (analisados) => {
  const p = analisados.find((a) => /^proposta/.test(normalizar(a.rotulo)));
  return p ? p.rotulo.split('·').slice(1).join('·').trim() : '';
};

export function requestsCapa({ sid, indice, W, H, assets, cliente, tipo, data }) {
  const { m } = geo(W, H);
  const nome = cliente.toUpperCase();
  const tam = nome.length > 26 ? 40 : nome.length > 16 ? 48 : 58;
  return [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    fundo(sid, urlFundo(assets, 'capa')),
    ...caixa(`${sid}_vk`, sid, m, Math.round(H * 0.2), W * 0.7, pt(22), `PROPOSTA COMERCIAL${tipo ? `  ·  ${tipo.toUpperCase()}` : ''}`, { rgb: ESTILO.amarelo, tamanho: 11, negrito: true }),
    ...caixa(`${sid}_vn`, sid, m, Math.round(H * 0.27), W * 0.78, Math.round(H * 0.42), nome, { fonte: ESTILO.fonteTitulo, tamanho: tam }),
    { updateShapeProperties: { objectId: `${sid}_vn`, shapeProperties: { contentAlignment: 'TOP' }, fields: 'contentAlignment' } },
    { updateParagraphStyle: { objectId: `${sid}_vn`, textRange: { type: 'ALL' }, style: { lineSpacing: 90 }, fields: 'lineSpacing' } },
    forma(`${sid}_vl`, sid, 'RECTANGLE', m, Math.round(H * 0.72), pt(64), pt(3)),
    aparencia(`${sid}_vl`, { fundo: ESTILO.vermelhoClaro }),
    ...caixa(`${sid}_vs`, sid, m, Math.round(H * 0.75), W * 0.7, pt(22), `Preparada pela V4 Company${data ? `  ·  ${data}` : ''}`, { rgb: BRANCO_SUAVE, tamanho: 12 }),
    ...caixa(`${sid}_vm`, sid, m, Math.round(H * 0.9), W - 2 * m, pt(18), 'NOSSO NEGÓCIO É VENDER O SEU', { rgb: ESTILO.cinza, tamanho: 9, negrito: true }),
  ];
}

// Números que JÁ estão no deck: valor (_p2) e desconto (_p1), prazo, nº de entregas, validade (_p0).
export function numerosDoDeck(analisados) {
  const inv = analisados.find((a) => a.p?.p2);
  const entregas = analisados.find((a) => /^proposta/.test(normalizar(a.rotulo)) && a.cartoes.length);
  const tudo = analisados.flatMap((a) => a.cartoes.map((c) => c.texto)).join('\n');
  const prazo = tudo.match(/prazo[^:\n]*:\s*(\d+)\s*dias/i);
  const acomp = tudo.match(/(\d+)\s*dias\s+de\s+acompanhamento/i);
  const val = inv?.p.p0 && normalizar(inv.p.p0.texto).match(/ate\s+(\d{1,2}\/\d{1,2})/);
  // Em ordem de prioridade; ficam os 4 primeiros que existirem.
  return [
    inv?.p.p2 && valorBRL(inv.p.p2.texto) != null
      && { rotulo: 'INVESTIMENTO', valor: inv.p.p2.texto.trim(), sub: (inv.p.p1?.texto || inv.p.p3?.texto || '').trim().toLowerCase() },
    prazo && { rotulo: 'PRAZO', valor: `${prazo[1]} dias`, sub: 'de implementação' },
    entregas && { rotulo: 'ENTREGAS', valor: String(entregas.cartoes.length), sub: 'nesta etapa' },
    val && { rotulo: 'CONDIÇÃO', valor: `até ${val[1]}`, sub: 'para fechamento' },
    acomp && { rotulo: 'ACOMPANHAMENTO', valor: `${acomp[1]} dias`, sub: 'depois do setup' },
  ].filter(Boolean).slice(0, 4);
}

export function requestsNumeros(tiles, { sid, indice, W, H, assets, rotulo, rodape }) {
  const { m } = geo(W, H);
  const n = tiles.length;
  const gap = pt(12);
  const tw = (W - 2 * m - gap * (n - 1)) / n;
  const y = Math.round(H * 0.38);
  const th = pt(150);
  const reqs = [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...cabecalho(sid, W, H, rotulo, 'A proposta em números'),
    fundo(sid, urlFundo(assets, 'destaque')),
  ];
  tiles.forEach((t, i) => {
    const x = m + i * (tw + gap);
    const id = `${sid}_vn${i}`;
    reqs.push(
      forma(`${id}c`, sid, 'ROUND_RECTANGLE', x, y, tw, th), vidro(`${id}c`, true),
      ...caixa(`${id}r`, sid, x + pt(12), y + pt(14), tw - pt(24), pt(18), t.rotulo, { rgb: ESTILO.vermelhoClaro, tamanho: 9, negrito: true }),
      ...caixa(`${id}v`, sid, x + pt(8), y + pt(40), tw - pt(16), pt(56), t.valor, { rgb: ESTILO.amarelo, fonte: ESTILO.fonteTitulo, tamanho: Math.max(20, Math.min(38, Math.floor((tw / PT - 16) / (0.5 * t.valor.length)))) }),
      ...caixa(`${id}s`, sid, x + pt(12), y + pt(102), tw - pt(24), pt(36), t.sub, { rgb: BRANCO_SUAVE, tamanho: 11 }),
      { updateShapeProperties: { objectId: `${id}s`, shapeProperties: { contentAlignment: 'TOP' }, fields: 'contentAlignment' } },
    );
  });
  reqs.push(...caixa(`${sid}_f`, sid, m, Math.round(H * 0.91), W - 2 * m, Math.round(H * 0.06), rodape, { rgb: ESTILO.cinza, tamanho: ESTILO.tamanhoRodape, negrito: true }));
  return reqs;
}

// Case do catálogo oficial com mais afinidade com o problema escrito no deck.
const SINAIS = ['crm', 'comercial', 'lead', 'google', 'landing', 'convers|convert', 'rastre|ga4', 'tiktok', 'b2b', 'loja|showroom', 'whatsapp', 'e-?commerce|checkout'];
export function escolherCaso(textoDeck, casos = CASOS.casos) {
  const t = normalizar(textoDeck);
  let melhor = null;
  for (const c of casos) {
    const d = normalizar(`${c.desafio} ${c.segmento}`);
    const nota = SINAIS.filter((s) => new RegExp(s).test(t) && new RegExp(s).test(d)).length;
    if (!melhor || nota > melhor.nota) melhor = { caso: c, nota };
  }
  return melhor && melhor.nota >= 2 ? melhor : null;
}

// Largura da foto com a altura do slide (proporção do arquivo); nunca menor que a coluna.
const fotoLargura = (caso, H, minimo) => Math.max(minimo, Math.round(H * ((caso.largura || 3) / (caso.altura || 2))));
const primeiraFrase = (t) => (String(t).match(/^.*?[.!?](\s|$)/)?.[0] || String(t)).trim();

export function requestsCaso(caso, { sid, indice, W, H, assets, rodape }) {
  const { m } = geo(W, H);
  const fotoW = Math.round(W * 0.4);
  const x = fotoW + pt(28);
  const w = W - m - x;
  const nums = caso.numeros.filter((n) => n.depois).slice(0, 3);
  const reqs = [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    fundo(sid, urlFundo(assets, 'b')),
    imagemRet(`${sid}_vf`, sid, urlCaso(assets, caso.imagem), fotoW - fotoLargura(caso, H, fotoW), 0, fotoLargura(caso, H, fotoW), H),
    forma(`${sid}_vfx`, sid, 'RECTANGLE', fotoW - pt(4), 0, pt(4), H), aparencia(`${sid}_vfx`, { fundo: ESTILO.vermelhoClaro }),
    ...caixa(`${sid}_r`, sid, x, Math.round(H * 0.07), w, pt(20), 'QUEM JÁ FEZ ESSE CAMINHO COM A V4', { rgb: ESTILO.vermelhoClaro, tamanho: 10, negrito: true }),
    ...caixa(`${sid}_t`, sid, x, Math.round(H * 0.12), w, pt(42), caso.nome.toUpperCase(), { fonte: ESTILO.fonteTitulo, tamanho: 28 }),
    ...caixa(`${sid}_vs`, sid, x, Math.round(H * 0.235), w, pt(18), caso.segmento, { rgb: ESTILO.amarelo, tamanho: 10, negrito: true }),
    ...caixa(`${sid}_vd`, sid, x, Math.round(H * 0.29), w, pt(64), primeiraFrase(caso.desafio), { rgb: BRANCO_SUAVE, tamanho: 10.5 }),
    { updateShapeProperties: { objectId: `${sid}_vd`, shapeProperties: { contentAlignment: 'TOP' }, fields: 'contentAlignment' } },
  ];
  const gap = pt(8);
  const nw = (w - gap * (nums.length - 1)) / Math.max(1, nums.length);
  const ny = Math.round(H * 0.5);
  nums.forEach((n, i) => {
    const nx = x + i * (nw + gap);
    const id = `${sid}_vk${i}`;
    reqs.push(
      forma(`${id}c`, sid, 'ROUND_RECTANGLE', nx, ny, nw, pt(92)), vidro(`${id}c`, true),
      ...caixa(`${id}r`, sid, nx + pt(6), ny + pt(6), nw - pt(12), pt(16), n.rotulo.toUpperCase(), { rgb: ESTILO.cinza, tamanho: 8, negrito: true }),
      ...caixa(`${id}a`, sid, nx + pt(6), ny + pt(22), nw - pt(12), pt(16), n.antes ? `antes ${n.antes}` : ' ', { rgb: ESTILO.cinza, tamanho: 9 }),
      ...caixa(`${id}d`, sid, nx + pt(4), ny + pt(40), nw - pt(8), pt(40), n.depois, { rgb: ESTILO.amarelo, fonte: ESTILO.fonteTitulo, tamanho: n.depois.length > 7 ? 20 : 26 }),
    );
  });
  reqs.push(
    ...caixa(`${sid}_vq`, sid, x, Math.round(H * 0.77), w, pt(36), `“${caso.frase}”`, { tamanho: 11, negrito: true }),
    ...caixa(`${sid}_f`, sid, x, Math.round(H * 0.91), w, Math.round(H * 0.06), 'CASE V4  ·  FONTE: PÁGINA OFICIAL ESTRUTURAÇÃO ESTRATÉGICA 2026', { rgb: ESTILO.cinza, tamanho: 8, negrito: true }),
  );
  return reqs;
}

// "Como fica na prática": wireframes em shapes (sem texto inventado) das entregas que têm forma visível.
const MOCKUPS = [
  { chave: 'landing', desenho: 'navegador' },
  { chave: 'whatsapp', desenho: 'celular' },
  { chave: 'funil', desenho: 'quadro' },
  { chave: 'crm', desenho: 'quadro' },
  { chave: 'google_ads', desenho: 'busca' },
];
export function mockupsDoDeck(a) {
  const chaves = a.cartoes.map((c) => iconePara(c.texto));
  const vistos = new Set();
  return MOCKUPS.filter((mk) => chaves.includes(mk.chave) && !vistos.has(mk.desenho) && vistos.add(mk.desenho))
    .slice(0, 3).map((mk) => ({ ...mk, nome: tituloCurto(a.cartoes[chaves.indexOf(mk.chave)].texto) }));
}

function desenho(tipo, id, pg, x, y, w, h) {
  const r = [];
  const ret = (k, xx, yy, ww, hh, rgb, alfa = 1, tipoF = 'ROUND_RECTANGLE') => { r.push(forma(`${id}${k}`, pg, tipoF, xx, yy, ww, hh), aparencia(`${id}${k}`, { fundo: rgb, alfa })); };
  const cinza = cor('#5A3A36');
  if (tipo === 'navegador') {
    ret('a', x, y, w, h, cor('#1A0505'));
    r.push(aparencia(`${id}a`, { fundo: cor('#1A0505'), contorno: ESTILO.vermelhoClaro, alfaContorno: 0.6, espessura: 1 }));
    ret('b', x, y, w, pt(14), cor('#3A1410'), 1, 'RECTANGLE');
    [0, 1, 2].forEach((i) => ret(`p${i}`, x + pt(6 + i * 9), y + pt(4), pt(6), pt(6), [ESTILO.vermelhoClaro, ESTILO.amarelo, ESTILO.cinza][i], 1, 'ELLIPSE'));
    ret('h', x + pt(10), y + pt(24), w * 0.55, pt(12), ESTILO.branco, 0.85);
    ret('i', x + pt(10), y + pt(42), w * 0.42, pt(6), cinza);
    ret('j', x + pt(10), y + pt(52), w * 0.36, pt(6), cinza);
    ret('k', x + pt(10), y + pt(66), pt(56), pt(14), ESTILO.vermelhoClaro);
    [0, 1, 2].forEach((i) => ret(`g${i}`, x + pt(10) + i * ((w - pt(20)) / 3), y + h - pt(52), (w - pt(20)) / 3 - pt(6), pt(42), ESTILO.branco, 0.12));
    ret('m', x + w * 0.62, y + pt(24), w * 0.32, pt(50), ESTILO.vermelhoClaro, 0.35);
  } else if (tipo === 'celular') {
    const cw = Math.min(w * 0.55, h * 0.52);
    const cx = x + (w - cw) / 2;
    r.push(forma(`${id}a`, pg, 'ROUND_RECTANGLE', cx, y, cw, h), aparencia(`${id}a`, { fundo: cor('#1A0505'), contorno: ESTILO.vermelhoClaro, alfaContorno: 0.6, espessura: 1.5 }));
    ret('b', cx, y + pt(8), cw, pt(16), cor('#3A1410'), 1, 'RECTANGLE');
    ret('c', cx + pt(6), y + pt(11), pt(10), pt(10), ESTILO.amarelo, 1, 'ELLIPSE');
    const bolhas = [[0, 0.62, 0.2], [1, 0.5, 0.9], [0, 0.7, 0.2], [1, 0.45, 0.9], [0, 0.55, 0.2]];
    bolhas.forEach(([lado, larg, alfa], i) => {
      const bw = (cw - pt(16)) * larg;
      ret(`m${i}`, lado ? cx + cw - pt(8) - bw : cx + pt(8), y + pt(32 + i * 24), bw, pt(16), lado ? ESTILO.vermelhoClaro : ESTILO.branco, lado ? alfa : 0.18);
    });
  } else if (tipo === 'quadro') {
    ret('a', x, y, w, h, cor('#1A0505'));
    r.push(aparencia(`${id}a`, { fundo: cor('#1A0505'), contorno: ESTILO.vermelhoClaro, alfaContorno: 0.6, espessura: 1 }));
    const col = (w - pt(24)) / 3;
    [3, 2, 1].forEach((qtd, c) => {
      const cx = x + pt(6) + c * (col + pt(6));
      ret(`h${c}`, cx, y + pt(8), col, pt(8), [ESTILO.cinza, ESTILO.vermelhoClaro, ESTILO.amarelo][c], 0.9);
      for (let k = 0; k < qtd; k++) ret(`c${c}${k}`, cx, y + pt(22 + k * 30), col, pt(24), ESTILO.branco, 0.12);
    });
  } else if (tipo === 'busca') {
    ret('a', x, y, w, h, cor('#1A0505'));
    r.push(aparencia(`${id}a`, { fundo: cor('#1A0505'), contorno: ESTILO.vermelhoClaro, alfaContorno: 0.6, espessura: 1 }));
    ret('s', x + pt(10), y + pt(12), w - pt(20), pt(16), ESTILO.branco, 0.85);
    [0, 1, 2].forEach((i) => {
      ret(`t${i}`, x + pt(10), y + pt(40 + i * 34), w * (i ? 0.5 : 0.6), pt(7), i ? cinza : ESTILO.amarelo);
      ret(`u${i}`, x + pt(10), y + pt(51 + i * 34), w * 0.75, pt(5), cinza);
    });
  }
  return r;
}

export function requestsMockups(itens, { sid, indice, W, H, assets, rotulo, rodape }) {
  const { m } = geo(W, H);
  const n = itens.length;
  const gap = pt(22);
  const w = (W - 2 * m - gap * (n - 1)) / n;
  const y = Math.round(H * 0.34);
  const h = pt(170);
  const reqs = [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...cabecalho(sid, W, H, rotulo, 'Como fica na prática'),
    fundo(sid, urlFundo(assets, 'a')),
  ];
  itens.forEach((it, i) => {
    const x = m + i * (w + gap);
    reqs.push(...desenho(it.desenho, `${sid}_vw${i}`, sid, x, y, w, h));
    reqs.push(
      ico(`${sid}_vx${i}i`, sid, assets, it.chave, x, y + h + pt(12), pt(18)),
      ...caixa(`${sid}_vx${i}t`, sid, x + pt(22), y + h + pt(8), w - pt(22), pt(26), it.nome, { fonte: ESTILO.fonteTitulo, tamanho: 15 }),
    );
  });
  reqs.push(
    ...caixa(`${sid}_vwn`, sid, m, Math.round(H * 0.86), W - 2 * m, pt(16), 'Ilustração do formato das entregas; o conteúdo real é construído com a sua empresa.', { rgb: ESTILO.cinza, tamanho: 8 }),
    ...caixa(`${sid}_f`, sid, m, Math.round(H * 0.91), W - 2 * m, Math.round(H * 0.06), rodape, { rgb: ESTILO.cinza, tamanho: ESTILO.tamanhoRodape, negrito: true }),
  );
  return reqs;
}

// ---------- orquestração ----------
export function requestsVisualV2(apresentacao, { assets, prefixo = `vz${Math.random().toString(36).slice(2, 8)}`, data = null, casos = CASOS.casos } = {}) {
  if (!assets) throw new Error('raiz dos assets ausente');
  const base = `${assets}/icones/${VERSAO_ASSETS}`;
  const W = apresentacao.pageSize?.width?.magnitude ?? 9144000;
  const H = apresentacao.pageSize?.height?.magnitude ?? 5143500;
  const slides = apresentacao.slides || [];
  const analisados = slides.map(analisarSlide).filter(Boolean);
  const temEtapa2 = analisados.some((a) => ETAPA2.test(normalizar(a.rotulo)));
  const existe = (suf) => slides.some((s) => s.objectId.endsWith(suf));
  const indiceDe = (sid) => slides.findIndex((s) => s.objectId === sid);
  const rodape = analisados.find((a) => a.rodape)?.rodape.texto || 'V4 COMPANY';
  const reqs = [];
  const resumo = [];
  const novos = [];

  analisados.filter((a) => !a.jaVisual).forEach((a, k) => {
    const feito = [];
    const r = normalizar(a.rotulo);
    const t = normalizar(a.titulo);
    reqs.push(fundo(a.sid, urlFundo(assets, k % 2 ? 'b' : 'a')));
    if (temEtapa2 && (ETAPA2.test(r) || /^proposta/.test(r))) { reqs.push(...requestsEtapas(a, W, ETAPA2.test(r) ? 2 : 1)); feito.push('etapas'); }

    let layout = null;
    if (/^proposta/.test(r)) { const p = planoGradeEntregas(a, W, H); if (p) { reqs.push(...requestsGradeEntregas(a, p, W, H, assets)); layout = 'grade_entregas'; } }
    else if (/^(diagnostico|contexto)/.test(r)) { const p = planoGradeDiagnostico(a, W, H); if (p) { reqs.push(...requestsGradeDiagnostico(a, p, W, H, assets)); layout = 'grade_diagnostico'; } }
    else if (/^decisao/.test(r) || /proximos passos/.test(t)) { const p = planoPassos(a, W, H); if (p) { reqs.push(...requestsPassos(a, p, W, H)); layout = p.validade ? 'passos+validade' : 'passos'; } }

    const midia = dadosMidia(a);
    if (!layout && midia) {
      const novaW = larguraComPainel(a, W);
      if (novaW) { reqs.push(...requestsMidia(a, midia, W, novaW, base)); feito.push('grafico_midia'); }
      else if (!existe(`${a.sid}_vms`)) {
        const indice = indiceDe(a.sid) + 1;
        novos.push({ indice, requests: [...requestsSlideMidia(midia, { sid: `${a.sid}_vms`, indice, W, H, base, rotulo: a.rotulo, assessoria: dadosAssessoria(a), aproximado: a.cartoes.some((c) => /cerca de|aprox/i.test(c.texto)), rodape, grafismo: false }), fundo(`${a.sid}_vms`, urlFundo(assets, 'b'))] });
        feito.push('grafico_midia_slide_proprio');
      }
    }
    if (!layout && a.cartoes.length) { reqs.push(...requestsListaVidro(a, assets)); layout = 'lista_vidro'; }
    if (layout) feito.push(layout);
    if (a.linhas.length) {
      reqs.push(...a.linhas.map((l) => vidro(l.id)), ...requestsIconesLinhas(a, base));
      feito.push(`icones_linhas:${a.linhas.length}`);
    }
    const comp = dadosComparativo(a);
    if (comp) { reqs.push(...requestsComparativo(a, comp)); feito.push('comparativo_preco'); }
    resumo.push({ slide: a.sid, titulo: a.titulo, feito });
  });

  // Slides novos, na ordem em que entram no deck (empate no índice: ordem de registro).
  const cliente = clienteDoDeck(analisados);
  if (cliente && !existe('_vcapa')) {
    const indice = 0;
    novos.push({ indice, requests: requestsCapa({ sid: `${prefixo}_vcapa`, indice, W, H, assets, cliente, tipo: tipoDoDeck(analisados), data }) });
    resumo.push({ slide: `${prefixo}_vcapa`, titulo: cliente, feito: ['capa_cliente'] });
  }
  const entregas = analisados.find((a) => /^proposta/.test(normalizar(a.rotulo)) && a.cartoes.length);
  const inv = analisados.find((a) => a.p?.p2 || a.linhas.length);
  const depoisEntregas = entregas ? indiceDe(entregas.sid) + 1 : (inv ? indiceDe(inv.sid) : slides.length);
  const mk = entregas ? mockupsDoDeck(entregas) : [];
  if (mk.length >= 2 && !existe('_vmock')) {
    novos.push({ indice: depoisEntregas, requests: requestsMockups(mk, { sid: `${prefixo}_vmock`, indice: depoisEntregas, W, H, assets, rotulo: entregas.rotulo, rodape }) });
    resumo.push({ slide: `${prefixo}_vmock`, titulo: 'COMO FICA NA PRÁTICA', feito: [`mockups:${mk.length}`] });
  }
  const textoDeck = analisados.flatMap((a) => [a.titulo, ...a.cartoes.map((c) => c.texto)]).join('\n');
  const caso = escolherCaso(textoDeck, casos);
  if (caso && !existe('_vcase')) {
    novos.push({ indice: depoisEntregas, requests: requestsCaso(caso.caso, { sid: `${prefixo}_vcase`, indice: depoisEntregas, W, H, assets, rodape }) });
    resumo.push({ slide: `${prefixo}_vcase`, titulo: caso.caso.nome, feito: [`case:${caso.caso.id}:${caso.nota}`] });
  }
  const tiles = numerosDoDeck(analisados);
  if (tiles.length >= 3 && inv && !existe('_vnum')) {
    const indice = indiceDe(inv.sid);
    novos.push({ indice, requests: requestsNumeros(tiles, { sid: `${prefixo}_vnum`, indice, W, H, assets, rotulo: inv.rotulo, rodape }) });
    resumo.push({ slide: `${prefixo}_vnum`, titulo: 'A PROPOSTA EM NÚMEROS', feito: [`numeros:${tiles.length}`] });
  }
  const marcos = marcosDoDeck(analisados);
  if (marcos.length >= 3 && !existe('_vtl')) {
    const iProx = slides.findIndex((s) => { const a = analisarSlide(s); return a && /proximos passos/.test(normalizar(a.titulo)); });
    const indice = iProx >= 0 ? iProx : indiceDe(analisados[analisados.length - 1].sid) + 1;
    novos.push({ indice, requests: [...requestsLinhaDoTempo(marcos, { sid: `${prefixo}_vtl`, indice, W, H, base, rodape, grafismo: false }), fundo(`${prefixo}_vtl`, urlFundo(assets, 'a'))] });
    resumo.push({ slide: `${prefixo}_vtl`, titulo: 'COMO VAI SER', feito: [`linha_do_tempo:${marcos.length}`] });
  }
  const ordem = novos.map((n, i) => ({ ...n, i })).sort((x, y) => y.indice - x.indice || y.i - x.i);
  for (const n of ordem) reqs.push(...n.requests);
  return { requests: reqs, resumo };
}

// Aplica a v2 (mesma rede e mesmo plano B da v1: sem imagens se o Google não baixar alguma).
export const aplicarVisualV2 = ({ assets, data = null, ...resto }) =>
  aplicarVisual({ ...resto, planejar: (ap) => requestsVisualV2(ap, { assets, data }) });
