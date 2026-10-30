// =============================================================
// Gerador de Propostas — camada visual (ícones, grafismos, gráficos)
// =============================================================
// Passo DEPOIS da geração: lê a apresentação pronta e acrescenta, só
// com shapes nativas e imagens PNG (tudo editável pelo closer):
//  - ícone por item (cartões de lista e linhas de investimento);
//  - grafismo de fundo (anéis translúcidos) nos slides gerados;
//  - indicador "Etapa 1 → Etapa 2" quando o deck tem as duas etapas;
//  - comparativo tabela × condição (barras) no painel de investimento;
//  - divisão da verba de mídia Google × Meta (barra empilhada);
//  - slide "linha do tempo" (aceite → implementação → acompanhamento → etapa 2).
//
// Não depende de IDs de um gerador específico: reconhece os slides gerados
// pela convenção `<slideId>_<sufixo>` (r rótulo, t título, c<i> cartão,
// i<n>/i<n>a/i<n>b linha de investimento, p/p0..p4 painel), comum ao
// slides.mjs e ao deck curto. Gráfico só sai quando o dado está no texto
// do slide; sem dado, nada é inventado.
//
// Idempotente: tudo o que cria usa o sufixo `_v…`; slide que já tem `_v…`
// é pulado. Ícones: PNGs (Lucide, ISC) gerados por propostas/visual/
// gerar-icones.mjs e servidos do Storage do próprio projeto; o Slides
// copia a imagem na inserção, então o deck não depende do bucket depois.
// =============================================================

import { ESTILO, formatarBRL, linhasDoTexto } from './slides.mjs';
import { redigir } from './redigir.mjs';

const PT = 12700;
const pt = (n) => Math.round(n * PT);
const emu = (n) => ({ magnitude: Math.round(n), unit: 'EMU' });

export const VERSAO_ICONES = 'v1';
export const BUCKET_ICONES = 'propostas-visual';
export const VARIANTES_ICONE = { amarelo: '#FFD60A', vinho: '#280000', branco: '#FFFFFF' };

// Ícone por palavra-chave. A ORDEM importa: a primeira regra que casa vence
// (ex.: "Setup Google Ads + rastreamento" é Google, não rastreamento).
export const ICONES = [
  { chave: 'desconto', lucide: 'badge-percent', nome: 'desconto', palavras: ['desconto'] },
  { chave: 'preco', lucide: 'banknote', nome: 'investimento', palavras: ['valor de tabela', 'preco', 'parcela'] },
  { chave: 'verba', lucide: 'wallet', nome: 'verba de mídia', palavras: ['verba', 'orcamento de midia', 'investimento em midia'] },
  { chave: 'prioridade', lucide: 'target', nome: 'foco', palavras: ['prioridade', 'concorr'] },
  { chave: 'site', lucide: 'globe', nome: 'site', palavras: ['wix', 'site atual'] },
  { chave: 'landing', lucide: 'monitor-smartphone', nome: 'Landing page', palavras: ['landing', 'portfolio'] },
  { chave: 'busca_ia', lucide: 'sparkles', nome: 'busca por IA', palavras: ['busca por ia', 'buscas por ia', 'chatgpt', 'gemini', 'organico', 'seo'] },
  { chave: 'whatsapp', lucide: 'message-circle', nome: 'CRM + WhatsApp', palavras: ['whatsapp'] },
  { chave: 'funil', lucide: 'filter', nome: 'funis', palavras: ['funil', 'funis'] },
  { chave: 'pasta', lucide: 'folder-open', nome: 'materiais', palavras: ['pasta', 'google drive'] },
  { chave: 'gestor', lucide: 'headset', nome: 'assessoria', palavras: ['gestor', 'assessoria', 'designer'] },
  { chave: 'tracao', lucide: 'rocket', nome: 'tração', palavras: ['tracion', 'tracao', 'escalar', 'acelerar'] },
  { chave: 'meta_ads', lucide: 'thumbs-up', nome: 'Meta Ads', palavras: ['meta ads', 'remarketing', 'instagram', 'facebook'] },
  { chave: 'google_ads', lucide: 'mouse-pointer-click', nome: 'Google Ads', palavras: ['google'] },
  { chave: 'rastreamento', lucide: 'crosshair', nome: 'rastreamento', palavras: ['rastre', 'utm', 'pixel', 'api de conversao', 'tags'] },
  { chave: 'criativos', lucide: 'camera', nome: 'criativos', palavras: ['criativo', 'foto', 'video'] },
  { chave: 'crm', lucide: 'contact', nome: 'CRM', palavras: ['crm'] },
  { chave: 'site', lucide: 'globe', nome: 'site', palavras: ['site', 'pagina', 'wix'] },
  { chave: 'prazo', lucide: 'calendar-clock', nome: 'prazo', palavras: ['prazo', 'dias', 'agenda', 'cronograma'] },
  { chave: 'decisao', lucide: 'handshake', nome: 'decisão', palavras: ['decis', 'aceite', 'fechamento', 'alinha'] },
  { chave: 'retorno', lucide: 'phone-call', nome: 'retorno', palavras: ['retorno', 'reuniao', 'ligacao'] },
  { chave: 'atendimento', lucide: 'timer', nome: 'atendimento', palavras: ['atendimento', 'tempo de resposta'] },
  { chave: 'publico', lucide: 'users', nome: 'público', palavras: ['publico', 'leads', 'perfil', 'cliente'] },
  { chave: 'empresa', lucide: 'store', nome: 'empresa', palavras: ['marcenaria', 'showroom', 'loja', 'empresa', 'anos'] },
  { chave: 'implementacao', lucide: 'hammer', nome: 'implementação', palavras: ['implementa', 'setup'] },
  { chave: 'acompanhamento', lucide: 'chart-line', nome: 'acompanhamento', palavras: ['acompanhamento', 'relatorio', 'metrica'] },
  { chave: 'padrao', lucide: 'circle-check', nome: '', palavras: [] },
];

export const normalizar = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REGRAS = ICONES.map((i) => ({ ...i, re: i.palavras.length ? new RegExp(`(^|[^a-z])(${i.palavras.map(escapar).join('|')})`) : null }));

// Texto do item → chave do ícone (o "01   " do cartão é ignorado).
export function iconePara(texto) {
  const t = normalizar(String(texto).replace(/^\s*\d+\s+/, ''));
  return (REGRAS.find((r) => r.re?.test(t)) || REGRAS[REGRAS.length - 1]).chave;
}

export function urlIcone(base, chave, variante = 'amarelo') {
  return `${String(base).replace(/\/+$/, '')}/${chave}-${variante}.png`;
}

// Base pública dos ícones no Storage do projeto (Supabase).
export function baseIconesDoProjeto(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET_ICONES}/icones/${VERSAO_ICONES}`;
}

// ---------- leitura da apresentação ----------
const geo = (el) => ({
  x: el.transform?.translateX ?? 0,
  y: el.transform?.translateY ?? 0,
  w: (el.size?.width?.magnitude ?? 0) * (el.transform?.scaleX ?? 1),
  h: (el.size?.height?.magnitude ?? 0) * (el.transform?.scaleY ?? 1),
});
const textoEl = (el) => (el?.shape?.text?.textElements || []).map((t) => t.textRun?.content || '').join('').trim();
const fonteEl = (el) => (el?.shape?.text?.textElements || []).find((t) => t.textRun?.style?.fontSize)?.textRun.style.fontSize.magnitude;

// Slide gerado → partes reconhecidas pelo sufixo. null se não for slide gerado.
export function analisarSlide(slide) {
  const pre = `${slide.objectId}_`;
  const por = {};
  for (const el of slide.pageElements || []) if (el.objectId?.startsWith(pre)) por[el.objectId.slice(pre.length)] = el;
  if (!por.t || !por.r) return null;
  const parte = (k) => (por[k] ? { id: pre + k, texto: textoEl(por[k]), fonte: fonteEl(por[k]), el: por[k], ...geo(por[k]) } : null);
  const numerados = (re) => Object.keys(por).filter((k) => re.test(k)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return {
    sid: slide.objectId,
    rotulo: textoEl(por.r),
    titulo: textoEl(por.t),
    cartoes: numerados(/^c\d+$/).map(parte),
    linhas: numerados(/^i\d+$/).map((k) => ({ ...parte(k), a: parte(`${k}a`), b: parte(`${k}b`) })),
    painel: parte('p'),
    p: Object.fromEntries(['p0', 'p1', 'p2', 'p3', 'p4'].filter((k) => por[k]).map((k) => [k, parte(k)])),
    rodape: parte('f'),
    jaVisual: Object.keys(por).some((k) => k.startsWith('v')),
  };
}

// "R$ 2.000" / "R$ 5.809,76" → número
export function valorBRL(t) {
  const m = String(t).match(/R\$\s*([\d.]+(?:,\d+)?)/);
  return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : null;
}

// ---------- primitivas de request ----------
const cor = (h) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
const CINZA_LINHA = cor('#6E4A45');
const props = (pagina, x, y, w, h) => ({
  pageObjectId: pagina,
  size: { width: emu(w), height: emu(h) },
  transform: { scaleX: 1, scaleY: 1, translateX: Math.round(x), translateY: Math.round(y), unit: 'EMU' },
});
const forma = (id, pagina, tipo, x, y, w, h) => ({ createShape: { objectId: id, shapeType: tipo, elementProperties: props(pagina, x, y, w, h) } });
const imagem = (id, pagina, url, x, y, s) => ({ createImage: { objectId: id, url, elementProperties: props(pagina, x, y, s, s) } });

function aparencia(id, { fundo = null, alfa = 1, contorno = null, alfaContorno = 1, espessura = 1 } = {}) {
  return {
    updateShapeProperties: {
      objectId: id,
      shapeProperties: {
        shapeBackgroundFill: fundo ? { solidFill: { color: { rgbColor: fundo }, alpha: alfa } } : { propertyState: 'NOT_RENDERED' },
        outline: contorno
          ? { outlineFill: { solidFill: { color: { rgbColor: contorno }, alpha: alfaContorno } }, weight: { magnitude: espessura, unit: 'PT' }, propertyState: 'RENDERED' }
          : { propertyState: 'NOT_RENDERED' },
        contentAlignment: 'MIDDLE',
      },
      fields: contorno
        ? `${fundo ? 'shapeBackgroundFill.solidFill' : 'shapeBackgroundFill.propertyState'},outline.outlineFill.solidFill,outline.weight,outline.propertyState,contentAlignment`
        : `${fundo ? 'shapeBackgroundFill.solidFill' : 'shapeBackgroundFill.propertyState'},outline.propertyState,contentAlignment`,
    },
  };
}

function texto(id, conteudo, { rgb = ESTILO.branco, fonte = ESTILO.fonteTexto, tamanho = 10, negrito = false, alinhar = 'START', riscado = false } = {}) {
  return [
    { insertText: { objectId: id, text: conteudo } },
    {
      updateTextStyle: {
        objectId: id,
        textRange: { type: 'ALL' },
        style: { foregroundColor: { opaqueColor: { rgbColor: rgb } }, fontFamily: fonte, fontSize: { magnitude: tamanho, unit: 'PT' }, bold: negrito, strikethrough: riscado },
        fields: 'foregroundColor,fontFamily,fontSize,bold,strikethrough',
      },
    },
    { updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { alignment: alinhar }, fields: 'alignment' } },
  ];
}

const caixa = (id, pagina, x, y, w, h, conteudo, estilo) => [forma(id, pagina, 'TEXT_BOX', x, y, w, h), ...texto(id, conteudo, estilo), aparencia(id)];
const paraTras = (ids) => ({ updatePageElementsZOrder: { pageElementObjectIds: ids, operation: 'SEND_TO_BACK' } });

// Reposiciona/redimensiona um elemento existente (escala sobre o tamanho original).
function mover(parte, { x = parte.x, y = parte.y, w = parte.w, h = parte.h }) {
  const t = parte.el.transform || {};
  return {
    updatePageElementTransform: {
      objectId: parte.id,
      applyMode: 'ABSOLUTE',
      transform: {
        scaleX: w / (parte.el.size?.width?.magnitude || w), scaleY: h / (parte.el.size?.height?.magnitude || h),
        shearX: t.shearX ?? 0, shearY: t.shearY ?? 0, translateX: Math.round(x), translateY: Math.round(y), unit: 'EMU',
      },
    },
  };
}

// ---------- peças ----------

// Dois anéis translúcidos no canto inferior direito, atrás de tudo.
export function requestsGrafismo(a, W, H) {
  const id0 = `${a.sid}_vg0`;
  const id1 = `${a.sid}_vg1`;
  return [
    forma(id0, a.sid, 'ELLIPSE', W - pt(150), H - pt(140), pt(260), pt(260)),
    aparencia(id0, { contorno: ESTILO.vermelhoClaro, alfaContorno: 0.22, espessura: 22 }),
    forma(id1, a.sid, 'ELLIPSE', W - pt(95), H - pt(85), pt(150), pt(150)),
    aparencia(id1, { contorno: ESTILO.amarelo, alfaContorno: 0.18, espessura: 2 }),
    paraTras([id0, id1]),
  ];
}

// "ETAPA 1 — ETAPA 2" no alto, à direita; a etapa do slide vem preenchida.
export function requestsEtapas(a, W, ativa) {
  const m = Math.round(W * 0.055);
  const pw = pt(62);
  const ph = pt(16);
  const lig = pt(18);
  const x0 = W - m - (2 * pw + lig);
  const y = pt(30);
  const reqs = [];
  [1, 2].forEach((n, i) => {
    const id = `${a.sid}_ve${n}`;
    const x = x0 + i * (pw + lig);
    const on = n === ativa;
    reqs.push(
      forma(id, a.sid, 'ROUND_RECTANGLE', x, y, pw, ph),
      aparencia(id, on ? { fundo: ESTILO.vermelhoClaro } : { contorno: ESTILO.cinza, alfaContorno: 0.7, espessura: 1 }),
      ...texto(id, `ETAPA ${n}`, { rgb: on ? ESTILO.branco : ESTILO.cinza, tamanho: 8, negrito: true, alinhar: 'CENTER' }),
    );
  });
  const lid = `${a.sid}_vel`;
  reqs.push(forma(lid, a.sid, 'RECTANGLE', x0 + pw + pt(3), y + ph / 2 - pt(0.75), lig - pt(6), pt(1.5)), aparencia(lid, { fundo: ESTILO.cinza, alfa: 0.7 }));
  return reqs;
}

// O ícone ocupa o lugar do número ("01   "), à esquerda: o recuo (~21pt) equivale à
// largura do número, então nenhuma linha quebra a mais do que no deck aprovado.
const ICONE_CARTAO = { min: 13, max: 16, x: 8, gap: 7 };
const tamIconeCartao = (h) => pt(Math.max(ICONE_CARTAO.min, Math.min(ICONE_CARTAO.max, (h / PT) * 0.6)));
const brutoEl = (el) => (el?.shape?.text?.textElements || []).map((t) => t.textRun?.content || '').join('');

export function requestsIconesCartoes(a, base) {
  const reqs = [];
  a.cartoes.forEach((c, i) => {
    const s = tamIconeCartao(c.h);
    const recuo = s / PT + ICONE_CARTAO.gap;
    const num = brutoEl(c.el).match(/^\d+\s+/);
    reqs.push(imagem(`${a.sid}_vi${i}`, a.sid, urlIcone(base, iconePara(c.texto)), c.x + pt(ICONE_CARTAO.x), c.y + (c.h - s) / 2, s));
    if (num) reqs.push({ deleteText: { objectId: c.id, textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: num[0].length } } });
    reqs.push({
      updateParagraphStyle: {
        objectId: c.id, textRange: { type: 'ALL' },
        style: { indentStart: { magnitude: recuo, unit: 'PT' }, indentFirstLine: { magnitude: recuo, unit: 'PT' } },
        fields: 'indentStart,indentFirstLine',
      },
    });
  });
  return reqs;
}

// Linhas do slide de investimento: ícone à esquerda e o texto empurrado.
export function requestsIconesLinhas(a, base) {
  const reqs = [];
  a.linhas.forEach((l, i) => {
    if (!l.a) return;
    const s = pt(Math.max(14, Math.min(20, (l.h / PT) * 0.5)));
    const xi = l.x + pt(9);
    const novoX = xi + s + pt(7);
    reqs.push(imagem(`${a.sid}_vl${i}`, a.sid, urlIcone(base, iconePara(l.a.texto)), xi, l.y + (l.h - s) / 2, s));
    if (l.a.x < novoX) reqs.push(mover(l.a, { x: novoX, w: l.a.x + l.a.w - novoX }));
  });
  return reqs;
}

// Painel de investimento: "de R$ X por R$ Y" vira duas barras (tabela × condição).
export function dadosComparativo(a) {
  const p4 = a.p?.p4;
  if (!p4 || !a.painel) return null;
  const m = p4.texto.match(/de\s+(R\$\s*[\d.,]+)\s+por\s+(R\$\s*[\d.,]+)/i);
  if (!m) return null;
  const de = valorBRL(m[1]);
  const por = valorBRL(m[2]);
  if (!(de > 0 && por > 0 && por < de)) return null;
  // O "%" da barra é o que o closer falou (_p1, "20% DE DESCONTO"), nunca recalculado.
  // Sem _p1, ou divergindo do de/por em mais de 1 ponto: barra sem percentual.
  const falado = a.p?.p1?.texto.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const pctFalado = falado ? Number(falado[1].replace(',', '.')) : null;
  const pctConta = (1 - por / de) * 100;
  const rotulo = pctFalado != null && Math.abs(pctFalado - pctConta) <= 1 ? `-${falado[1]}%` : 'CONDIÇÃO';
  return { de, por, rotulo };
}

export function requestsComparativo(a, d) {
  const p4 = a.p.p4;
  const x = p4.x;
  const w = p4.w;
  const y = p4.y;
  const h = Math.max(pt(30), a.painel.y + a.painel.h - pt(8) - y);
  const gap = pt(4);
  const lh = (h - gap) / 2;
  const rot = pt(54);
  const bw = w - rot - pt(4);
  const linhas = [
    { k: 0, rotulo: 'TABELA', valor: formatarBRL(d.de), larg: bw, fundo: ESTILO.cinza, alfa: 0.35, txt: ESTILO.branco, rotCor: ESTILO.cinza, riscado: true },
    { k: 1, rotulo: d.rotulo, valor: formatarBRL(d.por), larg: Math.round(bw * (d.por / d.de)), fundo: ESTILO.amarelo, alfa: 1, txt: ESTILO.fundo, rotCor: ESTILO.amarelo, riscado: false },
  ];
  const reqs = [{ deleteObject: { objectId: p4.id } }];
  for (const l of linhas) {
    const ly = y + l.k * (lh + gap);
    const rid = `${a.sid}_vc${l.k}r`;
    const bid = `${a.sid}_vc${l.k}b`;
    reqs.push(
      ...caixa(rid, a.sid, x, ly, rot, lh, l.rotulo, { rgb: l.rotCor, tamanho: 8, negrito: true }),
      forma(bid, a.sid, 'ROUND_RECTANGLE', x + rot + pt(4), ly, l.larg, lh),
      aparencia(bid, { fundo: l.fundo, alfa: l.alfa }),
      ...texto(bid, l.valor, { rgb: l.txt, tamanho: 9, negrito: true, alinhar: 'CENTER', riscado: l.riscado }),
    );
  }
  return reqs;
}

// Slides onde verba de mídia é proposta (não Diagnóstico, onde seria gasto passado).
export const ROTULO_SLIDE_MIDIA = /etapa 2|proxima etapa|proposta|investimento|verba/;
const ETAPA2 = /etapa 2|proxima etapa/;
// Palavra inteira, no texto sem acento: "mesmo" e "mesa" não são mês.
const MENSAL = /\bmes\b|\bmensa(l|is)\b|\bmensalidade\b/;
const ehMensal = (t) => MENSAL.test(normalizar(t));

// Verba de mídia: "R$ 2.000 em Google ... R$ 800 em Meta" num cartão de slide de proposta.
// `mensal` só quando o cartão ou o slide fala em mês: o período não é presumido.
export function dadosMidia(a) {
  if (!ROTULO_SLIDE_MIDIA.test(normalizar(a.rotulo))) return null;
  for (const c of a.cartoes) {
    const g = c.texto.match(/R\$\s*([\d.,]+)\s+(?:em|no|de)\s+Google/i);
    const mt = c.texto.match(/R\$\s*([\d.,]+)\s+(?:em|no|de)\s+Meta/i);
    if (g && mt) {
      const google = valorBRL(`R$ ${g[1]}`);
      const meta = valorBRL(`R$ ${mt[1]}`);
      const mensal = ehMensal(a.titulo) || a.cartoes.some((o) => ehMensal(o.texto));
      if (google > 0 && meta > 0) return { google, meta, total: google + meta, mensal };
    }
  }
  return null;
}

// Valor mensal da etapa ("assessoria ... R$ 4.000 por mês" ou, no deck curto,
// "Investimento: R$ 4.000 por mês"), para o total do mês.
export function dadosAssessoria(a) {
  for (const c of a.cartoes) {
    const m = c.texto.replace(/^\s*\d+\s+/, '').match(/(?:assessoria[^$]*?|^investimento:\s*)R\$\s*([\d.,]+)\s*(?:por|\/)\s*m[eê]s/i);
    if (m) return valorBRL(`R$ ${m[1]}`);
  }
  return null;
}

// Cartões encolhem para abrir uma coluna à direita, se o texto continuar cabendo.
export function larguraComPainel(a, W) {
  if (!a.cartoes.length) return null;
  const m = Math.round(W * 0.055);
  const novaW = Math.round((W - 2 * m) * 0.6);
  for (const c of a.cartoes) {
    const fonte = c.fonte || 12;
    // o cartão perde o "01   " e ganha o recuo do ícone (requestsIconesCartoes)
    const util = novaW / PT - 2 * 8 - (tamIconeCartao(c.h) / PT + ICONE_CARTAO.gap);
    const porLinha = Math.floor(util / (fonte * 0.5));
    const alturaTexto = linhasDoTexto(c.texto.replace(/^\s*\d+\s+/, ''), porLinha) * fonte * 1.2 + 8;
    if (alturaTexto > c.h / PT) return null;
  }
  return novaW;
}

export function requestsMidia(a, d, W, novaW, base) {
  const m = Math.round(W * 0.055);
  const gapCol = pt(14);
  const x = m + novaW + gapCol;
  const w = W - m - x;
  const topo = a.cartoes[0].y;
  const fim = a.cartoes[a.cartoes.length - 1].y + a.cartoes[a.cartoes.length - 1].h;
  const pad = pt(12);
  const pid = `${a.sid}_vm`;
  const pg = Math.round((d.google / d.total) * 100);
  const pm = 100 - pg;
  const bx = x + pad;
  const bw = w - 2 * pad;
  const by = topo + pt(92);
  const bh = pt(20);
  const gw = Math.round(bw * (d.google / d.total));
  const reqs = [
    ...a.cartoes.map((c) => mover(c, { w: novaW })),
    forma(pid, a.sid, 'ROUND_RECTANGLE', x, topo, w, fim - topo),
    aparencia(pid, { fundo: ESTILO.cartao }),
    ...caixa(`${pid}0`, a.sid, bx, topo + pt(8), bw, pt(18), `VERBA DE MÍDIA SUGERIDA${d.mensal ? ' / MÊS' : ''}`, { rgb: ESTILO.amarelo, tamanho: 9, negrito: true }),
    ...caixa(`${pid}1`, a.sid, bx, topo + pt(28), bw, pt(40), formatarBRL(d.total), { fonte: ESTILO.fonteTitulo, tamanho: 30 }),
    ...caixa(`${pid}2`, a.sid, bx, topo + pt(68), bw, pt(18), 'paga direto às plataformas', { rgb: ESTILO.cinza, tamanho: 9 }),
    forma(`${pid}g`, a.sid, 'RECTANGLE', bx, by, gw, bh),
    aparencia(`${pid}g`, { fundo: ESTILO.vermelhoClaro }),
    ...texto(`${pid}g`, gw > pt(28) ? `${pg}%` : '', { tamanho: 9, negrito: true, alinhar: 'CENTER' }),
    forma(`${pid}m`, a.sid, 'RECTANGLE', bx + gw, by, bw - gw, bh),
    aparencia(`${pid}m`, { fundo: ESTILO.amarelo }),
    ...texto(`${pid}m`, bw - gw > pt(28) ? `${pm}%` : '', { rgb: ESTILO.fundo, tamanho: 9, negrito: true, alinhar: 'CENTER' }),
  ];
  [['google_ads', 'Google Ads', d.google, pg], ['meta_ads', 'Meta Ads', d.meta, pm]].forEach(([chave, nome, v, p], i) => {
    const ly = by + bh + pt(14) + i * pt(26);
    reqs.push(
      imagem(`${pid}i${i}`, a.sid, urlIcone(base, chave), bx, ly, pt(18)),
      ...caixa(`${pid}t${i}`, a.sid, bx + pt(24), ly - pt(2), bw - pt(24), pt(22), `${nome}  ·  ${formatarBRL(v)}  (${p}%)`, { tamanho: 10 }),
    );
  });
  return reqs;
}

// Barra empilhada: segmentos proporcionais, % dentro quando cabe; legenda com ícone embaixo.
function barraEmpilhada(id, pagina, x, y, w, h, segs, base) {
  const total = segs.reduce((t, s) => t + s.valor, 0);
  const reqs = [];
  let cx = x;
  segs.forEach((s, i) => {
    const sw = i === segs.length - 1 ? x + w - cx : Math.round(w * (s.valor / total));
    const p = Math.round((s.valor / total) * 100);
    reqs.push(
      forma(`${id}s${i}`, pagina, 'RECTANGLE', cx, y, sw, h),
      aparencia(`${id}s${i}`, { fundo: s.cor }),
      ...texto(`${id}s${i}`, sw > pt(34) ? `${p}%` : '', { rgb: s.txt, tamanho: 11, negrito: true, alinhar: 'CENTER' }),
    );
    cx += sw;
  });
  const lw = w / segs.length;
  segs.forEach((s, i) => {
    const lx = x + i * lw;
    const ly = y + h + pt(8);
    reqs.push(
      imagem(`${id}i${i}`, pagina, urlIcone(base, s.icone), lx, ly, pt(16)),
      ...caixa(`${id}t${i}`, pagina, lx + pt(20), ly - pt(3), lw - pt(24), pt(22), `${s.nome}  ·  ${formatarBRL(s.valor)}`, { tamanho: 10 }),
    );
  });
  return reqs;
}

function cabecalho(sid, W, H, rotulo, titulo) {
  const m = Math.round(W * 0.055);
  return [
    { updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: ESTILO.fundo } } } }, fields: 'pageBackgroundFill.solidFill.color' } },
    ...caixa(`${sid}_r`, sid, m, Math.round(H * 0.07), W - 2 * m, Math.round(H * 0.07), rotulo.toUpperCase(), { rgb: ESTILO.vermelhoClaro, tamanho: ESTILO.tamanhoRotulo, negrito: true }),
    ...caixa(`${sid}_t`, sid, m, Math.round(H * 0.13), W - 2 * m, Math.round(H * 0.15), titulo.toUpperCase(), { fonte: ESTILO.fonteTitulo, tamanho: ESTILO.tamanhoTitulo }),
    forma(`${sid}_l`, sid, 'RECTANGLE', m, Math.round(H * 0.295), Math.round(W * 0.08), Math.round(H * 0.008)),
    aparencia(`${sid}_l`, { fundo: ESTILO.vermelho }),
  ];
}

// Slide próprio do gráfico de mídia (quando não cabe ao lado dos cartões).
export function requestsSlideMidia(d, { sid, indice, W, H, base, rotulo, assessoria = null, aproximado = false, rodape = 'V4 COMPANY', grafismo = true }) {
  const m = Math.round(W * 0.055);
  const w = W - 2 * m;
  const reqs = [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...cabecalho(sid, W, H, rotulo, d.mensal ? 'Investimento mensal sugerido' : 'Investimento em mídia sugerido'),
  ];
  const google = { valor: d.google, cor: ESTILO.vermelhoClaro, txt: ESTILO.branco, nome: 'Google Ads', icone: 'google_ads' };
  const meta = { valor: d.meta, cor: ESTILO.amarelo, txt: ESTILO.fundo, nome: 'Meta Ads', icone: 'meta_ads' };
  let y = Math.round(H * 0.35);
  reqs.push(...caixa(`${sid}_vm0`, sid, m, y, w, pt(18), `VERBA DE MÍDIA${d.mensal ? ' / MÊS' : ''}  ·  ${formatarBRL(d.total)}`, { rgb: ESTILO.amarelo, tamanho: 10, negrito: true }));
  reqs.push(...barraEmpilhada(`${sid}_vmb`, sid, m, y + pt(22), w, pt(30), [google, meta], base));
  // Somar mensalidade com verba só quando a verba também é mensal.
  if (assessoria && d.mensal) {
    y += pt(100);
    const total = assessoria + d.total;
    reqs.push(...caixa(`${sid}_vm1`, sid, m, y, w, pt(18), `MÊS COMPLETO (ASSESSORIA + MÍDIA)  ·  ${formatarBRL(total)}`, { rgb: ESTILO.amarelo, tamanho: 10, negrito: true }));
    reqs.push(...barraEmpilhada(`${sid}_vmc`, sid, m, y + pt(22), w, pt(30), [
      { valor: assessoria, cor: ESTILO.cinza, txt: ESTILO.fundo, nome: 'Assessoria V4', icone: 'gestor' }, google, meta,
    ], base));
  }
  const nota = ['Verba de mídia paga direto às plataformas.', aproximado ? 'Valores aproximados, conforme a proposta.' : ''].filter(Boolean).join(' ');
  reqs.push(...caixa(`${sid}_vmn`, sid, m, Math.round(H * 0.84), w, pt(18), nota, { rgb: ESTILO.cinza, tamanho: 9 }));
  reqs.push(...caixa(`${sid}_f`, sid, m, Math.round(H * 0.91), w, Math.round(H * 0.06), rodape, { rgb: ESTILO.cinza, tamanho: ESTILO.tamanhoRodape, negrito: true }));
  if (grafismo) reqs.push(...requestsGrafismo({ sid }, W, H));
  return reqs;
}

// ---------- linha do tempo ----------
const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();

// Marcos tirados do texto dos slides gerados. Só entra o que está escrito.
export function marcosDoDeck(analisados) {
  const todos = analisados.flatMap((a) => a.cartoes.map((c) => c.texto).concat(a.linhas.map((l) => l.a?.texto || '')));
  const tudo = todos.join('\n');
  const marcos = [];
  const decisao = analisados.find((a) => /proximos passos|decisao/.test(normalizar(`${a.rotulo} ${a.titulo}`)));
  if (decisao) marcos.push({ chave: 'decisao', quando: 'Aceite', titulo: 'Proposta aprovada', texto: 'Início do projeto' });
  const prazo = tudo.match(/prazo[^:\n]*:\s*(\d+)\s*dias/i);
  const entregas = analisados.find((a) => /^proposta|implementa/.test(normalizar(a.rotulo)) && a.cartoes.length);
  if (prazo) {
    const nomes = [...new Set((entregas?.cartoes || []).map((c) => ICONES.find((i) => i.chave === iconePara(c.texto))?.nome).filter(Boolean))];
    marcos.push({ chave: 'implementacao', quando: `${prazo[1]} dias`, titulo: 'Implementação', texto: nomes.slice(0, 4).join(', ') || 'Entregas da proposta' });
  }
  const acomp = tudo.match(/(\d+)\s*dias\s+de\s+acompanhamento/i);
  if (acomp) marcos.push({ chave: 'acompanhamento', quando: `+${acomp[1]} dias`, titulo: 'Acompanhamento', texto: /google ads/i.test(tudo.slice(Math.max(0, acomp.index - 80), acomp.index)) ? 'Google Ads no ar' : '' });
  const etapa2 = analisados.find((a) => ETAPA2.test(normalizar(a.rotulo)));
  if (etapa2) {
    // "A partir de janeiro: tracionar" (deck à mão) ou "Janeiro: próxima etapa" (deck curto)
    const quando = `${etapa2.titulo} ${etapa2.cartoes.map((c) => c.texto).join(' ')}`.match(/a partir de\s+([a-zà-ú]+)/i);
    const [antes, depois] = etapa2.titulo.split(':').map((t) => t.trim());
    const nome = /proxima etapa/.test(normalizar(etapa2.rotulo)) ? 'Próxima etapa' : 'Etapa 2';
    marcos.push({
      chave: 'tracao',
      quando: quando ? capital(quando[1]) : depois && antes.length <= 20 ? capital(antes) : nome,
      titulo: depois && quando && normalizar(depois) !== normalizar(nome) ? `${nome} · ${capital(depois)}` : nome,
      texto: /opcional/i.test(etapa2.rotulo) ? 'Opcional' : '',
    });
  }
  return marcos;
}

export function requestsLinhaDoTempo(marcos, { sid, indice, W, H, base, rodape = 'V4 COMPANY', grafismo = true }) {
  const m = Math.round(W * 0.055);
  const n = marcos.length;
  const colW = (W - 2 * m) / n;
  const yLinha = Math.round(H * 0.5);
  const d = pt(46);
  const s = pt(24);
  const reqs = [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    ...cabecalho(sid, W, H, 'Linha do tempo', 'Como vai ser'),
    forma(`${sid}_vtr`, sid, 'RECTANGLE', m + colW / 2, yLinha - pt(1.5), colW * (n - 1), pt(3)),
    aparencia(`${sid}_vtr`, { fundo: CINZA_LINHA }),
  ];
  marcos.forEach((mc, i) => {
    const cx = m + colW * (i + 0.5);
    const bx = cx - colW / 2 + pt(4);
    const bw = colW - pt(8);
    const id = `${sid}_vt${i}`;
    reqs.push(
      ...caixa(`${id}q`, sid, bx, yLinha - d / 2 - pt(40), bw, pt(30), mc.quando.toUpperCase(), { rgb: ESTILO.amarelo, fonte: ESTILO.fonteTitulo, tamanho: 18, alinhar: 'CENTER' }),
      forma(`${id}n`, sid, 'ELLIPSE', cx - d / 2, yLinha - d / 2, d, d),
      aparencia(`${id}n`, { fundo: i === n - 1 ? ESTILO.vermelhoClaro : ESTILO.amarelo }),
      imagem(`${id}i`, sid, urlIcone(base, mc.chave, i === n - 1 ? 'branco' : 'vinho'), cx - s / 2, yLinha - s / 2, s),
      ...caixa(`${id}t`, sid, bx, yLinha + d / 2 + pt(8), bw, pt(22), mc.titulo, { tamanho: 12, negrito: true, alinhar: 'CENTER' }),
    );
    if (mc.texto) reqs.push(...caixa(`${id}d`, sid, bx, yLinha + d / 2 + pt(30), bw, pt(36), mc.texto, { rgb: ESTILO.cinza, tamanho: 10, alinhar: 'CENTER' }));
  });
  reqs.push(...caixa(`${sid}_f`, sid, m, Math.round(H * 0.91), W - 2 * m, Math.round(H * 0.06), rodape, { rgb: ESTILO.cinza, tamanho: ESTILO.tamanhoRodape, negrito: true }));
  if (grafismo) reqs.push(...requestsGrafismo({ sid }, W, H));
  return reqs;
}

// ---------- orquestração (pura) ----------
export function requestsVisual(apresentacao, { base, prefixo = `vz${Math.random().toString(36).slice(2, 8)}`, linhaDoTempo = true } = {}) {
  if (!base) throw new Error('base dos ícones ausente');
  const W = apresentacao.pageSize?.width?.magnitude ?? 9144000;
  const H = apresentacao.pageSize?.height?.magnitude ?? 5143500;
  const slides = apresentacao.slides || [];
  const analisados = slides.map(analisarSlide).filter(Boolean);
  const novos = analisados.filter((a) => !a.jaVisual);
  const temEtapa2 = analisados.some((a) => ETAPA2.test(normalizar(a.rotulo)));
  const reqs = [];
  const resumo = [];
  const novosSlides = []; // { indice (na ordem original), requests }
  const indiceDe = (sid) => slides.findIndex((s) => s.objectId === sid);
  const rodape = analisados.find((a) => a.rodape)?.rodape.texto || 'V4 COMPANY';

  for (const a of novos) {
    const feito = [];
    reqs.push(...requestsGrafismo(a, W, H));
    const r = normalizar(a.rotulo);
    if (temEtapa2 && (ETAPA2.test(r) || /^proposta/.test(r))) { reqs.push(...requestsEtapas(a, W, ETAPA2.test(r) ? 2 : 1)); feito.push('etapas'); }
    const midia = dadosMidia(a);
    const novaW = midia ? larguraComPainel(a, W) : null;
    if (midia && novaW) {
      reqs.push(...requestsMidia(a, midia, W, novaW, base));
      feito.push('grafico_midia');
    } else if (midia && !slides.some((s) => s.objectId === `${a.sid}_vms`)) {
      const indice = indiceDe(a.sid) + 1;
      const aproximado = a.cartoes.some((c) => /cerca de|aprox/i.test(c.texto));
      novosSlides.push({ indice, requests: requestsSlideMidia(midia, { sid: `${a.sid}_vms`, indice, W, H, base, rotulo: a.rotulo, assessoria: dadosAssessoria(a), aproximado, rodape }) });
      feito.push('grafico_midia_slide_proprio');
    }
    if (a.cartoes.length) { reqs.push(...requestsIconesCartoes(a, base)); feito.push(`icones:${a.cartoes.length}`); }
    if (a.linhas.length) { reqs.push(...requestsIconesLinhas(a, base)); feito.push(`icones_linhas:${a.linhas.length}`); }
    const comp = dadosComparativo(a);
    if (comp) { reqs.push(...requestsComparativo(a, comp)); feito.push('comparativo_preco'); }
    resumo.push({ slide: a.sid, titulo: a.titulo, feito });
  }

  const jaTemLinha = slides.some((s) => s.objectId.endsWith('_vtl'));
  const marcos = marcosDoDeck(analisados);
  if (linhaDoTempo && !jaTemLinha && marcos.length >= 3) {
    const iProx = slides.findIndex((s) => { const a = analisarSlide(s); return a && /proximos passos/.test(normalizar(a.titulo)); });
    const indice = iProx >= 0 ? iProx : indiceDe(analisados[analisados.length - 1].sid) + 1;
    novosSlides.push({ indice, requests: requestsLinhaDoTempo(marcos, { sid: `${prefixo}_vtl`, indice, W, H, base, rodape }) });
    resumo.push({ slide: `${prefixo}_vtl`, titulo: 'COMO VAI SER', feito: [`linha_do_tempo:${marcos.length}`] });
  }
  // Do maior índice para o menor: cada createSlide usa o índice da ordem original.
  // Empate: o último registrado entra primeiro e acaba depois dos outros no deck.
  const ordem = novosSlides.map((n, i) => ({ ...n, i })).sort((x, y) => y.indice - x.indice || y.i - x.i);
  for (const n of ordem) reqs.push(...n.requests);
  return { requests: reqs, resumo };
}

// ---------- rede ----------
// Lê a apresentação completa (com posições) e aplica a camada visual.
// O batchUpdate é atômico: um ícone que o Google não consegue baixar derruba o lote
// inteiro (o deck fica intacto). Nesse caso tenta UMA vez sem as imagens; o resto da
// camada (grafismo, barras, etapas, linha do tempo) entra e `semIcones` avisa.
// Quem integra no pipeline: try/catch, log redigido e pendência na proposta, nunca erro.
// `planejar` troca o plano (a v2 passa o seu); o padrão é a v1.
export async function aplicarVisual({ token, apresentacaoId, base, fetchImpl = globalThis.fetch, dryRun = false, planejar = (ap) => requestsVisual(ap, { base }), planoB = semImagens }) {
  const auth = { Authorization: `Bearer ${token}` };
  const id = encodeURIComponent(apresentacaoId);
  const r = await fetchImpl(`https://slides.googleapis.com/v1/presentations/${id}`, { headers: auth });
  if (!r.ok) throw new Error(`slides.presentations.get: HTTP ${r.status}`);
  const apresentacao = await r.json();
  const { requests, resumo } = planejar(apresentacao);
  if (dryRun || !requests.length) return { resumo, total: requests.length, aplicado: false };
  const enviar = async (lote) => {
    const u = await fetchImpl(`https://slides.googleapis.com/v1/presentations/${id}:batchUpdate`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: lote }),
    });
    if (u.ok) return null;
    const corpo = await u.json().catch(() => ({}));
    return redigir(`slides.batchUpdate: HTTP ${u.status} ${String(corpo?.error?.message || '').slice(0, 300)}`, [token]);
  };
  const erro = await enviar(requests);
  if (!erro) return { resumo, total: requests.length, aplicado: true, semIcones: false };
  const lote2 = planoB(requests);
  if (!/image|url|fetch/i.test(erro) || lote2.length === requests.length) throw new Error(erro);
  const erro2 = await enviar(lote2);
  if (erro2) throw new Error(`${erro} | sem ícones: ${erro2}`);
  return { resumo, total: lote2.length, aplicado: true, semIcones: true, erroIcones: erro };
}

// Plano B padrão: o mesmo lote sem imagens (createImage) e sem fundos de imagem.
export const semImagens = (requests) => requests.filter((q) => !q.createImage && !q.updatePageProperties?.pageProperties?.pageBackgroundFill?.stretchedPictureFill);

// Primitivas para os layouts v2 (visual-v2.mjs). Não são API pública do gerador.
export const primitivas = { PT, pt, cor, forma, imagem, aparencia, texto, caixa, paraTras, mover, cabecalho, brutoEl, capital, barraEmpilhada, props };
