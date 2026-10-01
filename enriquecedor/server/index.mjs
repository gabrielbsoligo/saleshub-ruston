// ============================================================================
// Backend local de enriquecimento — SDNA Outbound
// Roda no terminal (sem deploy). Faz o que o navegador não pode:
//  - descobrir o site do lead (domínio do e-mail corporativo + busca web)
//  - auditar o site server-side (sem CORS)
//  - consultar CNPJ com cache + retry/backoff (evita 429 da BrasilAPI)
// O frontend (Vite) chama via proxy /api -> este servidor.
// ============================================================================
import http from 'node:http';
import pLimit from 'p-limit';
import Bottleneck from 'bottleneck';
import Anthropic from '@anthropic-ai/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';

// Contexto da requisição (token do chamador + lead em foco) disponível em
// qualquer função do motor, inclusive em trabalho que continua em background
// (esteira). Usado pelo cache em Postgres e pelas métricas sem passar token
// por parâmetro em toda a árvore de chamadas.
const reqCtx = new AsyncLocalStorage();
const ctxAtual = () => reqCtx.getStore() ?? null;
const tokenAtual = () => ctxAtual()?.token ?? null;

// Normaliza envs colados com aspas/espaços (ex.: valores copiados de um .env
// no formato CHAVE="valor" para o painel do Railway/Vercel).
for (const k of Object.keys(process.env)) {
  const v = process.env[k];
  if (typeof v !== 'string') continue;
  const clean = v.trim().replace(/^(["'])(.*)\1$/s, '$2');
  if (clean !== v) process.env[k] = clean;
}

// PORT: injetada pela plataforma (Railway) em produção; 3011 no dev local.
const PORT = Number(process.env.PORT || process.env.ENRICH_PORT || 3011);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// --- utils ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onlyDigits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

// Roda `fn` sobre `items` com no máximo `limit` em paralelo (preserva a ordem).
// Internamente usa p-limit — MESMO comportamento (concorrência + ordem por índice).
async function mapLimit(items, limit, fn) {
  const lim = pLimit(Math.max(1, limit || 1));
  return Promise.all(items.map((item, i) => lim(() => fn(item, i))));
}

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
      signal: ctrl.signal,
      ...opts,
    });
  } finally {
    clearTimeout(t);
  }
}

// --- CNPJ com cache + retry/backoff ----------------------------------------
const cnpjCache = new Map();

async function fetchCnpj(cnpjRaw) {
  const cnpj = onlyDigits(cnpjRaw);
  if (cnpj.length !== 14) return { ok: false, reason: 'formato' };
  if (cnpjCache.has(cnpj)) return cnpjCache.get(cnpj);

  let lastReason = 'erro';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchWithTimeout(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (res.status === 404) {
        const out = { ok: false, reason: 'nao_encontrado' };
        cnpjCache.set(cnpj, out);
        return out;
      }
      if (res.status === 429 || res.status >= 500) {
        lastReason = 'rate_limit';
        await sleep(800 * 2 ** attempt); // 0.8s, 1.6s, 3.2s, 6.4s
        continue;
      }
      if (!res.ok) {
        lastReason = 'erro';
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const d = await res.json();
      const out = { ok: true, data: d };
      cnpjCache.set(cnpj, out);
      return out;
    } catch {
      lastReason = 'timeout';
      await sleep(500 * 2 ** attempt);
    }
  }
  return { ok: false, reason: lastReason }; // não cacheia falha transitória
}

// --- descoberta de site -----------------------------------------------------
const FREEMAIL = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br',
  'live.com', 'icloud.com', 'me.com', 'uol.com.br', 'bol.com.br',
  'terra.com.br', 'ig.com.br', 'globo.com', 'aol.com', 'msn.com', 'globomail.com',
]);

const BLOCK_DOMAINS = [
  // redes sociais / buscadores / mapas
  'facebook.', 'instagram.', 'linkedin.', 'twitter.', 'x.com', 'youtube.',
  'google.', 'duckduckgo.', 'bing.', 'wikipedia.', 'maps.google', 'wa.me',
  // agregadores/diretórios de CNPJ e empresas (nunca são o site do lead)
  'cnpj', 'econodata', 'jusbrasil', 'consultasocio', 'casadosdados',
  'informecadastral', 'empresascnpj', 'econoinfo', 'listamais', 'guiamais',
  'guiaempresas', 'telelistas', 'solutudo', 'apontador', 'quemsomos',
  'consultacnpj', 'empresas.', 'razaosocial', 'dadosempresas',
  // órgãos / serviços
  'gov.br', 'receita', 'serasa', 'reclameaqui',
];

function isBlocked(url) {
  const u = url.toLowerCase();
  return BLOCK_DOMAINS.some((d) => u.includes(d));
}

// Normaliza para o domínio-raiz (protocolo + host, sem caminho e sem www).
function toRoot(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return `https://${host}`;
  } catch {
    return url;
  }
}

// Núcleo do domínio (label principal): mrv.com.br -> "mrv".
function hostCore(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].toLowerCase();
  } catch {
    return '';
  }
}

function nameTokens(companyName) {
  return String(companyName)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

// O domínio combina com o nome da empresa? Evita aceitar site de outra empresa.
function domainMatchesName(url, companyName) {
  const core = hostCore(url);
  if (!core) return false;
  return nameTokens(companyName).some(
    (t) =>
      core === t ||
      (t.length >= 4 && core.includes(t)) ||
      (core.length >= 4 && t.includes(core)),
  );
}

async function siteResponds(url) {
  try {
    const res = await fetchWithTimeout(url, { method: 'GET' }, 10000);
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

// Provedor de BUSCA WEB. Brave tem prioridade (é o dedicado à busca web, com
// budget próprio); a Serper fica reservada ao Google Meu Negócio (Places).
function searchProvider() {
  if (process.env.BRAVE_API_KEY) return 'brave';
  if (process.env.SERPER_API_KEY) return 'serper';
  return 'none';
}

// Estado da busca: 'ok' | 'quota' (cota/crédito esgotado - 402) | 'none' (sem chave).
let searchStatus = 'ok';

// Faz UMA requisição de busca. Retorna {results, ok}. ok=false = falha
// transitória (cota/erro) — para o chamador saber que NÃO é "não encontrado".
// Lança {status:429} para o rawSearch re-tentar.
async function searchOnce(query) {
  const serper = process.env.SERPER_API_KEY;
  const brave = process.env.BRAVE_API_KEY;
  // Brave é o provedor de busca web; Serper só entra se não houver Brave.
  if (serper && !brave) {
    const res = await fetchWithTimeout(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: { 'x-api-key': serper, 'content-type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: 10 }),
      },
      12000,
    );
    if (res.status === 429) throw { status: 429 };
    if (res.status === 402 || res.status === 403) {
      searchStatus = 'quota';
      return { results: [], ok: false };
    }
    if (!res.ok) return { results: [], ok: false };
    searchStatus = 'ok';
    const j = await res.json();
    return {
      results: (j.organic ?? [])
        .filter((o) => o.link)
        .map((o) => ({ url: o.link, title: o.title ?? '', desc: o.snippet ?? '' })),
      ok: true,
    };
  }
  if (brave) {
    // Brave exige o código de idioma no formato dele (`pt-br`, não `pt`): parâmetro
    // inválido vira HTTP 422 e TODA busca falha em silêncio. Por garantia, 422 re-tenta
    // sem os parâmetros de idioma, e qualquer HTTP != 2xx fica anotado na métrica/health.
    const base = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=br&count=10&text_decorations=false`;
    const hdr = { headers: { 'x-subscription-token': brave, accept: 'application/json' } };
    let res = await fetchWithTimeout(`${base}&search_lang=pt-br&ui_lang=pt-BR`, hdr, 12000);
    if (res.status === 422) res = await fetchWithTimeout(base, hdr, 12000);
    if (res.status === 429) throw { status: 429 };
    if (res.status === 402 || res.status === 403) {
      searchStatus = 'quota'; // cota/crédito da chave esgotado
      return { results: [], ok: false, note: `brave HTTP ${res.status} (cota)` };
    }
    if (!res.ok) {
      searchStatus = `erro HTTP ${res.status}`;
      return { results: [], ok: false, note: `brave HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}` };
    }
    searchStatus = 'ok';
    const j = await res.json();
    return {
      results: (j.web?.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({ url: r.url, title: r.title ?? '', desc: r.description ?? '' })),
      ok: true,
    };
  }
  return { results: [], ok: true }; // sem provedor configurado (não é falha)
}

// Controle de ritmo: serializa as buscas com espaçamento mínimo (Brave grátis
// = 1/seg) e re-tenta no 429. Sem isso, o enriquecimento em paralelo estoura o
// limite e volta tudo vazio.
// Espaçamento entre buscas. Grátis Brave = 1/seg (1100ms). Em planos pagos com
// rate maior, baixe via SEARCH_INTERVAL_MS no .env.local (ex.: 150).
const SEARCH_INTERVAL_MS = Number(process.env.SEARCH_INTERVAL_MS || 1100);
// Bottleneck reproduz o gate anterior: 1 busca por vez (maxConcurrent: 1) e no
// mínimo SEARCH_INTERVAL_MS entre o início de cada busca (minTime).
const searchLimiter = new Bottleneck({ maxConcurrent: 1, minTime: SEARCH_INTERVAL_MS });

// Retorna {results, ok}. ok=false quando a busca não pôde rodar (cota/limite),
// sinal usado pela lógica de coerência (não confundir com "não encontrado").
async function rawSearch(query) {
  // Cache em Postgres (14 dias): a mesma consulta volta na hora e não gasta cota.
  const ck = chaveCache('busca', query);
  const hit = await cacheGet(ck);
  if (hit && Array.isArray(hit.results)) return { results: hit.results, ok: true, cache: true };
  const r = await rawSearchSemCache(query);
  if (r?.ok) void cacheSet(ck, { results: r.results }, 14 * DIA);
  return r;
}
async function rawSearchSemCache(query) {
  return searchLimiter.schedule(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await searchOnce(query);
      } catch (e) {
        if (e && e.status === 429 && attempt < 2) {
          await sleep(1500 * (attempt + 1)); // backoff no rate limit
          continue;
        }
        return { results: [], ok: false, note: e?.status === 429 ? 'brave HTTP 429 (rate limit)' : String(e?.message || e) }; // 429 persistente = falha transitória
      }
    }
    return { results: [], ok: false, note: 'brave HTTP 429 (rate limit)' };
  });
}

// Para descoberta de SITE: remove diretórios/redes (blocklist).
async function searchSite(query) {
  const { results, ok } = await rawSearch(query);
  return { urls: results.map((r) => r.url).filter((l) => !isBlocked(l)), ok };
}

function stripQuery(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

// --- validação por PALAVRA INTEIRA usando título/descrição do resultado ------
function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
function wordSet(s) {
  return new Set(normText(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
}
// Tokens distintivos do nome da empresa (>=3, sem palavras de ramo).
function companyTokens(company) {
  return nameTokens(company).filter((t) => t.length >= 3);
}
// Tokens do nome da pessoa (>=3), na ordem.
function personTokens(name) {
  return normText(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
}
// Resultado bate com a EMPRESA? (algum token distintivo como palavra inteira)
function resultMatchesCompany(r, company) {
  const toks = companyTokens(company);
  if (!toks.length) return false;
  const hay = wordSet(`${r.title} ${r.desc}`);
  return toks.some((t) => hay.has(t));
}
// Resultado bate com a PESSOA? (exige primeiro E último nome como palavra inteira)
function resultMatchesPerson(r, name) {
  const toks = personTokens(name);
  if (toks.length < 2) return false;
  const hay = wordSet(`${r.title} ${r.desc}`);
  return hay.has(toks[0]) && hay.has(toks[toks.length - 1]);
}

// Sócio é pessoa física? (exclui S.A., LTDA, HOLDING, etc.)
function isPersonName(nome) {
  return !/\b(s\.?a\.?|s\/a|ltda|holding|empreendiment|participac|eireli|incorporad|construtora|imobiliaria|inc|group|grupo|fund|spe)\b/i.test(
    normText(nome),
  );
}

// Cada find* devolve {url, ok}. ok=false = a busca falhou (não é "não achou").
// `rejeitados` = handles institucionais que o operador apagou na tela (chaves de
// busca do lead) — nunca voltam.
//
// Redes da EMPRESA com pontuação e confiança (antes: primeiro resultado com uma
// palavra em comum). Consulta `site:instagram.com "Marca" cidade` e, se nada
// servir, `Marca cidade instagram`; pontua cada resultado: @ parecido com a
// marca ou com o domínio do site, marca no título, cidade/domínio na descrição.
// Exige 2 sinais e devolve alta/média.
async function findCompanySocial(company, network, rejeitados = [], { cidade = null, siteDomain = null } = {}) {
  const domainRe = network === 'instagram' ? /instagram\.com\//i : /facebook\.com\//i;
  const badPath =
    network === 'instagram'
      ? /instagram\.com\/(p|reel|reels|explore|stories|tv|accounts)\//i
      : /facebook\.com\/(sharer|login|events|photo|photos|groups|watch|people|marketplace|hashtag|public|pages\/category)\b/i;
  const bloqueados = new Set((rejeitados ?? []).map((h) => String(h).toLowerCase()));
  const handleDe = (u) => (u.match(/\.com\/([^/?#]+)/i)?.[1] ?? '').toLowerCase();
  const toks = companyTokens(company);
  const chaveMarca = toks.join('');
  const core = siteDomain ? String(siteDomain).replace(/^www\./, '').split('.')[0].toLowerCase() : null;
  const pontuar = (r) => {
    if (!domainRe.test(r.url) || badPath.test(r.url)) return null;
    const handle = handleDe(r.url);
    if (!handle || bloqueados.has(handle)) return null;
    const hk = handle.replace(/[^a-z0-9]/g, '');
    const sinais = new Set();
    let score = 0;
    // O que sobra do @ tirando a marca e palavras de ramo/sufixo ("construtora",
    // "oficial", "br"...): "construtoraalfa" → "" (é a marca); "alfafestas" → "festas"
    // (é OUTRO negócio que só compartilha uma palavra).
    const RAMO_RE = /(construtora|incorporadora|engenharia|imoveis|imobiliaria|empreendimentos|oficial|official|brasil|br|sp|rj|mg|pr|sc|rs|ba|go|df|ltda|sa|group|grupo|company|store|shop)/g;
    const residuo = (hk.includes(chaveMarca) ? hk.replace(chaveMarca, '') : toks.reduce((acc, t) => acc.replace(t, ''), hk)).replace(RAMO_RE, '');
    // marcas curtas (MRV, JHSF) valem: o resíduo é quem barra "mrvfans"/"alfafestas"
    if (chaveMarca.length >= 3 && (hk.includes(chaveMarca) || (hk.length >= 3 && chaveMarca.includes(hk))) && residuo.length < 4) { score += 4; sinais.add('handle_marca'); }
    else if (toks.some((t) => t.length >= 4 && hk.includes(t))) { score += 3; sinais.add('handle_token'); }
    if (residuo.length >= 4) { score -= 2; sinais.add('handle_extra'); }
    if (core && core.length >= 3 && (hk.includes(core) || (hk.length >= 3 && core.includes(hk))) && residuo.length < 4) { score += 3; sinais.add('handle_dominio'); }
    const texto = normText(`${r.title} ${r.desc}`);
    if (resultMatchesCompany(r, company)) { score += 2; sinais.add('marca_no_titulo'); }
    if (cidade && normText(cidade).length >= 3 && texto.includes(normText(cidade))) { score += 1; sinais.add('cidade'); }
    if (siteDomain && texto.includes(normText(siteDomain))) { score += 2; sinais.add('dominio_na_bio'); }
    const positivos = [...sinais].filter((x) => x !== 'handle_extra').length;
    if (positivos < 2 || score < 5) return null;
    const forte = sinais.has('handle_marca') || sinais.has('handle_dominio') || sinais.has('dominio_na_bio');
    return { url: stripQuery(r.url), handle, score, sinais: [...sinais], confianca: (forte && sinais.has('marca_no_titulo')) || score >= 7 ? 'alta' : 'media' };
  };
  const consultas = [`site:${network}.com "${company}" ${cidade ?? ''}`.trim(), `${company} ${cidade ?? ''} ${network}`.trim()];
  let okTotal = true;
  let melhor = null;
  for (const q of consultas) {
    const { results, ok } = await rawSearch(q);
    okTotal = okTotal && ok;
    for (const r of results.slice(0, 10)) {
      const c = pontuar(r);
      if (c && (!melhor || c.score > melhor.score)) melhor = c;
    }
    if (melhor?.confianca === 'alta') break; // a 2ª consulta só entra sem resultado forte
  }
  return { url: melhor?.url ?? null, confianca: melhor?.confianca ?? null, sinais: melhor?.sinais ?? [], ok: okTotal || !!melhor };
}

// Slug do perfil pessoal do LinkedIn (linkedin.com/in/<slug>), só letras/números.
function linkedinSlug(url) {
  const m = String(url).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

// Classifica UM resultado como perfil PESSOAL da pessoa (mesma escala do Instagram):
//   alta  = título/descrição traz nome E sobrenome  +  slug traz primeiro nome OU sobrenome
//   media = título/descrição traz nome E sobrenome (slug não ajuda — ex.: só números)
//   null  = página de empresa, ou o nome não bate por inteiro
function classificarPerfilLinkedin(r, name) {
  if (!/linkedin\.com\/(in|pub)\//i.test(r.url)) return null;
  if (!resultMatchesPerson(r, name)) return null;
  const slug = linkedinSlug(r.url).replace(/[^a-z0-9]/g, '');
  return handleTemPrimeiroNome(slug, name) || handleTemSobrenome(slug, name) ? 'alta' : 'media';
}

// Busca o LinkedIn PESSOAL do decisor. `rejeitados` = slugs que o operador apagou
// na tela (nunca voltam). Consulta `site:linkedin.com/in "Nome" Marca` (fallback:
// `Nome Marca linkedin`). "alta" só quando a EMPRESA aparece no título/descrição
// do perfil — sem isso é homônimo em potencial → "media". Devolve {url, ok, confianca}.
async function findPersonLinkedin(name, company, { rejeitados = [] } = {}) {
  const marca = company ? marcaDe(company) : '';
  const consultas = [`site:linkedin.com/in "${name}" ${marca}`.trim(), `${name} ${marca} linkedin`.trim()];
  const bloqueados = new Set((rejeitados ?? []).map((h) => String(h).toLowerCase()));
  let melhor = null;
  let okTotal = true;
  for (const q of consultas) {
    const { results, ok } = await rawSearch(q);
    okTotal = okTotal && ok;
    for (const r of results) {
      if (!classificarPerfilLinkedin(r, name)) continue;
      if (bloqueados.has(linkedinSlug(r.url))) continue;
      const conf = marca && resultMatchesCompany(r, marca) ? 'alta' : 'media';
      if (!melhor || (conf === 'alta' && melhor.confianca !== 'alta')) melhor = { url: stripQuery(r.url), confianca: conf };
      if (melhor.confianca === 'alta') break;
    }
    if (melhor) break;
  }
  return { url: melhor?.url ?? null, confianca: melhor?.confianca ?? null, ok: okTotal || !!melhor };
}

// @ (handle) do perfil, só letras/números — base das regras de nome abaixo.
function instagramHandle(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

// Handle com cara de EMPRESA/loja/página — nunca é o perfil pessoal do decisor
// (o caso "gois.construtora" para Aurino Gonçalves de Gois).
const HANDLE_NEGOCIO_RE =
  /(constru|incorp|imove|imob|engenh|empreend|store|shop|loja|oficial|ltda|eireli|clinic|odonto|advoc|advog|contab|consult|agencia|agency|studio|estudio|solucoes|servicos|comercio|distribui|atacad|descart|company|group|grupo|brasil|\bsa\b|holding|negocio|industria|logistic|transport|energia|solar|tech|digital|marketing|midia|design|arquitet|reformas|materiais|eletric|hidraul|pecas|auto|motos|veiculo|farma|saude|hospital|lab|escola|colegio|curso|academ|fit|gym|pizza|burger|restaur|bar\b|cafe|padaria|doces|bolos|festas|eventos|decor|moveis|planejad|vidro|vidrac|esquadr|aluminio|ferro|aco\b|tintas|piscina|jardim|pet\b|vet\b)/i;

// Regras de nome sobre o @: primeiro nome e sobrenome (sem stopwords) contidos.
function handleTemPrimeiroNome(handle, name) {
  const toks = personTokens(name);
  return toks.length >= 1 && toks[0].length >= 4 && handle.replace(/[^a-z0-9]/g, '').includes(toks[0]);
}
function handleTemSobrenome(handle, name) {
  const toks = personTokens(name);
  if (toks.length < 2) return false;
  const surname = toks[toks.length - 1];
  return surname.length >= 4 && handle.replace(/[^a-z0-9]/g, '').includes(surname);
}

// Classifica UM resultado de busca como perfil pessoal da pessoa. Devolve o grau
// de confiança ou null (rejeitado). Regra (endurecida em 13/09 — antes bastava o
// sobrenome no @, o que trazia parentes, homônimos e páginas de empresa):
//   alta  = título/descrição traz nome E sobrenome  +  @ traz primeiro nome OU sobrenome
//   media = título/descrição traz nome E sobrenome  OU  @ traz primeiro nome E sobrenome
//   null  = só sobrenome no @, só primeiro nome, ou @ de empresa/loja
// Fã-clube, memes, frases, notícias… — perfil SOBRE a pessoa, não DA pessoa
// (o caso "migueloliveirafanclub88").
const HANDLE_FA_RE = /(fanclub|fan_?club|fans?(?=[^a-z]|$)|f[aã]s(?=[^a-z]|$)|club(?=[^a-z]|$)|memes?|frases|noticias|news|fofoca|gossip|edits?(?=[^a-z]|$)|updates?|daily|fanpage|fc(?=\d|$))/i;
function classificarPerfilInstagram(r, name) {
  if (!/instagram\.com\//i.test(r.url)) return null;
  if (/instagram\.com\/(p|reel|reels|explore|stories|tv|accounts)\//i.test(r.url)) return null;
  const handle = instagramHandle(r.url);
  if (!handle || HANDLE_NEGOCIO_RE.test(handle) || HANDLE_FA_RE.test(handle)) return null;
  const titulo = resultMatchesPerson(r, name);
  const pn = handleTemPrimeiroNome(handle, name);
  const sn = handleTemSobrenome(handle, name);
  if (titulo && (pn || sn)) return 'alta';
  if (titulo || (pn && sn)) return 'media';
  return null;
}

// Busca o Instagram PESSOAL do decisor. Consulta `site:instagram.com "Primeiro
// Sobrenome" cidade` (o nome civil completo entre aspas quase nunca bate) e, se
// nada servir, `"Nome completo" cidade instagram`. A bio (descrição do resultado)
// citando a empresa ou a cidade sobe "media" → "alta". `rejeitados` são handles
// que o operador já apagou na tela — nunca voltam. Devolve {url, ok, confianca}.
async function findPersonInstagram(name, { cidade = null, rejeitados = [], company = null } = {}) {
  const toks = personTokens(name);
  const curto = toks.length >= 2 ? `${toks[0]} ${toks[toks.length - 1]}` : name;
  const consultas = [
    `site:instagram.com "${curto}" ${cidade ?? ''}`.trim(),
    [`"${name}"`, cidade, 'instagram'].filter(Boolean).join(' '),
  ];
  const bloqueados = new Set((rejeitados ?? []).map((h) => String(h).toLowerCase()));
  const toksEmpresa = company ? companyTokens(company).filter((t) => t.length >= 4) : [];
  let melhor = null;
  let okTotal = true;
  for (const q of consultas) {
    const { results, ok } = await rawSearch(q);
    okTotal = okTotal && ok;
    for (const r of results) {
      let conf = classificarPerfilInstagram(r, name);
      if (!conf) continue;
      if (bloqueados.has(instagramHandle(r.url))) continue;
      const bio = normText(r.desc);
      if (conf === 'media' && (toksEmpresa.some((t) => bio.includes(t)) || (cidade && normText(cidade).length >= 3 && bio.includes(normText(cidade))))) conf = 'alta';
      if (!melhor || (conf === 'alta' && melhor.confianca !== 'alta')) melhor = { url: stripQuery(r.url), confianca: conf };
      if (melhor.confianca === 'alta') break;
    }
    if (melhor) break;
  }
  return { url: melhor?.url ?? null, confianca: melhor?.confianca ?? null, ok: okTotal || !!melhor };
}

// Descoberta social completa: institucional (empresa) + por pessoa.
// SITE PRIMEIRO: o Instagram/Facebook que a própria empresa linkou no site
// (`siteSocial`, ou lido de `siteUrl`) vale mais que qualquer busca; a busca web
// só entra como fallback, já ancorada no domínio. Pessoas = sócios do QSA +
// `pessoasExtras` (decisores vindos da DataStone/Lemit), em paralelo (a fila de
// busca serializa as requisições; o paralelo só tira os tempos mortos).
// searchFailed=true se QUALQUER busca falhou (para reprocessar depois).
// `rejeitados` = { [nome normalizado]: [@ de Instagram apagados pelo operador] };
// `rejeitadosLinkedin` = idem para slugs do LinkedIn.
// `rejeitadosEmpresa` = { instagram: [@...], facebook: [@...] } apagados na tela.
async function discoverSociosSocial({ company, socios, cidade = null, rejeitados = {}, rejeitadosLinkedin = {}, rejeitadosEmpresa = {}, siteUrl = null, siteSocial = null, pessoasExtras = [] }) {
  let anyFail = false;
  const urlSite = siteUrl ? (String(siteUrl).startsWith('http') ? String(siteUrl) : `https://${siteUrl}`) : null;
  let sinais = siteSocial;
  if (!sinais && urlSite) {
    const r = await fetchHtmlCached(urlSite);
    if (r?.html) sinais = sinaisDoSite(r.html);
  }
  let siteDomain = null;
  try { siteDomain = urlSite ? new URL(urlSite).hostname.replace(/^www\./, '') : null; } catch { /* url inválida */ }
  const handleDe = (u) => (String(u).match(/\.com\/([^/?#]+)/i)?.[1] ?? '').toLowerCase();
  const rejIg = (rejeitadosEmpresa?.instagram ?? []).map((h) => String(h).toLowerCase());
  const rejFb = (rejeitadosEmpresa?.facebook ?? []).map((h) => String(h).toLowerCase());
  // Link do site só é "alta" se o @ lembra a marca ou o domínio (um site errado
  // — ou um rodapé com a rede do grupo/parceiro — não pode virar a rede oficial).
  const toksMarca = company ? companyTokens(company).filter((t) => t.length >= 3) : [];
  const coreSite = siteDomain ? siteDomain.split('.')[0].toLowerCase() : null;
  const coerente = (u) => { const hk = handleDe(u).replace(/[^a-z0-9]/g, ''); return toksMarca.some((t) => hk.includes(t)) || (coreSite && coreSite.length >= 3 && (hk.includes(coreSite) || coreSite.includes(hk))); };
  const doSiteIg = sinais?.instagram && !rejIg.includes(handleDe(sinais.instagram)) ? sinais.instagram : null;
  const doSiteFb = sinais?.facebook && !rejFb.includes(handleDe(sinais.facebook)) ? sinais.facebook : null;
  const opts = { cidade, siteDomain };
  const buscaRede = (network, rej) =>
    company
      ? findCompanySocial(company, network, rej, opts).then((r) => ({ ...r, origem: r.url ? 'busca' : null }))
      : Promise.resolve({ url: null, confianca: null, origem: null, ok: true });
  const [ig, fb] = await Promise.all([
    doSiteIg ? { url: doSiteIg, confianca: coerente(doSiteIg) ? 'alta' : 'media', origem: 'site', ok: true } : buscaRede('instagram', rejIg),
    doSiteFb ? { url: doSiteFb, confianca: coerente(doSiteFb) ? 'alta' : 'media', origem: 'site', ok: true } : buscaRede('facebook', rejFb),
  ]);
  if (!ig.ok || !fb.ok) anyFail = true;

  // Pessoas: sócios-pessoa do contrato social + decisores das outras fontes (até 6).
  const vistos = new Set();
  const nomes = [];
  for (const n of [...(socios ?? []), ...(pessoasExtras ?? [])]) {
    const nome = String(n ?? '').trim();
    if (!nome || !isPersonName(nome) || vistos.has(normText(nome))) continue;
    vistos.add(normText(nome));
    nomes.push(nome);
  }
  const people = await Promise.all(nomes.slice(0, 6).map(async (nome) => {
    const [li, igp] = await Promise.all([
      findPersonLinkedin(nome, company, { rejeitados: rejeitadosLinkedin?.[normText(nome)] ?? [] }),
      findPersonInstagram(nome, { cidade, company, rejeitados: rejeitados?.[normText(nome)] ?? [] }),
    ]);
    if (!li.ok || !igp.ok) anyFail = true;
    return { nome, linkedin: li.url, linkedinConfianca: li.confianca, instagram: igp.url, instagramConfianca: igp.confianca };
  }));
  return {
    companyInstagram: ig.url, companyInstagramConfianca: ig.confianca ?? null, companyInstagramOrigem: ig.origem ?? null,
    companyFacebook: fb.url, companyFacebookConfianca: fb.confianca ?? null, companyFacebookOrigem: fb.origem ?? null,
    metaPageId: sinais?.metaPageId ?? null,
    people, searchFailed: anyFail,
  };
}

const NAME_STOPWORDS = new Set([
  // jurídico / conectivos
  'ltda', 'sa', 's', 'a', 'eireli', 'me', 'epp', 'e', 'de', 'da', 'do', 'das', 'dos',
  'the', 'and',
  // palavras de ramo (genéricas — não identificam a empresa), incluindo
  // abreviações comuns nas listas (empreend, incorp, constr...)
  'empreendimentos', 'empreendimento', 'empreend', 'emp',
  'construcoes', 'construcao', 'construtora', 'constr',
  'incorporacao', 'incorporacoes', 'incorporadora', 'incorp',
  'participacoes', 'participacao', 'part', 'partic',
  'comercio', 'comercial', 'com', 'servicos', 'servico',
  'imobiliaria', 'imobiliarios', 'imobiliario', 'imoveis', 'imob',
  'engenharia', 'engenh', 'administradora', 'adm',
  'grupo', 'holding', 'negocios', 'negocio', 'industria', 'industrial', 'distribuidora',
  // financeiro / imobiliário genéricos (não identificam a empresa)
  'investimento', 'investimentos', 'invest', 'patrimonial', 'patrimonio',
  'urbanismo', 'urbanizadora', 'urbanizacao', 'loteadora', 'loteamento',
  'loteamentos', 'spe', 'capital', 'ventures', 'realty', 'desenvolvimento',
  'desenvolvimentos', 'solucoes', 'assessoria', 'consultoria', 'imobiliarios',
]);

// Cache de Google Meu Negócio (Serper Places) por empresa+cidade — evita chamar
// duas vezes (na descoberta do site e no card de GMN).
const _placesCache = new Map();
async function serperPlacesCached(company, cidade, rejeitados = [], { telefones = [], nomeCompleto = null } = {}) {
  const fonesK = (telefones ?? []).map((t) => onlyDigits(t).slice(-8)).filter((d) => d.length === 8).sort().join(',');
  const k = `${String(company ?? '').toLowerCase()}|${String(cidade ?? '').toLowerCase()}|${(rejeitados ?? []).join(',')}|${fonesK}|${String(nomeCompleto ?? '').toLowerCase()}`;
  if (_placesCache.has(k)) return _placesCache.get(k);
  const ck = chaveCache('places', company, cidade, (rejeitados ?? []).join(','), fonesK, nomeCompleto ?? '');
  const hit = await cacheGet(ck);
  if (hit !== undefined) { _placesCache.set(k, hit); return hit; }
  const r = await serperPlaces(company, cidade, rejeitados, { telefones, nomeCompleto }).catch(() => ({ ok: false, found: false }));
  // Falha transitória (ok:false) NÃO é cacheada: antes virava "sem ficha" até o próximo deploy.
  if (!r || r.ok === false) return null;
  const val = r.found ? r : null;
  _placesCache.set(k, val);
  void cacheSet(ck, val, 14 * DIA);
  return val;
}

// Tenta variações (https/www/http) de um domínio e devolve a 1ª que responde.
async function primeiraQueResponde(urlBruta) {
  if (!urlBruta) return null;
  const host = String(urlBruta).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/^www\./i, '').split('/')[0];
  if (!host || !host.includes('.')) return null;
  for (const v of [`https://${host}`, `https://www.${host}`, `http://${host}`, `http://www.${host}`]) {
    if (await siteResponds(v)) return toRoot(v);
  }
  return null;
}

const JURIDICO_RE = /^(ltda|limitada|sa|eireli|me|epp|spe|cia|companhia|holding|participacoes|participacao)$/;
// Pontua um candidato a site pelo CONTEÚDO da home (não por "respondeu"):
// CNPJ no rodapé é decisivo; marca no <title>/og:site_name e domínio parecido
// com a marca são fortes; cidade e a fonte do candidato desempatam. Página
// estacionada/à venda é descartada. https e https://www em paralelo.
async function validarCandidatoSite(c, { nome, companyName, cidade, cnpj }) {
  const host = String(c.url).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  if (!host || !host.includes('.')) return null;
  const tenta = async (variantes) => {
    const rs = await Promise.all(variantes.map(async (v) => [v, await fetchHtmlCached(v)]));
    return rs.find(([, r]) => r && r.ok && r.html) ?? null;
  };
  const hit = (await tenta([`https://${host}`, `https://www.${host}`])) ?? (await tenta([`http://${host}`, `http://www.${host}`]));
  if (!hit) return null;
  const [tentada, r] = hit;
  if (r.finalUrl && isBlocked(r.finalUrl)) return null; // redirecionou pra rede social/diretório
  const sn = sinaisDoSite(r.html);
  const sinais = [];
  let score = 0;
  if (sn.parked) { score -= 100; sinais.push('pagina_estacionada'); }
  if (cnpj && sn.cnpjs.has(cnpj)) { score += 100; sinais.push('cnpj_no_site'); }
  const toks = [...new Set([...companyTokens(nome), ...companyTokens(companyName ?? '')])];
  const cabecalho = `${sn.title} ${sn.siteName}`;
  const tituloBate = toks.some((t) => wordSet(cabecalho).has(t)) || (normText(nome).length >= 4 && normText(cabecalho).includes(normText(nome)));
  if (tituloBate) { score += 30; sinais.push('marca_no_titulo'); }
  const domBate = domainMatchesName(`https://${host}`, nome) || (companyName && domainMatchesName(`https://${host}`, companyName));
  if (domBate) { score += 20; sinais.push('dominio_parecido'); }
  if (cidade && normText(cidade).length >= 3 && sn.texto.includes(normText(cidade))) { score += 10; sinais.push('cidade_no_site'); }
  // Cobertura do NOME COMPLETO (com palavras de ramo: "net empreendimentos
  // imobiliarios") no título/og:site_name/domínio. Uma marca curta e genérica
  // ("NET") bate em site de qualquer um — o nome inteiro, não.
  const palavras = normText(companyName || nome).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !JURIDICO_RE.test(w));
  const alvoCobertura = `${normText(cabecalho)} ${host.replace(/[^a-z0-9]/g, '')}`;
  const cobertura = palavras.length ? palavras.filter((w) => alvoCobertura.includes(w)).length / palavras.length : 0;
  if (cobertura >= 0.6) { score += 15; sinais.push('nome_completo'); }
  if (c.source === 'busca' && !sinais.includes('cnpj_no_site') && cobertura < 0.6) return null; // busca só com o nome inteiro
  score += { validado: 50, gmn: 15, email: 12, planilha: 8, busca: 0 }[c.source] ?? 0;
  const confianca = sinais.includes('cnpj_no_site') || (tituloBate && domBate && (cobertura >= 0.6 || c.source !== 'busca')) ? 'alta' : score >= 15 ? 'media' : null;
  return { url: toRoot(r.finalUrl || tentada), source: c.source, score, sinais, confianca, html: r.html };
}

// Descobre o SITE INSTITUCIONAL investigando de verdade (não confia na planilha):
// cruza Google Meu Negócio + e-mail corporativo + planilha + busca web (marca) e
// valida cada candidato PELO CONTEÚDO (validarCandidatoSite), todos em paralelo,
// ficando com o melhor pontuado. Resultado em cache (7 dias) por marca/cidade/CNPJ/
// chaves — re-rodar a fase não repete a descoberta.
// `forcar` = site VALIDADO pelo operador (chaves de busca): se responder, é ele e
// pronto. `rejeitados` = domínios apagados na tela (nunca voltam). `gmn` = ficha já
// conferida pelo chamador (evita segunda consulta ao Places).
async function discoverSite({ siteUrl, emailDomain, companyName, nomeFantasia, cidade, cnpj = null, forcar = null, rejeitados = [], gmnRejeitados = [], gmn }) {
  const nome = marcaDe(nomeFantasia || companyName);
  const cnpjDigits = onlyDigits(cnpj).length === 14 ? onlyDigits(cnpj) : null;
  const ctx = { nome, companyName, cidade, cnpj: cnpjDigits };
  if (forcar) {
    const v = await validarCandidatoSite({ url: forcar, source: 'validado' }, ctx).catch(() => null);
    if (v) return { url: v.url, source: 'validado', confianca: 'alta', sinais: v.sinais, searchFailed: false, html: v.html };
    // não respondeu: segue a descoberta normal (o operador vê "não encontrado")
  }
  const ck = chaveCache('site', nome, companyName, cidade, cnpjDigits, (rejeitados ?? []).join(','), (gmnRejeitados ?? []).join(','));
  const hit = await cacheGet(ck);
  if (hit && hit.url) {
    const r = await fetchHtmlCached(hit.url); // HTML pra quem precisa (redes / página Meta)
    return { ...hit, searchFailed: false, html: r?.html ?? null, cache: true };
  }
  const bloqueados = new Set((rejeitados ?? []).map((d) => String(d).toLowerCase().replace(/^www\./, '')));
  const candidatos = []; // {url, source, dom}
  const push = (url, source) => {
    if (!url) return;
    const dom = String(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
    if (!dom.includes('.') || bloqueados.has(dom) || isBlocked(`https://${dom}/`)) return;
    if (candidatos.some((c) => c.dom === dom)) return;
    candidatos.push({ url, source, dom });
  };

  // 1) Google Meu Negócio — site do perfil (fonte forte do site real)
  try {
    const g = gmn !== undefined ? gmn : await serperPlacesCached(nome, cidade, gmnRejeitados);
    if (g && g.website) push(g.website, 'gmn');
  } catch { /* segue */ }
  // 2) site da planilha (palpite — precisa validar)
  if (siteUrl) push(siteUrl, 'planilha');
  // 3) domínio do e-mail corporativo
  if (emailDomain && !FREEMAIL.has(emailDomain.toLowerCase()) && emailDomain.includes('.')) push(emailDomain.toLowerCase(), 'email');
  // 4) busca web — "marca" cidade site oficial; só domínios que casam com o nome
  let buscaFalhou = false;
  if (nome) {
    // marca curta ("NET", "MRV") busca com o nome completo sem sufixo jurídico
    const nomeBusca = nome.length >= 5 ? nome : String(nomeFantasia || companyName || nome).replace(/\b(ltda|limitada|s\/?a\.?|eireli|me|epp|spe)\b/gi, '').replace(/\s+/g, ' ').trim();
    const { urls, ok } = await searchSite(`"${nomeBusca}" ${cidade ?? ''} site oficial`.trim());
    buscaFalhou = !ok;
    for (const u of urls) {
      if (domainMatchesName(u, nome) || (companyName && domainMatchesName(u, companyName))) push(u, 'busca');
    }
  }

  // Valida TODOS em paralelo pelo conteúdo e fica com o melhor pontuado.
  const avaliados = (await mapLimit(candidatos.slice(0, 8), 4, (c) => validarCandidatoSite(c, ctx).catch(() => null))).filter((v) => v && v.confianca);
  avaliados.sort((a, b) => b.score - a.score);
  const melhor = avaliados[0];
  if (melhor) {
    const out = { url: melhor.url, source: melhor.source, confianca: melhor.confianca, sinais: melhor.sinais };
    void cacheSet(ck, out, 7 * DIA);
    return { ...out, searchFailed: false, html: melhor.html };
  }
  // Nenhum candidato validou: melhor "não encontrado" do que atribuir site de outro.
  return { url: null, source: 'nao_encontrado', confianca: null, sinais: [], searchFailed: buscaFalhou, html: null };
}

// --- auditoria de site ------------------------------------------------------
function analyzeWhatsapp(html) {
  const buttons = [];
  const seen = new Set();
  // Links explícitos (wa.me / api|web.whatsapp.com/send).
  for (const m of html.matchAll(
    /(?:https?:)?\/\/(?:api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|wa\.me)[^\s"'<>]*/gi,
  )) {
    const href = m[0];
    if (seen.has(href)) continue;
    seen.add(href);
    const phoneMatch = href.match(/(?:wa\.me\/|phone=)(\+?\d+)/i);
    const number = phoneMatch ? phoneMatch[1] : null;
    const digits = onlyDigits(number);
    const working = Boolean(number) && (digits.length === 12 || digits.length === 13);
    buttons.push({ href, numberFound: number, working });
  }
  // Sinais de WhatsApp montado por JS (widget/plugin) quando não há link no HTML.
  // Muitos temas injetam o link via JavaScript — o HTML estático não o contém.
  const widgetSignals =
    /zap-link|whatsapp[-_]|wa[-_]float|float(ing)?[-_]?whatsapp|btn[-_]?(whatsapp|wpp|zap)|whatsappme|data-(whatsapp|wpp|phone)|["'](whatsapp|wpp)["']/i;
  const mentionsWhatsapp = /whatsapp/i.test(html);
  const hasWhatsappWidget = buttons.length === 0 && (widgetSignals.test(html) || mentionsWhatsapp);
  return { buttons, hasWhatsappWidget };
}

// Extrai o Instagram/Facebook que a PRÓPRIA empresa linkou no site (fonte mais
// confiável que busca). Ignora links de post/plugin/compartilhamento.
function extractSiteSocials(html) {
  const pickIg = () => {
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)\/?/gi)) {
      const handle = m[1].toLowerCase();
      if (['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'about'].includes(handle)) continue;
      return `https://www.instagram.com/${m[1]}`;
    }
    return null;
  };
  const pickFb = () => {
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9_.\-]+)\/?/gi)) {
      const handle = m[1].toLowerCase();
      if (['sharer', 'plugins', 'dialog', 'tr', 'login', 'sharer.php', 'profile.php'].includes(handle)) continue;
      return `https://www.facebook.com/${m[1]}`;
    }
    return null;
  };
  return { instagram: pickIg(), facebook: pickFb() };
}

// HTML da home com cache curto em memória (10 min): a mesma página é lida pela
// validação do site, pela extração de redes/página Meta e pelos empreendimentos.
const _htmlCache = new Map();
async function fetchHtmlCached(url, ms = 10000) {
  const k = String(url).replace(/\/+$/, '').toLowerCase();
  const hit = _htmlCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.val;
  let val = null;
  try {
    const res = await fetchWithTimeout(url, { headers: { 'accept-language': 'pt-BR,pt;q=0.9' } }, ms);
    const html = await res.text();
    val = { ok: res.ok || (res.status >= 300 && res.status < 400), status: res.status, finalUrl: res.url || url, html: html.slice(0, 600_000) };
  } catch {
    val = null;
  }
  _htmlCache.set(k, { val, exp: Date.now() + 10 * 60_000 });
  if (_htmlCache.size > 300) _htmlCache.delete(_htmlCache.keys().next().value);
  return val;
}

// Página "estacionada"/à venda/em construção — responde 200 mas não é site de ninguém.
const PARKED_RE =
  /dom[ií]nio (est[áa] )?[àa] venda|domain (is )?for sale|comprar este dom[ií]nio|buy this domain|sedoparking|parkingcrew|hugedomains|dan\.com\/buy|afternic|este dom[ií]nio (foi|est[áa]) (registrado|reservado)|p[áa]gina em constru[çc][ãa]o|site em constru[çc][ãa]o/i;

// Sinais do PRÓPRIO site: redes linkadas, id da página Meta (fb:pages / fb://page),
// título/og:site_name e CNPJs do rodapé. Fonte mais confiável que qualquer busca.
function sinaisDoSite(html) {
  const h = String(html || '');
  const { instagram, facebook } = extractSiteSocials(h);
  const metaPageId =
    h.match(/property=["']fb:pages?["']\s+content=["'](\d{5,})["']/i)?.[1] ??
    h.match(/content=["'](\d{5,})["']\s+property=["']fb:pages?["']/i)?.[1] ??
    h.match(/property=["']fb:page_id["']\s+content=["'](\d{5,})["']/i)?.[1] ??
    h.match(/fb:\/\/(?:page|profile)\/(\d{5,})/)?.[1] ??
    h.match(/facebook\.com\/profile\.php\?id=(\d{5,})/)?.[1] ??
    null;
  const title = decodeHtml((h.match(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const siteName = decodeHtml(h.match(/property=["']og:site_name["']\s+content=["']([^"']{1,120})["']/i)?.[1] ?? '');
  const cnpjs = new Set([...h.matchAll(/\b(\d{2})\.?(\d{3})\.?(\d{3})\/?(\d{4})-?(\d{2})\b/g)].map((m) => m.slice(1).join('')));
  const texto = normText(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' '));
  return { instagram, facebook, metaPageId, title, siteName, cnpjs, texto, parked: PARKED_RE.test(h.slice(0, 30000)) };
}

// Formulário de cadastro (captação de lead): existe? quantos campos? tem botão
// de envio? action suspeita (vazia/#/js) = possível form quebrado. Verificação
// ESTÁTICA (do HTML) — não submete de fato; teste real de envio seria headless.
function analyzeForm(html) {
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  if (!forms.length) {
    // Muitas LPs usam form embutido (RD Station, Typeform, HubSpot, etc.).
    const viaEmbed = /rdstation|rd-station|typeform|hsforms|hubspot|docs\.google\.com\/forms|jotform|wpforms|elementor-form|leadlovers|form\.respondi/i.test(html);
    return { hasForm: viaEmbed, viaEmbed, fields: null, hasSubmit: viaEmbed, actionSuspeita: false };
  }
  const form = forms.slice().sort((a, b) => b.length - a.length)[0]; // maior = provável cadastro
  const fieldTags = form.match(/<(input|select|textarea)\b[^>]*>/gi) || [];
  const visiveis = fieldTags.filter((t) => !/type=["']?(hidden|submit|button|image|reset)/i.test(t));
  // Detalhe de CADA campo: tipo + nome + placeholder (pra saber "quais são").
  const attr = (t, a) => (t.match(new RegExp(`${a}=["']([^"']*)["']`, 'i')) || [])[1] || null;
  const fieldList = visiveis.slice(0, 25).map((t) => {
    const tag = (t.match(/^<(\w+)/) || [])[1]?.toLowerCase() || 'input';
    const tipo = tag === 'input' ? (attr(t, 'type') || 'text').toLowerCase() : tag; // select/textarea
    return { tipo, nome: attr(t, 'name'), placeholder: attr(t, 'placeholder') };
  });
  const fields = visiveis.length;
  const hasSubmit = /<button[^>]*type=["']?submit|<input[^>]*type=["']?submit|<button(?![^>]*\stype=)[^>]*>/i.test(form);
  const actionMatch = form.match(/<form[^>]*\saction=["']([^"']*)["']/i);
  const action = actionMatch ? actionMatch[1].trim() : '';
  // action vazia = envia via JavaScript (normal em forms modernos). Só é suspeito
  // quando aponta pra "#" ou "javascript:" (placeholder quebrado, não envia lead).
  const actionSuspeita = action === '#' || /^javascript:/i.test(action);
  return { hasForm: true, viaEmbed: false, fields, fieldList, hasSubmit, actionSuspeita, action };
}

async function auditUrl(url) {
  const started = Date.now();
  const res = await fetchWithTimeout(url, {}, 12000);
  const finalUrl = res.url || url;
  const html = await res.text();
  const { buttons, hasWhatsappWidget } = analyzeWhatsapp(html);
  const form = analyzeForm(html);
  const siteSocials = extractSiteSocials(html);
  const notes = [];
  const broken = buttons.filter((b) => !b.working);
  if (broken.length > 0) {
    notes.push(`${broken.length} botão(ões) de WhatsApp com problema — gancho de abordagem.`);
  } else if (buttons.length === 0 && hasWhatsappWidget) {
    notes.push(
      'WhatsApp presente via widget/JavaScript — o link não está no HTML, então não deu para validar automaticamente. Conferir manualmente.',
    );
  } else if (buttons.length === 0) {
    notes.push('Nenhum sinal de WhatsApp no site.');
  }
  return {
    siteUrl: finalUrl,
    isOnline: res.ok,
    httpStatus: res.status,
    httpsValid: finalUrl.startsWith('https://'),
    loadTimeMs: Date.now() - started,
    whatsappButtons: buttons,
    hasWhatsappWidget,
    form,
    hasMetaPixel: /fbq\(|connect\.facebook\.net\/[^"']*fbevents/i.test(html),
    hasGoogleTag: /gtag\(|googletagmanager\.com\/(gtag|gtm)|GTM-[A-Z0-9]+/i.test(html),
    // Conversão do Google Ads (indica tráfego pago ativo, não só analytics).
    hasGoogleAds: /AW-\d{6,}|googleadservices\.com|google_conversion|gtag\('event',\s*'conversion'/i.test(html),
    // Pixel do TikTok Ads.
    hasTiktokPixel: /analytics\.tiktok\.com|ttq\.(load|track|page)/i.test(html),
    siteInstagram: siteSocials.instagram,
    siteFacebook: siteSocials.facebook,
    notes,
  };
}

// --- HTTP -------------------------------------------------------------------
// --- Lemit: contatos dos sócios (telefone/e-mail por CPF) -------------------
const LEMIT_BASE = 'https://api.lemit.com.br/api/v1/consulta';

async function lemitPost(path, documento) {
  const token = process.env.LEMIT_API_TOKEN;
  if (!token) return { ok: false, data: null };
  try {
    const res = await fetchWithTimeout(
      `${LEMIT_BASE}/${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `documento=${encodeURIComponent(documento)}`,
      },
      15000,
    );
    if (res.status === 404) return { ok: true, data: null }; // não encontrado (não é falha)
    if (!res.ok) return { ok: false, data: null }; // falha transitória
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, data: null };
  }
}

function fmtPhone(t) {
  return t ? `(${t.ddd}) ${t.numero}` : null;
}
// Melhor telefone: prioriza WhatsApp; senão o de melhor ranking.
function bestPhone(celulares) {
  const list = (celulares || []).slice().sort((a, b) => (a.ranking || 99) - (b.ranking || 99));
  const chosen = list.find((t) => t.whatsapp) || list[0];
  return { phone: fmtPhone(chosen), whatsapp: !!(chosen && chosen.whatsapp) };
}
function bestEmail(emails) {
  const list = (emails || []).slice().sort((a, b) => (a.ranking || 99) - (b.ranking || 99));
  return list[0]?.email ?? null;
}

// Consolida: /empresa (contatos + sócios c/ CPF) + /pessoa por sócio pessoa física.
// ok=false quando alguma consulta FALHOU (para reprocessar) — diferente de vazio.
// Todos os telefones (celulares) formatados, com ranking crescente.
function allPhones(celulares) {
  return (celulares || [])
    .slice()
    .sort((a, b) => (a.ranking || 99) - (b.ranking || 99))
    .map((t) => ({ numero: fmtPhone(t), whatsapp: !!t.whatsapp, ranking: t.ranking ?? null }));
}
function allEmails(emails) {
  return (emails || [])
    .slice()
    .sort((a, b) => (a.ranking || 99) - (b.ranking || 99))
    .map((e) => e.email)
    .filter(Boolean);
}
function fmtEndereco(en) {
  if (!en) return null;
  const linha = [en.endereco, en.bairro, en.cidade && `${en.cidade}/${en.uf ?? ''}`, en.cep]
    .filter(Boolean)
    .join(', ');
  return linha || null;
}

async function lemitEnrich(cnpj) {
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { ok: false, company: null, people: [] };

  const emp = await lemitPost('empresa', digits);
  if (!emp.ok) return { ok: false, company: null, people: [] };
  const e = emp.data?.empresa ?? {};
  const cp = bestPhone(e.celulares);
  const company = {
    phone: cp.phone,
    whatsapp: cp.whatsapp,
    email: bestEmail(e.emails),
    // dados completos da empresa (Lemit)
    phones: allPhones(e.celulares),
    fixos: (e.fixos || []).map(fmtPhone).filter(Boolean),
    emails: allEmails(e.emails),
    endereco: fmtEndereco(e.endereco),
    dataFundacao: e.data_fundacao ?? null,
    nomeFantasia: e.nome_fantasia ?? null,
    carros: (e.carros || []).map((c) => ({ marca: c.marca ?? null, ano: c.ano_modelo ?? c.ano_fabricacao ?? null, placa: c.placa ?? null })),
  };

  // Sócios pessoa física (documento com 11 dígitos = CPF).
  const socios = (e.socios ?? []).filter((s) => onlyDigits(s.cpf).length === 11);
  const people = [];
  let anyFail = false;
  for (const s of socios) {
    const pes = await lemitPost('pessoa', onlyDigits(s.cpf));
    if (!pes.ok) anyFail = true;
    const p = pes.data?.pessoa;
    const bp = p ? bestPhone(p.celulares) : { phone: null, whatsapp: false };
    const participacoes = Array.isArray(p?.participacao_societaria) ? p.participacao_societaria : [];
    const companies = participacoes.map((c) => ({
      nome: c.nome ?? null,
      cnpj: c.cnpj ?? null,
      situacao: c.situacao_cadastral ?? null,
      participacao: c.participacao_socio ?? null,
    }));
    people.push({
      cpf: onlyDigits(s.cpf),
      nome: s.nome ?? p?.nome ?? null,
      phone: bp.phone,
      whatsapp: bp.whatsapp,
      email: p ? bestEmail(p.emails) : null,
      companiesCount: companies.length,
      companies,
      // dados completos da pessoa (Lemit)
      lemit: p
        ? {
            phones: allPhones(p.celulares),
            fixos: (p.fixos || []).map(fmtPhone).filter(Boolean),
            emails: allEmails(p.emails),
            enderecos: (p.enderecos || []).map(fmtEndereco).filter(Boolean),
            dataNascimento: p.data_nascimento ?? null,
            renda: p.renda ?? null,
            ocupacao: p.ocupacao ?? null,
            situacaoCpf: p.situacao_cpf ?? null,
            scoreCredito: p.risco_credito?.score_credito ?? null,
            vinculos: (p.vinculos || []).map((v) => ({ nome: v.nome_vinculo ?? null, tipo: v.tipo_vinculo ?? null })),
            carros: (p.carros || []).map((c) => ({ marca: c.marca ?? null, ano: c.ano_modelo ?? c.ano_fabricacao ?? null, placa: c.placa ?? null })),
          }
        : null,
    });
  }
  return { ok: !anyFail, company, people };
}

// --- Google Meu Negócio (via Serper Places) ---------------------------------
// `rejeitados` = cids de fichas que o operador apagou (chave gmn do lead) —
// pula pra próxima ficha da resposta; se só sobrar rejeitada, "não encontrado".
async function serperPlaces(company, cidade, rejeitados = [], { telefones = [], nomeCompleto = null } = {}) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { ok: true, found: false, note: 'serper_desativado' };
  const bloqueados = new Set((rejeitados ?? []).map(String));
  try {
    const res = await fetchWithTimeout(
      'https://google.serper.dev/places',
      {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ q: `${company} ${cidade ?? ''}`.trim(), gl: 'br', hl: 'pt-br' }),
      },
      12000,
    );
    if (!res.ok) return { ok: false, found: false };
    const j = await res.json();
    const places = (j.places ?? []).filter((x) => !bloqueados.has(String(x.cid ?? '')));
    if (!places.length) return { ok: true, found: false };
    // Conferência (antes: primeira ficha da resposta). A ficha tem que bater com a
    // marca no título OU com um telefone conhecido (Lemit/DataStone); cidade no
    // endereço e posição desempatam. Nada bate → "não encontrado" (com candidatas).
    const fones = new Set((telefones ?? []).map((t) => onlyDigits(t).slice(-8)).filter((d) => d.length === 8));
    const marca = normText(company);
    // Palavras do nome completo (razão social sem sufixo jurídico): "net
    // empreendimentos imobiliarios" — a marca limpa ("net") sozinha é genérica.
    const palavras = normText(nomeCompleto || '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !JURIDICO_RE.test(w));
    const cobre = (titulo) => palavras.length >= 2 && palavras.filter((w) => normText(titulo).includes(w)).length / palavras.length >= 0.6;
    const avaliadas = places.map((x, i) => {
      const sinais = [];
      let score = 0;
      const titulo = String(x.title ?? '');
      // marca inteira no título (ex.: "construtora alfa") vale mais que um token em
      // comum ("alfa festas e eventos" também tem "alfa").
      if ((marca.length >= 4 && normText(titulo).includes(marca)) || cobre(titulo)) { score += 4; sinais.push('marca_no_titulo'); }
      else if (resultMatchesCompany({ title: titulo, desc: '' }, company)) { score += 2; sinais.push('marca_parcial'); }
      if (fones.size && fones.has(onlyDigits(x.phoneNumber).slice(-8))) { score += 3; sinais.push('telefone_confere'); }
      if (cidade && normText(cidade).length >= 3 && normText(x.address ?? '').includes(normText(cidade))) { score += 2; sinais.push('cidade_no_endereco'); }
      if (i === 0) score += 1;
      return { x, score, sinais };
    });
    avaliadas.sort((a, b) => b.score - a.score);
    const top = avaliadas[0];
    const conferida =
      top.sinais.includes('marca_no_titulo') || top.sinais.includes('telefone_confere') ||
      (top.sinais.includes('marca_parcial') && top.sinais.includes('cidade_no_endereco')) ||
      (places.length === 1 && top.sinais.includes('cidade_no_endereco'));
    if (!conferida) {
      return { ok: true, found: false, note: 'ficha_nao_confere', candidatos: places.slice(0, 3).map((x) => ({ title: x.title ?? null, address: x.address ?? null, cid: x.cid ?? null })) };
    }
    const p = top.x;
    return {
      ok: true,
      found: true,
      confianca: top.sinais.includes('telefone_confere') || (top.sinais.includes('marca_no_titulo') && top.sinais.length >= 2) ? 'alta' : 'media',
      sinais: top.sinais,
      title: p.title ?? null,
      rating: p.rating ?? null,
      reviews: p.ratingCount ?? null,
      category: p.category ?? null,
      address: p.address ?? null,
      phone: p.phoneNumber ?? null,
      website: p.website ?? null,
      cid: p.cid ?? null, // identificador do Google → link direto do Maps
      latitude: p.latitude ?? null,
      longitude: p.longitude ?? null,
      openingHours: p.openingHours ?? p.hours ?? null, // { seg: "9–18", ... } quando disponível
      thumbnail: p.thumbnailUrl ?? p.thumbnail ?? null,
    };
  } catch {
    return { ok: false, found: false };
  }
}

// --- Empreendimentos (via IA / Claude) --------------------------------------
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

// Cliente Anthropic (SDK oficial) — lazy; lê ANTHROPIC_API_KEY do ambiente.
// O SDK já traz retry/backoff e timeout embutidos.
let _anthropic = null;
function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}
// Chama o modelo e devolve o texto do bloco 'text' (mesma extração do fetch cru:
// ignora eventual bloco de "thinking"). Lança em erro (o chamador trata).
async function anthropicText(model, maxTokens, prompt) {
  const client = anthropicClient();
  if (!client) return null;
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return (msg.content ?? []).find((c) => c.type === 'text')?.text ?? '';
}

async function anthropicExtractEmpreendimentos(company, context) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: true, empreendimentos: [], note: 'ia_desativada' };
  const prompt =
    `Você recebe conteúdo do site e resultados de busca sobre a construtora/incorporadora "${company}". ` +
    `Extraia os EMPREENDIMENTOS imobiliários dela (prédios/condomínios/loteamentos). ` +
    `Responda APENAS um array JSON, sem texto extra, no formato: ` +
    `[{"nome": string, "cidade": string|null, "status": "lancamento"|"em_obra"|"entregue"|null}]. ` +
    `Se não identificar nenhum com segurança, responda [].\n\n=== CONTEÚDO ===\n${context}`;
  try {
    const text = await anthropicText('claude-haiku-4-5-20251001', 1024, prompt);
    if (text == null) return { ok: false, empreendimentos: [] };
    const m = text.match(/\[[\s\S]*\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    return { ok: true, empreendimentos: Array.isArray(arr) ? arr : [] };
  } catch {
    return { ok: false, empreendimentos: [] };
  }
}

// Acha a landing page real de um empreendimento. Prioriza a LP no domínio do
// PRÓPRIO site da empresa (mais confiável que portal/link solto).
async function findEmpreendimentoLP(nome, cidade, company, siteDomain) {
  const { results } = await rawSearch(`${nome} ${cidade ?? ''} ${company}`.trim());
  const matches = results.filter((r) => !isBlocked(r.url) && resultMatchesCompany(r, nome));
  if (matches.length === 0) return null;
  if (siteDomain) {
    const own = matches.find((r) => {
      try {
        return new URL(r.url).hostname.replace(/^www\./, '').includes(siteDomain);
      } catch {
        return false;
      }
    });
    if (own) return stripQuery(own.url);
  }
  return stripQuery(matches[0].url);
}

async function discoverEmpreendimentos({ company, nomeFantasia, cidade, siteUrl }) {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: true, empreendimentos: [], note: 'ia_desativada' };
  const nome = nomeFantasia || company;
  let context = '';
  if (siteUrl) {
    const r = await fetchHtmlCached(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`, 12000);
    if (r?.html) context += 'SITE:\n' + stripHtml(r.html) + '\n\n';
  }
  // Busca ancorada no nome fantasia (mais assertivo que a razão social).
  const { results } = await rawSearch(`empreendimentos lançamentos ${nome} ${cidade ?? ''}`.trim());
  context += 'BUSCA:\n' + results.slice(0, 8).map((r) => `${r.title} — ${r.desc} — ${r.url}`).join('\n');

  const base = await anthropicExtractEmpreendimentos(nome, context.slice(0, 8000));
  if (!base.ok) return base;

  // Domínio do próprio site da empresa — usado para priorizar a LP correta.
  let siteDomain = null;
  if (siteUrl) {
    try {
      siteDomain = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`).hostname.replace(/^www\./, '');
    } catch {
      /* ignora url inválida */
    }
  }

  // 1) LP real SÓ dos ativos (lançamento/em obra). Busca é serializada (rate limit).
  const withLp = [];
  for (const e of base.empreendimentos) {
    const ativo = e.status === 'lancamento' || e.status === 'em_obra';
    const lp = ativo ? await findEmpreendimentoLP(e.nome, e.cidade ?? cidade, company, siteDomain) : null;
    withLp.push({ ...e, lp });
  }

  // 2) Auditoria da LP (site + WhatsApp + PageSpeed) — no máx. 2 por vez para
  // não estourar o rate do PageSpeed.
  const empreendimentos = await mapLimit(withLp, 2, async (e) => {
    if (!e.lp) return { ...e, lpAudit: null };
    try {
      return { ...e, lpAudit: await buildLpAudit(e.lp) };
    } catch {
      return { ...e, lpAudit: null };
    }
  });
  return { ok: true, empreendimentos };
}

// --- PageSpeed Insights (Google, grátis) ------------------------------------
// Re-tenta em 429/5xx/timeout — PSI pode falhar quando várias LPs rodam juntas.
async function pagespeed(url, strategy = 'mobile') {
  if (!url) return { ok: false };
  const key = process.env.PAGESPEED_API_KEY;
  const cats = ['performance', 'seo', 'best-practices', 'accessibility']
    .map((c) => `category=${c}`)
    .join('&');
  const u =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}` +
    `&strategy=${strategy}&${cats}${key ? `&key=${key}` : ''}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(u, {}, 45000); // PSI é lento (roda Lighthouse)
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (attempt + 1)); // backoff e tenta de novo
        continue;
      }
      if (!res.ok) return { ok: false };
      const j = await res.json();
      const cat = j.lighthouseResult?.categories ?? {};
      const pct = (c) => (c && c.score != null ? Math.round(c.score * 100) : null);
      const lcp = j.lighthouseResult?.audits?.['largest-contentful-paint']?.numericValue ?? null;
      return {
        ok: true,
        performance: pct(cat.performance),
        seo: pct(cat.seo),
        bestPractices: pct(cat['best-practices']),
        accessibility: pct(cat.accessibility),
        lcpMs: lcp != null ? Math.round(lcp) : null,
      };
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  return { ok: false };
}

// Auditoria completa de uma LP: site (WhatsApp/pixels/form) + PageSpeed mobile E
// desktop. Reaproveitada pelo enriquecimento e pelo endpoint sob demanda.
async function buildLpAudit(url) {
  const a = await auditUrl(url);
  const [psM, psD, px] = a.isOnline
    ? await Promise.all([pagespeed(a.siteUrl, 'mobile'), pagespeed(a.siteUrl, 'desktop'), headlessPixelCheck(a.siteUrl)])
    : [{ ok: false }, { ok: false }, { ok: false }];
  const psObj = (ps) =>
    ps.ok
      ? { performance: ps.performance, seo: ps.seo, bestPractices: ps.bestPractices, accessibility: ps.accessibility, lcpMs: ps.lcpMs }
      : null;
  // Pixels: UNIÃO dos dois métodos (headless que roda o JS + estático do HTML) —
  // se qualquer um achou, tem. Evita falso negativo dos dois lados (GTM injeta o
  // que o HTML não mostra; conversão do Google às vezes só dispara em evento).
  const pxOk = px.ok;
  return {
    siteUrl: a.siteUrl,
    isOnline: a.isOnline,
    httpsValid: a.httpsValid,
    loadTimeMs: a.loadTimeMs,
    whatsappButtons: a.whatsappButtons,
    hasWhatsappWidget: a.hasWhatsappWidget,
    hasMetaPixel: (pxOk && px.hasMetaPixel) || a.hasMetaPixel,
    hasGoogleTag: (pxOk && px.hasGoogleTag) || a.hasGoogleTag,
    hasGoogleAds: (pxOk && px.hasGoogleAds) || !!a.hasGoogleAds,
    hasTiktokPixel: (pxOk && px.hasTiktokPixel) || !!a.hasTiktokPixel,
    pixelsConfirmed: pxOk, // true = passou pela checagem headless (rodou o JS)
    form: a.form,
    pagespeed: psObj(psM),
    pagespeedDesktop: psObj(psD),
  };
}

// --- Anúncios (headless / Playwright): contagem real na Meta Ad Library ------
// Navegador headless reutilizado + mutex (1 operação por vez) para não pesar.
let _browserPromise = null;
let _playwrightMissing = false;
async function getBrowser() {
  if (_playwrightMissing) return null;
  if (!_browserPromise) {
    _browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        _playwrightMissing = true; // pacote ausente (dev sem setup:motor): não re-tenta
        return null;
      }
      try {
        // Flags de container (Railway): /dev/shm pequeno derruba o Chromium no meio
        // da página; sem GPU/sandbox. Se o browser cair, a próxima chamada reabre.
        const browser = await chromium.launch({
          headless: true,
          args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--no-zygote', '--disable-extensions', '--mute-audio'],
        });
        browser.on('disconnected', () => {
          console.warn('[anuncios] Chromium desconectou — reabre na próxima chamada');
          _browserPromise = null;
        });
        return browser;
      } catch (err) {
        // Falha de LAUNCH pode ser transitória (boot/memória): zera a promise
        // para re-tentar na próxima requisição, em vez de ficar "sem headless"
        // até reiniciar o processo.
        console.warn('[anuncios] falha ao abrir o Chromium:', String(err?.message || err).slice(0, 200));
        _browserPromise = null;
        return null;
      }
    })();
  }
  return _browserPromise;
}

// Pool de concorrência do headless. COM proxy (IPs rodando) dá pra rodar várias
// buscas ao mesmo tempo com segurança → mede um lead em ~20-30s, não em 3 min.
// SEM proxy, mantém 1 por vez (serial + cadência) pra não tomar ban de um único IP.
const HEADLESS_CONCURRENCY = process.env.PROXY_SERVER ? 4 : 1;
let _headlessActive = 0;
const _headlessWaiters = [];
async function runHeadless(fn) {
  if (_headlessActive >= HEADLESS_CONCURRENCY) {
    await new Promise((resolve) => _headlessWaiters.push(resolve));
  }
  _headlessActive += 1;
  try {
    return await fn();
  } finally {
    _headlessActive -= 1;
    const next = _headlessWaiters.shift();
    if (next) next();
  }
}

// Confirma pixels de rastreamento RODANDO o JavaScript da LP (não só o HTML): abre
// a página como um visitante, observa as CHAMADAS DE REDE que os pixels disparam e
// os objetos globais. É a LP do próprio cliente (sem anti-bot) → sem proxy, direto.
async function headlessPixelCheck(url) {
  return runHeadless(async () => {
    const browser = await getBrowser();
    if (!browser) return { ok: false };
    let ctx;
    try {
      ctx = await browser.newContext({ locale: 'pt-BR', userAgent: UA, viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const hit = { meta: false, googleAds: false, googleTag: false, tiktok: false };
      page.on('request', (req) => {
        const u = req.url();
        if (/facebook\.com\/tr|connect\.facebook\.net\/[^"']*fbevents/i.test(u)) hit.meta = true;
        if (/googleadservices\.com\/pagead\/conversion|googleads\.g\.doubleclick\.net|google\.com\/pagead\/1p-conversion/i.test(u)) hit.googleAds = true;
        if (/googletagmanager\.com\/(gtm|gtag)|google-analytics\.com|analytics\.google\.com\/g\/collect/i.test(u)) hit.googleTag = true;
        if (/analytics\.tiktok\.com|tiktok\.com\/i18n\/pixel/i.test(u)) hit.tiktok = true;
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4500); // deixa as tags (inclusive via GTM) dispararem
      const g = await page
        .evaluate(() => {
          const dl = Array.isArray(window.dataLayer) ? JSON.stringify(window.dataLayer).slice(0, 20000) : '';
          return {
            fbq: typeof window.fbq === 'function' || !!window._fbq,
            gtag: typeof window.gtag === 'function' || Array.isArray(window.dataLayer) || !!window.google_tag_manager,
            aw: /AW-\d{6,}/.test(dl),
            ttq: !!window.ttq,
          };
        })
        .catch(() => ({}));
      return {
        ok: true,
        hasMetaPixel: hit.meta || !!g.fbq,
        hasGoogleAds: hit.googleAds || !!g.aw,
        hasGoogleTag: hit.googleTag || !!g.gtag,
        hasTiktokPixel: hit.tiktok || !!g.ttq,
      };
    } catch {
      return { ok: false };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

// --- Boas práticas anti-ban do Meta (cadência + cooldown + cap diário) -------
const META_SAFETY_MS = Number(process.env.META_SAFETY_MS || 20000); // intervalo mínimo entre buscas (bulk sem proxy)
const META_DIRECT_MS = Number(process.env.META_DIRECT_MS || 6000); // intervalo no IP direto (uso interativo)
const META_JITTER_MS = Number(process.env.META_JITTER_MS || 8000); // variação aleatória
const META_DAILY_CAP = Number(process.env.META_DAILY_CAP || 250); // teto diário sem proxy
// Pausa do IP DIRETO após bloqueio. Era 90s: com a fila do F4 a cada 40s, o IP
// do Railway (bloqueado pela Meta) saía do cooldown antes do próximo lead e
// tomava bloqueio de novo — o proxy quase nunca entrava. 15 min dá tempo de a
// fila inteira sair pelo proxy (13/09).
const META_COOLDOWN_MS = Number(process.env.META_COOLDOWN_MS || 15 * 60 * 1000);
let _metaLastTs = 0;
let _metaCooldownUntil = 0;
let _metaDayStamp = '';
let _metaDayCount = 0;

// Proxy residencial (ex.: Decodo) — se configurado, cada consulta sai por um IP
// diferente (rodízio), então não dependemos de cooldown de um único IP.
// .env.local: PROXY_SERVER=http://gate.decodo.com:7000  PROXY_USERNAME=...  PROXY_PASSWORD=...
function proxyConfig() {
  const server = process.env.PROXY_SERVER;
  if (!server) return null;
  return {
    server,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  };
}

// Checagem rápida do proxy (CONNECT) — pega o 407 "sem tráfego" na hora (<1s),
// em vez de deixar cada busca do Meta travar até o timeout. Retorna:
//   { ok:true } | { ok:false, reason:'sem_trafego'|'auth'|'conexao', msg }
function checkProxy() {
  return new Promise((resolve) => {
    const proxy = proxyConfig();
    if (!proxy) return resolve({ ok: true }); // sem proxy configurado, não checa
    const [host, port] = proxy.server.replace(/^https?:\/\//, '').split(':');
    const auth = Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64');
    // GET HTTP (absolute-form) via proxy: um proxy sem tráfego devolve 407 com o
    // corpo/x-error-message legível ("traffic limit"), ao contrário do CONNECT.
    const req = http.request({
      host,
      port: Number(port) || 80,
      method: 'GET',
      path: 'http://ipinfo.io/ip',
      headers: { Host: 'ipinfo.io', 'Proxy-Authorization': `Basic ${auth}` },
      timeout: 8000,
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode < 400) return resolve({ ok: true, ip: body.trim().slice(0, 40) });
        const msg = res.headers['x-error-message'] || body.slice(0, 200);
        const reason = /traffic limit|tráfego|quota|limit/i.test(msg) ? 'sem_trafego' : res.statusCode === 407 ? 'auth' : 'conexao';
        resolve({ ok: false, reason, msg });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'conexao', msg: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: 'conexao', msg: String(e?.message || e) }));
    req.end();
  });
}

// Extrai os CARDS de anúncio do Meta Ad Library (BR, ativos) para um termo:
// { id, advertiser (handle da página), dest (domínios de destino), copy }.
// `pageId` (opcional) troca a busca por palavra-chave pela PÁGINA do anunciante
// (view_all_page_id): devolve exatamente os anúncios ativos daquela página, sem
// ruído de homônimos — é o modo preferido do F4 quando a página foi resolvida.
async function metaAdSearch(term, useProxy = null, force = false, { pageId = null } = {}) {
  return runHeadless(async () => {
    // useProxy explícito manda; se null, usa o proxy se configurado.
    const proxy = useProxy === false ? null : useProxy === true ? proxyConfig() : proxyConfig();
    const usingProxy = !!proxy;
    // Cooldown só quando SEM proxy. `force` ignora o cooldown (usado quando o
    // proxy está indisponível e o direto é a única opção — melhor tentar).
    if (!usingProxy && !force && Date.now() < _metaCooldownUntil) return { ok: true, cards: [], total: null, note: 'meta_bloqueado' };
    // Teto diário (só sem proxy; com proxy o volume é seguro).
    const day = new Date().toISOString().slice(0, 10);
    if (day !== _metaDayStamp) {
      _metaDayStamp = day;
      _metaDayCount = 0;
    }
    if (!usingProxy && _metaDayCount >= META_DAILY_CAP) return { ok: true, cards: [], total: null, note: 'meta_cap' };
    // Cadência atômica: reserva o próximo horário JÁ (antes do await), pra buscas
    // concorrentes ficarem escalonadas de verdade. Com proxy: 1,5s (IP roda).
    // Direto: 6s entre buscas (uso interativo de poucos leads é seguro assim).
    const safety = usingProxy ? 1500 : META_DIRECT_MS;
    const jitter = usingProxy ? 0 : Math.floor(Math.random() * 1500);
    const now = Date.now();
    const slot = Math.max(now, _metaLastTs + safety + jitter);
    _metaLastTs = slot;
    _metaDayCount += 1;
    const wait = slot - now;
    if (wait) await sleep(wait);

    const browser = await getBrowser();
    if (!browser) return { ok: false, cards: [], total: null, note: 'headless_indisponivel' };
    let ctx;
    try {
      ctx = await browser.newContext({
        locale: 'pt-BR',
        userAgent: UA,
        viewport: { width: 1280, height: 800 },
        timezoneId: 'America/Sao_Paulo',
        ...(proxy ? { proxy } : {}),
      });
      const page = await ctx.newPage();
      // Economia de banda (custo por GB do proxy): corta imagem, mídia, fonte,
      // CSS e domínios de rastreio. Só HTML + JS essencial pra renderizar os cards.
      await page.route('**/*', (route) => {
        const req = route.request();
        const t = req.resourceType();
        if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return route.abort();
        if (/googletagmanager|google-analytics|doubleclick|facebook\.com\/tr|connect\.facebook\.net\/signals/i.test(req.url())) return route.abort();
        return route.continue();
      });
      const url = pageId
        ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR` +
          `&view_all_page_id=${encodeURIComponent(pageId)}&search_type=page&media_type=all`
        : `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR` +
          `&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      // Aguarda os resultados, tolerando renavegação do Meta (IP novo do proxy
      // costuma fazer a página redirecionar → "execution context destroyed").
      // Sinais de "carregou" em pt-BR E em inglês (IP do proxy pode receber a UI
      // em inglês): total de resultados, "Identificação da biblioteca"/"Library ID",
      // sem resultado, ou (modo página) "não está exibindo anúncios".
      const RE_LOADED = /\d\s*(resultados?|results?)\b|Identifica[çc][ãa]o da biblioteca|Library ID|nenhum resultado|no results|Nenhum an[úu]ncio corresponde|No ads match|n[ãa]o est[áa] (exibindo|veiculando) an[úu]ncios|isn'?t running ads|not running ads|não há anúncios/i;
      // Casca da Ad Library renderizada (menu + campo de busca) = NÃO é bloqueio;
      // no modo página, a lista pode demorar ou a página simplesmente não ter
      // anúncio ativo (a Meta mostra só o cabeçalho "Anúncios | Sobre").
      const RE_SHELL = /Pesquisar por palavra-chave ou anunciante|Search by keyword or advertiser/i;
      let loaded = false;
      let shell = false;
      const deadline = Date.now() + (pageId ? 26000 : 20000);
      while (!loaded && Date.now() < deadline) {
        await page.waitForTimeout(900);
        try {
          const r = await page.evaluate(([re, reShell]) => {
            const t = document.body.innerText || '';
            return { loaded: new RegExp(re, 'i').test(t), shell: new RegExp(reShell, 'i').test(t) };
          }, [RE_LOADED.source, RE_SHELL.source]);
          loaded = r.loaded;
          shell = r.shell;
          if (!loaded && shell && pageId) await page.mouse.wheel(0, 2500).catch(() => {}); // lista lazy
        } catch {
          /* renavegação (IP novo redireciona) — tenta de novo no próximo ciclo */
        }
      }
      if (!loaded && shell && pageId) {
        // Casca ok e nenhum anúncio listado após a espera: página sem anúncio ativo.
        if (!usingProxy) _metaCooldownUntil = 0;
        const diag = await page.evaluate(() => ({ url: location.href, title: document.title, texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200) })).catch(() => null);
        console.warn('[meta] página sem anúncios listados', JSON.stringify(diag).slice(0, 600));
        return { ok: true, cards: [], total: 0, note: 'pagina_sem_anuncios', diag };
      }
      if (!loaded) {
        // Não carregou (bloqueio transitório OU carga lenta). Sem proxy: cooldown
        // (15 min) — com proxy: ignora o IP. Devolve um diagnóstico da página
        // (título + começo do texto) pra ver a causa real no bridge/log.
        if (!usingProxy) _metaCooldownUntil = Date.now() + META_COOLDOWN_MS;
        const diag = await page.evaluate(() => ({ url: location.href, title: document.title, texto: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400) })).catch(() => null);
        console.warn('[meta] não carregou', usingProxy ? '(proxy)' : '(direto)', JSON.stringify(diag).slice(0, 500));
        return { ok: true, cards: [], total: null, note: 'meta_bloqueado', diag };
      }
      // Carregou pelo IP direto → o IP está saudável: zera qualquer cooldown.
      if (!usingProxy) _metaCooldownUntil = 0;
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, 4000).catch(() => {});
        await page.waitForTimeout(900);
      }
      const data = await page.evaluate(() => {
        const bodyTxt = document.body.innerText.slice(0, 3000);
        const tm = bodyTxt.match(/~?\s*([\d.,]+)\s*(resultados?|results?)\b/i);
        const total = tm ? parseInt(tm[1].replace(/[.,]/g, ''), 10) : null;
        const cards = [];
        const seen = new Set();
        const idNodes = [...document.querySelectorAll('div')].filter(
          (d) => /Identifica[çc][ãa]o da biblioteca|Library ID/i.test(d.textContent || '') && (d.innerText || '').length < 2500,
        );
        for (const idNode of idNodes) {
          let el = idNode;
          for (let k = 0; k < 8 && el.parentElement; k++) {
            if (/Patrocinad|Sponsored/i.test(el.innerText || '')) break;
            el = el.parentElement;
          }
          const text = (el.innerText || '').replace(/\s+/g, ' ');
          const idm = text.match(/(?:Identifica[çc][ãa]o da biblioteca|Library ID):\s*(\d+)/i);
          const id = idm ? idm[1] : null;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const pages = [...el.querySelectorAll('a[href*="facebook.com/"]')]
            .map((a) => a.getAttribute('href') || '')
            .filter((h) => h && !/ads\/library|l\.php|\/ads\//.test(h))
            .map((h) => {
              try {
                return new URL(h, location.href).pathname.replace(/\//g, '');
              } catch {
                return '';
              }
            })
            .filter(Boolean);
          // Destinos reais do anúncio: resolve os links (l.php?u=) e hrefs diretos.
          // Separa WhatsApp (msg direta) do domínio de LP/site.
          const resolved = [];
          for (const a of el.querySelectorAll('a[href]')) {
            const h = a.getAttribute('href') || '';
            try {
              if (/l\.facebook\.com\/l\.php/.test(h)) {
                const u = new URL(h, location.href).searchParams.get('u');
                if (u) resolved.push(u);
              } else if (/wa\.me|whatsapp\.com/i.test(h)) {
                resolved.push(h);
              }
            } catch {
              /* link inválido — ignora */
            }
          }
          const isWhats = (u) => /wa\.me|(?:api|web|chat)\.whatsapp\.com|whatsapp\.com\/(?:send|catalog|message)/i.test(u);
          // WhatsApp: link direto OU o texto do anúncio cita zap/whatsapp explicitamente.
          const whatsapp = resolved.some(isWhats) || /whats\s?app|\bno zap\b|chama no whats|chamar no whats/i.test(text);
          const dest = [...new Set(
            resolved
              .filter((u) => !isWhats(u))
              .map((u) => {
                try {
                  return new URL(u).hostname.replace(/^www\./, '');
                } catch {
                  return null;
                }
              })
              .filter(Boolean),
          )];
          // Criativo: URL da maior imagem fbcdn do card (miniatura carrega no
          // navegador do operador; o robô não baixa a imagem → proxy barato).
          const imgs = [...el.querySelectorAll('img')]
            .map((i) => i.getAttribute('src') || '')
            .filter((s) => /fbcdn|scontent/i.test(s));
          const sizeOf = (u) => {
            const m = u.match(/[sp](\d{2,4})x\d{2,4}/);
            return m ? parseInt(m[1], 10) : 0;
          };
          const imagem = imgs.length ? imgs.slice().sort((a, b) => sizeOf(b) - sizeOf(a))[0] : null;
          // Tipo de mídia do criativo: vídeo (tag <video>), carrossel (2+ imagens
          // grandes) ou imagem estática. Vídeo costuma converter mais.
          const hasVideo = !!el.querySelector('video') || /\brole=["']?button["']?[^>]*aria-label=["'][^"']*v[íi]deo/i.test(el.innerHTML || '');
          const bigImgs = imgs.filter((u) => sizeOf(u) >= 200);
          const midiaTipo = hasVideo ? 'video' : bigImgs.length > 1 ? 'carrossel' : 'imagem';
          cards.push({
            id,
            advertiser: pages[0] || null,
            dest: dest.slice(0, 3),
            whatsapp,
            midiaTipo,
            copy: text.slice(0, 500),
            imagem,
          });
          if (cards.length >= 40) break;
        }
        return { total, cards };
      });
      return { ok: true, cards: data.cards, total: data.total };
    } catch (e) {
      // Falha de proxy (ex.: Decodo sem tráfego → 407, ou túnel recusado) tem
      // tratamento próprio pra avisar o operador com clareza.
      const msg = String(e?.message || e);
      const proxyErro = usingProxy && /proxy|tunnel|ERR_PROXY|ERR_TUNNEL|407|ERR_HTTP_RESPONSE_CODE/i.test(msg);
      return { ok: false, cards: [], total: null, note: proxyErro ? 'proxy_falhou' : undefined };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

const normKey = (s) => normText(s).replace(/[^a-z0-9]/g, '');

// Pontua um card contra o lead. >=2 sinais = validado; 1 = a validar; 0 = descarta.
function scoreAd(card, ctx) {
  const copy = normText(card.copy);
  const advKey = normKey(card.advertiser || '');
  const signals = [];
  let empreend = null;

  // S1 — anunciante = página oficial do lead (sinal mais forte)
  if (ctx.fbKey && advKey && (advKey.includes(ctx.fbKey) || ctx.fbKey.includes(advKey))) {
    signals.push('conta oficial');
  }
  // S2 — nome da construtora no copy ou no handle
  if (ctx.construtoraTokens.some((t) => copy.includes(t) || advKey.includes(t))) {
    signals.push('construtora no anúncio');
  }
  // S3 — domínio de destino = site ou LP de um empreendimento
  const destKeys = (card.dest || []).map((d) => normKey(d));
  if (ctx.siteDomainKey && destKeys.some((d) => d.includes(ctx.siteDomainKey) || ctx.siteDomainKey.includes(d))) {
    signals.push('domínio do site');
  }
  for (const e of ctx.empreendimentos) {
    if (e.domainKey && destKeys.some((d) => d.includes(e.domainKey) || e.domainKey.includes(d))) {
      signals.push('domínio da LP');
      empreend = e.nome;
      break;
    }
  }
  // S4 — nome de um empreendimento no copy
  if (!empreend) {
    for (const e of ctx.empreendimentos) {
      if (e.tokens.length && e.tokens.every((t) => copy.includes(t))) {
        signals.push('empreendimento no anúncio');
        empreend = e.nome;
        break;
      }
    }
  }
  // S5 — cidade no copy
  if (ctx.cidadeKey && copy.replace(/[^a-z0-9]/g, '').includes(ctx.cidadeKey)) {
    signals.push('cidade');
  }

  // Níveis de confiança (sugestão — nada é jogado fora):
  //  ALTA: anúncio DA PÁGINA OFICIAL do cliente (é dele, ponto), ou 2+ sinais fortes.
  //  MÉDIA: 1 sinal forte (domínio/LP/nome do empreendimento) — confirmar.
  //  BAIXA: só sinal fraco ("cidade"/token genérico) ou nenhum — revisar.
  const FORTES = ['conta oficial', 'domínio do site', 'domínio da LP', 'empreendimento no anúncio'];
  const contaOficial = signals.includes('conta oficial');
  const fortes = signals.filter((s) => FORTES.includes(s)).length;
  const score = signals.length;
  const bucket = contaOficial || fortes >= 2 ? 'validado' : fortes >= 1 ? 'a_validar' : 'descartado';
  // Destino do anúncio: WhatsApp (msg direta) > LP/site externo > perfil (sem link).
  const destTipo = card.whatsapp ? 'whatsapp' : (card.dest && card.dest.length) ? 'lp' : 'perfil';
  return {
    id: card.id,
    advertiser: card.advertiser,
    dest: card.dest,
    destTipo,
    midiaTipo: card.midiaTipo ?? 'imagem',
    imagem: card.imagem ?? null,
    empreendimento: empreend,
    score,
    signals,
    bucket,
    // trecho legível do copy (após "Patrocinado")
    trecho: (card.copy.split(/Patrocinad[oa]/i)[1] || card.copy).replace(/Abrir menu suspenso|Ver detalhes do an[úu]ncio/gi, '').trim().slice(0, 160),
  };
}

// Anúncios de um lead com VALIDAÇÃO CRUZADA (busca pela empresa + pontuação).
async function anunciosHeadless(payload) {
  // "ok" SÓ quando a medição realmente aconteceu — sem headless ou sem termo de
  // busca é FALHA (ok:false), para o funil nunca marcar "Auditado" sem medir.
  const browser = await getBrowser();
  if (!browser) return { ok: false, note: 'headless_indisponivel', meta: null };
  const { company, fbHandle, siteDomain, cidade, empreendimentos, metaPageId } = payload || {};
  if (!company && !metaPageId) return { ok: false, note: 'sem_termo_busca', meta: null };

  // Estratégia de IP (13/09): PROXY PRIMEIRO quando configurado e com tráfego —
  // o IP direto do Railway é bloqueado pela Meta com frequência e, no desenho
  // antigo ("direto primeiro, proxy só em cooldown"), o proxy quase nunca era
  // usado. Sem proxy (ou proxy sem tráfego/auth), cai pro direto; se o direto
  // estiver em cooldown, FORÇA mesmo assim (melhor tentar que falhar em silêncio)
  // e o operador vê o motivo real no aviso.
  const diretoEmCooldown = Date.now() < _metaCooldownUntil;
  let useProxy = false;
  let forceDireto = false;
  let avisoProxy = null;
  if (proxyConfig()) {
    const pc = await checkProxy();
    if (pc.ok) useProxy = true;
    else {
      avisoProxy = pc.reason === 'sem_trafego' ? 'proxy_sem_trafego' : pc.reason === 'auth' ? 'proxy_auth' : 'proxy_conexao';
      forceDireto = diretoEmCooldown;
    }
  } else {
    forceDireto = diretoEmCooldown;
  }

  const ctx = {
    // Conta oficial: handle do Facebook OU, na falta dele, o nome da empresa
    // (o handle do anúncio "rdc.construtora" casa com "RDC Construtora").
    fbKey: normKey(fbHandle || company),
    construtoraTokens: normText(company)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !['construtora', 'incorporadora', 'empreendimentos', 'ltda', 'incorporacao'].includes(t)),
    siteDomainKey: siteDomain ? normKey(siteDomain.split('.')[0]) : null,
    cidadeKey: cidade ? normKey(cidade) : null,
    empreendimentos: (empreendimentos || []).map((e) => ({
      nome: e.nome,
      domainKey: e.domain ? normKey(e.domain.split('.')[0]) : null,
      tokens: normText(e.nome).split(/[^a-z0-9]+/).filter((t) => t.length >= 4),
    })),
  };

  // MODO PÁGINA (preferido): a chave "Página na Meta Ad Library" foi resolvida/
  // validada → uma única consulta por view_all_page_id devolve exatamente os
  // anúncios ativos daquela página. Todos são do cliente por definição
  // (sinal "página oficial"); o scoreAd só entra para atribuir empreendimento/
  // destino. A busca por palavra-chave abaixo vira fallback.
  if (metaPageId) {
    const s = await metaAdSearch(company || String(metaPageId), useProxy, forceDireto, { pageId: metaPageId });
    if (!s.ok) return { ok: false, note: s.note ?? avisoProxy ?? undefined, meta: null, diag: s.diag };
    if (s.note === 'meta_bloqueado' || s.note === 'meta_cap') return { ok: true, note: avisoProxy || s.note, meta: null, viaProxy: useProxy, diag: s.diag };
    // 'pagina_sem_anuncios' = mediu e a página não tem anúncio ativo → meta com zero (é medição válida).
    const scored = s.cards.map((c) => {
      const sc = scoreAd(c, ctx);
      sc.signals = ['página oficial', ...(sc.signals || []).filter((x) => x !== 'conta oficial')];
      sc.score = sc.signals.length;
      sc.bucket = 'validado';
      return sc;
    });
    const porEmpreendimento = {};
    for (const v of scored) if (v.empreendimento) porEmpreendimento[v.empreendimento] = (porEmpreendimento[v.empreendimento] || 0) + 1;
    return {
      ok: true,
      note: s.note === 'pagina_sem_anuncios' || !scored.length ? 'meta_sem_resultado' : undefined,
      diag: s.note === 'pagina_sem_anuncios' ? s.diag : undefined,
      meta: {
        modo: 'pagina',
        pageId: String(metaPageId),
        total: s.total ?? scored.length,
        validados: scored,
        aValidar: [],
        descartados: [],
        porEmpreendimento,
        termo: `página ${metaPageId}`,
        termosBuscados: [],
        termosIgnorados: [],
      },
    };
  }

  // Termos de busca (FALLBACK sem página resolvida): a EMPRESA + o NOME de cada
  // empreendimento (lançamentos e obras). Cada termo é uma consulta ao Meta.
  const termos = [company, ...(empreendimentos || []).map((e) => e.nome)]
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  const vistos = new Set();
  const termosUnicos = [];
  for (const t of termos) {
    const k = normKey(t);
    if (k.length < 3 || vistos.has(k)) continue;
    vistos.add(k);
    termosUnicos.push(t);
  }
  const MAX_TERMOS = 8; // teto anti-ban (empresa + até 7 empreendimentos)
  const termosBusca = termosUnicos.slice(0, MAX_TERMOS);
  const termosIgnorados = termosUnicos.slice(MAX_TERMOS).map((t) => t);

  // Com proxy: buscas EM PARALELO (IPs rodam). No IP direto: SEQUENCIAL com
  // cadência de 6s, pra não disparar rajada do mesmo IP e evitar bloqueio.
  let resultados;
  if (useProxy) {
    resultados = await Promise.all(termosBusca.map((termo) => metaAdSearch(termo, true)));
  } else {
    resultados = [];
    for (const termo of termosBusca) resultados.push(await metaAdSearch(termo, false, forceDireto));
  }
  const cardsById = new Map();
  const termosOk = [];
  let algumBloqueio = false;
  termosBusca.forEach((termo, i) => {
    const s = resultados[i];
    if (!s.ok) return;
    if (s.note === 'meta_bloqueado') { algumBloqueio = true; return; }
    termosOk.push(termo);
    for (const c of s.cards) if (!cardsById.has(c.id)) cardsById.set(c.id, c);
  });
  if (!termosOk.length) {
    // Nenhum termo respondeu. Se o direto bloqueou e o proxy estava sem tráfego,
    // avisa o gap do proxy; senão, informa bloqueio ou simplesmente sem resultado.
    const note = algumBloqueio ? (avisoProxy || 'meta_bloqueado') : (avisoProxy || 'meta_sem_resultado');
    return { ok: true, note, meta: null, viaProxy: useProxy, diag: resultados.find((r) => r?.diag)?.diag };
  }

  const scored = [...cardsById.values()].map((c) => scoreAd(c, ctx));
  const validados = scored.filter((s) => s.bucket === 'validado');
  const aValidar = scored.filter((s) => s.bucket === 'a_validar');
  // NADA é jogado fora: o "descartado" é só o nível de menor confiança (sugestão).
  // Trazemos TODOS para a análise manual; o operador promove/rebaixa.
  const descartados = scored.filter((s) => s.bucket === 'descartado');

  // Contagem por empreendimento (dos validados atribuídos)
  const porEmpreendimento = {};
  for (const v of validados) {
    if (v.empreendimento) porEmpreendimento[v.empreendimento] = (porEmpreendimento[v.empreendimento] || 0) + 1;
  }

  return {
    ok: true,
    note: algumBloqueio ? 'meta_parcial' : undefined, // algum termo bloqueou, mas houve resultado
    meta: {
      modo: 'keyword',
      total: scored.length, // anúncios únicos analisados (todos os termos juntos)
      validados,
      aValidar,
      descartados,
      porEmpreendimento,
      termo: termosOk.join(' · '),
      termosBuscados: termosOk,
      termosIgnorados, // termos além do teto anti-ban (não buscados)
    },
  };
}

// ============================================================================
// ANUNCIANTES (F4 por identidade, não por palavra-chave) — 13/09
// Resolve a PÁGINA do lead na Meta Ad Library (page id) a partir do Facebook
// validado, e o(s) ANUNCIANTE(s) no Google Ads Transparency Center a partir do
// domínio do site validado. Ambos viram "chaves de busca" que o operador confere.
// ============================================================================

// Page id do Facebook a partir do @/URL da página. Ordem: (1) HTML público da
// página — tag al:android:url = fb://page/<id> (sem headless, barato);
// (2) busca "por página" na Ad Library (headless, proxy quando disponível).
function decodeHtml(t) {
  return String(t).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
async function resolverMetaPageId(fbUrlOuHandle, { marca = null } = {}) {
  const bruto = String(fbUrlOuHandle || '').trim();
  const handle = bruto.match(/facebook\.com\/([^/?#]+)/i)?.[1] || bruto.replace(/^@/, '');
  if (!handle) return { ok: false, pageId: null, note: 'sem_handle' };
  if (/^\d{5,}$/.test(handle)) return { ok: true, pageId: handle, pageName: null, via: 'id', handle };

  // (0) Page Plugin público (plugins/page.php): HTML estático com o link
  // facebook.com/<pageId>?ref=embed_page e title="<nome da página>". Funciona
  // sem login e sem headless; verificado 13/09 (starraceroutlet, MRV, cyrela).
  try {
    const r = await fetchWithTimeout(
      `https://www.facebook.com/plugins/page.php?href=${encodeURIComponent(`https://www.facebook.com/${handle}`)}&tabs=&width=340&height=130&small_header=true`,
      { headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' }, redirect: 'follow' },
      12000,
    );
    const html = await r.text();
    const m = html.match(/facebook\.com\/(\d{5,})\?ref=embed_page/);
    if (m) {
      const nome = html.match(/title="([^"]{1,160})"\s+href="https:\/\/www\.facebook\.com\/\d{5,}\?ref=embed_page/)?.[1] ?? null;
      return { ok: true, pageId: m[1], pageName: nome ? decodeHtml(nome) : null, via: 'plugin', handle };
    }
  } catch { /* segue */ }

  try {
    const r = await fetchWithTimeout(`https://www.facebook.com/${encodeURIComponent(handle)}`, {
      headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' },
      redirect: 'follow',
    }, 12000);
    const html = await r.text();
    const m = html.match(/fb:\/\/page\/(\d{5,})/) || html.match(/"pageID":"(\d{5,})"/) || html.match(/"page_id":"?(\d{5,})"?/) || html.match(/[?&]page_id=(\d{5,})/);
    if (m) {
      const title = (html.match(/<title[^>]*>([^<]{2,160})<\/title>/i)?.[1] ?? '').replace(/\s*[|·-]\s*Facebook.*$/i, '').trim();
      return { ok: true, pageId: m[1], pageName: title || null, via: 'html', handle };
    }
  } catch { /* segue pro headless */ }

  return runHeadless(async () => {
    const browser = await getBrowser();
    if (!browser) return { ok: false, pageId: null, note: 'headless_indisponivel', handle };
    const proxy = proxyConfig();
    let useProxy = false;
    if (proxy) useProxy = (await checkProxy()).ok;
    let ctx;
    try {
      ctx = await browser.newContext({ locale: 'pt-BR', userAgent: UA, viewport: { width: 1280, height: 800 }, ...(useProxy ? { proxy } : {}) });
      const page = await ctx.newPage();
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return route.abort();
        return route.continue();
      });
      // A busca "por página" da Ad Library é um typeahead: digita no campo e o
      // dropdown lista páginas; clicar numa opção navega pra view_all_page_id=<id>.
      const termo = handle.replace(/[._-]+/g, ' ');
      const url = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=BR&search_type=page&media_type=all`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);
      const input = await page.$('input[type="search"], input[placeholder*="anunciante" i], input[placeholder*="advertiser" i], input[aria-label*="Pesquisar" i], input[aria-label*="Search" i], input[type="text"]');
      if (!input) return { ok: true, pageId: null, note: 'campo_busca_nao_encontrado', handle };
      await input.click();
      await input.fill('');
      await input.type(termo, { delay: 60 });
      const deadline = Date.now() + 12000;
      let opcoes = [];
      while (Date.now() < deadline && !opcoes.length) {
        await page.waitForTimeout(800);
        opcoes = await page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('[role="option"], [role="listbox"] [role="button"], [role="listbox"] li')) {
            const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
            if (t && t.length < 200) out.push(t);
          }
          return out;
        }).catch(() => []);
      }
      if (!opcoes.length) return { ok: true, pageId: null, note: 'pagina_nao_encontrada', handle };
      const hk = normText(handle).replace(/[^a-z0-9]/g, '');
      const toksMarca = marca ? companyTokens(marca).filter((t) => t.length >= 4) : [];
      const alvo = opcoes.findIndex((t) => {
        const k = normText(t).replace(/[^a-z0-9]/g, '');
        if (k.includes(hk) || hk.includes(k.slice(0, Math.max(6, hk.length)))) return true;
        const ws = wordSet(t);
        return toksMarca.some((tok) => ws.has(tok));
      });
      // Nenhuma opção bate com o @ nem com a marca: NÃO chuta a primeira (era a
      // origem das páginas erradas) — devolve as candidatas pro operador escolher.
      if (alvo < 0) return { ok: true, pageId: null, note: 'pagina_nao_encontrada', handle, candidatos: opcoes.slice(0, 5).map((nome) => ({ id: null, nome })) };
      const idx = alvo;
      const els = await page.$$('[role="option"], [role="listbox"] [role="button"], [role="listbox"] li');
      if (!els[idx]) return { ok: true, pageId: null, note: 'pagina_nao_encontrada', handle, candidatos: opcoes.slice(0, 5).map((nome) => ({ id: null, nome })) };
      await els[idx].click();
      const fim = Date.now() + 10000;
      let pageId = null;
      while (Date.now() < fim && !pageId) {
        await page.waitForTimeout(500);
        pageId = page.url().match(/view_all_page_id=(\d{5,})/)?.[1] ?? null;
      }
      if (!pageId) return { ok: true, pageId: null, note: 'pagina_nao_encontrada', handle, candidatos: opcoes.slice(0, 5).map((nome) => ({ id: null, nome })) };
      return { ok: true, pageId, pageName: opcoes[idx].split(/\s{2,}|\n/)[0].slice(0, 120) || null, via: 'adlib', handle, candidatos: opcoes.slice(0, 5).map((nome) => ({ id: null, nome })) };
    } catch (e) {
      return { ok: false, pageId: null, note: String(e?.message || e).slice(0, 120), handle };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

// Google Ads Transparency Center: por DOMÍNIO (lista anunciantes que apontam pro
// site) ou por ANUNCIANTE (AR…): conta criativos visíveis e amostra. App JS —
// headless, proxy quando disponível. Best-effort: seletores por href (/advertiser/
// e /creative/), que são estáveis na UI pública.
async function googleTransparency({ domain = null, advertiserId = null }) {
  if (!domain && !advertiserId) return { ok: false, note: 'sem_dominio' };
  return runHeadless(async () => {
    const browser = await getBrowser();
    if (!browser) return { ok: false, note: 'headless_indisponivel' };
    const proxy = proxyConfig();
    let useProxy = false;
    if (proxy) useProxy = (await checkProxy()).ok;
    let ctx;
    const url = advertiserId
      ? `https://adstransparency.google.com/advertiser/${encodeURIComponent(advertiserId)}?region=BR`
      : `https://adstransparency.google.com/?region=BR&domain=${encodeURIComponent(String(domain).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])}`;
    try {
      ctx = await browser.newContext({ locale: 'pt-BR', userAgent: UA, viewport: { width: 1280, height: 900 }, ...(useProxy ? { proxy } : {}) });
      const page = await ctx.newPage();
      await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Tela de consentimento do Google (IP do proxy fora do BR cai nela): aceita e segue.
      for (let i = 0; i < 2; i++) {
        await page.waitForTimeout(1200);
        const consent = /consent\.google/.test(page.url()) || (await page.evaluate(() => /Antes de continuar|Before you continue|Fazer login|Sign in/i.test((document.body.innerText || '').slice(0, 1500)) && !document.querySelector('a[href*="/creative/"]')).catch(() => false));
        if (!consent) break;
        const btn = await page.$('button:has-text("Aceitar tudo"), button:has-text("Accept all"), button:has-text("Concordo"), button:has-text("I agree"), form[action*="consent"] button');
        if (!btn) break;
        await btn.click().catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        if (!/adstransparency\.google\.com/.test(page.url())) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      const deadline = Date.now() + (advertiserId ? 25000 : 18000);
      let pronto = false;
      while (!pronto && Date.now() < deadline) {
        await page.waitForTimeout(1000);
        pronto = await page.evaluate((porAnunciante) =>
          !!document.querySelector(porAnunciante ? 'a[href*="/creative/"]' : 'a[href*="/advertiser/"], a[href*="/creative/"]') ||
          /nenhum an[úu]ncio|n[ãa]o (h[áa]|encontr)|no ads|sem an[úu]ncios|n[ãa]o exibiu an[úu]ncios|hasn'?t shown ads/i.test(document.body.innerText || ''),
        !!advertiserId).catch(() => false);
      }
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 3500).catch(() => {});
        await page.waitForTimeout(800);
      }
      const data = await page.evaluate(() => {
        const abs = (h) => { try { return new URL(h, location.href).href; } catch { return h; } };
        // Ícones Material aparecem como texto ("videocam", "image"…): não são nome.
        const ICONE = /^(videocam|image|play_arrow|text_fields|more_vert|open_in_new|info|verified|arrow_\w+)$/i;
        const limpaNome = (t) => (t || '').split('\n').map((x) => x.trim()).filter((x) => x && !ICONE.test(x) && !/^AR\d+$/.test(x) && !/^(Fazer login|Sign in|Login|Entrar)$/i.test(x))[0] || '';
        const advs = new Map();
        const registra = (id, nome) => {
          if (!advs.has(id)) advs.set(id, { id, nome: nome || '', url: `https://adstransparency.google.com/advertiser/${id}?region=BR` });
          else if (!advs.get(id).nome && nome) advs.get(id).nome = nome;
        };
        // Links diretos pro anunciante (sem /creative/) trazem o nome; os de criativo só o id.
        for (const a of document.querySelectorAll('a[href*="/advertiser/"]')) {
          const h = a.getAttribute('href') || '';
          const m = h.match(/\/advertiser\/(AR[0-9]{6,})/i);
          if (!m) continue;
          const id = m[1].toUpperCase();
          registra(id, /\/creative\//.test(h) ? '' : limpaNome(a.innerText || a.textContent));
        }
        // Nome do anunciante em elementos de cabeçalho/cartão (página por anunciante ou lista por domínio).
        for (const el of document.querySelectorAll('[class*="advertiser-name" i], [class*="advertiserName" i], h1, h2, [role="heading"]')) {
          const t = limpaNome(el.innerText || '');
          if (!t || /transpar[êe]ncia|transparency|an[úu]ncios|ads/i.test(t)) continue;
          for (const v of advs.values()) if (!v.nome) v.nome = t;
          break;
        }
        const tituloDoc = (document.title || '').replace(/\s*[-|–·]\s*(Centro de )?Transpar[êe]ncia.*$/i, '').replace(/\s*[-|–·]\s*Google.*$/i, '').trim();
        if (tituloDoc && !/transpar[êe]ncia|transparency/i.test(tituloDoc)) for (const v of advs.values()) if (!v.nome) v.nome = tituloDoc.slice(0, 120);
        const criativos = new Map();
        for (const a of document.querySelectorAll('a[href*="/creative/"]')) {
          const h = a.getAttribute('href') || '';
          const m = h.match(/\/advertiser\/([A-Z0-9]+)\/creative\/([A-Z0-9]+)/i);
          if (!m || criativos.has(m[2])) continue;
          const raw = (a.innerText || '').trim();
          // Imagens/vídeos são abortados (banda do proxy): o formato vem do ícone Material que sobra como texto.
          const fmt = a.querySelector('video') || /\bvideocam\b|\bplay_arrow\b/i.test(raw) ? 'video' : a.querySelector('img') || /\bimage\b|\bphoto\b/i.test(raw) ? 'imagem' : 'texto';
          const texto = raw.split('\n').map((x) => x.trim()).filter((x) => x && !ICONE.test(x)).join(' ').replace(/\s+/g, ' ').slice(0, 160);
          criativos.set(m[2], { id: m[2], anunciante: m[1], url: abs(h.split('?')[0]) + '?region=BR', formato: fmt, texto });
        }
        const body = (document.body.innerText || '').replace(/\s+/g, ' ');
        const tm = body.match(/(\d[\d.,]*)\s*(an[úu]ncios?|ads?)\b/i);
        return {
          anunciantes: [...advs.values()].slice(0, 10),
          criativos: [...criativos.values()],
          totalTexto: tm ? parseInt(tm[1].replace(/[.,]/g, ''), 10) : null,
          semAnuncios: /nenhum an[úu]ncio|n[ãa]o (h[áa]|encontr)|no ads|sem an[úu]ncios|n[ãa]o exibiu an[úu]ncios|hasn'?t shown ads/i.test(body),
          diag: { url: location.href, title: document.title, texto: body.slice(0, 300) },
        };
      });
      // Na página do anunciante o próprio id é o anunciante medido.
      if (advertiserId && !data.anunciantes.some((a) => a.id === advertiserId.toUpperCase())) {
        data.anunciantes.unshift({ id: advertiserId.toUpperCase(), nome: '', url: `https://adstransparency.google.com/advertiser/${advertiserId.toUpperCase()}?region=BR` });
      }
      const formatos = { video: 0, imagem: 0, texto: 0 };
      for (const c of data.criativos) formatos[c.formato] = (formatos[c.formato] || 0) + 1;
      return {
        ok: true,
        url,
        viaProxy: useProxy,
        anunciantes: data.anunciantes,
        criativos: data.criativos.length,
        totalTexto: data.totalTexto,
        formatos,
        amostra: data.criativos.slice(0, 12),
        semAnuncios: data.semAnuncios && !data.criativos.length,
        found: data.criativos.length > 0 || (!advertiserId && data.anunciantes.length > 0),
        diag: data.criativos.length ? undefined : data.diag,
      };
    } catch (e) {
      return { ok: false, note: String(e?.message || e).slice(0, 120), url };
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  });
}

// --- DataStone: organograma (diretoria + gerência) + porte ------------------
// Endpoint público /v1/companies/?cnpj= . Diretoria vem dos sócios (partners);
// gerência vem dos funcionários ATUAIS de gestão (related_company_members),
// filtrando históricos e removendo quem já está na diretoria.
function cleanPosition(pos) {
  return String(pos || '')
    .replace(/^\s*\d+\s*-\s*/, '') // remove código CBO ("142115 - ")
    .replace(/^hist[oó]rico\s*-\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const MGMT_RE =
  /diret|presid|geren|coorden|superint|\bhead\b|chief|conselh|\bceo\b|\bcfo\b|\bcto\b|\bcoo\b|s[oó]cio/i;

// A consulta de EMPRESA na DataStone (paga) era feita duas vezes por lead —
// datastoneCompany e datastonePessoas batiam no mesmo endpoint. Agora uma só,
// com cache curto em memória compartilhado pelas duas.
const _dsCompanyRaw = new Map();
async function datastoneCompanyRaw(digits) {
  const token = process.env.DATASTONE_API_TOKEN;
  const c = _dsCompanyRaw.get(digits);
  if (c && c.exp > Date.now()) return c.val;
  let val;
  try {
    const res = await fetchWithTimeout(
      `https://api.datastone.com.br/v1/companies/?cnpj=${digits}`,
      { headers: { Authorization: `Token ${token}`, accept: 'application/json' } },
      15000,
    );
    if (res.ok) {
      const j = await res.json();
      val = { status: res.status, ok: true, comp: Array.isArray(j) ? j[0] : j.results ? j.results[0] : j, body: '' };
    } else {
      val = { status: res.status, ok: false, comp: null, body: await res.text().catch(() => '') };
    }
  } catch (e) {
    val = { status: 0, ok: false, comp: null, body: String(e?.message || e), erro: true };
  }
  // 429/erro de rede não ficam em cache (reprocessa depois); o resto 10 min.
  if (val.status !== 429 && !val.erro) _dsCompanyRaw.set(digits, { val, exp: Date.now() + 10 * 60_000 });
  return val;
}

async function datastoneCompany(cnpj) {
  const token = process.env.DATASTONE_API_TOKEN;
  if (!token) return { ok: true, data: null, note: 'datastone_desativado' };
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { ok: false, data: null };
  try {
    const res = await datastoneCompanyRaw(digits);
    if (res.status === 401 || res.status === 403) return { ok: false, data: null, note: 'datastone_auth' };
    if (res.status === 429) return { ok: false, data: null }; // limite transitório — reprocessa depois
    if (!res.ok) {
      // Sem créditos = condição PERMANENTE: degrada sem travar nem reprocessar.
      if (/insufficient_credits|cr[eé]dito/i.test(res.body)) return { ok: true, data: null, note: 'datastone_sem_creditos' };
      return { ok: false, data: null };
    }
    const d = res.comp;
    if (!d || !d.company_name) return { ok: true, data: null }; // não encontrado (não é falha)

    const diretoria = (d.partners || [])
      .map((p) => ({
        nome: p.name || null,
        cargo: p.qualification || null,
        participacao: p.ownership ?? null,
        cpf: p.cpf ? onlyDigits(p.cpf) : null,
      }))
      .filter((x) => x.nome);
    const dirNames = new Set(diretoria.map((x) => normText(x.nome)));

    const gerencia = (d.related_company_members || [])
      .filter((m) => !/hist[oó]?ric/i.test(m.position_status || '') && !/hist[oó]ric/i.test(m.position || ''))
      .map((m) => ({ nome: m.name || null, cargo: cleanPosition(m.position) }))
      .filter((m) => m.nome && MGMT_RE.test(m.cargo) && !dirNames.has(normText(m.nome)))
      .filter((m, i, arr) => arr.findIndex((x) => normText(x.nome) === normText(m.nome)) === i);

    return {
      ok: true,
      data: {
        estimatedRevenue: d.estimated_revenue ?? null,
        segment: d.segment ?? null,
        employeeCount: d.employee_count ?? null,
        cnaeDescription: d.cnae_description ?? null,
        organograma: { diretoria, gerencia },
      },
    };
  } catch {
    return { ok: false, data: null };
  }
}

// --- DataStone: contatos do DECISOR por CPF (telefone quente/WhatsApp) --------
const DATASTONE_BASE = 'https://api.datastone.com.br/v1';

function cpfNorm(cpf) {
  const raw = onlyDigits(cpf);
  if (raw.length === 10) return `0${raw}`; // recupera zero à esquerda perdido
  return raw.length === 11 ? raw : null;
}

async function datastonePerson(cpf) {
  const token = process.env.DATASTONE_API_TOKEN;
  const c = cpfNorm(cpf);
  if (!token || !c) return null;
  try {
    const res = await fetchWithTimeout(
      `${DATASTONE_BASE}/persons/?cpf=${c}`,
      { headers: { Authorization: `Token ${token}`, accept: 'application/json' } },
      15000,
    );
    if (!res.ok) return null;
    const j = await res.json();
    const d = Array.isArray(j) ? j[0] : j.results ? j.results[0] : j;
    if (!d || !d.name) return null;
    // telefones ordenados: WhatsApp validado > quente > prioridade
    const phones = (d.mobile_phones || [])
      .map((p) => ({
        numero: `(${p.ddd}) ${p.number}`,
        digits: onlyDigits(`${p.ddd}${p.number}`),
        whatsapp: !!p.whatsapp_datetime,
        hot: !!p.hot_datetime,
        priority: p.priority ?? 99,
      }))
      .sort(
        (a, b) =>
          Number(b.whatsapp) - Number(a.whatsapp) ||
          Number(b.hot) - Number(a.hot) ||
          a.priority - b.priority,
      )
      .map(({ numero, digits, whatsapp, hot }) => ({ numero, digits, whatsapp, hot }));
    const emails = (d.emails || [])
      .slice()
      .sort((a, b) => (a.priority || 99) - (b.priority || 99))
      .map((e) => e.email)
      .filter(Boolean);
    const empresas = (d.related_companies || []).slice(0, 40).map((c2) => ({
      nome: c2.company_name || c2.trading_name || null,
      cnpj: c2.cnpj ? String(c2.cnpj) : null,
      situacao: c2.registry_situation || null,
      participacao: c2.ownership ?? null,
      cargo: c2.description || null,
    }));
    return {
      cpf: c,
      nome: d.name,
      phones,
      fixos: (d.land_lines || []).map((l) => `(${l.ddd}) ${l.number}`),
      emails,
      renda: d.estimated_income ?? null,
      ocupacao: d.cbo_description ?? null,
      empregador: Array.isArray(d.employer) ? (d.employer.length ? d.employer.join(', ') : null) : d.employer || null,
      pep: !!d.pep,
      idade: d.age ?? null,
      empresas,
      familia: (d.family_persons || []).map((f) => ({ nome: f.name ?? null, tipo: f.relationship ?? f.description ?? null })),
    };
  } catch {
    return null;
  }
}

// Contatos DataStone de todos os sócios pessoa física de um CNPJ.
async function datastonePessoas(cnpj) {
  const token = process.env.DATASTONE_API_TOKEN;
  if (!token) return { ok: true, people: [], note: 'datastone_desativado' };
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { ok: false, people: [] };
  const res = await datastoneCompanyRaw(digits);
  if (!res.ok) {
    // Sem créditos = permanente: degrada (Lemit assume) sem travar/reprocessar.
    if (/insufficient_credits|cr[eé]dito/i.test(res.body)) return { ok: true, people: [], note: 'datastone_sem_creditos' };
    return { ok: false, people: [] };
  }
  const comp = res.comp;
  if (!comp || !comp.company_name) return { ok: true, people: [] };
  const cpfs = [...new Set((comp.partners || []).map((p) => cpfNorm(p.cpf)).filter(Boolean))];
  const people = (await mapLimit(cpfs, 2, (cpf) => datastonePerson(cpf))).filter(Boolean);
  return { ok: true, people };
}

// --- Briefing por IA (Data Intel) — análise estratégica + scripts por canal --
// Reproduz (e supera) o "Data Intel" da DataStone: usa os dados REAIS já
// coletados (site, empreendimentos, PageSpeed, Google, decisores) para gerar
// análise + scripts de abordagem do DECISOR, no papel de SDR da V4 Ruston & Co.
const BRIEFING_MODEL = process.env.BRIEFING_MODEL || 'claude-sonnet-5';

async function generateBriefing(payload) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: true, briefing: null, note: 'ia_desativada' };

  const ctx = JSON.stringify(payload, null, 1).slice(0, 9000);
  // Perfil de auditoria: 'construtoras' (original, especializado em incorporação
  // imobiliária) ou 'geral' (versátil — qualquer tipo de empresa).
  const perfilGeral = payload?.perfil === 'geral';
  const contextoEmpresa = perfilGeral
    ? `a empresa abaixo — pode ser de QUALQUER segmento; identifique o ramo real pelo CNAE/segmento ` +
      `dos dados e adapte o vocabulário do discurso ao negócio dela (produtos/serviços, como ela vende ` +
      `e capta clientes). NÃO use jargão imobiliário (empreendimentos, lançamentos, unidades) a menos ` +
      `que os dados mostrem que é do setor. `
    : `a empresa abaixo — do ramo imobiliário/construção. `;
  const prompt =
    `Você é analista e SDR sênior da V4 Ruston & Co, uma assessoria de marketing e growth ` +
    `(tráfego pago, sites/landing pages, CRM, estruturação comercial). Vamos prospectar (outbound) ` +
    contextoEmpresa +
    `Seu trabalho: analisar a empresa e gerar ` +
    `scripts de abordagem do DECISOR, usando os GAPS DIGITAIS reais encontrados como gancho para ` +
    `oferecer os serviços da V4.\n\n` +
    `REGRAS:\n` +
    `- Use SOMENTE os fatos fornecidos. NÃO invente dados, números, contatos ou empreendimentos.\n` +
    `- Se um dado não existir, escreva de forma genérica sem inventar.\n` +
    `- Português do Brasil, tom consultivo e humano (não robótico, sem exageros).\n` +
    `- Nos scripts, trate o decisor pelo primeiro nome usando o placeholder {{nome}} e assine como {{sdr}} da V4.\n` +
    `- Scripts curtos e objetivos. WhatsApp e ligação bem curtos; e-mail com assunto + corpo.\n` +
    `- IMPORTANTE: o campo "sinaisConfirmados" traz gaps JÁ VERIFICADOS no enriquecimento. ` +
    `Você DEVE incorporar TODOS eles nas dores e usar os mais fortes nos ganchos e scripts. ` +
    `Se houver botão de WhatsApp quebrado/ausente, ISSO É PRIORIDADE MÁXIMA — cite explicitamente em dores, ganchos e em pelo menos um script.\n` +
    `- Os ganchos devem citar gaps CONCRETOS dos dados (ex.: botão de WhatsApp quebrado, site lento, ` +
    `sem pixel/tag, poucas avaliações no Google, ausência de anúncios).\n\n` +
    `Responda APENAS um objeto JSON válido, sem texto fora dele, exatamente neste formato:\n` +
    `{\n` +
    `  "resumo": string,\n` +
    `  "ramoAtividade": string,\n` +
    `  "setor": string,\n` +
    `  "produtosServicos": string,\n` +
    `  "publicoAlvo": string,\n` +
    `  "modeloNegocio": string,\n` +
    `  "diferenciais": string,\n` +
    `  "mercadoAtuacao": string,\n` +
    `  "icpPresumido": string,\n` +
    `  "pontosRapport": string,\n` +
    `  "tipoVenda": string,\n` +
    `  "presencaDigital": string,\n` +
    `  "historia": string,\n` +
    `  "dores": string[],\n` +
    `  "ganchos": string[],\n` +
    `  "scripts": {\n` +
    `    "ligacao": string,\n` +
    `    "whatsapp": string,\n` +
    `    "email": { "assunto": string, "corpo": string },\n` +
    `    "instagram": string,\n` +
    `    "linkedin": string\n` +
    `  }\n` +
    `}\n\n=== DADOS DA EMPRESA (fatos coletados) ===\n${ctx}`;

  // Até 4 tentativas: briefings em sequência ("rodar todos") esbarram no limite
  // por minuto da API — rate limit (429/529) espera bem mais entre tentativas,
  // respeitando o retry-after quando informado.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // SDK oficial (retry/backoff de 429/5xx embutido). Mesma extração de texto.
      const text = await anthropicText(BRIEFING_MODEL, 8000, prompt); // 4000 truncava JSONs longos (scripts extensos) — falha intermitente de parse
      if (text == null) return { ok: false, briefing: null };
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) {
        await sleep(2000);
        continue; // resposta inesperada — tenta de novo
      }
      const briefing = JSON.parse(m[0]);
      return { ok: true, briefing, model: BRIEFING_MODEL };
    } catch (err) {
      const status = err?.status ?? err?.response?.status;
      const retryAfter = Number(err?.headers?.['retry-after']) || 0;
      const rateLimited = status === 429 || status === 529;
      console.warn(`[briefing] tentativa ${attempt + 1} falhou (HTTP ${status ?? '?'}) — ${String(err?.message || err).slice(0, 120)}`);
      const espera = Math.max(retryAfter * 1000, (rateLimited ? 15000 : 2000) * (attempt + 1));
      await sleep(espera);
    }
  }
  return { ok: false, briefing: null };
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// --- Autenticação (deploy) ---------------------------------------------------
// Com SUPABASE_URL + SUPABASE_ANON_KEY no ambiente (Railway), toda rota exceto
// /api/health exige o token de sessão do SalesHub (Authorization: Bearer <jwt>),
// validado no Supabase — só o time logado consegue disparar enriquecimento
// (que consome créditos de Anthropic/DataStone/Lemit). Sem essas envs (dev
// local), a checagem fica desligada e nada muda no fluxo do terminal.
const AUTH_SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
// A anon key é PÚBLICA (vai no bundle do navegador de qualquer usuário), então
// um fallback embutido por projeto é seguro — e cobre o erro comum de colar no
// painel a chave MASCARADA (eyJhbGci••••…), cujos caracteres • quebram o header.
const ANON_FALLBACK = {
  'https://iaompeiokjxbffwehhrx.supabase.co':
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMjI5MDIsImV4cCI6MjA5MDc5ODkwMn0.D-rf7H8F21LyslQxmr6AGM13kWTWs7f05OcnBt5kbxg',
};
let AUTH_SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';
if (!AUTH_SUPABASE_ANON || /[^\x20-\x7e]/.test(AUTH_SUPABASE_ANON)) {
  if (AUTH_SUPABASE_ANON) {
    console.warn('[auth] SUPABASE_ANON_KEY contém caracteres inválidos (cópia mascarada?) — usando fallback embutido');
  }
  AUTH_SUPABASE_ANON = ANON_FALLBACK[AUTH_SUPABASE_URL] || '';
}
const AUTH_REQUIRED = Boolean(AUTH_SUPABASE_URL && AUTH_SUPABASE_ANON);
const _authCache = new Map(); // token -> expira (ms)

async function isAuthenticated(req) {
  if (!AUTH_REQUIRED) return true;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const exp = _authCache.get(token);
  if (exp && exp > Date.now()) return true;
  try {
    const r = await fetch(`${AUTH_SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: AUTH_SUPABASE_ANON, authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      console.warn(`[auth] token recusado pelo Supabase (HTTP ${r.status})`);
      return false;
    }
    if (_authCache.size > 500) _authCache.clear();
    _authCache.set(token, Date.now() + 5 * 60_000);
    return true;
  } catch (err) {
    console.warn('[auth] falha ao validar token no Supabase:', String(err?.message || err));
    return false;
  }
}

// Quem está chamando (JWT Supabase) → team_members {id, name, kommo_user_id}.
// Usado pra atribuir no Kommo o card ao SDR que importou e assinar o {{2}}.
const _userCache = new Map();
async function usuarioDoToken(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const c = _userCache.get(token);
  if (c && c.exp > Date.now()) return c.user;
  try {
    const r = await fetch(`${AUTH_SUPABASE_URL}/auth/v1/user`, { headers: { apikey: AUTH_SUPABASE_ANON, authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    const tm = (await sbSelect(token, 'team_members', `auth_user_id=eq.${u.id}&select=id,name,kommo_user_id,role&limit=1`))?.[0]
      ?? (u.email ? (await sbSelect(token, 'team_members', `email=eq.${encodeURIComponent(u.email)}&select=id,name,kommo_user_id,role&limit=1`))?.[0] : null)
      ?? null;
    const user = tm ? { id: tm.id, nome: tm.name, kommoUserId: tm.kommo_user_id ? Number(tm.kommo_user_id) : null, role: tm.role, email: u.email } : { id: null, nome: null, kommoUserId: null, role: null, email: u.email };
    if (_userCache.size > 200) _userCache.clear();
    _userCache.set(token, { user, exp: Date.now() + 5 * 60_000 });
    return user;
  } catch { return null; }
}

// Campos custom "CAD *" do Kommo (nome → id), cacheados.
let _camposCad = null;
async function camposCad() {
  if (_camposCad && _camposCad.exp > Date.now()) return _camposCad.map;
  const map = new Map();
  for (let page = 1; page <= 4; page++) {
    const r = await kommoApi('GET', `/api/v4/leads/custom_fields?limit=250&page=${page}`);
    const items = r.body?._embedded?.custom_fields ?? [];
    for (const f of items) if (/^CAD |^Enriquecedor URL$/.test(f.name)) map.set(f.name, { id: f.id, type: f.type });
    if (items.length < 250) break;
  }
  _camposCad = { map, exp: Date.now() + 10 * 60_000 };
  return map;
}
const VARS_TEMPLATE = {
  sdna_p1_auditoria_v1: ['CAD Nome decisor', 'CAD SDR', 'CAD Fantasia', 'CAD Frase falha', 'CAD Frase impacto'],
  sdna_p1_auditoria_v2: ['CAD Nome decisor', 'CAD SDR', 'CAD Fantasia', 'CAD Frase falha', 'CAD Frase impacto'],
};

// Preenche no card os campos CAD com as variáveis da cadência JÁ na importação
// (o SDR vê no Kommo o que vai sair na mensagem 1) e o responsável. O carteiro
// regrava na hora do disparo; aqui é visibilidade + atribuição.
async function preencherCardCadencia({ leadId, decisorId = null, kommoLeadId, token, sdrNome = null, responsavelKommoId = null }) {
  const pac = await prepararCadencia({ leadId, token, sdrNome, persistir: true, decisorId }).catch(() => null);
  const campos = await camposCad();
  const valores = {};
  const msg = pac?.whatsapp?.p1 ?? null;
  if (pac?.aptoCadencia && msg) {
    const ordem = VARS_TEMPLATE[msg.template] ?? [];
    ordem.forEach((nome, i) => { valores[nome] = String(msg.variaveis[i] ?? ''); });
    if (pac.variaveis?.rotuloSecundaria) valores['CAD Rotulo 2a falha'] = pac.variaveis.rotuloSecundaria;
    valores['CAD Template'] = String(msg.template);
    valores['CAD Passo'] = '0';
    valores['CAD Falha primaria'] = String(pac.falhaPrimaria?.codigo ?? '');
  } else if (pac?.variaveis) {
    valores['CAD Nome decisor'] = pac.variaveis.nome1; valores['CAD SDR'] = pac.variaveis.sdr; valores['CAD Fantasia'] = pac.variaveis.fantasia;
  }
  valores['Enriquecedor URL'] = `${APP_URL}/enriquecedor/#lead=${leadId}`;
  const cfv = Object.entries(valores).map(([nome, valor]) => {
    const f = campos.get(nome); if (!f) return null;
    return { field_id: f.id, values: [{ value: f.type === 'numeric' ? Number(valor) : valor }] };
  }).filter(Boolean);
  const patch = {};
  if (cfv.length) patch.custom_fields_values = cfv;
  if (responsavelKommoId) patch.responsible_user_id = Number(responsavelKommoId);
  if (!Object.keys(patch).length) return { ok: true, vazio: true, apto: !!pac?.aptoCadencia };
  const r = await kommoApi('PATCH', `/api/v4/leads/${kommoLeadId}`, patch);
  return { ok: r.ok, status: r.status, apto: !!pac?.aptoCadencia, motivo: pac?.aptoCadencia ? undefined : (pac?.motivo ?? pac?.error ?? null), campos: Object.keys(valores).length, responsavel: responsavelKommoId ?? null };
}

// ============================================================================
// ESTEIRA server-side (integração Kommo): roda F1→F4 de UM lead inteiro no
// motor, gravando no banco via PostgREST com o token do chamador, e devolve
// notas pro card na Kommo (link do lead ao entrar; ganchos de abordagem ao
// concluir). O endpoint /api/esteira responde 202 na hora e roda em background.
// ============================================================================
const APP_URL = (process.env.APP_URL || 'https://gestao-comercial-rosy.vercel.app').replace(/\/$/, '');

function linkDoLead(id) {
  return `${APP_URL}/enriquecedor/#lead=${id}`;
}

// REST (PostgREST) com o token do chamador — RLS de usuário autenticado.
// Identidade própria do motor (worker da fila): SUPABASE_SERVICE_ROLE_KEY no
// Railway. Sem ela o worker fica desligado e o front volta a rodar na aba.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
function sbHeaders(token) {
  return {
    apikey: SERVICE_KEY && token === SERVICE_KEY ? SERVICE_KEY : AUTH_SUPABASE_ANON,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}
async function sbRpc(token, fn, args) {
  const r = await fetch(`${AUTH_SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: sbHeaders(token), body: JSON.stringify(args ?? {}) });
  if (!r.ok) throw new Error(`rpc ${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch { return t; }
}
// ── Cache em Postgres (enriquecedor_cache, migration_151) ───────────────────
// Busca web e Places por consulta, com TTL. Só grava resposta OK (falha
// transitória nunca vira "não existe" permanente — era o bug do _placesCache).
const DIA = 24 * 60 * 60 * 1000;
async function cacheGet(chave) {
  const token = tokenAtual();
  if (!token) return undefined;
  try {
    const rows = await sbSelect(token, 'enriquecedor_cache', `chave=eq.${encodeURIComponent(chave)}&expira_em=gt.${encodeURIComponent(new Date().toISOString())}&select=valor`);
    return rows?.[0]?.valor;
  } catch { return undefined; }
}
async function cacheSet(chave, valor, ttlMs) {
  const token = tokenAtual();
  if (!token) return;
  try {
    await sbUpsert(token, 'enriquecedor_cache', [{ chave, valor, expira_em: new Date(Date.now() + ttlMs).toISOString() }], 'chave');
  } catch { /* cache é best-effort */ }
}
const chaveCache = (prefixo, ...partes) => `${prefixo}:${partes.map((x) => String(x ?? '').toLowerCase().trim()).join('|')}`.slice(0, 900);

// ── Métricas (enriquecedor_metricas) — duração por fonte/rota ────────────────
async function registrarMetrica({ fonte, ms, ok = true, note = null, leadId = null, fase = null }) {
  const token = tokenAtual();
  if (!token) return;
  try {
    await fetch(`${AUTH_SUPABASE_URL}/rest/v1/enriquecedor_metricas`, {
      method: 'POST',
      headers: { ...sbHeaders(token), prefer: 'return=minimal' },
      body: JSON.stringify({ lead_id: leadId ?? ctxAtual()?.leadId ?? null, origem: 'motor', fase: fase ?? ctxAtual()?.fase ?? null, fonte, duration_ms: Math.round(ms), ok: ok !== false, note: note ? String(note).slice(0, 200) : null }),
    });
  } catch { /* métrica nunca derruba a rota */ }
}
// Envolve uma função assíncrona registrando a duração e se deu certo (result.ok !== false).
function medido(fonte, fn) {
  return async function (...args) {
    const t0 = Date.now();
    try {
      const r = await fn.apply(this, args);
      void registrarMetrica({ fonte, ms: Date.now() - t0, ok: !(r && r.ok === false), note: r && r.note ? r.note : null });
      return r;
    } catch (e) {
      void registrarMetrica({ fonte, ms: Date.now() - t0, ok: false, note: String(e?.message || e) });
      throw e;
    }
  };
}

async function sbSelect(token, table, query) {
  const r = await fetch(`${AUTH_SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders(token) });
  if (!r.ok) throw new Error(`select ${table}: HTTP ${r.status}`);
  return r.json();
}
async function sbPatch(token, table, query, body) {
  const r = await fetch(`${AUTH_SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(token), prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`patch ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function sbUpsert(token, table, body, onConflict) {
  const r = await fetch(
    `${AUTH_SUPABASE_URL}/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`,
    {
      method: 'POST',
      headers: { ...sbHeaders(token), prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`upsert ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function sbDelete(token, table, query) {
  await fetch(`${AUTH_SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: sbHeaders(token),
  });
}

// Nota no card da Kommo (KOMMO_SUBDOMAIN + KOMMO_API_TOKEN do ambiente).
async function kommoNote(kommoLeadId, text) {
  try {
    const sub = process.env.KOMMO_SUBDOMAIN;
    const tok = process.env.KOMMO_API_TOKEN;
    if (!sub || !tok || !kommoLeadId) return false;
    const r = await fetch(`https://${sub}.kommo.com/api/v4/leads/${kommoLeadId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ note_type: 'common', params: { text: String(text).slice(0, 19000) } }]),
    });
    if (!r.ok) console.warn(`[kommo] nota falhou: HTTP ${r.status}`);
    return r.ok;
  } catch (err) {
    console.warn('[kommo] nota falhou:', String(err?.message || err));
    return false;
  }
}

// Nome de marca pra buscas (aproximação server-side do adSearchTerm do app).
function marcaDe(nome) {
  const limpo = String(nome || '')
    .replace(/\b(ltda|limitada|s\/?a\.?|eireli|me|epp|holding|participacoes|participações|empreendimentos?|imobiliaria|imobiliária|incorporadora|incorporacoes|incorporações|construtora|construcoes|construções)\b/gi, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpo || String(nome || '');
}

// Sinais/gaps básicos server-side (aproximação do computeDores do app) — só
// fatos verificados; alimentam o briefing gerado pela esteira.
function sinaisBasicos(row, audit, gb, anunciosMeta) {
  const s = [];
  if (!audit || !audit.isOnline) s.push('Sem site no ar (ou não encontrado)');
  else {
    if ((audit.whatsappButtons ?? []).length === 0 && !audit.hasWhatsappWidget) s.push('Site sem botão de WhatsApp: perde contato de cliente quente');
    const quebrados = (audit.whatsappButtons ?? []).filter((b) => !b.working).length;
    if (quebrados > 0) s.push(`${quebrados} botão(ões) de WhatsApp com problema no site`);
    if (!audit.hasMetaPixel) s.push('Site sem Pixel do Meta (mídia roda sem rastreio)');
    if (!audit.hasGoogleTag) s.push('Site sem Google Tag');
    if (audit.loadTimeMs > 5000) s.push('Site lento (carregamento acima de 5s)');
  }
  if (!row.company_instagram) s.push('Sem Instagram institucional identificado');
  if (!gb || gb.found === false) s.push('Sem ficha no Google Meu Negócio');
  else if (gb.reviews != null && gb.reviews < 20) s.push(`Poucas avaliações no Google (${gb.reviews})`);
  if (anunciosMeta) {
    const rodando = (anunciosMeta.validados?.length ?? 0) + (anunciosMeta.aValidar?.length ?? 0);
    if (rodando === 0) s.push('Sem anúncios ativos na Meta Ad Library');
  }
  return s;
}

function payloadBriefing(row, audit, decisores, anunciosMeta) {
  return {
    perfil: row.perfil ?? 'construtoras',
    sinaisConfirmados: sinaisBasicos(row, audit, row.google_business, anunciosMeta),
    empresa: row.razao_social ?? row.company_name_raw,
    nomeFantasia: row.nome_fantasia,
    cnae: row.datastone?.cnaeDescription ?? row.cnae,
    segmento: row.datastone?.segment ?? row.segmento,
    cidade: row.cidade,
    uf: row.uf,
    situacao: row.situacao_cadastral,
    receita: row.datastone?.estimatedRevenue ?? row.revenue_band_raw,
    funcionarios: row.datastone?.employeeCount ?? null,
    site: audit?.isOnline
      ? {
          url: audit.siteUrl,
          online: true,
          https: audit.httpsValid,
          loadTimeMs: audit.loadTimeMs,
          pagespeed: audit.pagespeed ?? null,
          pixel: audit.hasMetaPixel,
          googleTag: audit.hasGoogleTag,
          instagram: audit.siteInstagram,
          facebook: audit.siteFacebook,
        }
      : { online: false, obs: 'empresa sem site no ar' },
    // Perfil geral não tem "empreendimentos": não manda a lista pra IA não puxar jargão imobiliário.
    ...((row.perfil ?? 'construtoras') === 'geral' ? {} : { empreendimentos: (row.empreendimentos ?? []).map((e) => ({ nome: e.nome, cidade: e.cidade, status: e.status })) }),
    google: row.google_business?.found !== false && row.google_business
      ? { rating: row.google_business.rating, reviews: row.google_business.reviews, category: row.google_business.category }
      : null,
    anunciosMeta: anunciosMeta
      ? { validados: anunciosMeta.validados?.length ?? 0, aValidar: anunciosMeta.aValidar?.length ?? 0, totalAnalisados: anunciosMeta.total ?? null }
      : null,
    decisores,
  };
}

// Chamada genérica à API da Kommo (mesmo token/subdomínio da nota).
async function kommoApi(method, path, body) {
  const sub = process.env.KOMMO_SUBDOMAIN;
  const tok = process.env.KOMMO_API_TOKEN;
  if (!sub || !tok) return { ok: false, status: 0, body: null };
  const r = await fetch(`https://${sub}.kommo.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let parsed = null;
  try { parsed = txt ? JSON.parse(txt) : null; } catch { parsed = txt; }
  return { ok: r.ok, status: r.status, body: parsed };
}

// Funil da cadência (Outbound Cadência SDNA) — ids resolvidos por nome e cacheados.
const FUNIL_CADENCIA_NOME = 'Outbound Cadência SDNA';
let _funilCadencia = null;
async function funilCadencia() {
  if (_funilCadencia) return _funilCadencia;
  const r = await kommoApi('GET', '/api/v4/leads/pipelines');
  const p = (r.body?._embedded?.pipelines ?? []).find((x) => String(x.name).trim() === FUNIL_CADENCIA_NOME);
  if (!p) return null;
  const etapas = {};
  for (const s of p._embedded?.statuses ?? []) etapas[String(s.name).trim()] = Number(s.id);
  _funilCadencia = { id: Number(p.id), etapas };
  return _funilCadencia;
}

// Telefone pro contato do card: decisor (WhatsApp > pessoal) > planilha > Lemit.
function foneParaKommo(row, decisores) {
  const norm = (v) => {
    const d = String(v ?? '').replace(/\D/g, '');
    if (d.length < 10 || d.length > 13) return null;
    return `+${d.length <= 11 ? '55' + d : d}`;
  };
  const dec = [...(decisores ?? [])].sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  for (const d of dec) {
    const f = norm(d.phone_whatsapp) ?? norm(d.phone_personal);
    if (f) return { fone: f, dono: d.nome ?? null };
  }
  const daPlanilha = norm(row.phone_raw);
  if (daPlanilha) return { fone: daPlanilha, dono: null };
  for (const t of row.lemit_company?.telefones ?? []) {
    const f = norm(t?.numero ?? t?.telefone ?? t);
    if (f) return { fone: f, dono: null };
  }
  return { fone: null, dono: null };
}

// Importa leads enriquecidos pro Kommo: card no funil da cadência (etapa Fila),
// contato com telefone do decisor, nota com o link, espelho em public.leads
// (controle do SalesHub, canal outbound). Idempotente: pula quem já tem card.
async function importarLeadsKommo({ leadIds, token, responsavelKommoId = null, sdrNome = null }) {
  const funil = await funilCadencia();
  if (!funil || !funil.etapas['Fila']) return { ok: false, error: `funil "${FUNIL_CADENCIA_NOME}" não encontrado no Kommo` };
  const sub = process.env.KOMMO_SUBDOMAIN;
  const resultados = [];
  let criados = 0;

  for (const leadId of leadIds ?? []) {
    try {
      const row = (await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=*`))?.[0];
      if (!row) { resultados.push({ leadId, pulado: 'não encontrado' }); continue; }
      // 1 card POR DESTINATÁRIO (decisores escolhidos no F2): cada um recebe a
      // cadência com o próprio {{1}}. Quem já tem card (decisor.kommo_lead_id) é pulado.
      const decisores = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=id,nome,cargo,is_primary,selecionado,phone_whatsapp,phone_personal,kommo_lead_id`)) ?? [];
      const destinatarios = destinatariosDe(decisores);
      const nomeCard = row.nome_fantasia || marcaDe(row.razao_social || row.company_name_raw || '') || row.company_name_raw;
      const cc = row.cadencia_config && typeof row.cadencia_config === 'object' ? row.cadencia_config : null;
      const linhaCad = cc?.validadoEm
        ? `\nCadencia validada${cc.validadoPor ? ` por ${cc.validadoPor}` : ''}${cc.sdrNome ? ` - SDR: ${cc.sdrNome}` : ''}. Gancho principal: ${cc.falhaPrimaria ?? row.falha_primaria ?? '-'}${cc.falhaSecundaria ? ` / secundario: ${cc.falhaSecundaria}` : ''}.`
        : '';
      const foneEmpresa = foneParaKommo(row, []).fone;
      // Sem decisor nenhum: card único da empresa (comportamento antigo).
      const alvos = destinatarios.length ? destinatarios : [null];
      if (!destinatarios.length && row.kommo_lead_id) { resultados.push({ leadId, empresa: nomeCard, pulado: `já no Kommo (${row.kommo_lead_id})` }); continue; }
      let primeiroCard = row.kommo_lead_id ?? null;
      for (const d of alvos) {
        if (d?.kommo_lead_id) { resultados.push({ leadId, empresa: nomeCard, decisor: d.nome, pulado: `já no Kommo (${d.kommo_lead_id})` }); continue; }
        const { fone: foneDec } = d ? foneParaKommo(row, [d]) : { fone: null };
        const fone = foneDec ?? foneEmpresa;
        const nomeContato = d?.nome || nomeCard;
        const primeiro = d ? nome1De(cc, d) : null;
        const contato = { name: String(nomeContato).slice(0, 250) };
        if (fone) contato.custom_fields_values = [{ field_code: 'PHONE', values: [{ value: fone, enum_code: 'WORK' }] }];
        const rc = await kommoApi('POST', '/api/v4/leads/complex', [{
          name: String(d && destinatarios.length > 1 ? `${nomeCard} · ${primeiro}` : nomeCard).slice(0, 250),
          pipeline_id: funil.id,
          status_id: funil.etapas['Fila'],
          ...(responsavelKommoId ? { responsible_user_id: Number(responsavelKommoId) } : {}), // card do SDR que importou
          _embedded: { contacts: [contato] },
        }]);
        const kommoId = rc.body?.[0]?.id ?? rc.body?._embedded?.leads?.[0]?.id ?? null;
        if (!rc.ok || !kommoId) {
          resultados.push({ leadId, empresa: nomeCard, decisor: d?.nome ?? null, erro: `Kommo HTTP ${rc.status}: ${JSON.stringify(rc.body).slice(0, 150)}` });
          continue;
        }
        if (d) await sbPatch(token, 'enriquecedor_decision_makers', `id=eq.${d.id}`, { kommo_lead_id: String(kommoId) }).catch(() => {});
        if (!primeiroCard) {
          primeiroCard = String(kommoId);
          await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { kommo_lead_id: String(kommoId), updated_at: new Date().toISOString() });
        }
        const linhaDec = d ? `\nDestinatario: ${d.nome}${d.cargo ? ` (${d.cargo})` : ''} - primeiro nome na mensagem: ${primeiro}${!foneDec ? (fone ? ' - SEM telefone pessoal, usando o da empresa' : ' - SEM TELEFONE') : ''}.` : '';
        await kommoNote(kommoId, `ENRIQUECEDOR — lead importado pra cadência outbound (etapa Fila).${linhaDec}${linhaCad}\nMova pra "Passo 1 enviado" pra disparar a mensagem 1.\nLead completo: ${linkDoLead(leadId)}`);

        // Espelho no controle de leads do SalesHub (canal outbound) — 1 por CNPJ (só o primeiro card).
        const cnpj = row.cnpj ?? onlyDigits(row.cnpj_raw);
        const jaTem = cnpj ? await sbSelect(token, 'leads', `cnpj=eq.${cnpj}&select=id&limit=1`) : null;
        if (!jaTem?.length) {
          await sbUpsert(token, 'leads', [{
            empresa: nomeCard,
            nome_contato: nomeContato === nomeCard ? null : nomeContato,
            telefone: fone,
            cnpj: cnpj || null,
            canal: 'outbound',
            fonte: 'enriquecedor',
            kommo_id: String(kommoId),
            kommo_link: `https://${sub}.kommo.com/leads/detail/${kommoId}`,
            kommo_pipeline_id: funil.id,
            kommo_status_id: funil.etapas['Fila'],
            data_cadastro: new Date().toISOString().slice(0, 10),
          }]).catch((e) => console.warn('[importar] public.leads falhou:', String(e?.message || e).slice(0, 120)));
        }

        // Variáveis da cadência visíveis no card desde já (CAD *) + responsável.
        const pre = await preencherCardCadencia({ leadId, decisorId: d?.id ?? null, kommoLeadId, token, sdrNome, responsavelKommoId }).catch((e) => ({ ok: false, erro: String(e?.message || e) }));
        criados += 1;
        resultados.push({ leadId, empresa: nomeCard, decisor: d?.nome ?? null, kommo_lead_id: String(kommoId), fone: fone ?? 'SEM TELEFONE — completar no card', cadencia: pre });
        await sleep(250); // folga de rate na Kommo
      }
    } catch (err) {
      resultados.push({ leadId, erro: String(err?.message || err).slice(0, 200) });
    }
  }
  return { ok: true, criados, total: (leadIds ?? []).length, resultados };
}

// ═══ Cadência outbound (SDNA) ════════════════════════════════════════════════
// Detecção de falhas verificáveis + montagem do pacote de mensagens WABA.
// ÚNICA fonte de verdade da detecção: roda no /api/cadencia/preparar (sob demanda)
// e no fim da esteira (persistindo no lead). Trabalha com as LINHAS DO BANCO
// (snake_case: enriquecedor_leads + enriquecedor_site_audits), não com os shapes
// camelCase do app — quem chama lê as linhas via PostgREST com o token do usuário.

const FALHA_ORDEM = ['https', 'whatsapp', 'destino', 'semanuncio', 'gmn', 'pixel'];

function detectarFalhas(leadRow, auditRow) {
  const falhas = [];
  const add = (codigo, evidencia) => falhas.push(evidencia ? { codigo, evidencia } : { codigo });

  // "mediu anúncios" = jsonb anuncios tem a chave meta (só é gravado quando a varredura rodou)
  const meta = leadRow?.anuncios?.meta ?? null;
  const ativos = meta ? (meta.validados?.length ?? 0) + (meta.aValidar?.length ?? 0) : null;
  const perf = auditRow?.pagespeed?.performance ?? null;

  // 1 · https — precisa de auditoria feita; sem linha de audit não dá pra afirmar
  //     que o site não existe (pode ser só F3 que não rodou).
  if (auditRow && (!auditRow.is_online || auditRow.https_valid === false || (auditRow.http_status ?? 200) >= 400)) {
    add('https');
  }
  // 2 · whatsapp — ausente (sem botão E sem widget) ou quebrado (há botões, nenhum
  //     com número utilizável). Widget JS presente = ambíguo, não vira falha.
  if (auditRow?.is_online) {
    const botoes = Array.isArray(auditRow.whatsapp_buttons) ? auditRow.whatsapp_buttons : [];
    const quebrado = botoes.length > 0 && botoes.every((b) => !b?.working);
    const ausente = botoes.length === 0 && !auditRow.has_whatsapp_widget;
    if (quebrado || ausente) add('whatsapp', { situacao: quebrado ? 'quebrado' : 'ausente' });
  }
  // 3 · destino — anuncia E o PSI mobile mediu abaixo de 50 (performance null = não afirma)
  if (ativos != null && ativos > 0 && perf != null && perf < 50) add('destino', { nota: perf });
  // 4 · semanuncio — a varredura rodou e nada ativo (meta_bloqueado não grava meta, então não cai aqui)
  if (ativos === 0) add('semanuncio');
  // 5 · gmn — busca feita: sem perfil, ou perfil com poucas avaliações / nota baixa
  const gb = leadRow?.google_business ?? null;
  if (gb) {
    if (gb.found === false) add('gmn', { avaliacoes: 0, semPerfil: true });
    else if ((gb.reviews ?? 0) < 10 || (gb.rating != null && Number(gb.rating) < 4.0)) {
      add('gmn', { avaliacoes: gb.reviews ?? 0 });
    }
  }
  // 6 · pixel
  if (auditRow?.is_online && !auditRow.has_meta_pixel) add('pixel');

  falhas.sort((a, b) => FALHA_ORDEM.indexOf(a.codigo) - FALHA_ORDEM.indexOf(b.codigo));
  return falhas;
}

// Resolve as frases do catálogo pra UMA falha detectada, interpolando [nota]/[n].
// A falha 'whatsapp' tem frase própria pro caso "ausente" (a do catálogo descreve
// botão quebrado) e 'gmn' pro caso "sem perfil" — variação vive aqui, não na Meta:
// pro WABA tudo é conteúdo de variável, o template aprovado não muda.
function frasesDaFalha(f, catalogo) {
  const cat = catalogo.find((c) => c.codigo === f.codigo);
  if (!cat) return null;
  let falha = cat.frase_falha;
  let impacto = cat.frase_impacto;
  let rotulo = cat.rotulo_curto;
  if (f.codigo === 'whatsapp' && f.evidencia?.situacao === 'ausente') {
    falha = 'não achei botão de WhatsApp no site de vocês';
    impacto = 'quem entra no site decidido a chamar acaba tendo que caçar o número por fora — e é nesse desvio que a maioria desiste';
    rotulo = 'o site sem botão de WhatsApp';
  }
  if (f.codigo === 'gmn' && f.evidencia?.semPerfil) {
    falha = 'não achei o perfil da empresa no Google Maps';
    impacto = 'quem procura o serviço na região só encontra os concorrentes — vocês nem entram na comparação';
    rotulo = 'a empresa fora do Google Maps';
  }
  falha = falha.replace('[nota]', String(f.evidencia?.nota ?? '')).replace('[n]', String(f.evidencia?.avaliacoes ?? ''));
  return { falha, impacto, rotulo };
}

const primeiroNome = (nome) => {
  const n = String(nome || '').trim().split(/\s+/)[0] || '';
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : '';
};

// Decisor pro {{1}}: decision_makers primeiro (cargo de dono/decisão na frente),
// senão sócio-administrador do QSA, senão primeiro sócio.
function nomeDecisor(row, decisores) {
  const peso = (cargo) => (/soci|dono|propriet|founder|fundador|ceo|diretor|presidente|adminis/i.test(cargo || '') ? 0 : 1);
  const d = [...(decisores ?? [])].sort((a, b) => peso(a.cargo) - peso(b.cargo))[0];
  if (d?.nome) return d.nome;
  const socios = Array.isArray(row?.socios) ? row.socios : [];
  const adm = socios.find((s) => /adminis/i.test(s?.qualificacao || ''));
  return adm?.nome ?? socios[0]?.nome ?? '';
}

// Corta no fim da última palavra inteira que cabe em max.
function cortaPalavra(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  const corte = t.slice(0, max + 1);
  const i = corte.lastIndexOf(' ');
  return (i > 0 ? corte.slice(0, i) : t.slice(0, max)).trim();
}

const montarCorpo = (corpo, vars) =>
  String(corpo ?? '').replace(/\{\{(\d)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '');

// Monta o pacote completo da cadência de um lead: detecta as falhas, persiste
// no lead (falha_primaria/secundaria/falhas_detectadas/apto_cadencia) e devolve
// as 3 mensagens de WhatsApp com template escolhido + variáveis interpoladas,
// prontas pro n8n/Salesbot. Tetos validados (140/180 nas frases, 1024 no corpo).
// `config` (13/09): escolhas do SDR feitas no arquiteto (F7) — vem do body
// (prévia ao vivo) ou de enriquecedor_leads.cadencia_config (validado). Quando
// existe, MANDA: falha principal/secundária, decisor, nome do SDR, marca,
// frases dentro dos tetos e variante do template. A detecção automática vira
// só o padrão/opções. A resposta traz `opcoes` pra UI montar o editor.
// Destinatários da cadência = decisores ESCOLHIDOS no F2 (selecionado); sem
// escolha, o primário; sem primário, o primeiro. Cada um vira um card no Kommo
// e recebe as mensagens com o próprio {{1}}.
function destinatariosDe(decisores) {
  const all = decisores ?? [];
  const sel = all.filter((d) => d.selecionado);
  if (sel.length) return sel;
  const prim = all.find((d) => d.is_primary);
  return prim ? [prim] : all.slice(0, 1);
}
const nome1De = (cfg, d) => String(cfg?.nomes1?.[String(d?.id)] ?? '').trim() || primeiroNome(d?.nome);

async function prepararCadencia({ leadId, token, sdrNome, persistir = true, config = null, decisorId = null }) {
  const rows = await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=*`);
  const row = rows?.[0];
  if (!row) return { ok: false, error: 'lead não encontrado' };
  const audit = (await sbSelect(token, 'enriquecedor_site_audits', `lead_id=eq.${leadId}&select=*`))?.[0] ?? null;
  const catalogo = (await sbSelect(token, 'enriquecedor_cadencia_falhas', 'ativo=eq.true&select=*&order=prioridade')) ?? [];
  const templates = (await sbSelect(token, 'enriquecedor_cadencia_templates', 'canal=eq.whatsapp&ativo=eq.true&select=*')) ?? [];

  const cfg = (config && typeof config === 'object' ? config : null) ?? (row.cadencia_config && typeof row.cadencia_config === 'object' && Object.keys(row.cadencia_config).length ? row.cadencia_config : null);
  const falhas = detectarFalhas(row, audit);
  const avisos = [];
  // Falha principal: a escolhida pelo SDR, se ainda estiver entre as detectadas;
  // senão a mais forte detectada (e avisa que a escolha caiu).
  const porCodigo = (c) => (c ? falhas.find((f) => f.codigo === c) ?? null : null);
  let primaria = porCodigo(cfg?.falhaPrimaria);
  if (cfg?.falhaPrimaria && !primaria) avisos.push(`a falha escolhida (${cfg.falhaPrimaria}) não está mais entre as detectadas — usando a mais forte medida`);
  if (!primaria) primaria = falhas[0] ?? null;
  // Secundária: escolhida (≠ primária) | null explícito (passo 2 "aprofunda") | padrão = próxima detectada.
  let secundaria;
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'falhaSecundaria')) {
    secundaria = cfg.falhaSecundaria ? porCodigo(cfg.falhaSecundaria) : null;
    if (secundaria && primaria && secundaria.codigo === primaria.codigo) secundaria = null;
  } else {
    secundaria = falhas.find((f) => f.codigo !== primaria?.codigo) ?? null;
  }
  const apto = !!primaria && !row.optout;
  const opcoes = {
    falhas: falhas.map((f) => ({ ...f, ...(frasesDaFalha(f, catalogo) ?? {}), rotuloLongo: catalogo.find((c) => c.codigo === f.codigo)?.rotulo_curto ?? f.codigo })),
    templates: templates.map((t) => ({ nome: t.nome, passo: t.passo, versao: t.versao, corpo: t.corpo, variaveis: t.variaveis ?? [], botoes: t.botoes ?? [], statusMeta: t.status_meta, review: t.review_status ?? null, temBot: !!t.kommo_bot_id })),
    limites: { nome1: 20, sdr: 20, fantasia: 40, fraseFalha: 140, fraseImpacto: 180, rotulo: 60, corpo: 1024 },
  };

  if (persistir) {
    await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, {
      falha_primaria: primaria?.codigo ?? null,
      falha_secundaria: secundaria?.codigo ?? null,
      falhas_detectadas: falhas,
      apto_cadencia: apto,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  }

  if (!apto) {
    return {
      ok: true,
      aptoCadencia: false,
      falhas,
      opcoes,
      config: cfg,
      motivo: row.optout
        ? 'lead pediu pra não receber (optout)'
        : 'nenhuma falha verificável medida — rode F2/F3/F4 antes; mensagem sem falha concreta é spam',
    };
  }

  const tpl = (nome) => templates.find((t) => t.nome === nome) ?? null;
  // Rotação 50/50 determinística por lead (não depende de estado externo).
  const rot = [...String(leadId)].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;

  const decisores = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=id,nome,cargo,is_primary,selecionado,phone_personal,phone_whatsapp,kommo_lead_id`)) ?? [];
  const destinatarios = destinatariosDe(decisores);
  // {{1}}: o destinatário deste disparo (card do decisor) → senão o primeiro
  // destinatário → senão a regra antiga (QSA). Override por decisor em cfg.nomes1.
  const decisorEscolhido = (decisorId ? decisores.find((d) => String(d.id) === String(decisorId)) : null) ?? destinatarios[0] ?? null;
  let nome1 = decisorEscolhido ? nome1De(cfg, decisorEscolhido) : (String(cfg?.nome1 ?? '').trim() || primeiroNome(nomeDecisor(row, decisores)));
  if (!nome1) { nome1 = 'tudo bem?'; avisos.push('decisor não identificado — {{1}} caiu no genérico "tudo bem?"'); }
  nome1 = cortaPalavra(nome1, 20);
  // {{2}}: o SDR que validou a cadência manda; senão o responsável do card (carteiro) ou o informado.
  let sdr = cortaPalavra(String(cfg?.sdrNome || sdrNome || '').trim(), 20);
  if (!sdr) { sdr = '[SDR]'; avisos.push('sdrNome não informado — preencha {{2}} antes do disparo'); }
  const fantasia = cortaPalavra(String(cfg?.fantasia ?? '').trim() || row.nome_fantasia || marcaDe(row.razao_social || row.company_name_raw || ''), 40);

  const fr1 = frasesDaFalha(primaria, catalogo);
  if (!fr1) return { ok: false, error: `falha '${primaria.codigo}' sem registro no catálogo` };
  // Ajustes do SDR nas frases (só quando a falha escolhida é a que está valendo).
  if (cfg?.falhaPrimaria === primaria.codigo) {
    if (String(cfg.fraseFalha ?? '').trim()) fr1.falha = String(cfg.fraseFalha).trim();
    if (String(cfg.fraseImpacto ?? '').trim()) fr1.impacto = String(cfg.fraseImpacto).trim();
  }
  const teto = (texto, max, rotulo) => {
    if (String(texto).length > max) {
      avisos.push(`${rotulo} estourou ${max} caracteres e foi cortado na última palavra`);
      void logErroToken(token, '/api/cadencia/preparar', `${rotulo} estourou o teto de ${max}`, { leadId, texto });
      return cortaPalavra(texto, max);
    }
    return texto;
  };
  const v4 = teto(fr1.falha, 140, 'frase da falha ({{4}})');
  const v5 = teto(fr1.impacto, 180, 'frase do impacto ({{5}})');

  const msg = (t, vars) => {
    if (!t) return null;
    const corpo = montarCorpo(t.corpo, vars);
    if (corpo.length > 1024) avisos.push(`corpo do ${t.nome} passou de 1024 caracteres (${corpo.length}) — a Meta rejeita`);
    return {
      template: t.nome,
      templateId: t.id,
      statusMeta: t.status_meta,
      variaveis: vars,
      botoes: t.botoes ?? [],
      corpoPreview: corpo,
    };
  };

  // Variante do template: a escolhida pelo SDR (se existir/ativa) ou a rotação padrão.
  const escolhe = (passo, padrao) => {
    const nome = cfg?.templates?.[`p${passo}`];
    if (nome && tpl(nome) && tpl(nome).passo === passo) return tpl(nome);
    if (nome) avisos.push(`template ${nome} indisponível — usando ${padrao}`);
    return tpl(padrao);
  };
  const fr2 = secundaria ? frasesDaFalha(secundaria, catalogo) : null;
  if (fr2 && cfg?.falhaSecundaria === secundaria.codigo && String(cfg.rotuloSecundaria ?? '').trim()) fr2.rotulo = cortaPalavra(String(cfg.rotuloSecundaria).trim(), 60);
  const p1 = msg(escolhe(1, rot === 0 ? 'sdna_p1_auditoria_v1' : 'sdna_p1_auditoria_v2'), [nome1, sdr, fantasia, v4, v5]);
  const t2 = escolhe(2, fr2 ? 'sdna_p2_segunda_falha_v1' : 'sdna_p2_aprofunda_v1');
  const p2 = t2 && t2.nome === 'sdna_p2_segunda_falha_v1'
    ? (fr2 ? msg(t2, [nome1, fantasia, fr2.rotulo]) : msg(tpl('sdna_p2_aprofunda_v1'), [nome1, fantasia]))
    : msg(t2, [nome1, fantasia]);
  const p3 = msg(escolhe(3, rot === 0 ? 'sdna_p3_breakup_v1' : 'sdna_p3_breakup_v2'), [nome1, fantasia]);

  return {
    ok: true,
    aptoCadencia: true,
    leadId,
    kommoLeadId: row.kommo_lead_id ?? null,
    empresa: row.nome_fantasia ?? row.razao_social ?? row.company_name_raw ?? null,
    falhas,
    falhaPrimaria: { ...primaria, ...fr1 },
    falhaSecundaria: fr2 ? { ...secundaria, ...fr2 } : null,
    whatsapp: { p1, p2, p3 },
    variaveis: { nome1, sdr, fantasia, fraseFalha: v4, fraseImpacto: v5, rotuloSecundaria: fr2?.rotulo ?? null },
    decisorId: decisorEscolhido?.id ?? null,
    destinatarios: destinatarios.map((d) => ({ id: d.id, nome: d.nome, cargo: d.cargo ?? null, nome1: nome1De(cfg, d), fone: !!(d.phone_whatsapp || d.phone_personal), kommoLeadId: d.kommo_lead_id ?? null })),
    validado: !!cfg?.validadoEm,
    opcoes,
    config: cfg,
    avisos,
  };
}

// E-mail da cadência — corpo 100% gerado por IA a partir do briefing + falha.
async function gerarEmailCadencia({ leadId, passo, sdrNome, sdrCargo, token }) {
  const row = (await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=*`))?.[0];
  if (!row) return { ok: false, error: 'lead não encontrado' };
  const audit = (await sbSelect(token, 'enriquecedor_site_audits', `lead_id=eq.${leadId}&select=*`))?.[0] ?? null;
  const catalogo = (await sbSelect(token, 'enriquecedor_cadencia_falhas', 'ativo=eq.true&select=*&order=prioridade')) ?? [];
  const falhas = detectarFalhas(row, audit);
  if (!falhas.length) return { ok: false, error: 'nenhuma falha verificável — sem gancho não sai e-mail' };
  const fr = frasesDaFalha(falhas[0], catalogo);

  const regras = {
    1: 'PASSO 1 (abertura): assunto com no máximo 6 palavras e SEM o nome da empresa; corpo de 120 a 160 palavras; o primeiro parágrafo traz um dado duro da auditoria; CTA de RESPOSTA (pergunta simples), não de reunião.',
    2: 'PASSO 2 (prova): 100 a 140 palavras; aprofunda a falha com o que ela custa na prática; sem inventar case ou leitura de concorrente que não está nos dados.',
    3: 'PASSO 3 (breakup): no máximo 80 palavras; despedida sem pressão; termina oferecendo sair da lista.',
  };
  const prompt =
    `Você escreve e-mails de prospecção outbound B2B em português brasileiro pra V4 Ruston (assessoria de marketing). ` +
    `Remetente: ${sdrNome || 'SDR'}${sdrCargo ? `, ${sdrCargo}` : ''}.\n\n` +
    `EMPRESA-ALVO: ${row.nome_fantasia ?? row.razao_social ?? row.company_name_raw}\n` +
    `FALHA VERIFICADA NA AUDITORIA: ${fr?.falha ?? falhas[0].codigo}\n` +
    `IMPACTO PRÁTICO: ${fr?.impacto ?? ''}\n` +
    `TODAS AS FALHAS DETECTADAS: ${falhas.map((f) => f.codigo).join(', ')}\n` +
    `BRIEFING (dados já apurados): ${JSON.stringify({ dores: row.briefing?.dores ?? [], ganchos: row.briefing?.ganchos ?? [], segmento: row.segmento, cidade: row.cidade, uf: row.uf }).slice(0, 2500)}\n\n` +
    `${regras[passo] ?? regras[1]}\n\n` +
    `PROIBIDO: "espero que esteja bem", "gostaria de apresentar", superlativos, emoji, mencionar anexo, inventar números que não estão acima.\n` +
    `Responda APENAS um JSON: {"assunto": string, "corpoTexto": string} — corpoTexto com parágrafos separados por linha em branco, sem HTML.`;

  try {
    const text = await anthropicText(BRIEFING_MODEL, 2000, prompt);
    if (text == null) return { ok: false, error: 'IA desativada (sem ANTHROPIC_API_KEY)' };
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (!j?.assunto || !j?.corpoTexto) return { ok: false, error: 'IA não devolveu assunto/corpo' };
    const assunto = cortaPalavra(j.assunto, 60);
    const corpoHtml = String(j.corpoTexto)
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('\n');
    return { ok: true, passo, assunto, corpoTexto: j.corpoTexto, corpoHtml, falha: falhas[0].codigo };
  } catch (err) {
    return { ok: false, error: `geração falhou: ${String(err?.message || err).slice(0, 200)}` };
  }
}

// Classifica resposta em TEXTO LIVRE (quick reply é determinístico e não passa aqui).
// Opt-out sai por regex antes do modelo — barato e sem falso negativo do lado que importa.
// O regex do spec tinha \bpara\b — preposição comum ("pode ligar para mim") viraria
// opt-out. Ficam só formas imperativas/infinitivas e combinações inequívocas.
const OPTOUT_RE = /\b(sair da lista|pare|parar|descadastr\w*|remove\w*|(tira|tirar|me tire)\b.{0,20}\blista|n[aã]o quero (receber|mais)|n[aã]o (me )?(mande|manda|envie|envia) mais)\b/i;
async function classificarResposta({ texto }) {
  const t = String(texto ?? '').trim();
  if (!t) return { ok: false, error: 'texto vazio' };
  if (OPTOUT_RE.test(t)) {
    return { ok: true, classificacao: 'optout', confianca: 0.99, resumo_1_linha: 'pediu pra sair da lista (regex)', proxima_acao: 'marcar optout=true e bloquear reentrada', classificado_por: 'regex' };
  }
  const prompt =
    `Classifique a resposta de um lead B2B a uma mensagem de prospecção por WhatsApp/e-mail.\n` +
    `RESPOSTA DO LEAD: """${t.slice(0, 1500)}"""\n\n` +
    `Classes possíveis (escolha UMA): interesse | pedido_info | objecao_preco | objecao_momento | nao_decisor | sem_fit | optout\n` +
    `Responda APENAS um JSON: {"classificacao": string, "confianca": number entre 0 e 1, "resumo_1_linha": string, "proxima_acao": string}`;
  try {
    const text = await anthropicText('claude-haiku-4-5-20251001', 500, prompt);
    if (text == null) return { ok: false, error: 'IA desativada' };
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    const classes = ['interesse', 'pedido_info', 'objecao_preco', 'objecao_momento', 'nao_decisor', 'sem_fit', 'optout'];
    if (!j || !classes.includes(j.classificacao)) return { ok: false, error: 'classificação fora das 7 classes' };
    return { ok: true, ...j, classificado_por: 'ia' };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

// `fases` (28/09): subconjunto opcional ['f2'|'f3'|'f4'] — sem ele roda tudo.
// Com fases:['f2'] faz Receita + Qualificação e para (status 'enriquecido'),
// sem site/anúncios/briefing/nota no Kommo — é o "rodar F2 em todos" pelo servidor.
async function runEsteira({ leadId, kommoLeadId, token, fases = null }) {
  const so = (f) => !Array.isArray(fases) || !fases.length || fases.includes(f);
  { const st = ctxAtual(); if (st) st.leadId = leadId; }
  const setStatus = (status) =>
    sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { status, updated_at: new Date().toISOString() }).catch(() => {});
  let row = null;
  try {
    const rows = await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=*`);
    row = rows?.[0];
    if (!row) throw new Error('lead não encontrado no banco');

    // ── F1 · Triagem (Receita) ───────────────────────────────────────────────
    await setStatus('esteira_f1');
    const digits = onlyDigits(row.cnpj ?? row.cnpj_raw);
    if (digits.length === 14) {
      const r1 = await fetchCnpj(digits);
      const d = r1?.data;
      if (d) {
        const patch = {
          cnpj: digits,
          razao_social: d.razao_social ?? row.razao_social,
          nome_fantasia: d.nome_fantasia ?? row.nome_fantasia,
          cnae: d.cnae_fiscal ? String(d.cnae_fiscal) : row.cnae,
          segmento: d.cnae_fiscal_descricao ?? row.segmento,
          cidade: d.municipio ?? row.cidade,
          uf: d.uf ?? row.uf,
          situacao_cadastral: d.descricao_situacao_cadastral ?? row.situacao_cadastral,
          socios: (d.qsa ?? []).map((s) => ({ nome: s.nome_socio, qualificacao: s.qualificacao_socio ?? null })),
          data_quality: 'valido',
        };
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, patch);
        Object.assign(row, patch);
      }
    }

    // ── F2 · Qualificação (DataStone + Lemit + redes dos sócios) ────────────
    // Mesma regra do front (enrichService.discoverPeople): pessoa = união de
    // DataStone e Lemit por CPF/nome; telefone/e-mail "validado" = nas 2 fontes;
    // decisor já existente (mesmo nome) é ATUALIZADO, não recriado — preserva
    // seleção do F2, validação de redes e o card do Kommo; redes da empresa
    // respeitam as chaves validadas/rejeitadas.
    if (so('f2')) {
    await setStatus('esteira_f2');
    { const st = ctxAtual(); if (st) st.fase = 'F2'; }
    const chaves = row.chaves_busca && typeof row.chaves_busca === 'object' ? row.chaves_busca : {};
    const igValidado = chaves.instagram?.validacao === 'validado' && row.company_instagram;
    const fbValidado = chaves.facebook?.validacao === 'validado' && row.company_facebook;
    const existentes = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=*`)) ?? [];
    const normNome = (n) => normText(String(n ?? '')).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    // SITE PRIMEIRO (em paralelo com DataStone/Lemit): descobre e valida o site pelo
    // conteúdo e lê DELE as redes que a própria empresa publica e o id da página
    // Meta. A busca web de redes só entra como fallback, ancorada no domínio.
    const marcaF2 = chaves.marca?.valor?.trim() || row.nome_fantasia || marcaDe(row.razao_social ?? row.company_name_raw);
    const siteP = discoverSite({
      companyName: row.razao_social ?? row.company_name_raw,
      nomeFantasia: marcaF2,
      emailDomain: row.email_raw?.includes('@') ? row.email_raw.split('@')[1] : null,
      cidade: row.cidade,
      siteUrl: row.site_url,
      cnpj: digits,
      forcar: chaves.site?.validacao === 'validado' && row.site_url ? row.site_url : null,
      rejeitados: chaves.site?.rejeitados ?? [],
      gmnRejeitados: chaves.gmn?.rejeitados ?? [],
    }).catch(() => null);
    const [ds, pessoas, lemit, disc] = await Promise.all([
      datastoneCompany(digits).catch(() => null),
      datastonePessoas(digits).catch(() => null),
      lemitEnrich(digits).catch(() => null),
      siteP,
    ]);
    const patch2 = {};
    const novasChaves = { ...chaves };
    let chavesMudou = false;
    const setChave = (id, patch) => { novasChaves[id] = { ...(novasChaves[id] ?? {}), ...patch }; chavesMudou = true; };
    if (ds?.ok && ds.data) {
      patch2.datastone = ds.data;
      if (ds.data.organograma) patch2.organograma = ds.data.organograma;
    }
    if (lemit?.ok && lemit.company) patch2.lemit_company = lemit.company;
    if (disc?.url && chaves.site?.validacao !== 'validado' && disc.url !== row.site_url && (!row.site_url || disc.confianca === 'alta')) {
      patch2.site_url = disc.url;
      setChave('site', { origem: disc.source, confianca: disc.confianca ?? null });
    }
    const sinaisSite = disc?.html ? sinaisDoSite(disc.html) : null;
    // Decisores que a DataStone/Lemit trouxeram além do QSA também ganham busca social.
    const nomesQsa = new Set((row.socios ?? []).map((s) => normText(s.nome ?? '')));
    const pessoasExtras = [...(pessoas?.ok ? pessoas.people ?? [] : []), ...(lemit?.ok ? lemit.people ?? [] : [])]
      .map((p) => p?.nome).filter((n) => n && !nomesQsa.has(normText(n)));
    const social = await discoverSociosSocial({
      company: marcaF2,
      socios: (row.socios ?? []).map((s) => s.nome).filter(Boolean),
      pessoasExtras,
      cidade: row.cidade ?? null,
      siteUrl: disc?.url ?? row.site_url ?? null,
      siteSocial: sinaisSite,
      rejeitados: Object.fromEntries(existentes.map((d) => [normText(d.nome), d.instagram_rejeitados ?? []])),
      rejeitadosLinkedin: Object.fromEntries(existentes.map((d) => [normText(d.nome), d.linkedin_rejeitados ?? []])),
      rejeitadosEmpresa: { instagram: chaves.instagram?.rejeitados ?? [], facebook: chaves.facebook?.rejeitados ?? [] },
    }).catch(() => null);
    const podeTrocar = (conf, atual) => !atual || conf === 'alta'; // valor existente só cai pra um "alta"
    if (social?.companyInstagram && !igValidado && podeTrocar(social.companyInstagramConfianca, row.company_instagram)) {
      patch2.company_instagram = social.companyInstagram;
      setChave('instagram', { origem: social.companyInstagramOrigem ?? 'busca', confianca: social.companyInstagramConfianca ?? null });
    }
    if (social?.companyFacebook && !fbValidado && podeTrocar(social.companyFacebookConfianca, row.company_facebook)) {
      patch2.company_facebook = social.companyFacebook;
      setChave('facebook', { origem: social.companyFacebookOrigem ?? 'busca', confianca: social.companyFacebookConfianca ?? null });
    }
    // Id da página Meta publicado no próprio site → F4 mede direto, sem headless/chute.
    const mp = social?.metaPageId ?? sinaisSite?.metaPageId ?? null;
    if (mp && chaves.meta_pagina?.validacao !== 'validado' && !chaves.meta_pagina?.valor && !(chaves.meta_pagina?.rejeitados ?? []).includes(mp)) {
      setChave('meta_pagina', { valor: mp, nome: null, origem: 'site' });
    }
    if (chavesMudou) patch2.chaves_busca = novasChaves;
    if (Object.keys(patch2).length) {
      await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, patch2);
      Object.assign(row, patch2);
    }
    // União das pessoas (DataStone + Lemit) por CPF, senão por nome normalizado.
    const uni = new Map();
    const chave = (p) => (onlyDigits(p.cpf).length === 11 ? `cpf:${onlyDigits(p.cpf)}` : `nome:${normNome(p.nome)}`);
    for (const p of pessoas?.ok ? (pessoas.people ?? []) : []) {
      if (!p?.nome) continue;
      const u = uni.get(chave(p)) ?? { nome: p.nome, cpf: onlyDigits(p.cpf) || null, cargo: p.cargo ?? null, ds: null, lm: null };
      u.ds = p; uni.set(chave(p), u);
    }
    for (const p of lemit?.ok ? (lemit.people ?? []) : []) {
      if (!p?.nome) continue;
      const k = chave(p);
      const u = uni.get(k) ?? [...uni.values()].find((x) => normNome(x.nome) === normNome(p.nome)) ?? { nome: p.nome, cpf: onlyDigits(p.cpf) || null, cargo: null, ds: null, lm: null };
      u.lm = p; if (!u.cpf && onlyDigits(p.cpf).length === 11) u.cpf = onlyDigits(p.cpf); uni.set(k, u);
    }
    const mergePhones = (lm, dsp) => {
      const map = new Map();
      const add = (numero, whatsapp, hot, source) => {
        const d = onlyDigits(numero); if (d.length < 10) return;
        const k = d.slice(-11);
        const ex = map.get(k) ?? { numero, whatsapp: false, hot: false, sources: [], validado: false };
        ex.whatsapp = ex.whatsapp || !!whatsapp; ex.hot = ex.hot || !!hot;
        if (String(numero).length >= String(ex.numero).length) ex.numero = numero;
        if (!ex.sources.includes(source)) ex.sources.push(source);
        map.set(k, ex);
      };
      for (const p of lm ?? []) add(p.numero ?? p, p.whatsapp, false, 'lemit');
      for (const p of dsp ?? []) add(p.numero, p.whatsapp, p.hot, 'datastone');
      return [...map.values()].map((p) => ({ ...p, validado: p.sources.length >= 2 }))
        .sort((a, b) => Number(b.validado) - Number(a.validado) || Number(b.whatsapp) - Number(a.whatsapp) || Number(b.hot) - Number(a.hot));
    };
    const mergeEmails = (lm, dsp) => {
      const map = new Map();
      const add = (email, source) => { const k = String(email ?? '').toLowerCase().trim(); if (!k) return; const ex = map.get(k) ?? { email: k, sources: [], validado: false }; if (!ex.sources.includes(source)) ex.sources.push(source); map.set(k, ex); };
      for (const e of lm ?? []) add(e, 'lemit');
      for (const e of dsp ?? []) add(e, 'datastone');
      return [...map.values()].map((e) => ({ ...e, validado: e.sources.length >= 2 })).sort((a, b) => Number(b.validado) - Number(a.validado));
    };
    const socialPeople = social?.people ?? [];
    // {url, confianca} da rede achada pro sócio (findPersonInstagram/Linkedin) ou null.
    const redeDe = (nome, campo) => {
      const sp = socialPeople.find((x) => normNome(x.nome) === normNome(nome));
      if (!sp?.[campo]) return null;
      return { url: sp[campo], confianca: sp[campo === 'instagram' ? 'instagramConfianca' : 'linkedinConfianca'] ?? null };
    };
    const pessoasUni = [...uni.values()].slice(0, 12);
    if (pessoasUni.length) {
      const porNome = new Map(existentes.map((d) => [normNome(d.nome), d]));
      const novos = [];
      let i = 0;
      for (const u of pessoasUni) {
        const phones = mergePhones(u.lm?.lemit?.phones ?? (u.lm?.phone ? [{ numero: u.lm.phone, whatsapp: u.lm.whatsapp }] : []), u.ds?.phones ?? []);
        const emails = mergeEmails(u.lm?.lemit?.emails ?? (u.lm?.email ? [u.lm.email] : []), u.ds?.emails ?? []);
        const cel = phones.find((x) => x.whatsapp) ?? phones[0] ?? null;
        const fontes = [u.ds ? 'datastone' : null, u.lm ? 'lemit' : null].filter(Boolean);
        const base = {
          cargo: u.cargo ?? (row.socios ?? []).find((s) => normNome(s.nome) === normNome(u.nome))?.qualificacao ?? null,
          cpf: u.cpf,
          phone_personal: cel?.numero ?? null,
          phone_whatsapp: !!cel?.whatsapp,
          email_personal: emails[0]?.email ?? null,
          phones, emails,
          confidence: fontes.length >= 2 ? 90 : 70,
          source: fontes.join('+'),
          companies_count: u.lm?.companiesCount ?? 0,
          companies: u.lm?.companies ?? [],
          lemit: u.lm?.lemit ?? null,
        };
        const ex = porNome.get(normNome(u.nome));
        if (ex) {
          // preserva: selecionado, validações/rejeitados de redes, kommo_lead_id, is_primary
          const patch = { ...base, cargo: ex.cargo ?? base.cargo };
          const ig = redeDe(u.nome, 'instagram'); const li = redeDe(u.nome, 'linkedin');
          if (ig && ex.instagram_validacao !== 'validado') { patch.instagram = ig.url; patch.instagram_confianca = ig.confianca; }
          if (li && ex.linkedin_validacao !== 'validado') { patch.linkedin = li.url; patch.linkedin_confianca = li.confianca; }
          await sbPatch(token, 'enriquecedor_decision_makers', `id=eq.${ex.id}`, patch).catch(() => {});
        } else {
          const ig = redeDe(u.nome, 'instagram'); const li = redeDe(u.nome, 'linkedin');
          novos.push({ lead_id: leadId, nome: u.nome, is_primary: existentes.length === 0 && i === 0, ...base,
            instagram: ig?.url ?? null, instagram_confianca: ig?.confianca ?? null,
            linkedin: li?.url ?? null, linkedin_confianca: li?.confianca ?? null });
        }
        i += 1;
      }
      if (novos.length) await sbUpsert(token, 'enriquecedor_decision_makers', novos);
    }
    if (Array.isArray(fases) && fases.length && !so('f3') && !so('f4')) {
      await setStatus('enriquecido');
      return;
    }
    }

    // ── F3 · Diagnóstico digital (site, GMN, empreendimentos, briefing) ─────
    if (so('f3')) {
    await setStatus('esteira_f3');
    { const st = ctxAtual(); if (st) st.fase = 'F3'; }
    let audit = null;
    try {
      // Chaves de busca do operador valem também aqui: site validado é forçado,
      // domínios/fichas apagados nunca voltam, marca manual é o nome de busca.
      const chavesSite = row.chaves_busca && typeof row.chaves_busca === 'object' ? row.chaves_busca : {};
      const marcaF3 = chavesSite.marca?.valor?.trim() || row.nome_fantasia || marcaDe(row.razao_social ?? row.company_name_raw);
      // Google Meu Negócio CONFERIDO (marca no título / telefone conhecido / cidade)
      // antes do site: a ficha certa é a fonte mais forte do site real.
      const telefones = [
        row.phone_raw,
        ...(row.lemit_company?.phones ?? []).map((t) => (typeof t === 'string' ? t : t?.numero)),
        ...(row.lemit_company?.fixos ?? []).map((t) => (typeof t === 'string' ? t : t?.numero)),
        row.datastone?.telefone, row.datastone?.phone,
      ].filter(Boolean);
      const gmnValidado = chavesSite.gmn?.validacao === 'validado' && row.google_business;
      const gbNovo = gmnValidado
        ? null
        : await serperPlacesCached(chavesSite.gmn?.consulta?.trim() || marcaF3, row.cidade, chavesSite.gmn?.rejeitados ?? [], { telefones, nomeCompleto: row.razao_social ?? row.company_name_raw }).catch(() => null);
      // Ficha já gravada só é trocada por uma "alta" (ou a mesma ficha).
      const trocaGmn = gbNovo && !gmnValidado && (!row.google_business || gbNovo.confianca === 'alta' || String(gbNovo.cid ?? '') === String(row.google_business?.cid ?? '-'));
      if (trocaGmn) {
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { google_business: gbNovo }).catch(() => {});
        row.google_business = gbNovo;
      }
      const gb = row.google_business ?? gbNovo;
      const disc = await discoverSite({
        companyName: row.razao_social ?? row.company_name_raw,
        nomeFantasia: marcaF3,
        emailDomain: row.email_raw?.includes('@') ? row.email_raw.split('@')[1] : null,
        cidade: row.cidade,
        siteUrl: row.site_url,
        cnpj: digits,
        forcar: chavesSite.site?.validacao === 'validado' && row.site_url ? row.site_url : null,
        rejeitados: chavesSite.site?.rejeitados ?? [],
        gmnRejeitados: chavesSite.gmn?.rejeitados ?? [],
        gmn: gb ?? null,
      });
      // Site já gravado só é trocado por um "alta" (ou mesmo host): a auditoria é
      // do site que FICA no lead — nunca de um candidato que não foi aceito.
      const mesmoHost = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; } };
      const trocaSite = !!disc?.url && (!row.site_url || disc.confianca === 'alta' || disc.source === 'validado' || mesmoHost(row.site_url, disc.url));
      const siteAlvo = trocaSite ? disc.url : (row.site_url || null);
      if (trocaSite && chavesSite.site?.validacao !== 'validado' && disc.source !== 'validado') {
        const ch = { ...chavesSite, site: { ...(chavesSite.site ?? {}), origem: disc.source, confianca: disc.confianca ?? null } };
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { chaves_busca: ch }).catch(() => {});
        row.chaves_busca = ch;
      }
      if (siteAlvo) {
        audit = await auditUrl(siteAlvo).catch(() => null);
        if (audit) {
          // PageSpeed (até 2,5 min) sai do caminho crítico: dispara agora, cobra depois.
          var psP = pagespeed(audit.siteUrl).catch(() => null);
          await sbUpsert(token, 'enriquecedor_site_audits', [{
            lead_id: leadId,
            site_url: audit.siteUrl,
            source: disc.source ?? null,
            is_online: !!audit.isOnline,
            http_status: audit.httpStatus ?? null,
            https_valid: !!audit.httpsValid,
            load_time_ms: audit.loadTimeMs ?? null,
            whatsapp_buttons: audit.whatsappButtons ?? [],
            has_whatsapp_widget: !!audit.hasWhatsappWidget,
            site_instagram: audit.siteInstagram ?? null,
            site_facebook: audit.siteFacebook ?? null,
            pagespeed: audit.pagespeed ?? null,
            has_meta_pixel: !!audit.hasMetaPixel,
            has_google_tag: !!audit.hasGoogleTag,
            notes: audit.notes ?? [],
          }], 'lead_id');
          if (trocaSite || mesmoHost(row.site_url ?? '', audit.siteUrl)) {
            await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { site_url: audit.siteUrl });
            row.site_url = audit.siteUrl;
          }
        }
      }
    } catch { /* site não encontrado */ }
    // Google Meu Negócio ‖ empreendimentos ‖ PageSpeed (já disparado) — independentes.
    const gmnP = Promise.resolve(); // GMN já conferido antes da descoberta do site
    const empP = (async () => {
      if ((row.perfil ?? 'construtoras') === 'geral') return;
      try {
        const emp = await discoverEmpreendimentos({
          company: row.razao_social ?? row.company_name_raw,
          nomeFantasia: row.nome_fantasia,
          cidade: row.cidade,
          siteUrl: row.site_url,
        });
        if (emp?.ok && (emp.empreendimentos ?? []).length) {
          // Mescla com o que já existe (LPs descobertas por anúncio e auditorias de LP não se perdem).
          const atuais = Array.isArray(row.empreendimentos) ? row.empreendimentos : [];
          const chaveE = (e) => normText(e?.nome ?? '');
          const mapa = new Map(atuais.map((e) => [chaveE(e), e]));
          for (const e of emp.empreendimentos) {
            const ex = mapa.get(chaveE(e));
            mapa.set(chaveE(e), ex ? { ...ex, ...e, lp: e.lp ?? ex.lp ?? null, lpAudit: ex.lpAudit ?? e.lpAudit ?? null } : e);
          }
          const final = [...mapa.values()];
          await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { empreendimentos: final });
          row.empreendimentos = final;
        }
      } catch { /* sem empreendimentos */ }
    })();
    await Promise.all([gmnP, empP]);
    // PageSpeed: espera no máximo 20 s aqui; se demorar mais, grava quando chegar.
    if (typeof psP !== 'undefined' && psP && audit) {
      const ps = await Promise.race([psP, sleep(20000).then(() => undefined)]);
      const gravaPs = async (v) => { if (v && v.ok !== false) { audit.pagespeed = v; await sbPatch(token, 'enriquecedor_site_audits', `lead_id=eq.${leadId}`, { pagespeed: v }).catch(() => {}); } };
      if (ps !== undefined) await gravaPs(ps);
      else void psP.then(gravaPs).catch(() => {});
    }
    const decisores = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=nome,cargo`)) ?? [];
    let briefing = null;
    // Briefing do F3 só quando o F4 NÃO vai rodar nesta execução (senão seria
    // gerado duas vezes — o do F4 já incorpora a mídia).
    if (!so('f4')) {
      const b1 = await generateBriefing(payloadBriefing(row, audit, decisores, null));
      if (b1?.ok && b1.briefing) {
        briefing = { ...b1.briefing, model: b1.model ?? null, generatedAt: new Date().toISOString() };
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { briefing });
      }
    }

    }
    // ── F4 · Anúncios por IDENTIDADE (página Meta + anunciante Google) ───────
    if (so('f4')) {
    // Mesmo desenho do front: resolve as chaves (respeitando validado/rejeitado
    // em chaves_busca), mede a Meta pela página (fallback: termo) e o Google
    // Transparency pelo anunciante (fallback: domínio); briefing ATUALIZADO.
    await setStatus('esteira_f4');
    let anunciosMeta = null;
    try {
      const hostDe = (u) => { try { return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, ''); } catch { return null; } };
      const siteDomain = row.site_url ? hostDe(row.site_url) : null;
      const chaves = { ...(row.chaves_busca ?? {}) };
      const idDe = (c, re) => { const m = String(c?.valor ?? '').match(re); return m && !(c?.rejeitados ?? []).includes(m[1]) ? m[1] : null; };
      let metaPageId = idDe(chaves.meta_pagina, /(\d{5,})/);
      let googleAdvertiser = idDe(chaves.google_anunciante, /(AR\d{6,})/i);
      let googleDominio = null;
      const precisaMeta = !metaPageId && chaves.meta_pagina?.validacao !== 'validado' && row.company_facebook;
      const precisaGoogle = !googleAdvertiser && chaves.google_anunciante?.validacao !== 'validado' && siteDomain;
      if (precisaMeta || precisaGoogle) {
        const [rm, rg] = await Promise.all([
          precisaMeta ? resolverMetaPageId(row.company_facebook, { marca: chaves.marca?.valor?.trim() || row.nome_fantasia || marcaDe(row.razao_social ?? row.company_name_raw) }).catch(() => null) : null,
          precisaGoogle ? googleTransparency({ domain: siteDomain }).catch(() => null) : null,
        ]);
        if (precisaMeta) {
          const rej = new Set(chaves.meta_pagina?.rejeitados ?? []);
          const cand = rm?.pageId ? [{ id: String(rm.pageId), nome: rm.pageName ?? null }, ...(rm.candidatos ?? [])].find((c) => !rej.has(String(c.id))) : null;
          chaves.meta_pagina = { ...(chaves.meta_pagina ?? {}), valor: cand ? String(cand.id) : null, nome: cand?.nome ?? null, validacao: null, origem: cand ? (rm.via ?? 'adlib') : 'nao_encontrado' };
          metaPageId = cand ? String(cand.id) : null;
        }
        if (precisaGoogle) {
          const rej = new Set(chaves.google_anunciante?.rejeitados ?? []);
          const adv = (rg?.anunciantes ?? []).find((a) => !rej.has(a.id)) ?? null;
          chaves.google_anunciante = { ...(chaves.google_anunciante ?? {}), valor: adv?.id ?? null, nome: adv?.nome ?? null, validacao: null, origem: adv ? 'dominio' : 'nao_encontrado' };
          googleAdvertiser = adv?.id ?? null;
          if (rg?.ok) googleDominio = rg; // já é a medição por domínio
        }
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { chaves_busca: chaves });
        row.chaves_busca = chaves;
      }
      const [an, ag] = await Promise.all([
        anunciosHeadless({
          company: marcaDe(row.nome_fantasia ?? row.razao_social ?? row.company_name_raw),
          fbHandle: row.company_facebook ? (row.company_facebook.match(/facebook\.com\/([^/?#]+)/i)?.[1] ?? null) : null,
          siteDomain,
          cidade: row.cidade,
          metaPageId,
          empreendimentos: (row.empreendimentos ?? [])
            .filter((e) => e.status === 'lancamento' || e.status === 'em_obra')
            .map((e) => ({ nome: e.nome, domain: e.lp ? hostDe(e.lp) : null })),
        }),
        googleAdvertiser ? googleTransparency({ advertiserId: googleAdvertiser }).catch(() => null) : Promise.resolve(googleDominio),
      ]);
      const google = ag?.ok
        ? { url: ag.url, advertiserId: googleAdvertiser, domain: googleAdvertiser ? null : siteDomain, anunciantes: ag.anunciantes ?? [], criativos: ag.criativos ?? 0, totalTexto: ag.totalTexto ?? null, formatos: ag.formatos ?? { video: 0, imagem: 0, texto: 0 }, amostra: ag.amostra ?? [], semAnuncios: !!ag.semAnuncios, viaProxy: !!ag.viaProxy }
        : (row.anuncios?.google ?? null);
      if (an?.meta) {
        anunciosMeta = an.meta;
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, {
          anuncios: { meta: an.meta, google, checkedAt: new Date().toISOString(), metaFalha: null },
        });
        // Fases seguintes ATUALIZAM o discurso: re-gera o briefing com a mídia.
        const b2 = await generateBriefing(payloadBriefing(row, audit, decisores, an.meta));
        if (b2?.ok && b2.briefing) {
          briefing = { ...b2.briefing, model: b2.model ?? null, generatedAt: new Date().toISOString() };
          await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { briefing });
        }
      } else {
        // Sem medição Meta: o briefing do F3 foi pulado por causa do F4 — gera agora sem mídia.
        if (!briefing) {
          const b3 = await generateBriefing(payloadBriefing(row, audit, decisores, null)).catch(() => null);
          if (b3?.ok && b3.briefing) {
            briefing = { ...b3.briefing, model: b3.model ?? null, generatedAt: new Date().toISOString() };
            await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { briefing });
          }
        }
        // Motivo real fica no lead (a UI mostra em vez de "ainda não medidos").
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, {
          anuncios: { meta: row.anuncios?.meta ?? null, google, checkedAt: row.anuncios?.checkedAt ?? new Date().toISOString(), metaFalha: { note: an?.note ?? 'meta_nao_medido', at: new Date().toISOString() } },
        });
      }
    } catch (err) {
      console.warn('[esteira] anúncios falharam:', String(err?.message || err).slice(0, 150));
    }

    }
    await setStatus('enriquecido');

    // ── Cadência: detecta e persiste as falhas verificáveis (falha_primaria etc.)
    let cad = null;
    try { cad = await prepararCadencia({ leadId, token, persistir: true }); } catch { /* não trava a esteira */ }

    // ── Nota final na Kommo: ganchos de abordagem ────────────────────────────
    if (kommoLeadId) {
      const ganchos = briefing?.ganchos ?? [];
      const dores = briefing?.dores ?? [];
      const linhaCadencia = cad?.aptoCadencia && cad.falhaPrimaria
        ? `\n\nGANCHO DE CADENCIA (falha verificada): ${cad.falhaPrimaria.falha}`
        : '';
      const texto = ganchos.length
        ? `ENRIQUECEDOR — GANCHOS DE ABORDAGEM\n\n${ganchos.map((g, i) => `${i + 1}. ${g}`).join('\n')}` +
          (dores.length ? `\n\nDORES IDENTIFICADAS\n${dores.map((d) => `- ${d}`).join('\n')}` : '') +
          linhaCadencia +
          `\n\nLead completo (scripts por canal, decisores, auditoria):\n${linkDoLead(leadId)}`
        : `ENRIQUECEDOR — enriquecimento concluído, mas o briefing por IA não foi gerado. ` +
          `Veja o que foi coletado: ${linkDoLead(leadId)}`;
      await kommoNote(kommoLeadId, texto);
    }
    return { ok: true };
  } catch (err) {
    console.warn('[esteira] falhou:', String(err?.message || err));
    await setStatus('esteira_erro');
    void logErroToken(token, '/api/esteira', `esteira falhou: ${String(err?.message || err)}`, {
      leadId, kommoLeadId: kommoLeadId ?? null,
    });
    if (kommoLeadId) {
      await kommoNote(kommoLeadId, `ENRIQUECEDOR — o enriquecimento automático falhou (${String(err?.message || err).slice(0, 200)}). Acompanhe/re-rode em: ${linkDoLead(leadId)}`);
    }
    return { ok: false, erro: String(err?.message || err).slice(0, 300) };
  }
}

// Grava erro na tabela enriquecedor_error_log com um token JWT direto.
async function logErroToken(token, etapa, mensagem, detalhe) {
  try {
    if (!AUTH_SUPABASE_URL || !AUTH_SUPABASE_ANON) return;
    console.warn(`[erro] ${etapa}: ${String(mensagem).slice(0, 200)}`);
    await fetch(`${AUTH_SUPABASE_URL}/rest/v1/enriquecedor_error_log`, {
      method: 'POST',
      headers: { ...sbHeaders(token || AUTH_SUPABASE_ANON), prefer: 'return=minimal' },
      body: JSON.stringify({ origem: 'motor', etapa, mensagem: String(mensagem).slice(0, 2000), detalhe: detalhe ?? null }),
    });
  } catch { /* nunca propaga */ }
}

// Grava erro na tabela enriquecedor_error_log (banco do SalesHub) usando o
// token do próprio chamador — fire-and-forget: logar NUNCA quebra o fluxo.
async function logErroMotor(req, etapa, mensagem, detalhe) {
  try {
    if (!AUTH_SUPABASE_URL || !AUTH_SUPABASE_ANON) return; // dev local: só console
    console.warn(`[erro] ${etapa}: ${String(mensagem).slice(0, 200)}`);
    const token =
      String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '') || AUTH_SUPABASE_ANON;
    await fetch(`${AUTH_SUPABASE_URL}/rest/v1/enriquecedor_error_log`, {
      method: 'POST',
      headers: {
        apikey: AUTH_SUPABASE_ANON,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({
        origem: 'motor',
        etapa,
        mensagem: String(mensagem).slice(0, 2000),
        detalhe: detalhe ?? null,
      }),
    });
  } catch {
    /* nunca propaga */
  }
}

// ============================================================================
// WORKER DA FILA (Onda 2) — consome enriquecedor_enrichment_jobs com a chave de
// serviço: concorrência por fase, heartbeat, retry com backoff e recuperação
// de órfãos. O front só enfileira; fechar a aba não interrompe nada.
// ============================================================================
const WORKER_ID = `motor-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
const workerRodando = { f2: 0, f3: 0, f4: 0, all: 0 };
const capacidade = () => ({ f2: 3, f3: 2, f4: proxyConfig() ? 2 : 1, all: 1 });
let _ultimaRecuperacao = 0;

async function resumoJob(leadId, fase) {
  try {
    const row = (await sbSelect(SERVICE_KEY, 'enriquecedor_leads', `id=eq.${leadId}&select=status,site_url,google_business,briefing,anuncios,empreendimentos`))?.[0];
    if (!row) return null;
    if (fase === 'f2') {
      const d = (await sbSelect(SERVICE_KEY, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=id,phone_personal`)) ?? [];
      return { resumo: `${d.length} decisor(es) · ${d.filter((x) => x.phone_personal).length} com telefone` };
    }
    if (fase === 'f3') return { resumo: `site ${row.site_url ? '✓' : '—'} · GMN ${row.google_business?.rating ?? '—'}★ · briefing ${row.briefing ? '✓' : '—'}` };
    if (fase === 'f4') {
      const m = row.anuncios?.meta;
      return { resumo: m ? `Meta ${m.modo === 'pagina' ? '(página)' : '(termo)'}: ${m.validados?.length ?? 0} validados` : `Meta não medida${row.anuncios?.metaFalha?.note ? ` (${row.anuncios.metaFalha.note})` : ''}`, ok: !!m };
    }
    return { resumo: row.status };
  } catch { return null; }
}

async function executarJob(job) {
  const fase = job.fase || 'all';
  workerRodando[fase] = (workerRodando[fase] ?? 0) + 1;
  const t0 = Date.now();
  const hb = setInterval(() => { sbPatch(SERVICE_KEY, 'enriquecedor_enrichment_jobs', `id=eq.${job.id}`, { heartbeat_at: new Date().toISOString() }).catch(() => {}); }, 20_000);
  try {
    const r = await reqCtx.run({ token: SERVICE_KEY, leadId: job.lead_id, fase: fase.toUpperCase() }, () =>
      runEsteira({ leadId: job.lead_id, kommoLeadId: null, token: SERVICE_KEY, fases: fase === 'all' ? null : [fase] }));
    const res = await resumoJob(job.lead_id, fase);
    const ok = r?.ok !== false && res?.ok !== false;
    await sbPatch(SERVICE_KEY, 'enriquecedor_enrichment_jobs', `id=eq.${job.id}`, {
      status: ok ? 'done' : (job.attempts >= 3 ? 'error' : 'pending'),
      run_after: ok ? undefined : new Date(Date.now() + 60_000 * job.attempts).toISOString(),
      finished_at: ok || job.attempts >= 3 ? new Date().toISOString() : null,
      duration_ms: Date.now() - t0,
      result: { ...(res ?? {}), ok },
      error: ok ? null : (r?.erro ?? res?.resumo ?? 'fase sem resultado'),
      locked_at: null, locked_by: null, updated_at: new Date().toISOString(),
    });
    void registrarMetrica({ fonte: `job:${fase}`, ms: Date.now() - t0, ok, leadId: job.lead_id, fase: fase.toUpperCase() });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await sbPatch(SERVICE_KEY, 'enriquecedor_enrichment_jobs', `id=eq.${job.id}`, {
      status: job.attempts >= 3 ? 'error' : 'pending', run_after: new Date(Date.now() + 60_000 * job.attempts).toISOString(),
      error: msg, duration_ms: Date.now() - t0, locked_at: null, locked_by: null, updated_at: new Date().toISOString(),
      finished_at: job.attempts >= 3 ? new Date().toISOString() : null,
    }).catch(() => {});
  } finally {
    clearInterval(hb);
    workerRodando[fase] = Math.max(0, (workerRodando[fase] ?? 1) - 1);
  }
}

// Lead preso em `esteira_fX` (redeploy no meio, processo morto) sem job rodando há
// 30 min: vira `esteira_erro` — a tela mostra o aviso e o botão da fase re-roda.
let _ultimoSweep = 0;
async function sweepEsteirasOrfas() {
  const limite = new Date(Date.now() - 30 * 60_000).toISOString();
  const presos = await sbSelect(SERVICE_KEY, 'enriquecedor_leads', `status=like.esteira_f*&updated_at=lt.${encodeURIComponent(limite)}&select=id&limit=200`);
  if (!presos?.length) return 0;
  const ids = presos.map((l) => l.id);
  const rodando = await sbSelect(SERVICE_KEY, 'enriquecedor_enrichment_jobs', `lead_id=in.(${ids.join(',')})&status=in.(pending,running)&select=lead_id`);
  const ocupados = new Set((rodando ?? []).map((j) => j.lead_id));
  const alvo = ids.filter((id) => !ocupados.has(id));
  if (!alvo.length) return 0;
  await sbPatch(SERVICE_KEY, 'enriquecedor_leads', `id=in.(${alvo.join(',')})`, { status: 'esteira_erro', updated_at: new Date().toISOString() });
  return alvo.length;
}

async function workerTick() {
  if (!SERVICE_KEY) return;
  try {
    if (Date.now() - _ultimaRecuperacao > 60_000) {
      _ultimaRecuperacao = Date.now();
      const n = await sbRpc(SERVICE_KEY, 'enriquecedor_recuperar_jobs_orfaos', { p_minutos: 3 }).catch(() => 0);
      if (n) console.warn(`[worker] ${n} job(s) órfão(s) devolvido(s) à fila`);
    }
    if (Date.now() - _ultimoSweep > 10 * 60_000) {
      _ultimoSweep = Date.now();
      const n = await sweepEsteirasOrfas().catch((e) => { console.warn('[worker] sweep falhou:', String(e?.message || e).slice(0, 160)); return 0; });
      if (n) console.warn(`[worker] ${n} lead(s) preso(s) em esteira_fX marcados como esteira_erro`);
    }
    const cap = capacidade();
    for (const fase of ['f4', 'f3', 'f2', 'all']) {
      const livre = cap[fase] - (workerRodando[fase] ?? 0);
      if (livre <= 0) continue;
      const jobs = await sbRpc(SERVICE_KEY, 'enriquecedor_claim_jobs', { p_worker: WORKER_ID, p_fases: [fase], p_limit: livre }).catch((e) => { console.warn('[worker] claim falhou:', String(e?.message || e).slice(0, 160)); return []; });
      for (const job of jobs ?? []) void executarJob(job);
    }
  } catch (e) {
    console.warn('[worker] tick falhou:', String(e?.message || e).slice(0, 160));
  }
}
if (SERVICE_KEY) {
  setInterval(workerTick, 4000);
  console.log(`[worker] fila de jobs LIGADA (${WORKER_ID})`);
} else {
  console.log('[worker] fila de jobs DESLIGADA — defina SUPABASE_SERVICE_ROLE_KEY no Railway');
}

// Métricas por fonte externa: cada chamada registra duração e sucesso em
// enriquecedor_metricas. Rebind das declarações (bindings de function são mutáveis).
searchOnce = medido('busca_web', searchOnce);
serperPlaces = medido('places', serperPlaces);
fetchCnpj = medido('cnpj', fetchCnpj);
datastoneCompany = medido('datastone_empresa', datastoneCompany);
datastonePessoas = medido('datastone_pessoas', datastonePessoas);
lemitEnrich = medido('lemit', lemitEnrich);
discoverSociosSocial = medido('social_socios', discoverSociosSocial);
discoverSite = medido('site_descoberta', discoverSite);
auditUrl = medido('site_auditoria', auditUrl);
pagespeed = medido('pagespeed', pagespeed);
discoverEmpreendimentos = medido('empreendimentos', discoverEmpreendimentos);
generateBriefing = medido('llm_briefing', generateBriefing);
metaAdSearch = medido('meta_adlib', metaAdSearch);
resolverMetaPageId = medido('meta_page_id', resolverMetaPageId);
googleTransparency = medido('google_transparency', googleTransparency);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Contexto da requisição (token/lead/fase) pra cache e métricas em qualquer profundidade.
  reqCtx.enterWith({ token: String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null, leadId: null, fase: null });
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
    const t0 = Date.now();
    res.once('finish', () => void registrarMetrica({ fonte: `rota:${url.pathname}`, ms: Date.now() - t0, ok: res.statusCode < 500, note: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null }));
  }

  try {
    if (url.pathname !== '/api/health' && !(await isAuthenticated(req))) {
      return send(res, 401, { error: 'não autenticado — faça login no SalesHub' });
    }

    if (url.pathname === '/api/health') {
      // Autodiagnóstico da autenticação: mostra a URL de Supabase configurada
      // (pública por natureza) e se o GoTrue aceita a apikey — sem expor chaves.
      let authProbe = null;
      if (AUTH_REQUIRED) {
        try {
          const pr = await fetch(`${AUTH_SUPABASE_URL}/auth/v1/health`, {
            headers: { apikey: AUTH_SUPABASE_ANON },
          });
          authProbe = { supabaseUrl: AUTH_SUPABASE_URL, gotrueStatus: pr.status };
        } catch (err) {
          authProbe = { supabaseUrl: AUTH_SUPABASE_URL, erro: String(err?.message || err) };
        }
      }
      return send(res, 200, {
        versao: 'onda4c-2026-10-01',
        worker: { ativo: !!SERVICE_KEY, id: WORKER_ID, rodando: workerRodando, capacidade: capacidade() },
        ok: true,
        authRequired: AUTH_REQUIRED,
        authProbe,
        search: searchProvider(),
        searchStatus,
        lemit: !!process.env.LEMIT_API_TOKEN,
        serper: !!process.env.SERPER_API_KEY,
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        datastone: !!process.env.DATASTONE_API_TOKEN,
        proxy: !!process.env.PROXY_SERVER,
      });
    }

    if (url.pathname.startsWith('/api/cnpj/')) {
      const cnpj = url.pathname.split('/').pop();
      const r = await fetchCnpj(cnpj);
      return send(res, 200, r);
    }

    if (url.pathname === '/api/socios-social' && req.method === 'POST') {
      const body = await readJson(req);
      if (searchProvider() === 'none') {
        return send(res, 200, {
          companyInstagram: null,
          companyFacebook: null,
          people: [],
          note: 'busca por API desativada',
        });
      }
      const social = await discoverSociosSocial(body);
      return send(res, 200, social);
    }

    if (url.pathname === '/api/site-audit' && req.method === 'POST') {
      const body = await readJson(req);
      const disc = await discoverSite(body);
      if (!disc.url) {
        return send(res, 200, {
          discoveredUrl: null,
          source: disc.source,
          audit: null,
          searchFailed: disc.searchFailed,
          notes: ['Site não encontrado (sem domínio no e-mail e sem resultado na busca).'],
        });
      }
      try {
        const audit = await auditUrl(disc.url);
        return send(res, 200, {
          discoveredUrl: audit.siteUrl,
          source: disc.source,
          confianca: disc.confianca ?? null,
          sinais: disc.sinais ?? [],
          audit,
          searchFailed: false,
        });
      } catch (err) {
        return send(res, 200, {
          discoveredUrl: disc.url,
          source: disc.source,
          audit: null,
          searchFailed: false,
          notes: [`Site encontrado mas não respondeu: ${String(err?.message || err)}`],
        });
      }
    }

    if (url.pathname === '/api/lemit' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await lemitEnrich(body.cnpj);
      if (r?.ok === false) void logErroMotor(req, '/api/lemit', r.note || 'falha na Lemit', { cnpj: body?.cnpj });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/google-negocio' && req.method === 'POST') {
      const body = await readJson(req);
      const cached = await serperPlacesCached(body.company, body.cidade, body.rejeitados ?? []);
      return send(res, 200, cached ?? { ok: true, found: false });
    }

    if (url.pathname === '/api/empreendimentos' && req.method === 'POST') {
      const body = await readJson(req);
      // Etapa específica do perfil construtoras — perfil versátil não tem
      // "empreendimentos" (o cliente também pula; guarda dupla).
      if (body?.perfil === 'geral') {
        return send(res, 200, { ok: true, empreendimentos: [], note: 'nao_aplicavel_perfil' });
      }
      return send(res, 200, await discoverEmpreendimentos(body));
    }

    if (url.pathname === '/api/pagespeed' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, await pagespeed(body.url));
    }

    if (url.pathname === '/api/datastone' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await datastoneCompany(body.cnpj);
      if (r?.ok === false) void logErroMotor(req, '/api/datastone', r.note || 'falha na DataStone', { cnpj: body?.cnpj });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/datastone-pessoas' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await datastonePessoas(body.cnpj);
      if (r?.ok === false) void logErroMotor(req, '/api/datastone-pessoas', r.note || 'falha na DataStone (pessoas)', { cnpj: body?.cnpj });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/anuncios' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await anunciosHeadless(body);
      if (r?.ok === false) void logErroMotor(req, '/api/anuncios', r.note || 'falha na varredura de anúncios', { company: body?.company });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/audit-lp' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.url) return send(res, 200, { ok: false });
      try {
        return send(res, 200, { ok: true, lpAudit: await buildLpAudit(body.url) });
      } catch {
        return send(res, 200, { ok: false });
      }
    }

    if (url.pathname === '/api/briefing' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await generateBriefing(body);
      if (r?.ok === false) void logErroMotor(req, '/api/briefing', 'briefing falhou após todas as tentativas', { empresa: body?.empresa });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/cadencia/importar-kommo' && req.method === 'POST') {
      const body = await readJson(req);
      const leadIds = Array.isArray(body?.leadIds) ? body.leadIds : [];
      if (!leadIds.length) return send(res, 400, { error: 'leadIds obrigatório (array de ids do enriquecedor)' });
      if (leadIds.length > 200) return send(res, 400, { error: 'máximo de 200 leads por importação' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const quem = await usuarioDoToken(req);
      const responsavelKommoId = body.responsavelKommoId ?? quem?.kommoUserId ?? null;
      const sdrNome = body.sdrNome ?? (quem?.nome ? String(quem.nome).split(/\s+/)[0] : null);
      const r = await importarLeadsKommo({ leadIds, token, responsavelKommoId, sdrNome });
      if (r?.ok === false) void logErroMotor(req, '/api/cadencia/importar-kommo', r.error, { qtd: leadIds.length });
      return send(res, r?.ok === false ? 422 : 200, r);
    }

    // Backfill: preenche CAD * + responsável nos cards já criados dos leads informados.
    if (url.pathname === '/api/cadencia/preencher-cards' && req.method === 'POST') {
      const body = await readJson(req);
      const leadIds = Array.isArray(body?.leadIds) ? body.leadIds : [];
      if (!leadIds.length) return send(res, 400, { error: 'leadIds obrigatório' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const quem = await usuarioDoToken(req);
      const responsavelKommoId = body.responsavelKommoId ?? quem?.kommoUserId ?? null;
      const sdrNome = body.sdrNome ?? (quem?.nome ? String(quem.nome).split(/\s+/)[0] : null);
      const resultados = [];
      for (const leadId of leadIds) {
        const row = (await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=id,razao_social,kommo_lead_id`))?.[0];
        if (!row) { resultados.push({ leadId, erro: 'não encontrado' }); continue; }
        const decs = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&kommo_lead_id=not.is.null&select=id,nome,kommo_lead_id`)) ?? [];
        const cards = decs.length ? decs.map((d) => ({ decisorId: d.id, kommoLeadId: d.kommo_lead_id, nome: d.nome })) : (row.kommo_lead_id ? [{ decisorId: null, kommoLeadId: row.kommo_lead_id, nome: null }] : []);
        for (const c of cards) {
          const r = await preencherCardCadencia({ leadId, decisorId: c.decisorId, kommoLeadId: c.kommoLeadId, token, sdrNome, responsavelKommoId }).catch((e) => ({ ok: false, erro: String(e?.message || e) }));
          resultados.push({ leadId, empresa: row.razao_social, decisor: c.nome, kommo_lead_id: c.kommoLeadId, ...r });
          await sleep(200);
        }
        if (!cards.length) resultados.push({ leadId, empresa: row.razao_social, pulado: 'sem card no Kommo' });
      }
      return send(res, 200, { ok: true, resultados });
    }

    if (url.pathname === '/api/cadencia/preparar' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body?.leadId) return send(res, 400, { error: 'leadId obrigatório' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const r = await prepararCadencia({
        leadId: body.leadId,
        token,
        sdrNome: body.sdrNome ?? null,
        persistir: body.persistir !== false,
        config: body.config ?? null, // prévia com as escolhas do SDR (não grava; quem grava é o front no lead)
        decisorId: body.decisorId ?? null, // destinatário (card do decisor) — {{1}} dele
      });
      if (r?.ok === false) void logErroMotor(req, '/api/cadencia/preparar', r.error, { leadId: body?.leadId });
      return send(res, r?.ok === false ? 422 : 200, r);
    }

    if (url.pathname === '/api/cadencia/email' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body?.leadId) return send(res, 400, { error: 'leadId obrigatório' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const r = await gerarEmailCadencia({
        leadId: body.leadId,
        passo: Number(body.passo) || 1,
        sdrNome: body.sdrNome ?? null,
        sdrCargo: body.sdrCargo ?? null,
        token,
      });
      if (r?.ok === false) void logErroMotor(req, '/api/cadencia/email', r.error, { leadId: body?.leadId, passo: body?.passo });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/cadencia/classificar' && req.method === 'POST') {
      const body = await readJson(req);
      const r = await classificarResposta({ texto: body?.texto });
      if (r?.ok === false) void logErroMotor(req, '/api/cadencia/classificar', r.error, { leadId: body?.leadId });
      return send(res, 200, r);
    }

    // ── Ops Kommo pelo token do MOTOR (31/08: a integração OAuth do SalesHub foi
    // desativada/reativada no painel e TODOS os tokens dela morreram — config, env
    // das edges e refresh. O token daqui é de outra integração e sobreviveu; estas
    // rotas deixam o sistema operar e se curar por ele. Auth: JWT padrão do motor.)

    // Lista os custom fields de lead (nome→id→enums) — p/ preencher cards por API.
    if (url.pathname === '/api/kommo/campos' && req.method === 'POST') {
      const out = [];
      for (let page = 1; page <= 4; page++) {
        const r = await kommoApi('GET', `/api/v4/leads/custom_fields?limit=250&page=${page}`);
        const items = r.body?._embedded?.custom_fields ?? [];
        for (const f of items) out.push({ id: f.id, name: f.name, type: f.type, enums: f.enums ?? undefined });
        if (items.length < 250) break;
      }
      return send(res, 200, { ok: true, campos: out });
    }

    // Completa UM card: renomeia, tags, custom fields e nota (paths fixos da v4).
    if (url.pathname === '/api/kommo/card-prep' && req.method === 'POST') {
      const body = await readJson(req);
      const kommoLeadId = Number(body?.kommoLeadId);
      if (!kommoLeadId) return send(res, 400, { error: 'kommoLeadId obrigatório' });
      const resultado = {};
      const patch = {};
      if (body.nome) patch.name = String(body.nome).slice(0, 250);
      if (Array.isArray(body.tags) && body.tags.length) {
        patch._embedded = { tags: body.tags.map((t) => ({ name: String(t).slice(0, 60) })) };
      }
      if (Array.isArray(body.campos) && body.campos.length) {
        patch.custom_fields_values = body.campos.map((c) => ({
          field_id: Number(c.field_id),
          values: [c.enum_id != null ? { enum_id: Number(c.enum_id) } : { value: c.value }],
        }));
      }
      if (Object.keys(patch).length) {
        const r = await kommoApi('PATCH', `/api/v4/leads/${kommoLeadId}`, patch);
        resultado.patch = { ok: r.ok, status: r.status, detalhe: r.ok ? undefined : r.body };
      }
      if (body.nota) resultado.nota = { ok: await kommoNote(kommoLeadId, String(body.nota).slice(0, 15000)) };
      return send(res, 200, { ok: true, resultado });
    }

    // Autocura: valida o próprio token na Kommo e grava no integracao_config
    // (kommo_access_token) — o token NUNCA sai daqui; a resposta só traz statuses.
    // Com o config são o kommo-sync, a criação de lead via SQL e o front voltam.
    if (url.pathname === '/api/kommo/token-heal' && req.method === 'POST') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const chk = await kommoApi('GET', '/api/v4/account');
      if (!chk.ok) return send(res, 502, { ok: false, account_check: chk.status });
      try {
        await sbUpsert(token, 'integracao_config', [{ key: 'kommo_access_token', value: process.env.KOMMO_API_TOKEN }], 'key');
      } catch (err) {
        return send(res, 500, { ok: false, account_check: chk.status, erro_gravacao: String(err?.message || err).slice(0, 200) });
      }
      return send(res, 200, { ok: true, account_check: chk.status, gravado: true });
    }

    // F4 por identidade: resolve página da Meta (pelo Facebook) e anunciante no
    // Google Transparency (pelo domínio) → viram chaves de busca do lead.
    if (url.pathname === '/api/anunciantes/resolver' && req.method === 'POST') {
      const body = await readJson(req);
      const [meta, google] = await Promise.all([
        body?.fbUrl ? resolverMetaPageId(body.fbUrl, { marca: body.marca ?? body.company ?? null }).catch((e) => ({ ok: false, pageId: null, note: String(e?.message || e).slice(0, 120) })) : Promise.resolve(null),
        body?.siteDomain ? googleTransparency({ domain: body.siteDomain }).catch((e) => ({ ok: false, note: String(e?.message || e).slice(0, 120) })) : Promise.resolve(null),
      ]);
      return send(res, 200, { ok: true, meta, google });
    }

    // Anúncios no Google Ads Transparency Center (por anunciante AR… ou por domínio).
    if (url.pathname === '/api/anuncios-google' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body?.advertiserId && !body?.domain) return send(res, 400, { error: 'advertiserId ou domain obrigatório' });
      const r = await googleTransparency({ advertiserId: body.advertiserId ?? null, domain: body.domain ?? null });
      if (r?.ok === false) void logErroMotor(req, '/api/anuncios-google', r.note || 'falha no Transparency Center', { advertiserId: body?.advertiserId, domain: body?.domain });
      return send(res, 200, r);
    }

    if (url.pathname === '/api/esteira' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body?.leadId) return send(res, 400, { error: 'leadId obrigatório' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const fases = Array.isArray(body.fases) && body.fases.length ? body.fases : null;
      // Com o worker ligado, a esteira vira JOB na fila: não duplica (índice único por
      // lead×fase pendente), sobrevive a redeploy e respeita a concorrência por fase.
      // O card do Kommo (nota ao final) só é conhecido no disparo direto — por isso a
      // esteira completa disparada pelo Kommo (com kommoLeadId) continua direta.
      if (SERVICE_KEY && !body.kommoLeadId) {
        const fase = fases && fases.length === 1 ? fases[0] : 'all';
        try {
          const existentes = await sbSelect(SERVICE_KEY, 'enriquecedor_enrichment_jobs', `lead_id=eq.${body.leadId}&fase=eq.${fase}&status=in.(pending,running)&select=id`);
          if (!existentes?.length) {
            await sbUpsert(SERVICE_KEY, 'enriquecedor_enrichment_jobs', [{ lead_id: body.leadId, type: 'fase', fase, status: 'pending', priority: 5, requested_by: 'api/esteira' }]);
          }
          return send(res, 202, { ok: true, viaFila: true, duplicado: !!existentes?.length, link: linkDoLead(body.leadId) });
        } catch (e) {
          console.warn('[esteira] não deu pra enfileirar, roda direto:', String(e?.message || e).slice(0, 160));
        }
      }
      // 202 na hora; a esteira roda em background e escreve o progresso no lead.
      void runEsteira({ leadId: body.leadId, kommoLeadId: body.kommoLeadId ?? null, token, fases });
      return send(res, 202, { ok: true, link: linkDoLead(body.leadId) });
    }

    return send(res, 404, { error: 'rota não encontrada' });
  } catch (err) {
    void logErroMotor(req, url.pathname, err?.message || err, { stack: String(err?.stack || '').slice(0, 800) });
    return send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  const prov = searchProvider();
  console.log(`[enrich] backend de enriquecimento em http://localhost:${PORT}`);
  console.log(
    prov === 'none'
      ? '[enrich] busca por API: DESLIGADA (defina BRAVE_API_KEY no .env.local para ligar)'
      : `[enrich] busca por API: ${prov.toUpperCase()} ativa`,
  );
});
