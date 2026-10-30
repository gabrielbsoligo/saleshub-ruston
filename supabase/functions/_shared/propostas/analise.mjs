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

// Portfólio V4 (catálogo v1): só nome e categoria STEP. O valor base não vai ao
// prompt: preço é sempre o falado na reunião.
function portfolioCompacto(c) {
  const linhas = [];
  for (const step of ['ter', 'executar', 'saber', 'destrava_receita', 'potencializar']) {
    const ps = (c.produtos || []).filter((p) => p.step === step);
    if (!ps.length) continue;
    linhas.push(`## ${step.toUpperCase()}`);
    for (const p of ps) linhas.push(`- ${p.id}: ${p.nome}`);
  }
  return linhas.join('\n');
}

export function tiposDeOferta(catalogo) {
  return (catalogo.tipos_oferta || []).map((t) => t.id);
}

export function montarPrompt({ transcricao, catalogo, empresa, modeloVenda = null, tipoOferta = null }) {
  const tipos = catalogo.tipos_oferta || [];
  const comTipos = tipos.length > 0;
  const forcado = comTipos && tiposDeOferta(catalogo).includes(tipoOferta) ? tipoOferta : null;
  const passoTipo = comTipos ? `
PASSO 1 — TIPO DE OFERTA. Antes do escopo, classifique o que o closer OFERECEU na reunião (não o que a V4 costuma vender):
${tipos.map((t) => `- ${t.id} (${t.nome}, STEP ${t.step}): ${t.quando}`).join('\n')}
Ponha em "oferta" o tipo e uma citação literal que mostre a oferta.${forcado ? ` O closer já escolheu o tipo: ${forcado}. Use este.` : ''}
Se o tipo for "estruturacao", siga as regras 1 a 4 (semanas). Se NÃO for, deixe "escopo.semanas" vazio, "plano_execucao.incluido" false, e preencha "entregaveis" (regra 4b) e "preco.oferta" (regra 5d).
` : '';
  return `Você monta o ESCOPO de uma proposta da V4 Company a partir da transcrição da reunião de vendas com o lead "${empresa}".
${passoTipo}
REGRAS (obrigatórias):
1. (Estruturação) Escolha itens do CATÁLOGO pelo id ("catalogo_id") e adapte o texto ao lead com poucas palavras. Traga SEMPRE as quatro semanas s1, s2, s3 e s4, cada uma com os itens do catálogo que fazem sentido para o lead (onboarding é opcional); no plano de execução, liste os itens padrão (ex_*) e os adicionais combinados.
2. A Semana 3 usa a variante do modelo de venda do lead (inside_sales, pdv ou ecommerce).${modeloVenda ? ` Modelo informado: ${modeloVenda}.` : ''}
3. Ênfases e overdeliveries só entram se a conversa pedir ou o closer prometer. Item fora do catálogo: catalogo_id null, origem "ia" e "citacao" com um trecho LITERAL da transcrição (copiado, sem parafrasear).
4. Itens do catálogo sem adaptação específica: origem "catalogo", citacao null.
4b. (Outros tipos) "entregaveis": cada entregável que o closer ofereceu, com "produto_id" do PORTFÓLIO V4 quando corresponder (senão null), "titulo" (nome curto do entregável, até 5 palavras, ex.: "Landing page", "CRM com IA"), "texto" (o detalhe adaptado ao lead, frase de até ~12 palavras, sem repetir o título), "citacao" literal OBRIGATÓRIA (onde o closer ofereceu aquele item), "recorrencia" ("unico" para projeto/implementação, "mensal" para serviço recorrente) e, se o closer falou o preço DAQUELE item, "valor" e "evidencia_valor" (trecho literal com o número). Só o que foi oferecido: nada do catálogo da Estruturação.
5. PREÇO: só o que o closer FALOU na reunião. Valores em número (29750, não "29,7 mil"). Se não foi falado, use null. Nunca invente nem use tabela de preço. Para CADA valor preenchido, ponha em "evidencias" o trecho LITERAL da transcrição onde aquele valor foi dito (com o número como foi falado). Estruturação é o valor do projeto; execução é o valor mensal; "execucao_com_social" só se o closer falou o valor do pacote COM social media.
5b. VALIDADE: até quando a proposta/condição vale, como combinado na reunião. Data explícita: "validade" no formato dd/mm/aaaa ou dd/mm. Prazo relativo ("hoje", "amanhã", "fim do mês", "sexta-feira", "essa semana"): escreva o termo como foi dito (ex.: "hoje"). Sempre com a evidência literal. Nada combinado: null.
5c. TAMANHO: "texto" de cada item é UMA frase de até ~12 palavras (no máximo 90 caracteres), direta, sem rodeio; "titulo" de cada semana com no máximo 45 caracteres. O limite vale para "texto", nunca para "citacao" (que segue a regra 6b).
5d. (Outros tipos) "preco.oferta": "valor_tabela" (preço cheio falado, antes de desconto), "desconto_percentual" (só o número, ex.: 20), "valor_final" (o valor a pagar com o desconto, como foi falado), "parcelas", "valor_parcela" e "recorrencia" ("unico" ou "mensal"), cada um com sua evidência literal em "preco.oferta.evidencias".
5e. "custos_terceiros": custos pagos pelo cliente direto a terceiros e que NÃO estão no preço (ferramenta, licença, verba de mídia), com "texto", "valor", "periodicidade" ("mensal", "unico" ou null se não foi dito) e "evidencia" literal.
5f. "etapa2": se o closer apresentou uma PRÓXIMA ETAPA opcional (ex.: assessoria mensal depois da implementação), "incluida": true, "itens" (texto + citação literal, origem "ia"), "valor_mensal", "verba_midia" (lista de {"canal","valor","evidencia"}) e "evidencias" ({"quando","valor_mensal"}). Senão "incluida": false.
6. "dores": até 4 dores ditas pelo lead, cada uma com citação literal (origem "ia").
6a. Contexto (opcional, até 4 itens cada, com citação literal, origem "ia"): "publico" (quem o lead quer atingir, região), "concorrentes" (citados por nome), "cliente_fornece" (o que o lead vai fornecer: fotos, acessos...), "proximos_passos" (decisor, retorno combinado, prazos).
6b. CITAÇÕES e EVIDÊNCIAS: copie de 6 a 20 palavras SEGUIDAS de uma única fala da transcrição (se a fala inteira tiver menos de 6 palavras, copie a fala inteira), exatamente como estão escritas (inclusive erros de transcrição e números como "6,500"), sem juntar falas, resumir ou corrigir. Citação que não for cópia exata é descartada.
7. "pendencias": o que faltou para fechar a proposta (ex.: "preço da execução não foi falado").
8. Responda APENAS o JSON, sem texto antes ou depois.

FORMATO:
{"schema_version":"proposta-escopo/v1",${comTipos ? `"oferta":{"tipo":"${tiposDeOferta(catalogo).join('|')}","citacao":""},` : ''}"cliente":{"empresa":"${empresa}","contato":null,"segmento":null,"modelo_venda":"inside_sales|pdv|ecommerce"},
 "contexto":{"dores":[{"texto":"","origem":"ia","citacao":""}],"publico":[],"concorrentes":[],"cliente_fornece":[],"proximos_passos":[]},
 "escopo":{"enfases":["id"],"semanas":[{"id":"s1","titulo":"Semana 1 — ...","itens":[{"catalogo_id":"id|null","texto":"","origem":"catalogo|ia","citacao":null}]}],"overdeliveries":[]},
 "entregaveis":[{"produto_id":"id|null","titulo":"","texto":"","citacao":"","recorrencia":"unico|mensal","valor":null,"evidencia_valor":null}],
 "plano_execucao":{"incluido":true,"faixa_midia":null,"itens":[]},
 "preco":{"estruturacao":{"valor_total":null,"parcelas":null,"valor_parcela":null,"condicao":null},"execucao_mensal":{"valor":null,"valor_com_social":null,"meses":null},"oferta":{"valor_tabela":null,"desconto_percentual":null,"valor_final":null,"parcelas":null,"valor_parcela":null,"recorrencia":"unico","evidencias":{"valor_tabela":null,"desconto":null,"valor_final":null,"parcelas":null,"valor_parcela":null}},"fonte":"transcricao","validade":null,"evidencias":{"valor_total":null,"parcelas":null,"valor_parcela":null,"execucao_valor":null,"execucao_com_social":null,"meses":null,"validade":null}},
 "custos_terceiros":[{"texto":"","valor":null,"periodicidade":null,"evidencia":""}],
 "etapa2":{"incluida":false,"itens":[],"valor_mensal":null,"verba_midia":[],"evidencias":{"quando":null,"valor_mensal":null}},
 "pendencias":[]}

CATÁLOGO DA ESTRUTURAÇÃO (versão ${catalogo.versao}):
${catalogoCompacto(catalogo)}
${comTipos ? `
PORTFÓLIO V4 (produtos avulsos por categoria STEP; use o id em "produto_id"):
${portfolioCompacto(catalogo)}
` : ''}
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
// "6,500" (a transcrição do Meet às vezes separa milhar com vírgula; centavos têm 2 dígitos),
// "29,75 mil", "5k", "29 mil e 750". Não quebra número maior em pedaços ("750"
// de "29.750") e ignora quantidades ("12x", "6 meses").
const RE_DINHEIRO = /(\d{1,3}(?:[.,]\d{3})+(?!\d)|\d+)(?:,(\d{1,2}))?(?:\s*(mil|k)\b(?:\s*e\s*(\d{1,3})\b)?)?/gi;
export function expressoesMonetarias(texto) {
  const t = String(texto || '').toLowerCase();
  const out = [];
  for (const m of t.matchAll(RE_DINHEIRO)) {
    const fim = m.index + m[0].length;
    if (/[\d.,]/.test(t[m.index - 1] || '')) continue;
    if (!m[3] && /^\s*(x\b|vezes|parcelas|meses|%)/.test(t.slice(fim))) continue;
    let v = Number(m[1].replace(/[.,]/g, '')) + (m[2] ? Number(m[2].padEnd(2, '0')) / 100 : 0);
    if (m[3]) v = v * 1000 + (m[4] ? Number(m[4]) : 0);
    out.push({ valor: Math.round(v * 100) / 100, ini: m.index, fim });
    // "29,750 mil": a vírgula também pode ser decimal; as duas leituras ficam no mesmo
    // trecho e o número proposto pelo LLM escolhe.
    if (m[3] && !m[2] && /^\d{1,3},\d{3}$/.test(m[1])) {
      const alt = Number(m[1].replace(',', '.')) * 1000 + (m[4] ? Number(m[4]) : 0);
      out.push({ valor: Math.round(alt * 100) / 100, ini: m.index, fim });
    }
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
  if (papel === 'qualquer') return true;
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
// Data de entrega/início/reunião na mesma oração: só conta com "válido/validade" explícito.
const ENTREGA = /\b(entrega|entregar|entregamos|comecar|comeca|comeco|comecamos|comecarmos|inicio|iniciar|iniciamos|kickoff|onboarding|reuniao|lancamento)\b/;
const VALIDADE_EXPLICITA = /\b(valid[ao]s?|validade)\b/;
export function falaDeValidade(oracaoNorm) {
  const t = oracaoNorm.replace(/\bvalem? a pena\b/g, ' ');
  if (ENTREGA.test(t) && !VALIDADE_EXPLICITA.test(t)) return false;
  return VALIDADE.test(t) || (VALIDADE_FRACA.test(t) && ASSUNTO_PRECO.test(t));
}
const ORACAO = /[.!?;:,](?=\s)|\n/g;

// Validade relativa (P4): "hoje", "amanhã", "fim do mês", "essa semana", "sexta-feira"
// viram data pela data da reunião. O trecho precisa falar de validade; "fechar/prazo/assinar"
// só valem se o trecho ou o que vem logo depois na fala (depois: texto original, ~150
// caracteres) fala de preço/desconto ("para esse fechamento hoje… consigo tirar 20%").
// "Vamos fechar por hoje" e data de entrega/início não contam (Vedor, 30/10).
const DESCONTO = /\b(desconto|descontos|descontar|tirar|tiro|tirando|abat\w*|reduz\w*|menos|off|baix\w*|bonific\w*)\b/;
const PRECO_PERTO =/\b(proposta|condicao|condicoes|valor|valores|preco|precos|desconto|investimento|tirar|tiro|parcel\w*|vezes)\b/;
export function falaDeValidadeRelativa(norm, depois = '') {
  const t = norm.replace(/\bvalem? a pena\b/g, ' ');
  if (ENTREGA.test(t) && !VALIDADE_EXPLICITA.test(t)) return false;
  if (VALIDADE.test(t)) return true;
  if (!VALIDADE_FRACA.test(t)) return false;
  return PRECO_PERTO.test(t) || PRECO_PERTO.test(normalizarTexto(depois)) || /\d\s*%/.test(depois);
}
const DIAS_SEMANA = { segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5 };
const somarDias = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const proximoDiaSemana = (d, alvo) => somarDias(d, (alvo - d.getUTCDay() + 7) % 7);
// dataReuniao: 'aaaa-mm-dd'. Devolve { data: 'dd/mm/aaaa', termo } com a data mais cedo
// citada, ou null se o trecho não traz prazo relativo reconhecível.
export function resolverValidadeRelativa(evidenciaNorm, dataReuniao) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dataReuniao || ''));
  if (!m) return null;
  const base = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const achados = [];
  const t = evidenciaNorm;
  if (/\bhoje\b/.test(t)) achados.push(['hoje', base]);
  if (/\bamanha\b/.test(t)) achados.push(['amanhã', somarDias(base, 1)]);
  if (/\b(fim|final) (do |de |desse |deste |nesse |neste )?mes\b/.test(t)) {
    achados.push(['fim do mês', new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0))]);
  }
  if (/\b(fim|final) (da |de |dessa |desta |nessa |nesta )?semana\b|\b(essa|esta|nessa|nesta) semana\b/.test(t)) {
    achados.push(['esta semana', proximoDiaSemana(base, 5)]);
  }
  // "segunda" sozinha é ordinal ("segunda etapa"): dia da semana só com "feira" ou "até/na ...".
  for (const [nome, n] of Object.entries(DIAS_SEMANA)) {
    if (new RegExp(`\\b${nome} feira\\b|\\b(ate|na|nesta|nessa|essa|esta) ${nome}\\b(?! (etapa|etapas|fase|fases|parte|vez|parcela|opcao|proposta|reuniao|call|semana))`).test(t)) {
      achados.push([`${nome}-feira`, proximoDiaSemana(base, n)]);
    }
  }
  if (!achados.length) return null;
  achados.sort((a, b) => a[1] - b[1]);
  const [termo, d] = achados[0];
  return { data: formatarData({ dia: d.getUTCDate(), mes: d.getUTCMonth() + 1, ano: d.getUTCFullYear() }), termo };
}
const formatarDataIso = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };

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
// Título curto do entregável (contrato com a camada visual: "Título: detalhe", até 5 palavras).
// Mais longo, com dois-pontos ou repetindo o texto inteiro: null (o deck usa só o texto).
export function tituloCurto(titulo, texto = '') {
  const t = textoOuNull(titulo)?.replace(/[.;:,\s]+$/, '');
  if (!t || /:/.test(t) || t.split(/\s+/).length > 5) return null;
  if (normalizarTexto(t) === normalizarTexto(texto)) return null;
  return t;
}

// dataReuniao ('aaaa-mm-dd'): base da validade relativa; dataAssumida = não veio da reunião
// (ex.: transcrição colada), vira aviso. tipoOferta: escolhido pelo closer (vence a IA).
export function normalizarEscopo(bruto, { catalogo, empresa, transcricao, modeloVenda = null, tipoOferta = null, dataReuniao = null, dataAssumida = false }) {
  const ids = idsDoCatalogo(catalogo);
  const tNorm = normalizarTexto(transcricao);
  const pendencias = Array.isArray(bruto?.pendencias) ? bruto.pendencias.filter((p) => typeof p === 'string' && p.trim()) : [];

  // Tipo de oferta (P1). Catálogo sem tipos (v0) = sempre Estruturação.
  const tipos = catalogo.tipos_oferta || [];
  let oferta = { tipo: 'estruturacao', origem: 'padrao', citacao: null };
  if (tipos.length) {
    const citOferta = textoOuNull(bruto?.oferta?.citacao);
    const citacao = citOferta && citacaoNaTranscricao(citOferta, tNorm) ? citOferta : null;
    if (tipos.some((t) => t.id === tipoOferta)) oferta = { tipo: tipoOferta, origem: 'closer', citacao };
    else if (tipos.some((t) => t.id === bruto?.oferta?.tipo)) oferta = { tipo: bruto.oferta.tipo, origem: 'ia', citacao };
    else pendencias.push('tipo de oferta não identificado: usei Estruturação — se não for, gere de novo escolhendo o tipo');
    // Só avisa quando a IA tirou do deck completo (senão a frase vira ruído em toda Estruturação).
    if (oferta.origem === 'ia' && oferta.tipo !== 'estruturacao') {
      const nome = tipos.find((t) => t.id === oferta.tipo).nome;
      pendencias.push(`tipo de oferta identificado pela IA: ${nome}${citacao ? ` ("${citacao}")` : ''} — se não for, gere de novo escolhendo o tipo`);
    }
  }
  const ehEstruturacao = oferta.tipo === 'estruturacao';

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
  if (!modelo) { modelo = 'inside_sales'; if (ehEstruturacao) pendencias.push('modelo de venda não identificado (usei inside_sales)'); }

  // Semana repetida (duas "s1") é uma só: itens juntados, título da primeira.
  const daAnalise = [];
  const vieram = new Set();
  // Fora da Estruturação não há semanas (a IA às vezes manda mesmo assim).
  for (const s of ehEstruturacao && Array.isArray(bruto?.escopo?.semanas) ? bruto.escopo.semanas : []) {
    if (!s || typeof s.id !== 'string') continue;
    vieram.add(s.id);
    const itens = lista(s.itens, `semana ${s.id}`);
    const ja = daAnalise.find((x) => x.id === s.id);
    if (ja) ja.itens.push(...itens);
    else daAnalise.push({ id: s.id, titulo: textoOuNull(s.titulo) || s.id, itens });
  }
  for (let k = daAnalise.length - 1; k >= 0; k--) if (!daAnalise[k].itens.length) daAnalise.splice(k, 1);
  // A proposta padrão (EE 2026) tem as Semanas 1 a 4: a que a análise omitiu ou
  // esvaziou entra com os itens do catálogo (S3 pela variante do modelo) e vira
  // pendência para o closer revisar. Ordem do catálogo; ids extras vão ao fim.
  const ordem = catalogo.semanas.map((s) => s.id);
  const semanas = [];
  for (const s of ehEstruturacao ? catalogo.semanas : []) {
    const veio = daAnalise.find((x) => x.id === s.id);
    if (veio) { semanas.push(veio); continue; }
    if (s.id === 'onboarding') continue;
    const nomeModelo = catalogo.modelos_venda.find((m) => m.id === modelo)?.nome || modelo;
    semanas.push({
      id: s.id,
      titulo: s.variantes ? `${s.titulo} (${nomeModelo})` : s.titulo,
      itens: (s.itens || s.variantes?.[modelo] || []).map((i) => ({ catalogo_id: i.id, texto: i.texto, origem: 'catalogo', citacao: null })),
    });
    const nome = s.titulo.split(' — ')[0];
    pendencias.push(vieram.has(s.id)
      ? `${nome} ficou sem itens válidos: entrou com os itens padrão do catálogo — revise`
      : `${nome} não veio da análise: entrou com os itens padrão do catálogo — revise`);
  }
  semanas.push(...daAnalise.filter((x) => !ordem.includes(x.id)));

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
  const conferida = (t0) => {
    const t = textoOuNull(t0);
    return t && citacaoNaTranscricao(t, tNorm) ? t : null;
  };
  const evidenciaDe = (campo) => conferida(ev[campo]);
  const aceitos = [];
  const naoConfirmado = (rotulo) => pendencias.push(`${rotulo}: a análise sugeriu um valor que não foi confirmado na transcrição — confira`);
  // campo = chave para a checagem de ambiguidade (null = não entra nela).
  const dinheiro = (campo, valor, papel, rotulo, evidencia = evidenciaDe(campo), { silencioso = false } = {}) => {
    if (valor == null) return null;
    const e = conferida(evidencia);
    const falhou = () => { if (!silencioso) naoConfirmado(rotulo); return null; };
    if (!e || !papelConfere(e, papel)) return falhou();
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
    if (!casa.length) return falhou();
    if (campo) aceitos.push({ campo, posicoes: casa.map((x) => x.ini), rotulo });
    return valor;
  };
  const quantidade = (campo, valor, formas, rotulo, evidencia = evidenciaDe(campo)) => {
    if (valor == null) return null;
    const e = conferida(evidencia);
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
  // Fora da Estruturação os campos de estruturação/execução não valem (a oferta tem o seu preço).
  const soEstr = (f) => (ehEstruturacao ? f() : null);
  const preco = {
    estruturacao: {
      valor_total: soEstr(() => dinheiro('valor_total', numero(est.valor_total), 'estruturacao', 'preço da estruturação')),
      parcelas: soEstr(() => quantidade('parcelas', inteiro(est.parcelas), formasParcelas, 'parcelas')),
      valor_parcela: soEstr(() => dinheiro('valor_parcela', numero(est.valor_parcela), 'estruturacao', 'valor da parcela')),
      condicao: soEstr(() => textoConferido(est.condicao, 'condição de pagamento')),
    },
    execucao_mensal: {
      valor: soEstr(() => dinheiro('execucao_valor', numero(exe.valor), 'execucao', 'preço da execução')),
      valor_com_social: soEstr(() => dinheiro('execucao_com_social', numero(exe.valor_com_social), 'social', 'preço da execução com social media')),
      meses: soEstr(() => quantidade('meses', inteiro(exe.meses), formasMeses, 'meses da execução')),
    },
    validade: null,
    fonte: 'transcricao',
    citacoes: [],
  };

  // Entregáveis e preço da oferta (implementação / execução; P2 e P3). Cada entregável
  // precisa de citação literal (onde o closer ofereceu); valor por item com a sua evidência.
  const produtos = new Set((catalogo.produtos || []).map((p) => p.id));
  const entregaveis = [];
  const custos = [];
  let etapa2 = null;
  if (!ehEstruturacao) {
    for (const e of Array.isArray(bruto?.entregaveis) ? bruto.entregaveis : []) {
      const texto = textoOuNull(e?.texto);
      if (!texto) continue;
      const citacao = conferida(e.citacao);
      if (!citacao) { pendencias.push(`entregável sem citação conferida na transcrição — "${texto}"`); continue; }
      const recorrencia = e.recorrencia === 'mensal' ? 'mensal' : 'unico';
      entregaveis.push({
        produto_id: produtos.has(e.produto_id) ? e.produto_id : null,
        titulo: tituloCurto(e.titulo, texto), texto, origem: 'ia', citacao, recorrencia,
        valor: dinheiro(null, numero(e.valor), recorrencia === 'mensal' ? 'execucao' : 'estruturacao', `valor de "${texto}"`, e.evidencia_valor),
      });
    }
    if (!entregaveis.length) pendencias.push('nenhum entregável confirmado na transcrição: preencha o que foi oferecido');

    const of = bruto?.preco?.oferta || {};
    const evo = of.evidencias && typeof of.evidencias === 'object' ? of.evidencias : {};
    const recorrencia = of.recorrencia === 'mensal' ? 'mensal' : 'unico';
    const papel = recorrencia === 'mensal' ? 'execucao' : 'estruturacao';
    const tabela = dinheiro('oferta_tabela', numero(of.valor_tabela), papel, 'preço de tabela', evo.valor_tabela);
    // Desconto: o número com "%" ou "por cento" num trecho que fala de desconto
    // ("20% de entrada" não é desconto).
    let desconto = numero(of.desconto_percentual);
    if (desconto != null) {
      const e = conferida(evo.desconto);
      const n = escaparRe(String(desconto).replace('.', ','));
      if (!(desconto > 0 && desconto < 100) || !e || !new RegExp(`(^|[^\\d.,])${n}\\s*(%|por ?cento)`, 'i').test(e)) {
        naoConfirmado('desconto');
        desconto = null;
      } else if (!DESCONTO.test(normalizarTexto(e))) {
        pendencias.push('desconto: trecho não fala de desconto — confira');
        desconto = null;
      }
    }
    let final = dinheiro('oferta_final', numero(of.valor_final), papel, 'valor com desconto', evo.valor_final, { silencioso: true });
    let finalCalculado = false;
    const calculado = tabela != null && desconto != null ? Math.round(tabela * (1 - desconto / 100) * 100) / 100 : null;
    const pct = desconto != null ? String(desconto).replace('.', ',') : '';
    if (final != null && calculado != null && Math.abs(final - calculado) > tabela * 0.01) {
      // "Confirmado" mas de outro valor da call (ex.: o preço de um item): vale o cálculo.
      pendencias.push(`valor com desconto lido (${final}) não bate com o preço de tabela − ${pct}%: usei o cálculo — confira`);
      final = null;
    }
    if (final == null && calculado != null) {
      // Não foi lido limpo (ex.: o Meet escreveu "52,200"): calcula da tabela e do desconto, ambos conferidos.
      final = calculado;
      finalCalculado = true;
      pendencias.push(`valor com desconto calculado (preço de tabela − ${pct}%) — confira`);
    } else if (final == null && numero(of.valor_final) != null) naoConfirmado('valor com desconto');
    preco.oferta = {
      recorrencia,
      valor_tabela: tabela,
      desconto_percentual: desconto,
      valor_final: final,
      valor_final_calculado: finalCalculado,
      parcelas: quantidade(null, inteiro(of.parcelas), formasParcelas, 'parcelas', evo.parcelas),
      valor_parcela: dinheiro('oferta_parcela', numero(of.valor_parcela), papel, 'valor da parcela', evo.valor_parcela),
    };
    if (tabela == null && final == null) pendencias.push('preço da oferta não confirmado na transcrição: preencha');

    // Custos pagos pelo cliente direto a terceiros (ferramenta, licença, mídia).
    for (const c of Array.isArray(bruto?.custos_terceiros) ? bruto.custos_terceiros : []) {
      const texto = textoOuNull(c?.texto);
      const e = conferida(c?.evidencia);
      if (!texto) continue;
      if (!e) { pendencias.push(`custo de terceiros sem evidência na transcrição — "${texto}"`); continue; }
      const valor = dinheiro(null, numero(c.valor), 'qualquer', `valor de "${texto}"`, e);
      const periodicidade = c.periodicidade === 'mensal' && MENSAL.test(normalizarTexto(e)) ? 'mensal'
        : c.periodicidade === 'unico' ? 'unico' : null;
      if (valor != null && !periodicidade) pendencias.push(`custo "${texto}": periodicidade não falada — confira`);
      custos.push({ texto, valor, periodicidade, citacao: e });
    }

    // Próxima etapa opcional (P5).
    const e2 = bruto?.etapa2;
    if (e2 && e2.incluida === true) {
      const ev2 = e2.evidencias && typeof e2.evidencias === 'object' ? e2.evidencias : {};
      const q = conferida(ev2.quando);
      const mes = q ? MESES.find((m) => contemTermo(normalizarTexto(q), m)) : null;
      const verba = [];
      for (const v of Array.isArray(e2.verba_midia) ? e2.verba_midia : []) {
        const canal = textoOuNull(v?.canal);
        const e = conferida(v?.evidencia);
        const nomes = canal ? normalizarTexto(canal).split(' ').filter((w) => w.length >= 4) : [];
        // o canal tem de estar no trecho (ex.: "Google", "Instagram")
        if (!canal || !e || !nomes.some((w) => contemTermo(normalizarTexto(e), w))) {
          if (canal) pendencias.push(`verba de mídia "${canal}" não confirmada na transcrição — confira`);
          continue;
        }
        const valor = dinheiro(null, numero(v.valor), 'qualquer', `verba de ${canal}`, e);
        if (valor != null) verba.push({ canal, valor });
      }
      etapa2 = {
        quando: mes ? `a partir de ${mes === 'marco' ? 'março' : mes}` : null,
        itens: lista(e2.itens, 'etapa 2'),
        valor_mensal: dinheiro('etapa2_mensal', numero(e2.valor_mensal), 'execucao', 'valor mensal da etapa 2', ev2.valor_mensal),
        verba_midia: verba,
      };
      if (!etapa2.itens.length && etapa2.valor_mensal == null) etapa2 = null;
    }
  }

  // Validade (decisão do Gabriel, 29/10): a data combinada na reunião, com a SUA
  // evidência; a data é lida na fonte (dia + mês explícitos) e o trecho precisa
  // falar de validade/prazo. Prazo relativo ("hoje", "fim do mês") vira data pela
  // data da reunião (P4). Sem isso: null → [PREENCHER] + pendência.
  {
    const v = textoOuNull(bruto?.preco?.validade);
    if (v && datasNoTexto(v).length) {
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
    } else if (v) {
      const e = evidenciaDe('validade');
      const en = e ? normalizarTexto(e) : '';
      // o que vem logo depois do trecho na transcrição (para "fechamento hoje… tirar 20%")
      const fimTrecho = e ? Math.max(0, ...localizarCitacao(e, fonteMapa).map(([, b]) => b)) : 0;
      const depois = fimTrecho ? transcricao.slice(fimTrecho, fimTrecho + 150) : '';
      const ok = !!e && falaDeValidadeRelativa(en, depois);
      const rel = ok ? resolverValidadeRelativa(en, dataReuniao) : null;
      if (rel) {
        preco.validade = rel.data;
        const base = dataAssumida ? `${formatarDataIso(dataReuniao)}, data do pedido (a reunião não estava vinculada)` : formatarDataIso(dataReuniao);
        pendencias.push(`validade ${rel.data} calculada de "${rel.termo}" pela data da reunião (${base}), lida em: "${e}" — confira`);
      } else if (ok && !dataReuniao) {
        pendencias.push('validade da proposta: prazo relativo sem a data da reunião — preencha');
      } else pendencias.push('validade da proposta: data não confirmada na transcrição — confira');
    }
  }
  // A mesma expressão da fonte sustentando dois campos = papel ambíguo → nenhum.
  const LUGAR = {
    valor_total: ['estruturacao', 'valor_total'], valor_parcela: ['estruturacao', 'valor_parcela'],
    execucao_valor: ['execucao_mensal', 'valor'], execucao_com_social: ['execucao_mensal', 'valor_com_social'],
    oferta_tabela: ['oferta', 'valor_tabela'], oferta_final: ['oferta', 'valor_final'], oferta_parcela: ['oferta', 'valor_parcela'],
  };
  const ambiguos = new Set();
  for (const a of aceitos) {
    for (const b of aceitos) {
      if (a !== b && a.posicoes.some((p) => b.posicoes.includes(p))) { ambiguos.add(a); ambiguos.add(b); }
    }
  }
  for (const a of ambiguos) {
    if (a.campo === 'etapa2_mensal') etapa2.valor_mensal = null;
    else {
      const [grupo, chave] = LUGAR[a.campo];
      preco[grupo][chave] = null;
    }
    pendencias.push(`${a.rotulo}: valor ambíguo na transcrição — confira`);
  }
  preco.citacoes = [...new Set(['valor_total', 'parcelas', 'valor_parcela', 'execucao_valor', 'execucao_com_social', 'meses', 'validade']
    .map(evidenciaDe).filter(Boolean))];

  const pe = bruto?.plano_execucao || {};
  // O pacote padrão da execução está fixo no slide "Resumo da Proposta": o slide de
  // escopo traz os itens padrão (com o texto adaptado, se veio) e depois os extras.
  let itensExecucao = ehEstruturacao ? lista(pe.itens, 'plano de execução') : [];
  if (ehEstruturacao && pe.incluido !== false) {
    const padrao = catalogo.execucao.itens_padrao.map((p) => itensExecucao.find((i) => i.catalogo_id === p.id)
      || { catalogo_id: p.id, texto: p.texto, origem: 'catalogo', citacao: null });
    // item do catálogo repetido pela análise conta uma vez só
    const vistos = new Set(padrao.map((i) => i.catalogo_id));
    const extras = itensExecucao.filter((i) => !padrao.includes(i)
      && (!i.catalogo_id || !vistos.has(i.catalogo_id)) && (vistos.add(i.catalogo_id), true));
    if (!itensExecucao.length) pendencias.push('plano de execução não veio da análise: entrou o pacote padrão do catálogo — revise');
    itensExecucao = [...padrao, ...extras];
  }
  const ctx = bruto?.contexto || {};
  const escopo = {
    schema_version: tipos.length ? 'proposta-escopo/v1' : 'proposta-escopo/v0',
    catalogo_versao: catalogo.versao,
    ...(tipos.length ? { oferta } : {}),
    cliente: {
      empresa,
      contato: textoOuNull(bruto?.cliente?.contato),
      segmento: textoOuNull(bruto?.cliente?.segmento),
      modelo_venda: modelo,
    },
    contexto: {
      dores: lista(ctx.dores, 'dores').slice(0, 4),
      // Seções de contexto (P7), só com citação conferida.
      ...(tipos.length ? {
        publico: lista(ctx.publico, 'público').slice(0, 4),
        concorrentes: lista(ctx.concorrentes, 'concorrentes').slice(0, 4),
        cliente_fornece: lista(ctx.cliente_fornece, 'o que o cliente fornece').slice(0, 4),
        proximos_passos: lista(ctx.proximos_passos, 'próximos passos').slice(0, 4),
      } : {}),
    },
    escopo: {
      enfases: ehEstruturacao ? (Array.isArray(bruto?.escopo?.enfases) ? bruto.escopo.enfases : []).filter((e) => enfasesValidas.has(e)) : [],
      semanas,
      overdeliveries: ehEstruturacao ? lista(bruto?.escopo?.overdeliveries, 'overdeliveries') : [],
    },
    ...(ehEstruturacao ? {} : { entregaveis, custos_terceiros: custos, etapa2 }),
    plano_execucao: {
      incluido: ehEstruturacao && pe.incluido !== false,
      faixa_midia: ehEstruturacao ? textoConferido(pe.faixa_midia, 'faixa de mídia') : null,
      itens: itensExecucao,
    },
    preco,
    pendencias: [...new Set(pendencias)],
  };
  return escopo;
}
