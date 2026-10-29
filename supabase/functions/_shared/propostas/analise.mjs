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
5. PREÇO: só o que o closer FALOU na reunião. Valores em número (29750, não "29,7 mil"). Se não foi falado, use null. Nunca invente nem use tabela de preço. Para CADA valor preenchido, ponha em "evidencias" o trecho LITERAL da transcrição onde aquele valor foi dito (com o número como foi falado). Estruturação é o valor do projeto; execução é o valor mensal; "execucao_com_social" só se o closer falou o valor do pacote COM social media.
5b. VALIDADE: a data até quando a proposta/condição vale, combinada na reunião ("validade" no formato dd/mm/aaaa ou dd/mm, com a evidência literal). Sem data falada: null.
5c. TAMANHO: "texto" de cada item com no máximo 90 caracteres; "titulo" de cada semana com no máximo 45 caracteres.
6. "dores": até 4 dores ditas pelo lead, cada uma com citação literal (origem "ia").
7. "pendencias": o que faltou para fechar a proposta (ex.: "preço da execução não foi falado").
8. Responda APENAS o JSON, sem texto antes ou depois.

FORMATO:
{"schema_version":"proposta-escopo/v0","cliente":{"empresa":"${empresa}","contato":null,"segmento":null,"modelo_venda":"inside_sales|pdv|ecommerce"},
 "contexto":{"dores":[{"texto":"","origem":"ia","citacao":""}]},
 "escopo":{"enfases":["id"],"semanas":[{"id":"s1","titulo":"Semana 1 — ...","itens":[{"catalogo_id":"id|null","texto":"","origem":"catalogo|ia","citacao":null}]}],"overdeliveries":[]},
 "plano_execucao":{"incluido":true,"faixa_midia":null,"itens":[]},
 "preco":{"estruturacao":{"valor_total":null,"parcelas":null,"valor_parcela":null,"condicao":null},"execucao_mensal":{"valor":null,"valor_com_social":null,"meses":null},"fonte":"transcricao","validade":null,"evidencias":{"valor_total":null,"parcelas":null,"valor_parcela":null,"execucao_valor":null,"execucao_com_social":null,"meses":null,"validade":null}},
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
  return normalizarComMapa(t).norm;
}

// Mesma normalização, guardando para cada caractere normalizado a posição no
// texto original (para localizar uma citação na transcrição de verdade).
export function normalizarComMapa(t) {
  const fonte = String(t || '');
  let norm = '';
  const mapa = [];
  for (let i = 0; i < fonte.length; i++) {
    const base = fonte[i].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const c of base) {
      if (/[a-z0-9]/.test(c)) { norm += c; mapa.push(i); }
      else if (norm && !norm.endsWith(' ')) { norm += ' '; mapa.push(i); }
    }
  }
  if (norm.endsWith(' ')) { norm = norm.slice(0, -1); mapa.pop(); }
  return { norm, mapa };
}

export function citacaoNaTranscricao(citacao, transcricaoNorm) {
  const c = normalizarTexto(citacao);
  return c.length >= 8 && transcricaoNorm.includes(c);
}

// Trechos [ini, fim) da transcrição ORIGINAL onde a citação aparece (palavras inteiras).
export function localizarCitacao(citacao, fonteMapa) {
  const c = normalizarTexto(citacao);
  const { norm, mapa } = fonteMapa;
  const spans = [];
  if (c.length < 8) return spans;
  for (let k = norm.indexOf(c); k >= 0; k = norm.indexOf(c, k + 1)) {
    const antes = k === 0 || norm[k - 1] === ' ';
    const depois = k + c.length === norm.length || norm[k + c.length] === ' ';
    if (antes && depois) spans.push([mapa[k], mapa[k + c.length - 1] + 1]);
  }
  return spans;
}

const MODELOS = ['inside_sales', 'pdv', 'ecommerce'];

const escaparRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Expressões monetárias completas, com posição: "R$ 29.750,00", "29750", "5 mil",
// "29,75 mil", "5k", "29 mil e 750". Não quebra número maior em pedaços ("750"
// de "29.750") e ignora quantidades ("12x", "6 meses").
const RE_DINHEIRO = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?:\s*(mil|k)\b(?:\s*e\s*(\d{1,3})\b)?)?/gi;
export function expressoesMonetarias(texto) {
  const t = String(texto || '').toLowerCase();
  const out = [];
  for (const m of t.matchAll(RE_DINHEIRO)) {
    const fim = m.index + m[0].length;
    if (/[\d.,]/.test(t[m.index - 1] || '')) continue;
    if (!m[3] && /^\s*(x\b|vezes|parcelas|meses|%)/.test(t.slice(fim))) continue;
    let v = Number(m[1].replace(/\./g, '')) + (m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0);
    if (m[3]) v = v * 1000 + (m[4] ? Number(m[4]) : 0);
    out.push({ valor: Math.round(v * 100) / 100, ini: m.index, fim });
  }
  return out;
}
export const valoresMonetarios = (texto) => expressoesMonetarias(texto).map((e) => e.valor);

// Pacote ao qual a FONTE prende um valor: 'com' (com social media), 'sem'
// (explicitamente sem), 'neutro' (não fala de social) ou 'ambiguo'.
// Olha a oração do valor (até vírgula/ponto); se ela não fala de social, a frase.
// Conservador: 'com' só com inclusão explícita e NENHUMA negação/exclusão no
// trecho (não dá para resolver o escopo da negação com segurança: "não vem com
// social", "sem o pacote com social"). 'sem' só com negação colada a social e
// nenhuma inclusão. Todo o resto que fala de social = 'ambiguo'.
const SOCIAL_NEG = /\b(sem|nao inclui|nao incluindo|nao incluso|exceto|tirando|fora o|fora a)\s+(o |a )?social\b/;
const SOCIAL_POS = /\b(com|incluindo|inclui|incluso|mais|somando|junto com)\s+(o |a )?social\b|\bsocial (media )?(incluso|incluido|junto)\b/;
const NEGACAO = /\b(nao|sem|nem|exceto|excluindo|excluido|tirando|retirando|fora|menos|salvo|nunca)\b/;
function polaridadeSocial(trechoNorm) {
  if (!/social/.test(trechoNorm)) return 'neutro';
  const pos = SOCIAL_POS.test(trechoNorm.replace(new RegExp(SOCIAL_NEG.source, 'g'), ' '));
  if (pos && !NEGACAO.test(trechoNorm)) return 'com';
  if (!pos && SOCIAL_NEG.test(trechoNorm)) return 'sem';
  return 'ambiguo';
}
function trechoAoRedor(fonte, ini, fim, separadores) {
  let a = 0;
  let b = fonte.length;
  for (const m of fonte.matchAll(separadores)) {
    if (m.index < ini) a = m.index + m[0].length;
    else if (m.index >= fim) { b = m.index; break; }
  }
  return fonte.slice(a, b);
}
export function pacoteDaExpressao(fonte, expr) {
  const oracao = normalizarTexto(trechoAoRedor(fonte, expr.ini, expr.fim, /[.!?;:,](?=\s)|\n/g));
  const frase = normalizarTexto(trechoAoRedor(fonte, expr.ini, expr.fim, /[.!?;](?=\s)|\n/g));
  const p = polaridadeSocial(oracao);
  // 'com' exige frase inteira sem negação/exclusão (o escopo da negação não é resolvido).
  if (p === 'com') return NEGACAO.test(frase) ? 'ambiguo' : 'com';
  if (p !== 'neutro') return p;
  return polaridadeSocial(frase);
}

// Papel do valor: execução é mensal/recorrente; com social precisa citar social;
// estruturação não pode vir de trecho mensal (a não ser que cite a estruturação).
const MENSAL = /(por mes|ao mes|mensal|mensais|mensalidade|recorren|execucao)/;
const ESTRUTURA = /(estrutura|setup|implementa|projeto|parcela|vezes|\d+x)/;
export function papelConfere(evidencia, papel) {
  const n = normalizarTexto(evidencia);
  if (papel === 'social') return MENSAL.test(n) && /social/.test(n);
  if (papel === 'execucao') return MENSAL.test(n);
  return !MENSAL.test(n) || ESTRUTURA.test(n);
}

// termo inteiro dentro de texto já normalizado (sem casar "2 meses" dentro de "12 meses")
export function contemTermo(textoNorm, termo) {
  return new RegExp(`(^| )${escaparRe(termo)}( |$)`).test(textoNorm);
}

// (datas)

// Datas com posição no texto original: "05/11", "5/11/2026", "5 de novembro",
// "dia 5 de novembro de 2026". Dia sem mês ("dia 5", "sexta") não conta: ambíguo.
const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const RE_DATA = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b(?!\s+d[oae]s?\b)|\b(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(\d{4}))?\b/gi;
export function datasNoTexto(texto) {
  const t = String(texto || '');
  const out = [];
  for (const m of t.matchAll(RE_DATA)) {
    let dia; let mes; let ano = null;
    if (m[1]) {
      // sem ano, "1/2" é fração, não data: exige dia ou mês com 2 dígitos ("5/11", "05/1")
      if (!m[3] && m[1].length < 2 && m[2].length < 2) continue;
      dia = Number(m[1]); mes = Number(m[2]); ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
    }
    else { dia = Number(m[4]); mes = MESES.indexOf(normalizarTexto(m[5])) + 1; ano = m[6] ? Number(m[6]) : null; }
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    out.push({ dia, mes, ano, ini: m.index, fim: m.index + m[0].length });
  }
  return out;
}
export const formatarData = (d) => `${String(d.dia).padStart(2, '0')}/${String(d.mes).padStart(2, '0')}${d.ano ? `/${d.ano}` : ''}`;
// Palavra inteira (texto normalizado): "material" não é "ate", e "até" sozinho não basta.
// Prazo/garantia/fechar/assinar/segurar também falam de entrega e reunião: só valem se a
// oração também fala de proposta/preço. "Vale a pena" não é validade.
const VALIDADE = /\b(valid[ao]s?|validade|vale|valem|valendo|condicao|condicoes)\b/;
const VALIDADE_FRACA = /\b(prazo|garantid[ao]s?|garanto|garantimos|fechar|fecha|fechamento|assinar|assina|assinatura|segurar|seguro|seguramos)\b/;
const ASSUNTO_PRECO = /\b(proposta|condicao|condicoes|valor|valores|preco|precos|desconto|investimento)\b/;
export function falaDeValidade(oracaoNorm) {
  const t = oracaoNorm.replace(/\bvalem? a pena\b/g, ' ');
  return VALIDADE.test(t) || (VALIDADE_FRACA.test(t) && ASSUNTO_PRECO.test(t));
}
const ORACAO = /[.!?;:,](?=\s)|\n/g;

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
  // O valor é lido na TRANSCRIÇÃO, não na citação: localiza a citação na fonte e
  // usa a expressão monetária inteira que está ali (citação cortada em "R$ 29" não
  // vale 29 se a fonte diz "R$ 29.750,00"). Papel do campo conferido; a mesma
  // expressão da fonte usada por dois campos = ambígua. Senão: null + pendência.
  const fonteMapa = normalizarComMapa(transcricao);
  const exprsFonte = expressoesMonetarias(transcricao);
  const evidenciaDe = (campo) => {
    const t = textoOuNull(ev[campo]);
    return t && citacaoNaTranscricao(t, tNorm) ? t : null;
  };
  const aceitos = [];
  const naoConfirmado = (rotulo) => pendencias.push(`${rotulo}: a análise sugeriu um valor que não foi confirmado na transcrição — confira`);
  const dinheiro = (campo, valor, papel, rotulo) => {
    if (valor == null) return null;
    const e = evidenciaDe(campo);
    if (!e || !papelConfere(e, papel)) { naoConfirmado(rotulo); return null; }
    const alvo = Math.round(valor * 100) / 100;
    const spans = localizarCitacao(e, fonteMapa);
    const exprs = exprsFonte.filter((x) => spans.some(([a, b]) => x.ini < b && x.fim > a));
    // Toda expressão tocada pela citação conta pelo valor que tem NA FONTE, e
    // pelo pacote que a fonte afirma para ela (com social x sem/neutro).
    const pacoteOk = (x) => {
      const pk = pacoteDaExpressao(transcricao, x);
      if (papel === 'social') return pk === 'com';
      if (papel === 'execucao') return pk === 'sem' || pk === 'neutro';
      return pk !== 'ambiguo' && pk !== 'com';
    };
    const casa = exprs.filter((x) => x.valor === alvo && pacoteOk(x));
    if (!casa.length) { naoConfirmado(rotulo); return null; }
    aceitos.push({ campo, posicoes: casa.map((x) => x.ini), rotulo });
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
      valor_com_social: dinheiro('execucao_com_social', numero(exe.valor_com_social), 'social', 'preço da execução com social media'),
      meses: quantidade('meses', inteiro(exe.meses), formasMeses, 'meses da execução'),
    },
    validade: null,
    fonte: 'transcricao',
    citacoes: [],
  };
  // Validade (decisão do Gabriel, 29/10): a data combinada na reunião, com a SUA
  // evidência; a data é lida na fonte (dia + mês explícitos) e o trecho precisa
  // falar de validade/prazo. Sem isso: null → [PREENCHER] + pendência.
  {
    const v = textoOuNull(bruto?.preco?.validade);
    if (v) {
      const alvo = datasNoTexto(v)[0];
      const e = evidenciaDe('validade');
      const spans = e ? localizarCitacao(e, fonteMapa) : [];
      // A data inteira dentro do trecho localizado, e a ORAÇÃO da fonte em volta dela
      // (não só o trecho escolhido pelo LLM) tem de falar de validade.
      const naFonte = datasNoTexto(transcricao).filter((d) => spans.some(([a, b]) => d.ini >= a && d.fim <= b));
      const oracaoDe = (d) => trechoAoRedor(transcricao, d.ini, d.fim, ORACAO).trim();
      const casa = alvo && e && falaDeValidade(normalizarTexto(e))
        ? naFonte.find((d) => d.dia === alvo.dia && d.mes === alvo.mes && (!alvo.ano || !d.ano || alvo.ano === d.ano)
          && falaDeValidade(normalizarTexto(oracaoDe(d))))
        : null;
      if (casa) {
        preco.validade = formatarData(casa);
        // mesmo aceita, o closer confere de onde a data saiu
        const trecho = oracaoDe(casa);
        pendencias.push(`validade ${formatarData(casa)} lida em: "${trecho.length > 140 ? `${trecho.slice(0, 140)}…` : trecho}" — confira`);
      } else pendencias.push('validade da proposta: data não confirmada na transcrição — confira');
    }
  }
  // A mesma expressão da fonte sustentando dois campos = papel ambíguo → nenhum.
  const LUGAR = {
    valor_total: ['estruturacao', 'valor_total'], valor_parcela: ['estruturacao', 'valor_parcela'],
    execucao_valor: ['execucao_mensal', 'valor'], execucao_com_social: ['execucao_mensal', 'valor_com_social'],
  };
  const ambiguos = new Set();
  for (const a of aceitos) {
    for (const b of aceitos) {
      if (a !== b && a.posicoes.some((p) => b.posicoes.includes(p))) { ambiguos.add(a); ambiguos.add(b); }
    }
  }
  for (const a of ambiguos) {
    const [grupo, chave] = LUGAR[a.campo];
    preco[grupo][chave] = null;
    pendencias.push(`${a.rotulo}: valor ambíguo na transcrição — confira`);
  }
  preco.citacoes = [...new Set(['valor_total', 'parcelas', 'valor_parcela', 'execucao_valor', 'execucao_com_social', 'meses', 'validade']
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
