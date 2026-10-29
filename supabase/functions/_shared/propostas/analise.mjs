// =============================================================
// Gerador de Propostas — transcrição → escopo (parte pura)
// =============================================================
// montarPrompt: instrução + catálogo compacto + transcrição.
// normalizarEscopo: pega o JSON do LLM e devolve um escopo no formato
// escopo.schema.json, sem confiar no modelo:
//  - empresa vem do deal (não do LLM);
//  - catalogo_id inexistente é descartado (item vira 'ia' e precisa citar);
//  - citação de item da IA e de preço é conferida contra a transcrição;
//    se não aparecer, o item sai e vira pendência;
//  - preço só número; texto/ilegível vira null + pendência.
// =============================================================

export function idsDoCatalogo(catalogo) {
  const ids = new Map();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (typeof o.id === 'string' && typeof o.texto === 'string') ids.set(o.id, o.texto);
      Object.values(o).forEach(walk);
    }
  };
  walk(catalogo);
  return ids;
}

function catalogoCompacto(c) {
  const linhas = [];
  for (const s of c.semanas) {
    linhas.push(`## ${s.id} — ${s.titulo}`);
    if (s.itens) for (const i of s.itens) linhas.push(`- ${i.id}: ${i.texto}`);
    if (s.variantes) {
      for (const [modelo, itens] of Object.entries(s.variantes)) {
        linhas.push(`  (variante ${modelo})`);
        for (const i of itens) linhas.push(`  - ${i.id}: ${i.texto}`);
      }
    }
  }
  linhas.push('## Ênfases (itens extras; use só se a conversa pedir)');
  for (const e of c.enfases) {
    linhas.push(`### ${e.id} — ${e.nome}`);
    for (const i of e.itens) linhas.push(`- ${i.id} [semana ${i.semana}]: ${i.texto}`);
  }
  linhas.push('## Overdeliveries sugeridos');
  for (const i of c.overdeliveries_sugeridos) linhas.push(`- ${i.id}: ${i.texto}`);
  linhas.push('## Execução (plano mensal)');
  for (const i of [...c.execucao.itens_padrao, ...c.execucao.adicionais]) linhas.push(`- ${i.id}: ${i.texto}`);
  return linhas.join('\n');
}

export function montarPrompt({ transcricao, catalogo, empresa, modeloVenda = null }) {
  return `Você monta o ESCOPO de uma proposta da V4 Company (Estruturação Estratégica + plano de execução) a partir da transcrição da reunião de vendas com o lead "${empresa}".

REGRAS (obrigatórias):
1. Escolha itens do CATÁLOGO pelo id ("catalogo_id") e adapte o texto ao lead com poucas palavras. Mantenha a estrutura de semanas s1, s2, s3, s4 (onboarding é opcional).
2. A Semana 3 usa a variante do modelo de venda do lead (inside_sales, pdv ou ecommerce).${modeloVenda ? ` Modelo informado: ${modeloVenda}.` : ''}
3. Ênfases e overdeliveries só entram se a conversa pedir ou o closer prometer. Item fora do catálogo: catalogo_id null, origem "ia" e "citacao" com um trecho LITERAL da transcrição (copiado, sem parafrasear).
4. Itens do catálogo sem adaptação específica: origem "catalogo", citacao null.
5. PREÇO: só o que o closer FALOU na reunião. Valores em número (29750, não "29,7 mil"). Se não foi falado, use null. Nunca invente nem use tabela de preço. Para CADA valor preenchido, ponha em "evidencias" o trecho LITERAL da transcrição onde aquele valor foi dito (com o número como foi falado). Estruturação é o valor do projeto; execução é o valor mensal.
6. "dores": até 4 dores ditas pelo lead, cada uma com citação literal (origem "ia").
7. "pendencias": o que faltou para fechar a proposta (ex.: "preço da execução não foi falado").
8. Responda APENAS o JSON, sem texto antes ou depois.

FORMATO:
{"schema_version":"proposta-escopo/v0","cliente":{"empresa":"${empresa}","contato":null,"segmento":null,"modelo_venda":"inside_sales|pdv|ecommerce"},
 "contexto":{"dores":[{"texto":"","origem":"ia","citacao":""}]},
 "escopo":{"enfases":["id"],"semanas":[{"id":"s1","titulo":"Semana 1 — ...","itens":[{"catalogo_id":"id|null","texto":"","origem":"catalogo|ia","citacao":null}]}],"overdeliveries":[]},
 "plano_execucao":{"incluido":true,"faixa_midia":null,"itens":[]},
 "preco":{"estruturacao":{"valor_total":null,"parcelas":null,"valor_parcela":null,"condicao":null},"execucao_mensal":{"valor":null,"valor_com_social":null,"meses":null},"fonte":"transcricao","evidencias":{"valor_total":null,"parcelas":null,"valor_parcela":null,"execucao_valor":null,"execucao_com_social":null,"meses":null}},
 "pendencias":[]}

CATÁLOGO (versão ${catalogo.versao}):
${catalogoCompacto(catalogo)}

TRANSCRIÇÃO:
${transcricao}`;
}

// Extrai o primeiro objeto JSON da resposta (o modelo às vezes cerca com ```json).
export function extrairJson(texto) {
  if (typeof texto !== 'string') throw new Error('resposta do LLM vazia');
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) throw new Error('resposta do LLM sem JSON');
  return JSON.parse(texto.slice(ini, fim + 1));
}

// Comparação tolerante: minúsculas, sem acento, sem pontuação, espaços colapsados.
export function normalizarTexto(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function citacaoNaTranscricao(citacao, transcricaoNorm) {
  const c = normalizarTexto(citacao);
  return c.length >= 8 && transcricaoNorm.includes(c);
}

const MODELOS = ['inside_sales', 'pdv', 'ecommerce'];

const escaparRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Expressões monetárias completas de um trecho: "R$ 29.750,00", "29750", "5 mil",
// "29,75 mil", "5k", "29 mil e 750". Não quebra número maior em pedaços ("750"
// de "29.750") e ignora quantidades ("12x", "6 meses").
const RE_DINHEIRO = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?:\s*(mil|k)\b(?:\s*e\s*(\d{1,3})\b)?)?/gi;
export function valoresMonetarios(texto) {
  const t = String(texto || '').toLowerCase();
  const out = [];
  for (const m of t.matchAll(RE_DINHEIRO)) {
    const fim = m.index + m[0].length;
    if (/[\d.,]/.test(t[m.index - 1] || '')) continue;
    if (!m[3] && /^\s*(x\b|vezes|parcelas|meses|%)/.test(t.slice(fim))) continue;
    let v = Number(m[1].replace(/\./g, '')) + (m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0);
    if (m[3]) v = v * 1000 + (m[4] ? Number(m[4]) : 0);
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

// Papel do valor: execução é mensal/recorrente; estruturação não pode vir de
// um trecho que fala de valor mensal (a não ser que cite a estruturação).
const MENSAL = /(por mes|ao mes|mensal|mensais|mensalidade|recorren|execucao)/;
const ESTRUTURA = /(estrutura|setup|implementa|projeto|parcela|vezes|\d+x)/;
export function papelConfere(evidencia, papel) {
  const n = normalizarTexto(evidencia);
  if (papel === 'execucao') return MENSAL.test(n);
  return !MENSAL.test(n) || ESTRUTURA.test(n);
}

// termo inteiro dentro de texto já normalizado (sem casar "2 meses" dentro de "12 meses")
export function contemTermo(textoNorm, termo) {
  return new RegExp(`(^| )${escaparRe(termo)}( |$)`).test(textoNorm);
}

export const formasParcelas = (p) => [`${p}x`, `${p} x`, `${p} vezes`, `${p} parcelas`];
export const formasMeses = (m) => [`${m} meses`];

function numero(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return null;
}
function inteiro(v) {
  return Number.isInteger(v) && v >= 1 ? v : null;
}
const textoOuNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function normalizarEscopo(bruto, { catalogo, empresa, transcricao, modeloVenda = null }) {
  const ids = idsDoCatalogo(catalogo);
  const tNorm = normalizarTexto(transcricao);
  const pendencias = Array.isArray(bruto?.pendencias) ? bruto.pendencias.filter((p) => typeof p === 'string' && p.trim()) : [];

  const item = (i, onde) => {
    if (!i || typeof i.texto !== 'string' || !i.texto.trim()) return null;
    let catalogo_id = typeof i.catalogo_id === 'string' && ids.has(i.catalogo_id) ? i.catalogo_id : null;
    let origem = catalogo_id && i.origem !== 'ia' ? 'catalogo' : 'ia';
    const citacao = textoOuNull(i.citacao);
    if (origem === 'ia') {
      if (!citacao || !citacaoNaTranscricao(citacao, tNorm)) {
        pendencias.push(`${onde}: item sugerido sem citação conferida na transcrição — "${i.texto.trim()}"`);
        return null;
      }
    }
    return { catalogo_id, texto: i.texto.trim(), origem, citacao: origem === 'ia' ? citacao : null };
  };
  const lista = (arr, onde) => (Array.isArray(arr) ? arr.map((i) => item(i, onde)).filter(Boolean) : []);

  let modelo = MODELOS.includes(modeloVenda) ? modeloVenda : MODELOS.includes(bruto?.cliente?.modelo_venda) ? bruto.cliente.modelo_venda : null;
  if (!modelo) { modelo = 'inside_sales'; pendencias.push('modelo de venda não identificado (usei inside_sales)'); }

  const semanas = (Array.isArray(bruto?.escopo?.semanas) ? bruto.escopo.semanas : [])
    .filter((s) => s && typeof s.id === 'string')
    .map((s) => ({ id: s.id, titulo: textoOuNull(s.titulo) || s.id, itens: lista(s.itens, `semana ${s.id}`) }))
    .filter((s) => s.itens.length);
  if (!semanas.length) pendencias.push('escopo vazio: monte as semanas na revisão');

  const enfasesValidas = new Set(catalogo.enfases.map((e) => e.id));
  const est = bruto?.preco?.estruturacao || {};
  const exe = bruto?.preco?.execucao_mensal || {};
  const ev = bruto?.preco?.evidencias && typeof bruto.preco.evidencias === 'object' ? bruto.preco.evidencias : {};
  // Cada campo de preço tem a SUA evidência (trecho literal da transcrição).
  // O valor só entra se: a evidência está na transcrição, contém a expressão
  // monetária completa igual ao valor e combina com o papel do campo
  // (estruturação x execução mensal). Senão: null + pendência. Nunca chuta.
  const evidenciaDe = (campo) => {
    const t = textoOuNull(ev[campo]);
    return t && citacaoNaTranscricao(t, tNorm) ? t : null;
  };
  const aceitos = [];
  const dinheiro = (campo, valor, papel, rotulo) => {
    if (valor == null) return null;
    const e = evidenciaDe(campo);
    const ok = e && valoresMonetarios(e).includes(Math.round(valor * 100) / 100) && papelConfere(e, papel);
    if (!ok) {
      pendencias.push(`${rotulo}: a análise sugeriu um valor que não foi confirmado na transcrição — confira`);
      return null;
    }
    aceitos.push({ campo, valor, evidencia: normalizarTexto(e), rotulo });
    return valor;
  };
  const quantidade = (campo, valor, formas, rotulo) => {
    if (valor == null) return null;
    const e = evidenciaDe(campo);
    if (e && formas(valor).some((f) => contemTermo(normalizarTexto(e), f))) return valor;
    pendencias.push(`${rotulo}: não confirmado na transcrição — confira`);
    return null;
  };
  const textoConferido = (t, rotulo) => {
    const v = textoOuNull(t);
    if (v == null) return null;
    if (citacaoNaTranscricao(v, tNorm)) return v;
    pendencias.push(`${rotulo}: não confirmado na transcrição — confira`);
    return null;
  };
  const preco = {
    estruturacao: {
      valor_total: dinheiro('valor_total', numero(est.valor_total), 'estruturacao', 'preço da estruturação'),
      parcelas: quantidade('parcelas', inteiro(est.parcelas), formasParcelas, 'parcelas'),
      valor_parcela: dinheiro('valor_parcela', numero(est.valor_parcela), 'estruturacao', 'valor da parcela'),
      condicao: textoConferido(est.condicao, 'condição de pagamento'),
    },
    execucao_mensal: {
      valor: dinheiro('execucao_valor', numero(exe.valor), 'execucao', 'preço da execução'),
      valor_com_social: dinheiro('execucao_com_social', numero(exe.valor_com_social), 'execucao', 'preço da execução com social media'),
      meses: quantidade('meses', inteiro(exe.meses), formasMeses, 'meses da execução'),
    },
    fonte: 'transcricao',
    citacoes: [],
  };
  // Mesmo valor e mesma evidência em dois campos = papel ambíguo → nenhum dos dois.
  for (const a of aceitos) {
    const dupla = aceitos.filter((b) => b.valor === a.valor && b.evidencia === a.evidencia);
    if (dupla.length > 1) {
      for (const b of dupla) {
        const [grupo, chave] = {
          valor_total: ['estruturacao', 'valor_total'], valor_parcela: ['estruturacao', 'valor_parcela'],
          execucao_valor: ['execucao_mensal', 'valor'], execucao_com_social: ['execucao_mensal', 'valor_com_social'],
        }[b.campo];
        if (preco[grupo][chave] != null) pendencias.push(`${b.rotulo}: valor ambíguo na transcrição — confira`);
        preco[grupo][chave] = null;
      }
    }
  }
  preco.citacoes = [...new Set(['valor_total', 'parcelas', 'valor_parcela', 'execucao_valor', 'execucao_com_social', 'meses']
    .map(evidenciaDe).filter(Boolean))];

  const pe = bruto?.plano_execucao || {};
  const escopo = {
    schema_version: 'proposta-escopo/v0',
    catalogo_versao: catalogo.versao,
    cliente: {
      empresa,
      contato: textoOuNull(bruto?.cliente?.contato),
      segmento: textoOuNull(bruto?.cliente?.segmento),
      modelo_venda: modelo,
    },
    contexto: { dores: lista(bruto?.contexto?.dores, 'dores').slice(0, 4) },
    escopo: {
      enfases: (Array.isArray(bruto?.escopo?.enfases) ? bruto.escopo.enfases : []).filter((e) => enfasesValidas.has(e)),
      semanas: semanas.length ? semanas : [{ id: 's1', titulo: 'Semana 1', itens: [{ catalogo_id: null, texto: '[PREENCHER: escopo]', origem: 'closer', citacao: null }] }],
      overdeliveries: lista(bruto?.escopo?.overdeliveries, 'overdeliveries'),
    },
    plano_execucao: {
      incluido: pe.incluido !== false,
      faixa_midia: textoConferido(pe.faixa_midia, 'faixa de mídia'),
      itens: lista(pe.itens, 'plano de execução'),
    },
    preco,
    pendencias: [...new Set(pendencias)],
  };
  return escopo;
}
