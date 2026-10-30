// =============================================================
// Gerador de Propostas — deck curto (implementação / execução)
// =============================================================
// Para ofertas que não são a Estruturação (P1/P6, decisão do Gabriel 30/10):
// mantém só os slides institucionais escolhidos do template (capa, "maior
// assessoria", clientes, método) e acrescenta slides de texto no visual EE 2026:
// o que ouvimos, contexto, entregáveis, investimento (com desconto e
// parcelas), próxima etapa opcional e próximos passos.
// Funções puras (sem rede), testadas em gerador.test.mjs.
// =============================================================
import { ESTILO, formatarBRL } from './slides.mjs';

export const NOME_TIPO = {
  implementacao: 'Implementação',
  execucao: 'Execução mensal',
  implementacao_e_execucao: 'Implementação + execução',
};

const PREENCHER = '[PREENCHER]';
const MAX_ITENS = 8;
const MAX_CHARS = 140;
const cortar = (t) => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1).trimEnd()}…` : t);
const diaMes = (data) => String(data).split('/').slice(0, 2).join('/');
const brl = (v, recorrencia) => `${formatarBRL(v)}${recorrencia === 'mensal' ? '/mês' : ''}`;
const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// "Google Ads", "Meta Ads (Instagram)" → "R$ 2.000 em Google Ads"
const listaE = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}` : xs[0] || '');

function paginar(secao) {
  const itens = secao.itens.map(cortar);
  if (itens.length <= MAX_ITENS) return [{ ...secao, itens }];
  const out = [];
  for (let i = 0; i < itens.length; i += MAX_ITENS) {
    out.push({ ...secao, titulo: i ? `${secao.titulo} (cont.)` : secao.titulo, itens: itens.slice(i, i + MAX_ITENS) });
  }
  return out;
}

// Slides do deck curto, na ordem. Cada um: { tipo: 'lista', rotulo, titulo, itens }
// ou { tipo: 'investimento', ... }.
export function secoesCurto(escopo) {
  const empresa = escopo.cliente.empresa;
  const ctx = escopo.contexto || {};
  const tipo = escopo.oferta?.tipo;
  const preco = escopo.preco || {};
  const of = preco.oferta || {};
  const secoes = [];

  const dores = (ctx.dores || []).map((d) => d.texto);
  if (dores.length) secoes.push({ tipo: 'lista', rotulo: 'Diagnóstico', titulo: `O que ouvimos da ${empresa}`, itens: dores });

  const contexto = [
    ...(ctx.publico || []).map((i) => `Público: ${i.texto}`),
    ...(ctx.concorrentes || []).map((i) => `Concorrência: ${i.texto}`),
    ...(ctx.cliente_fornece || []).map((i) => `Você fornece: ${i.texto}`),
  ];
  if (contexto.length) secoes.push({ tipo: 'lista', rotulo: 'Contexto', titulo: 'Contexto do projeto', itens: contexto });

  const entregaveis = (escopo.entregaveis || []).map((e) => e.texto);
  secoes.push({
    tipo: 'lista',
    rotulo: `Proposta · ${NOME_TIPO[tipo] || 'Entregáveis'}`,
    titulo: tipo === 'execucao' ? 'O que fazemos todo mês' : 'O que entregamos',
    itens: entregaveis.length ? entregaveis : [`${PREENCHER} entregáveis combinados`],
  });

  // Investimento: itens com valor falado, preço de tabela, condição (desconto/validade).
  const linhas = (escopo.entregaveis || []).filter((e) => e.valor != null)
    .map((e) => ({ texto: e.texto, valor: brl(e.valor, e.recorrencia) }))
    .slice(0, 4); // 4 itens + a linha do preço de tabela cabem no slide
  const temDesconto = of.desconto_percentual != null;
  if (of.valor_tabela != null && (linhas.length > 1 || temDesconto)) {
    linhas.push({ texto: temDesconto ? 'Valor de tabela' : 'Total', valor: brl(of.valor_tabela, of.recorrencia), destaque: true });
  }
  const principal = of.valor_final ?? of.valor_tabela;
  const parcelas = of.parcelas && of.valor_parcela != null ? `ou ${of.parcelas}x de ${formatarBRL(of.valor_parcela)}`
    : of.parcelas ? `em até ${of.parcelas}x` : null;
  const validade = preco.validade ? diaMes(preco.validade) : null;
  secoes.push({
    tipo: 'investimento',
    rotulo: `Investimento · ${NOME_TIPO[tipo] || 'Proposta'}`,
    titulo: 'Qual é o investimento?',
    linhas,
    condicao: temDesconto || validade ? `CONDIÇÃO PARA FECHAMENTO ATÉ ${validade || PREENCHER}` : 'INVESTIMENTO',
    desconto: temDesconto ? `${String(of.desconto_percentual).replace('.', ',')}% DE DESCONTO` : null,
    valor: principal != null ? brl(principal, of.recorrencia) : PREENCHER,
    parcelas,
    dePor: temDesconto && of.valor_tabela != null && of.valor_final != null
      ? `de ${formatarBRL(of.valor_tabela)} por ${formatarBRL(of.valor_final)}` : null,
    rodape: (escopo.custos_terceiros || []).length
      ? `Não incluso, pago direto ao fornecedor: ${listaE(escopo.custos_terceiros.map((c) => `${c.texto} (${c.valor != null ? formatarBRL(c.valor) : PREENCHER}${c.periodicidade === 'mensal' ? ' por mês' : ''})`))}.`
      : null,
  });

  const e2 = escopo.etapa2;
  if (e2) {
    const itens = (e2.itens || []).map((i) => i.texto);
    if (e2.valor_mensal != null) itens.push(`Investimento: ${formatarBRL(e2.valor_mensal)} por mês`);
    if (e2.verba_midia?.length) {
      itens.push(`Verba de mídia, paga direto às plataformas: ${listaE(e2.verba_midia.map((v) => `${formatarBRL(v.valor)} em ${v.canal}`))}`);
    }
    secoes.push({
      tipo: 'lista', rotulo: 'Próxima etapa · opcional',
      titulo: e2.quando ? `${maiuscula(e2.quando)}: próxima etapa` : 'Próxima etapa', itens,
    });
  }

  const passos = (ctx.proximos_passos || []).map((i) => i.texto);
  if (validade && temDesconto) passos.push(`Condição de ${String(of.desconto_percentual).replace('.', ',')}% válida para fechamento até ${validade}`);
  else if (validade) passos.push(`Proposta válida até ${validade}`);
  if (passos.length) secoes.push({ tipo: 'lista', rotulo: 'Decisão', titulo: 'Próximos passos', itens: passos });

  return secoes.flatMap((s) => (s.tipo === 'lista' ? paginar(s) : [s]));
}

// ---- Slides API ----
const emu = (n) => ({ magnitude: n, unit: 'EMU' });
const cor = (rgb) => ({ opaqueColor: { rgbColor: rgb } });
function caixa(id, page, tipo, x, y, w, h) {
  return { createShape: { objectId: id, shapeType: tipo, elementProperties: { pageObjectId: page, size: { width: emu(w), height: emu(h) }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } } } };
}
function texto(id, t, rgb, fonte, tamanho, { negrito = false, alinhamento = null } = {}) {
  const r = [
    { insertText: { objectId: id, text: t } },
    { updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style: { foregroundColor: cor(rgb), fontFamily: fonte, fontSize: { magnitude: tamanho, unit: 'PT' }, bold: negrito }, fields: 'foregroundColor,fontFamily,fontSize,bold' } },
  ];
  if (alinhamento) r.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { alignment: alinhamento }, fields: 'alignment' } });
  return r;
}
const meio = (id) => ({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: 'MIDDLE' }, fields: 'contentAlignment' } });
function fundo(id, rgb) {
  return { updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb } } }, outline: { propertyState: 'NOT_RENDERED' }, contentAlignment: 'MIDDLE' }, fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState,contentAlignment' } };
}

function cabecalho(sid, indice, s, W, H, m) {
  return [
    { createSlide: { objectId: sid, insertionIndex: indice, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
    { updatePageProperties: { objectId: sid, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: ESTILO.fundo } } } }, fields: 'pageBackgroundFill.solidFill.color' } },
    caixa(`${sid}_r`, sid, 'TEXT_BOX', m, Math.round(H * 0.07), W - 2 * m, Math.round(H * 0.07)),
    ...texto(`${sid}_r`, s.rotulo.toUpperCase(), ESTILO.vermelhoClaro, ESTILO.fonteTexto, ESTILO.tamanhoRotulo, { negrito: true }),
    caixa(`${sid}_t`, sid, 'TEXT_BOX', m, Math.round(H * 0.13), W - 2 * m, Math.round(H * 0.15)),
    ...texto(`${sid}_t`, s.titulo.toUpperCase(), ESTILO.branco, ESTILO.fonteTitulo, s.titulo.length > 40 ? 24 : ESTILO.tamanhoTitulo),
    caixa(`${sid}_l`, sid, 'RECTANGLE', m, Math.round(H * 0.295), Math.round(W * 0.08), Math.round(H * 0.008)),
    fundo(`${sid}_l`, ESTILO.vermelho),
  ];
}
function rodape(sid, empresa, W, H, m) {
  return [
    caixa(`${sid}_f`, sid, 'TEXT_BOX', m, Math.round(H * 0.91), W - 2 * m, Math.round(H * 0.06)),
    ...texto(`${sid}_f`, `V4 COMPANY  ·  ${empresa.toUpperCase()}`, ESTILO.cinza, ESTILO.fonteTexto, ESTILO.tamanhoRodape, { negrito: true }),
  ];
}

// Lista em coluna única, largura total: cartões numerados (1–2 linhas cada).
function slideLista(sid, indice, s, { W, H, empresa }) {
  const m = Math.round(W * 0.055);
  const R = cabecalho(sid, indice, s, W, H, m);
  const topo = Math.round(H * 0.34);
  const area = Math.round(H * 0.54);
  const gap = Math.round(H * 0.012);
  const n = s.itens.length;
  const h = Math.min(Math.round(H * 0.1), Math.floor((area - gap * (n - 1)) / n));
  const tamanho = n > 6 ? 11 : 12;
  s.itens.forEach((t, i) => {
    const id = `${sid}_c${i}`;
    const num = String(i + 1).padStart(2, '0');
    R.push(
      caixa(id, sid, 'ROUND_RECTANGLE', m, topo + i * (h + gap), W - 2 * m, h), fundo(id, ESTILO.cartao),
      ...texto(id, `${num}   ${t}`, ESTILO.branco, ESTILO.fonteTexto, tamanho, { alinhamento: 'START' }),
      { updateTextStyle: { objectId: id, textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: num.length }, style: { foregroundColor: cor(ESTILO.amarelo), bold: true }, fields: 'foregroundColor,bold' } },
    );
  });
  return [...R, ...rodape(sid, empresa, W, H, m)];
}

// Investimento: itens com valor à esquerda; painel vermelho com a condição à direita.
function slideInvestimento(sid, indice, s, { W, H, empresa }) {
  const m = Math.round(W * 0.055);
  const R = cabecalho(sid, indice, s, W, H, m);
  const esqW = Math.round(W * 0.53);
  const topo = Math.round(H * 0.35);
  const gap = Math.round(H * 0.018);
  const blocoH = 4 * Math.round(H * 0.105) + 3 * gap;
  const n = Math.max(1, s.linhas.length);
  const h = Math.floor((blocoH - gap * (n - 1)) / n);
  s.linhas.forEach((l, i) => {
    const y = topo + i * (h + gap);
    const id = `${sid}_i${i}`;
    const rgb = l.destaque ? ESTILO.amarelo : ESTILO.branco;
    R.push(
      caixa(id, sid, 'ROUND_RECTANGLE', m, y, esqW, h), fundo(id, ESTILO.cartao),
      caixa(`${id}a`, sid, 'TEXT_BOX', m + Math.round(W * 0.012), y, Math.round(esqW * 0.72), h),
      ...texto(`${id}a`, cortar(l.texto), rgb, ESTILO.fonteTexto, n > 4 ? 11 : 12, { negrito: !!l.destaque }), meio(`${id}a`),
      caixa(`${id}b`, sid, 'TEXT_BOX', m + Math.round(esqW * 0.72), y, Math.round(esqW * 0.26), h),
      ...texto(`${id}b`, l.valor, rgb, ESTILO.fonteTexto, 14, { negrito: true, alinhamento: 'END' }), meio(`${id}b`),
    );
  });
  const px = (s.linhas.length ? m + esqW + Math.round(W * 0.025) : m);
  const pw = W - m - px;
  R.push(caixa(`${sid}_p`, sid, 'ROUND_RECTANGLE', px, topo, pw, blocoH), fundo(`${sid}_p`, ESTILO.vermelho));
  const blocos = [
    [s.condicao, ESTILO.branco, ESTILO.fonteTexto, 10, true, 0.04, 0.12],
    [s.desconto, ESTILO.amarelo, ESTILO.fonteTitulo, 20, false, 0.17, 0.14],
    [s.valor, ESTILO.branco, ESTILO.fonteTitulo, s.valor.length > 12 ? 30 : 40, false, 0.33, 0.26],
    [s.parcelas, ESTILO.branco, ESTILO.fonteTexto, 12, true, 0.62, 0.14],
    [s.dePor, ESTILO.branco, ESTILO.fonteTexto, 10, false, 0.78, 0.12],
  ];
  blocos.forEach(([t, rgb, fonte, tam, negrito, fy, fh], k) => {
    if (!t) return;
    const id = `${sid}_p${k}`;
    R.push(
      caixa(id, sid, 'TEXT_BOX', px + Math.round(pw * 0.06), topo + Math.round(blocoH * fy), Math.round(pw * 0.88), Math.round(blocoH * fh)),
      ...texto(id, t, rgb, fonte, tam, { negrito, alinhamento: 'CENTER' }), meio(id),
    );
  });
  if (s.rodape) {
    R.push(
      caixa(`${sid}_n`, sid, 'TEXT_BOX', m, Math.round(H * 0.86), W - 2 * m, Math.round(H * 0.1)),
      ...texto(`${sid}_n`, s.rodape, ESTILO.cinza, ESTILO.fonteTexto, 9),
    );
  } else R.push(...rodape(sid, empresa, W, H, m));
  return R;
}

// Pedidos do batchUpdate: apaga o que não é institucional e insere as seções.
// manter: objectIds dos slides institucionais (propostas_config.slides_curto);
// nenhum encontrado → fica só o primeiro slide (capa).
export function requestsDeckCurto(escopo, apresentacao, { manter = [], prefixo }) {
  const slides = apresentacao.slides || [];
  let fica = slides.filter((s) => manter.includes(s.objectId)).map((s) => s.objectId);
  if (!fica.length && slides.length) fica = [slides[0].objectId];
  const W = apresentacao.pageSize?.width?.magnitude ?? 9144000;
  const H = apresentacao.pageSize?.height?.magnitude ?? 5143500;
  const secoes = secoesCurto(escopo);
  const requests = slides.filter((s) => !fica.includes(s.objectId)).map((s) => ({ deleteObject: { objectId: s.objectId } }));
  secoes.forEach((s, k) => {
    const sid = `${prefixo}_k${k}`;
    const ctx = { W, H, empresa: escopo.cliente.empresa };
    requests.push(...(s.tipo === 'investimento' ? slideInvestimento(sid, fica.length + k, s, ctx) : slideLista(sid, fica.length + k, s, ctx)));
  });
  return { requests, secoes, mantidos: fica };
}
