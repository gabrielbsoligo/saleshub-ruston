// =============================================================
// Gerador de Propostas — montagem dos pedidos para a Slides API
// =============================================================
// Funções puras (sem rede): recebem o JSON de escopo
// (propostas/escopo.schema.json) e devolvem os `requests` do
// presentations.batchUpdate. Testadas em gerador.test.mjs.
//
// O deck EE 2026 é quase todo imagem; só os slides de investimento
// têm texto editável. Por isso:
//  - preço: o template tem {{placeholders}} nos slides de investimento
//    (colocados uma vez por `preparar`, a partir dos literais do deck);
//  - escopo: slides novos de texto, inseridos antes do 1º slide de
//    investimento ("Qual é o investimento?").
// =============================================================

// Literais do deck original → placeholders. Usado só por `preparar`,
// numa CÓPIA do deck, para transformá-la em template.
export const LITERAIS_DECK = [
  ['Condição exclusiva junto com a execução, Val. até 24/08', '{{condicao_preco}}'],
  ['R$ 56.000', '{{preco_estruturacao}}'],
  ['56 mil', '{{preco_estruturacao_curto}}'],
  ['1.830,00', '{{valor_parcela}}'],
  ['12x de', '{{parcelas}}x de'],
  ['(0 a 20k Mídia)', '({{faixa_midia}})'],
  ['R$ 5.809,76', '{{preco_execucao}}'],
  ['R$ 7.809,76', '{{preco_execucao_com_social}}'],
];

export const MARCADOR_SLIDE_PRECO = 'Qual é o investimento?';

// Slides de preço do deck: só neles `preparar` mexe.
export const MARCADORES_SLIDES_PRECO = [MARCADOR_SLIDE_PRECO, 'Produtos da Proposta', 'Resumo da Proposta'];

// Placeholders que um template preparado tem de ter (saem de LITERAIS_DECK).
export const PLACEHOLDERS_TEMPLATE = [...new Set(LITERAIS_DECK.flatMap(([, para]) => para.match(/\{\{\w+\}\}/g)))];

// Visual dos slides de escopo (a validar contra o deck oficial)
export const ESTILO = {
  fundo: { red: 0.05, green: 0.05, blue: 0.05 },
  titulo: { red: 0.89, green: 0.02, blue: 0.07 },
  texto: { red: 1, green: 1, blue: 1 },
  fonte: 'Montserrat',
  tamanhoTitulo: 28,
  tamanhoTexto: 16,
  itensPorSlide: 8,
};

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Como no deck: "R$ 56.000" (sem centavos se inteiro) e "R$ 5.809,76".
// Intl usa espaço não separável entre "R$" e o número; o deck usa espaço comum.
export function formatarBRL(v) {
  return brl.format(v).replace(/ /g, ' ').replace(/,00$/, '');
}

export function formatarCurto(v) {
  if (v >= 1000 && v % 1000 === 0) return `${v / 1000} mil`;
  if (v >= 1000) return `${num2.format(v / 1000).replace(/,?0+$/, '')} mil`;
  return num2.format(v);
}

const PREENCHER = (o_que) => `[PREENCHER: ${o_que}]`;

// Placeholder → texto. Valor ausente vira marcador visível e entra em `pendencias`
// (o closer não consegue enviar sem ver o buraco).
export function montarValores(escopo) {
  const pendencias = [...(escopo.pendencias || [])];
  const est = escopo.preco?.estruturacao || {};
  const exe = escopo.preco?.execucao_mensal || {};
  const faltou = (o_que) => { pendencias.push(o_que); return PREENCHER(o_que); };

  const total = est.valor_total;
  let parcelas = est.parcelas;
  let parcela = est.valor_parcela;
  if (total != null && parcelas && parcela == null) parcela = Math.round((total / parcelas) * 100) / 100;

  const valores = {
    cliente: escopo.cliente.empresa,
    preco_estruturacao: total != null ? formatarBRL(total) : faltou('preço da estruturação'),
    preco_estruturacao_curto: total != null ? formatarCurto(total) : PREENCHER('preço'),
    parcelas: parcelas ? String(parcelas) : faltou('número de parcelas'),
    valor_parcela: parcela != null ? num2.format(parcela) : faltou('valor da parcela'),
    condicao_preco: est.condicao || '',
    faixa_midia: escopo.plano_execucao?.faixa_midia || faltou('faixa de mídia'),
    preco_execucao: exe.valor != null ? formatarBRL(exe.valor) : faltou('preço da execução mensal'),
    preco_execucao_com_social: exe.valor_com_social != null ? formatarBRL(exe.valor_com_social) : faltou('preço da execução com social media'),
  };
  return { valores, pendencias: [...new Set(pendencias)] };
}

export function requestsPreencher(valores) {
  return Object.entries(valores).map(([k, v]) => ({
    replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: true }, replaceText: v },
  }));
}

export function slidesDePreco(apresentacao) {
  return (apresentacao.slides || []).filter((s) => {
    const t = textoDoSlide(s);
    return MARCADORES_SLIDES_PRECO.some((m) => t.includes(m));
  });
}

const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Planeja o `preparar` só nos slides de preço. Recusa se faltar literal ou se ele
// aparecer colado a outro número (ex.: "R$ 56.000,00" viraria "{{...}},00").
export function planejarPreparar(apresentacao) {
  const slides = slidesDePreco(apresentacao);
  const erros = [];
  if (!slides.length) erros.push('nenhum slide de preço encontrado (marcadores: ' + MARCADORES_SLIDES_PRECO.join(', ') + ')');
  const texto = slides.map(textoDoSlide).join('\n');
  for (const [de] of LITERAIS_DECK) {
    if (!texto.includes(de)) { erros.push(`literal ausente nos slides de preço: ${de}`); continue; }
    if (new RegExp(`\\d${escapar(de)}|${escapar(de)}[,.]?\\d`).test(texto)) erros.push(`literal colado a outro número: ${de}`);
  }
  const pageObjectIds = slides.map((s) => s.objectId);
  const requests = LITERAIS_DECK.map(([de, para]) => ({
    replaceAllText: { containsText: { text: de, matchCase: true }, replaceText: para, pageObjectIds },
  }));
  return { erros, requests, pageObjectIds };
}

// Template utilizável: todos os placeholders presentes e nenhum preço antigo nos slides de preço.
export function verificarTemplate(apresentacao) {
  const erros = [];
  const tudo = (apresentacao.slides || []).map(textoDoSlide).join('\n');
  for (const ph of PLACEHOLDERS_TEMPLATE) if (!tudo.includes(ph)) erros.push(`placeholder ausente no template: ${ph}`);
  if (!tudo.includes(MARCADOR_SLIDE_PRECO)) erros.push(`marcador ausente no template: ${MARCADOR_SLIDE_PRECO}`);
  const preco = slidesDePreco(apresentacao).map(textoDoSlide).join('\n');
  for (const [de] of LITERAIS_DECK) if (preco.includes(de)) erros.push(`preço antigo no template (rode preparar): ${de}`);
  return erros;
}

export function idsExistentes(apresentacao) {
  const ids = new Set();
  for (const s of apresentacao.slides || []) {
    if (s.objectId) ids.add(s.objectId);
    for (const el of s.pageElements || []) if (el.objectId) ids.add(el.objectId);
  }
  return ids;
}

// Seções de texto que viram slides: uma por semana, overdeliveries e plano de execução.
export function secoesEscopo(escopo) {
  const secoes = [];
  const dores = escopo.contexto?.dores || [];
  if (dores.length) secoes.push({ titulo: `O que ouvimos da ${escopo.cliente.empresa}`, itens: dores.map((d) => d.texto) });
  for (const s of escopo.escopo.semanas) {
    if (s.itens.length) secoes.push({ titulo: s.titulo, itens: s.itens.map((i) => i.texto) });
  }
  const od = escopo.escopo.overdeliveries || [];
  if (od.length) secoes.push({ titulo: 'Overdeliveries', itens: od.map((i) => i.texto) });
  const pe = escopo.plano_execucao;
  if (pe?.incluido && pe.itens?.length) secoes.push({ titulo: 'Plano de execução', itens: pe.itens.map((i) => i.texto) });

  // Quebra listas longas em slides "(cont.)"
  const n = ESTILO.itensPorSlide;
  return secoes.flatMap((s) => {
    if (s.itens.length <= n) return [s];
    const partes = [];
    for (let i = 0; i < s.itens.length; i += n) {
      partes.push({ titulo: i === 0 ? s.titulo : `${s.titulo} (cont.)`, itens: s.itens.slice(i, i + n) });
    }
    return partes;
  });
}

export function textoDoSlide(slide) {
  const out = [];
  const coletar = (text) => {
    for (const te of text?.textElements || []) if (te.textRun?.content) out.push(te.textRun.content);
  };
  // Separa elementos/células com \n para não colar textos vizinhos ("56.000" + "56 mil").
  for (const el of slide.pageElements || []) {
    coletar(el.shape?.text);
    out.push('\n');
    for (const row of el.table?.tableRows || []) for (const cell of row.tableCells || []) { coletar(cell.text); out.push('\n'); }
  }
  return out.join('');
}

export function acharIndicePreco(apresentacao) {
  const slides = apresentacao.slides || [];
  const i = slides.findIndex((s) => textoDoSlide(s).includes(MARCADOR_SLIDE_PRECO));
  return i >= 0 ? i : slides.length;
}

const emu = (n) => ({ magnitude: n, unit: 'EMU' });

function caixa(objectId, pageObjectId, x, y, w, h) {
  return {
    createShape: {
      objectId,
      shapeType: 'TEXT_BOX',
      elementProperties: {
        pageObjectId,
        size: { width: emu(w), height: emu(h) },
        transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
      },
    },
  };
}

function estiloTexto(objectId, cor, tamanho, negrito) {
  return {
    updateTextStyle: {
      objectId,
      textRange: { type: 'ALL' },
      style: {
        foregroundColor: { opaqueColor: { rgbColor: cor } },
        fontFamily: ESTILO.fonte,
        fontSize: { magnitude: tamanho, unit: 'PT' },
        bold: negrito,
      },
      fields: 'foregroundColor,fontFamily,fontSize,bold',
    },
  };
}

// Prefixo aleatório por geração: evita colisão com objectIds já existentes no template.
export function novoPrefixo() {
  return `gp${Math.random().toString(36).slice(2, 10)}`;
}

// pageSize vem de presentations.get (o deck pode não ser 16:9 padrão).
export function requestsSlidesEscopo(secoes, { indice, pageSize, prefixo = novoPrefixo() }) {
  const W = pageSize?.width?.magnitude ?? 9144000;
  const H = pageSize?.height?.magnitude ?? 5143500;
  const m = Math.round(W * 0.06);
  const reqs = [];
  secoes.forEach((s, k) => {
    const slideId = `${prefixo}_s${k}`;
    const tId = `${slideId}_t`;
    const bId = `${slideId}_b`;
    reqs.push(
      { createSlide: { objectId: slideId, insertionIndex: indice + k, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
      {
        updatePageProperties: {
          objectId: slideId,
          pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: ESTILO.fundo } } } },
          fields: 'pageBackgroundFill.solidFill.color',
        },
      },
      caixa(tId, slideId, m, m, W - 2 * m, Math.round(H * 0.16)),
      { insertText: { objectId: tId, text: s.titulo } },
      estiloTexto(tId, ESTILO.titulo, ESTILO.tamanhoTitulo, true),
      caixa(bId, slideId, m, Math.round(H * 0.26), W - 2 * m, Math.round(H * 0.66)),
      { insertText: { objectId: bId, text: s.itens.join('\n') } },
      estiloTexto(bId, ESTILO.texto, ESTILO.tamanhoTexto, false),
      { createParagraphBullets: { objectId: bId, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    );
  });
  return reqs;
}

// Validação mínima (sem dependência de lib de JSON Schema): o que quebraria a geração.
export function validarEscopo(e) {
  const erros = [];
  if (e?.schema_version !== 'proposta-escopo/v0') erros.push('schema_version deve ser proposta-escopo/v0');
  if (!e?.cliente?.empresa) erros.push('cliente.empresa é obrigatório');
  if (!['inside_sales', 'pdv', 'ecommerce'].includes(e?.cliente?.modelo_venda)) erros.push('cliente.modelo_venda inválido');
  if (!Array.isArray(e?.escopo?.semanas) || !e.escopo.semanas.length) erros.push('escopo.semanas vazio');
  if (!e?.preco?.estruturacao) erros.push('preco.estruturacao é obrigatório (valores podem ser null)');

  // Preço: null/ausente vira [PREENCHER]; valor presente tem de ser número válido.
  const valor = (v, nome) => {
    if (v == null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) erros.push(`${nome} deve ser número >= 0 ou null`);
  };
  const inteiro = (v, nome) => {
    if (v == null) return;
    if (!Number.isInteger(v) || v < 1) erros.push(`${nome} deve ser inteiro >= 1 ou null`);
  };
  const texto = (v, nome) => { if (v != null && typeof v !== 'string') erros.push(`${nome} deve ser texto ou null`); };
  const est = e?.preco?.estruturacao || {};
  const exe = e?.preco?.execucao_mensal || {};
  valor(est.valor_total, 'preco.estruturacao.valor_total');
  valor(est.valor_parcela, 'preco.estruturacao.valor_parcela');
  inteiro(est.parcelas, 'preco.estruturacao.parcelas');
  texto(est.condicao, 'preco.estruturacao.condicao');
  valor(exe.valor, 'preco.execucao_mensal.valor');
  valor(exe.valor_com_social, 'preco.execucao_mensal.valor_com_social');
  inteiro(exe.meses, 'preco.execucao_mensal.meses');
  texto(e?.plano_execucao?.faixa_midia, 'plano_execucao.faixa_midia');

  // Todo item que vira slide: texto obrigatório; da IA, só com citação da transcrição.
  const colecoes = [
    ['contexto.dores', e?.contexto?.dores],
    ['contexto.objetivos', e?.contexto?.objetivos],
    ...(e?.escopo?.semanas || []).map((s) => [`semana ${s.id}`, s.itens]),
    ['escopo.overdeliveries', e?.escopo?.overdeliveries],
    ['plano_execucao.itens', e?.plano_execucao?.itens],
  ];
  const preenchido = (v) => typeof v === 'string' && v.trim().length > 0;
  for (const [onde, itens] of colecoes) {
    if (itens != null && !Array.isArray(itens)) { erros.push(`${onde} deve ser lista`); continue; }
    for (const i of itens || []) {
      if (!preenchido(i?.texto)) { erros.push(`item sem texto em ${onde}`); continue; }
      if (!['catalogo', 'ia', 'closer'].includes(i.origem)) erros.push(`origem inválida em ${onde}: ${i.texto}`);
      if (i.citacao != null && typeof i.citacao !== 'string') erros.push(`citação deve ser texto ou null em ${onde}: ${i.texto}`);
      else if (i.origem === 'ia' && !preenchido(i.citacao)) erros.push(`item da IA sem citação em ${onde}: ${i.texto}`);
    }
  }
  return erros;
}
