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

// Visual dos slides de escopo, inspirado nas páginas V4 (ee-2026, sales-deck 2025,
// executar/profissionais): fundo vinho #280000, vermelho #E50914/#FB2E0A,
// amarelo #FFD60A, títulos Anton (no lugar da Morganite), texto IBM Plex Sans.
const hex = (h) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
export const ESTILO = {
  fundo: hex('#280000'),
  cartao: hex('#3D0A05'),
  vermelho: hex('#E50914'),
  vermelhoClaro: hex('#FB2E0A'),
  amarelo: hex('#FFD60A'),
  branco: hex('#FFFFFF'),
  cinza: hex('#B8A6A3'),
  fonteTitulo: 'Anton',
  fonteTexto: 'IBM Plex Sans',
  tamanhoRotulo: 11,
  tamanhoTitulo: 30,
  tamanhoTexto: 13,
  tamanhoRodape: 9,
  itensPorSlide: 8,
};

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Como no deck: "R$ 56.000" (sem centavos se inteiro) e "R$ 5.809,76".
// Intl usa espaço não separável entre "R$" e o número; o deck usa espaço comum.
export function formatarBRL(v) {
  return brl.format(v).replace(/ /g, ' ').replace(/,00$/, '');
}

// Total em destaque no slide "Soma total" (o deck usa "56 MIL", fonte grande):
// milhar redondo → "56 mil"; quebrado → "29.750" (mesmo tamanho; "29,75 mil" quebra a linha).
export function formatarCurto(v) {
  if (v >= 1000 && v % 1000 === 0) return `${v / 1000} mil`;
  return formatarBRL(v).replace(/^R\$\s*/, '');
}

// Validade no slide no formato do deck ("Val. até 24/08"): só dia/mês, para caber.
const diaMes = (data) => String(data).split('/').slice(0, 2).join('/');

// No slide o buraco é curto (caixas pequenas); o que falta vai detalhado em `pendencias`.
const PREENCHER = () => '[PREENCHER]';

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
    // Deck: "Condição exclusiva junto com a execução, Val. até 24/08" → condição (se houver)
    // + validade combinada na reunião (o 24/08 do deck não vale), no mesmo formato curto.
    condicao_preco: est.condicao
      ? `${est.condicao}, Val. até ${escopo.preco?.validade ? diaMes(escopo.preco.validade) : faltou('validade da proposta')}`
      : `Válido até ${escopo.preco?.validade ? diaMes(escopo.preco.validade) : faltou('validade da proposta')}`,
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
  const visitar = (els) => {
    for (const el of els || []) {
      if (el.objectId) ids.add(el.objectId);
      visitar(el.elementGroup?.children);
    }
  };
  for (const s of apresentacao.slides || []) {
    if (s.objectId) ids.add(s.objectId);
    visitar(s.pageElements);
  }
  return ids;
}

// Seções de texto que viram slides: dores, uma por semana, overdeliveries e plano de execução.
export function secoesEscopo(escopo) {
  const secoes = [];
  const dores = escopo.contexto?.dores || [];
  if (dores.length) secoes.push({ rotulo: 'Diagnóstico', titulo: `O que ouvimos da ${escopo.cliente.empresa}`, itens: dores.map((d) => d.texto) });
  for (const s of escopo.escopo.semanas) {
    if (s.itens.length) secoes.push({ rotulo: 'Estruturação Estratégica', titulo: s.titulo, itens: s.itens.map((i) => i.texto) });
  }
  const od = escopo.escopo.overdeliveries || [];
  if (od.length) secoes.push({ rotulo: 'Bônus para você', tipo: 'bonus', titulo: 'Overdeliveries', itens: od.map((i) => i.texto) });
  const pe = escopo.plano_execucao;
  if (pe?.incluido && pe.itens?.length) secoes.push({ rotulo: 'Executar', titulo: 'Plano de execução', itens: pe.itens.map((i) => i.texto) });

  // Quebra listas longas em slides "(cont.)" pelo espaço que os cartões ocupam
  // (itens longos ocupam mais linhas → menos cartões por slide), até itensPorSlide.
  return secoes.flatMap((s) => {
    const itens = s.itens.map(cortarItem);
    const paginas = [];
    let pagina = [];
    for (const item of itens) {
      const tentativa = [...pagina, item];
      if (!pagina.length || cabemNoSlide(tentativa)) pagina = tentativa;
      else { paginas.push(pagina); pagina = [item]; }
    }
    if (pagina.length) paginas.push(pagina);
    // tituloBase/sufixo: no slide o corte do título é feito no base, e o " (cont.)" vem depois
    return paginas.map((p, i) => ({
      ...s, titulo: i === 0 ? s.titulo : `${s.titulo} (cont.)`, tituloBase: s.titulo, sufixo: i === 0 ? '' : ' (cont.)', itens: p,
    }));
  });
}

// Medidas dos cartões em frações da altura do slide 16:9 (720 x 405 pt): IBM Plex Sans 13pt
// numa coluna de ~313pt cabe ~42 caracteres por linha; usamos 38 para sobrar. Sem autofit
// (a API não liga TEXT_AUTOFIT), então a altura do cartão sai do texto mais longo do slide.
const CARTAO = {
  caracteresPorLinha: 38,
  maxLinhas: 6,
  linhaH: 17 / 405,
  folgaH: 16 / 405,
  minH: 36 / 405,
  maxH: 0.12,
  topo: 0.35,
  areaH: 0.52,
  gap: 0.022,
};

// Linhas que o texto ocupa com quebra por palavra.
export function linhasDoTexto(texto, porLinha = CARTAO.caracteresPorLinha) {
  let linhas = 1;
  let atual = 0;
  for (const p of String(texto).split(/\s+/).filter(Boolean)) {
    for (let resto = p.length; resto > 0;) {
      const espaco = atual ? 1 : 0;
      if (atual + espaco + Math.min(resto, porLinha) <= porLinha) {
        const usa = Math.min(resto, porLinha - atual - espaco);
        atual += espaco + usa; resto -= usa;
      } else { linhas += 1; atual = 0; }
    }
  }
  return linhas;
}
const conteudoCartao = (i, texto) => `${doisDigitos(i + 1)}   ${texto}`;

// Item maior que o cartão (maxLinhas) é cortado com "…": o closer completa no Slides.
function cortarItem(texto) {
  if (linhasDoTexto(conteudoCartao(0, texto)) <= CARTAO.maxLinhas) return texto;
  let t = texto;
  while (t.length > 1 && linhasDoTexto(conteudoCartao(0, `${t}…`)) > CARTAO.maxLinhas) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

// Altura (fração de H) dos cartões de um slide e quantos cabem por coluna.
export function medidaCartoes(itens) {
  const linhas = Math.max(1, ...itens.map((t, i) => linhasDoTexto(conteudoCartao(i, t))));
  const h = Math.max(CARTAO.minH, CARTAO.folgaH + linhas * CARTAO.linhaH);
  const porColunaMax = Math.max(1, Math.floor((CARTAO.areaH + CARTAO.gap) / (h + CARTAO.gap)));
  const porColuna = Math.ceil(itens.length / 2) || 1;
  // com poucos itens o cartão cresce até maxH (visual), nunca abaixo do que o texto pede
  const preenche = (CARTAO.areaH - CARTAO.gap * (porColuna - 1)) / porColuna;
  return { linhas, porColuna, porColunaMax, h: Math.max(h, Math.min(CARTAO.maxH, preenche)) };
}
const cabemNoSlide = (itens) => {
  const m = medidaCartoes(itens);
  return itens.length <= ESTILO.itensPorSlide && m.porColuna <= m.porColunaMax;
};

// Título em uma linha: Anton em caixa alta usa ~0,48 em por caractere. Longo → fonte menor
// (até 18pt); ainda maior → o título-base é cortado com "…" e o sufixo (" (CONT.)") vem
// depois do corte, para os slides de continuação não perderem a marca.
export function tituloAjustado(titulo, larguraPt, sufixo = '') {
  const base = String(titulo).toUpperCase();
  const fim = String(sufixo).toUpperCase();
  const t = `${base}${fim}`;
  const cabe = (tam) => Math.floor(larguraPt / (0.48 * tam));
  for (let tam = ESTILO.tamanhoTitulo; tam >= 18; tam -= 2) {
    if (t.length <= cabe(tam)) return { texto: t, tamanho: tam };
  }
  return { texto: `${base.slice(0, Math.max(1, cabe(18) - 1 - fim.length)).trimEnd()}…${fim}`, tamanho: 18 };
}

export function textoDoSlide(slide) {
  const out = [];
  const coletar = (text) => {
    for (const te of text?.textElements || []) if (te.textRun?.content) out.push(te.textRun.content);
  };
  // Separa elementos/células com \n para não colar textos vizinhos ("56.000" + "56 mil").
  // Entra nos grupos (elementGroup.children), que o deck usa no slide de execução.
  const visitar = (els) => {
    for (const el of els || []) {
      coletar(el.shape?.text);
      out.push('\n');
      for (const row of el.table?.tableRows || []) for (const cell of row.tableCells || []) { coletar(cell.text); out.push('\n'); }
      visitar(el.elementGroup?.children);
    }
  };
  visitar(slide.pageElements);
  return out.join('');
}

export function acharIndicePreco(apresentacao) {
  const slides = apresentacao.slides || [];
  const i = slides.findIndex((s) => textoDoSlide(s).includes(MARCADOR_SLIDE_PRECO));
  return i >= 0 ? i : slides.length;
}

const emu = (n) => ({ magnitude: n, unit: 'EMU' });
const cor = (rgb) => ({ opaqueColor: { rgbColor: rgb } });

function forma(objectId, pageObjectId, tipo, x, y, w, h) {
  return {
    createShape: {
      objectId,
      shapeType: tipo,
      elementProperties: {
        pageObjectId,
        size: { width: emu(w), height: emu(h) },
        transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' },
      },
    },
  };
}

function estiloTexto(objectId, { rgb, fonte, tamanho, negrito = false, faixa = { type: 'ALL' } }) {
  return {
    updateTextStyle: {
      objectId,
      textRange: faixa,
      style: {
        foregroundColor: cor(rgb),
        fontFamily: fonte,
        fontSize: { magnitude: tamanho, unit: 'PT' },
        bold: negrito,
      },
      fields: 'foregroundColor,fontFamily,fontSize,bold',
    },
  };
}

function preenchimento(objectId, rgb) {
  return {
    updateShapeProperties: {
      objectId,
      shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb } } },
        outline: { propertyState: 'NOT_RENDERED' },
        contentAlignment: 'MIDDLE',
      },
      fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState,contentAlignment',
    },
  };
}

// Prefixo aleatório por geração: evita colisão com objectIds já existentes no template.
export function novoPrefixo() {
  return `gp${Math.random().toString(36).slice(2, 10)}`;
}

const doisDigitos = (n) => String(n).padStart(2, '0');

// Slide de escopo no visual das páginas V4 (EE 2026): fundo vinho, rótulo
// vermelho, título Anton em caixa alta, linha de destaque, itens em cartões
// numerados (2 colunas) e rodapé. pageSize vem de presentations.get.
export function requestsSlidesEscopo(secoes, { indice, pageSize, prefixo = novoPrefixo(), cliente = '' }) {
  const W = pageSize?.width?.magnitude ?? 9144000;
  const H = pageSize?.height?.magnitude ?? 5143500;
  const m = Math.round(W * 0.055);
  const reqs = [];
  secoes.forEach((s, k) => {
    const sid = `${prefixo}_s${k}`;
    const rotuloCor = s.tipo === 'bonus' ? ESTILO.amarelo : ESTILO.vermelhoClaro;
    const titulo = tituloAjustado(s.tituloBase ?? s.titulo, (W - 2 * m) / 12700, s.tituloBase != null ? s.sufixo : '');
    reqs.push(
      { createSlide: { objectId: sid, insertionIndex: indice + k, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
      {
        updatePageProperties: {
          objectId: sid,
          pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: ESTILO.fundo } } } },
          fields: 'pageBackgroundFill.solidFill.color',
        },
      },
      // rótulo
      forma(`${sid}_r`, sid, 'TEXT_BOX', m, Math.round(H * 0.07), W - 2 * m, Math.round(H * 0.07)),
      { insertText: { objectId: `${sid}_r`, text: s.rotulo.toUpperCase() } },
      estiloTexto(`${sid}_r`, { rgb: rotuloCor, fonte: ESTILO.fonteTexto, tamanho: ESTILO.tamanhoRotulo, negrito: true }),
      // título
      forma(`${sid}_t`, sid, 'TEXT_BOX', m, Math.round(H * 0.13), W - 2 * m, Math.round(H * 0.15)),
      { insertText: { objectId: `${sid}_t`, text: titulo.texto } },
      estiloTexto(`${sid}_t`, { rgb: ESTILO.branco, fonte: ESTILO.fonteTitulo, tamanho: titulo.tamanho }),
      // linha de destaque
      forma(`${sid}_l`, sid, 'RECTANGLE', m, Math.round(H * 0.295), Math.round(W * 0.08), Math.round(H * 0.008)),
      preenchimento(`${sid}_l`, ESTILO.vermelho),
    );
    // cartões numerados, 2 colunas
    // (altura pelo item mais longo; secoesEscopo já garantiu que cabem)
    const { porColuna, h } = medidaCartoes(s.itens);
    const topo = Math.round(H * CARTAO.topo);
    const gap = Math.round(H * CARTAO.gap);
    const cardH = Math.round(H * h);
    const colW = Math.round((W - 2 * m - Math.round(W * 0.02)) / 2);
    s.itens.forEach((texto, i) => {
      const col = Math.floor(i / porColuna);
      const lin = i % porColuna;
      const cid = `${sid}_c${i}`;
      const num = doisDigitos(i + 1);
      const conteudo = conteudoCartao(i, texto);
      reqs.push(
        forma(cid, sid, 'ROUND_RECTANGLE', m + col * (colW + Math.round(W * 0.02)), topo + lin * (cardH + gap), colW, cardH),
        preenchimento(cid, ESTILO.cartao),
        { insertText: { objectId: cid, text: conteudo } },
        estiloTexto(cid, { rgb: ESTILO.branco, fonte: ESTILO.fonteTexto, tamanho: ESTILO.tamanhoTexto }),
        estiloTexto(cid, { rgb: ESTILO.amarelo, fonte: ESTILO.fonteTexto, tamanho: ESTILO.tamanhoTexto, negrito: true,
          faixa: { type: 'FIXED_RANGE', startIndex: 0, endIndex: num.length } }),
      );
    });
    // rodapé
    reqs.push(
      forma(`${sid}_f`, sid, 'TEXT_BOX', m, Math.round(H * 0.91), W - 2 * m, Math.round(H * 0.06)),
      { insertText: { objectId: `${sid}_f`, text: cliente ? `V4 COMPANY  ·  ${cliente.toUpperCase()}` : 'V4 COMPANY' } },
      estiloTexto(`${sid}_f`, { rgb: ESTILO.cinza, fonte: ESTILO.fonteTexto, tamanho: ESTILO.tamanhoRodape, negrito: true }),
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
  texto(e?.preco?.validade, 'preco.validade');

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
