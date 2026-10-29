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
5. PREÇO: só o que o closer FALOU na reunião. Valores em número (29750, não "29,7 mil"). Se não foi falado, use null. Nunca invente nem use tabela de preço. Em "citacoes" ponha os trechos literais onde o preço foi dito.
6. "dores": até 4 dores ditas pelo lead, cada uma com citação literal (origem "ia").
7. "pendencias": o que faltou para fechar a proposta (ex.: "preço da execução não foi falado").
8. Responda APENAS o JSON, sem texto antes ou depois.

FORMATO:
{"schema_version":"proposta-escopo/v0","cliente":{"empresa":"${empresa}","contato":null,"segmento":null,"modelo_venda":"inside_sales|pdv|ecommerce"},
 "contexto":{"dores":[{"texto":"","origem":"ia","citacao":""}]},
 "escopo":{"enfases":["id"],"semanas":[{"id":"s1","titulo":"Semana 1 — ...","itens":[{"catalogo_id":"id|null","texto":"","origem":"catalogo|ia","citacao":null}]}],"overdeliveries":[]},
 "plano_execucao":{"incluido":true,"faixa_midia":null,"itens":[]},
 "preco":{"estruturacao":{"valor_total":null,"parcelas":null,"valor_parcela":null,"condicao":null},"execucao_mensal":{"valor":null,"valor_com_social":null,"meses":null},"fonte":"transcricao","citacoes":[]},
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
  const citacoesPreco = (Array.isArray(bruto?.preco?.citacoes) ? bruto.preco.citacoes : [])
    .filter((c) => typeof c === 'string' && c.trim());
  const precoConferido = citacoesPreco.some((c) => citacaoNaTranscricao(c, tNorm));
  const temPreco = [est.valor_total, est.valor_parcela, exe.valor, exe.valor_com_social].some((v) => numero(v) != null);
  // Preço sem citação conferida não entra (o LLM pode ter "chutado"): vira pendência.
  const usarPreco = temPreco && precoConferido;
  if (temPreco && !precoConferido) pendencias.push('preço sugerido pela análise sem citação conferida na transcrição — confirme o valor');

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
      faixa_midia: textoOuNull(pe.faixa_midia),
      itens: lista(pe.itens, 'plano de execução'),
    },
    preco: {
      estruturacao: {
        valor_total: usarPreco ? numero(est.valor_total) : null,
        parcelas: usarPreco ? inteiro(est.parcelas) : null,
        valor_parcela: usarPreco ? numero(est.valor_parcela) : null,
        condicao: usarPreco ? textoOuNull(est.condicao) : null,
      },
      execucao_mensal: {
        valor: usarPreco ? numero(exe.valor) : null,
        valor_com_social: usarPreco ? numero(exe.valor_com_social) : null,
        meses: usarPreco ? inteiro(exe.meses) : null,
      },
      fonte: 'transcricao',
      citacoes: usarPreco ? citacoesPreco.filter((c) => citacaoNaTranscricao(c, tNorm)) : [],
    },
    pendencias: [...new Set(pendencias)],
  };
  return escopo;
}
