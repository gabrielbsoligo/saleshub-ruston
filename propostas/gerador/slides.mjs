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

export function requestsPreparar() {
  return LITERAIS_DECK.map(([de, para]) => ({
    replaceAllText: { containsText: { text: de, matchCase: true }, replaceText: para },
  }));
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
  for (const el of slide.pageElements || []) {
    for (const te of el.shape?.text?.textElements || []) {
      if (te.textRun?.content) out.push(te.textRun.content);
    }
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

// pageSize vem de presentations.get (o deck pode não ser 16:9 padrão).
export function requestsSlidesEscopo(secoes, { indice, pageSize, prefixo = 'gp' }) {
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
  for (const s of e?.escopo?.semanas || []) {
    for (const i of s.itens || []) {
      if (!i.texto) erros.push(`item sem texto na semana ${s.id}`);
      if (i.origem === 'ia' && !i.citacao) erros.push(`item da IA sem citação na semana ${s.id}: ${i.texto}`);
    }
  }
  return erros;
}
