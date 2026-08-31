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
    const res = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=br`,
      { headers: { 'x-subscription-token': brave, accept: 'application/json' } },
      12000,
    );
    if (res.status === 429) throw { status: 429 };
    if (res.status === 402 || res.status === 403) {
      searchStatus = 'quota'; // cota/crédito da chave esgotado
      return { results: [], ok: false };
    }
    if (!res.ok) return { results: [], ok: false };
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
  return searchLimiter.schedule(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await searchOnce(query);
      } catch (e) {
        if (e && e.status === 429 && attempt < 2) {
          await sleep(1500 * (attempt + 1)); // backoff no rate limit
          continue;
        }
        return { results: [], ok: false }; // 429 persistente = falha transitória
      }
    }
    return { results: [], ok: false };
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
async function findCompanySocial(company, network) {
  const { results, ok } = await rawSearch(`${company} ${network}`);
  const domainRe = network === 'instagram' ? /instagram\.com\//i : /facebook\.com\//i;
  const badPath =
    network === 'instagram'
      ? /instagram\.com\/(p|reel|reels|explore|stories)\//i
      : /facebook\.com\/(sharer|login|events|photo|groups|watch|people)/i;
  const hit = results.find(
    (r) => domainRe.test(r.url) && !badPath.test(r.url) && resultMatchesCompany(r, company),
  );
  return { url: hit ? stripQuery(hit.url) : null, ok };
}

async function findPersonLinkedin(name, company) {
  const { results, ok } = await rawSearch(`${name} ${company ?? ''} linkedin`);
  // Só perfil PESSOAL (/in/ ou /pub/), nunca página de empresa.
  const hit = results.find(
    (r) => /linkedin\.com\/(in|pub)\//i.test(r.url) && resultMatchesPerson(r, name),
  );
  return { url: hit ? stripQuery(hit.url) : null, ok };
}

// O @ (handle) do perfil contém o sobrenome da pessoa? Sinal forte e preciso.
function handleHasSurname(url, name) {
  const toks = personTokens(name);
  if (toks.length < 2) return false;
  const surname = toks[toks.length - 1];
  if (surname.length < 4) return false;
  try {
    const handle = new URL(url).pathname.toLowerCase().replace(/[^a-z0-9]/g, '');
    return handle.includes(surname);
  } catch {
    return false;
  }
}

async function findPersonInstagram(name) {
  const { results, ok } = await rawSearch(`${name} instagram`);
  // Aceita se o título bate (nome+sobrenome) OU o @ contém o sobrenome.
  const hit = results.find(
    (r) =>
      /instagram\.com\//i.test(r.url) &&
      !/instagram\.com\/(p|reel|reels|explore|stories)\//i.test(r.url) &&
      (resultMatchesPerson(r, name) || handleHasSurname(r.url, name)),
  );
  return { url: hit ? stripQuery(hit.url) : null, ok };
}

// Descoberta social completa: institucional (empresa) + por sócio-pessoa.
// searchFailed=true se QUALQUER busca falhou (para reprocessar depois).
async function discoverSociosSocial({ company, socios }) {
  let anyFail = false;
  const mark = (r) => {
    if (!r.ok) anyFail = true;
    return r.url;
  };

  const companyInstagram = company ? mark(await findCompanySocial(company, 'instagram')) : null;
  const companyFacebook = company ? mark(await findCompanySocial(company, 'facebook')) : null;

  // Todos os sócios-pessoas do contrato social (assertividade > economia).
  const pessoas = (socios ?? []).filter(isPersonName);
  const people = [];
  for (const nome of pessoas) {
    const linkedin = mark(await findPersonLinkedin(nome, company));
    const instagram = mark(await findPersonInstagram(nome));
    people.push({ nome, linkedin, instagram });
  }
  return { companyInstagram, companyFacebook, people, searchFailed: anyFail };
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
async function serperPlacesCached(company, cidade) {
  const k = `${String(company ?? '').toLowerCase()}|${String(cidade ?? '').toLowerCase()}`;
  if (_placesCache.has(k)) return _placesCache.get(k);
  const r = await serperPlaces(company, cidade).catch(() => ({ ok: false, found: false }));
  const val = r && r.found ? r : null;
  _placesCache.set(k, val);
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

// Descobre o SITE INSTITUCIONAL investigando de verdade (não confia na planilha):
// cruza Google Meu Negócio + e-mail corporativo + planilha + busca web (nome
// fantasia) e valida qual candidato realmente RESPONDE. Ordem de confiança:
// GMN > e-mail corporativo > planilha > busca. A planilha vira só um palpite.
async function discoverSite({ siteUrl, emailDomain, companyName, nomeFantasia, cidade }) {
  const nome = nomeFantasia || companyName;
  const candidatos = []; // {url, source}
  const push = (url, source) => url && candidatos.push({ url, source });

  // 1) Google Meu Negócio — site do perfil (fonte forte do site real)
  try {
    const gmn = await serperPlacesCached(nome, cidade);
    if (gmn && gmn.website) push(gmn.website, 'gmn');
  } catch { /* segue */ }
  // 2) site da planilha (palpite — precisa validar)
  if (siteUrl) push(siteUrl, 'planilha');
  // 3) domínio do e-mail corporativo
  if (emailDomain && !FREEMAIL.has(emailDomain.toLowerCase()) && emailDomain.includes('.')) push(emailDomain.toLowerCase(), 'email');
  // 4) busca web — só domínios que casam com o nome da empresa
  let buscaFalhou = false;
  if (nome) {
    const { urls, ok } = await searchSite(`${nome} ${cidade ?? ''} site oficial`.trim());
    buscaFalhou = !ok;
    for (const u of urls) {
      if (domainMatchesName(u, nome) || (companyName && domainMatchesName(u, companyName))) push(u, 'busca');
    }
  }

  // Valida na ordem de confiança: devolve o primeiro que RESPONDE de fato.
  const ordem = { gmn: 4, email: 3, planilha: 2, busca: 1 };
  candidatos.sort((a, b) => (ordem[b.source] || 0) - (ordem[a.source] || 0));
  const vistos = new Set();
  for (const c of candidatos) {
    const dom = String(c.url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    if (vistos.has(dom)) continue;
    vistos.add(dom);
    const url = await primeiraQueResponde(c.url);
    if (url) return { url, source: c.source, searchFailed: false };
  }
  // Nenhum candidato respondeu: melhor "não encontrado" do que atribuir site morto.
  return { url: null, source: 'nao_encontrado', searchFailed: buscaFalhou };
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
async function serperPlaces(company, cidade) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { ok: true, found: false, note: 'serper_desativado' };
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
    const p = (j.places ?? [])[0];
    if (!p) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
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
    try {
      const res = await fetchWithTimeout(siteUrl, {}, 12000);
      context += 'SITE:\n' + stripHtml(await res.text()) + '\n\n';
    } catch {
      /* segue sem o site */
    }
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
        return await chromium.launch({ headless: true });
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
const META_COOLDOWN_MS = Number(process.env.META_COOLDOWN_MS || 90 * 1000); // pausa curta após bloqueio (Ad Library é pública; bloqueio é transitório)
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
async function metaAdSearch(term, useProxy = null, force = false) {
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
      const url =
        `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR` +
        `&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      // Aguarda os resultados, tolerando renavegação do Meta (IP novo do proxy
      // costuma fazer a página redirecionar → "execution context destroyed").
      let loaded = false;
      const deadline = Date.now() + 16000; // ~16s no máximo pra aparecer resultado
      while (!loaded && Date.now() < deadline) {
        await page.waitForTimeout(900);
        try {
          loaded = await page.evaluate(() =>
            /\d\s*resultado|Identifica[çc][ãa]o da biblioteca|nenhum resultado/i.test(document.body.innerText),
          );
        } catch {
          /* renavegação (IP novo redireciona) — tenta de novo no próximo ciclo */
        }
      }
      if (!loaded) {
        // Não carregou (bloqueio transitório OU carga lenta). Sem proxy: cooldown
        // CURTO (90s) — não punir o IP por um termo lento. Com proxy: ignora o IP.
        if (!usingProxy) _metaCooldownUntil = Date.now() + META_COOLDOWN_MS;
        return { ok: true, cards: [], total: null, note: 'meta_bloqueado' };
      }
      // Carregou pelo IP direto → o IP está saudável: zera qualquer cooldown.
      if (!usingProxy) _metaCooldownUntil = 0;
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, 4000).catch(() => {});
        await page.waitForTimeout(900);
      }
      const data = await page.evaluate(() => {
        const bodyTxt = document.body.innerText.slice(0, 3000);
        const tm = bodyTxt.match(/~?\s*([\d.]+)\s*resultado/i);
        const total = tm ? parseInt(tm[1].replace(/\./g, ''), 10) : null;
        const cards = [];
        const seen = new Set();
        const idNodes = [...document.querySelectorAll('div')].filter(
          (d) => /Identifica[çc][ãa]o da biblioteca/i.test(d.textContent || '') && (d.innerText || '').length < 2500,
        );
        for (const idNode of idNodes) {
          let el = idNode;
          for (let k = 0; k < 8 && el.parentElement; k++) {
            if (/Patrocinad/i.test(el.innerText || '')) break;
            el = el.parentElement;
          }
          const text = (el.innerText || '').replace(/\s+/g, ' ');
          const idm = text.match(/Identifica[çc][ãa]o da biblioteca:\s*(\d+)/i);
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
  const { company, fbHandle, siteDomain, cidade, empreendimentos } = payload || {};
  if (!company) return { ok: false, note: 'sem_termo_busca', meta: null };

  // Estratégia de IP: por padrão usa o IP DIRETO (rápido e, fora de rajada, não
  // bloqueia). Se o direto estiver em cooldown, tenta o PROXY — mas só se tiver
  // tráfego. Se o proxy também não der, FORÇA o direto (melhor tentar que falhar).
  const diretoEmCooldown = Date.now() < _metaCooldownUntil;
  let useProxy = false;
  let forceDireto = false;
  let avisoProxy = null;
  if (diretoEmCooldown) {
    if (proxyConfig()) {
      const pc = await checkProxy();
      if (pc.ok) useProxy = true;
      else {
        avisoProxy = pc.reason === 'sem_trafego' ? 'proxy_sem_trafego' : pc.reason === 'auth' ? 'proxy_auth' : 'proxy_conexao';
        forceDireto = true; // proxy indisponível → tenta o direto mesmo em cooldown
      }
    } else {
      forceDireto = true; // sem proxy configurado → tenta o direto de qualquer forma
    }
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

  // Termos de busca: a EMPRESA + o NOME de cada empreendimento (lançamentos e
  // obras). Assim achamos anúncios que rodam no nome do empreendimento, não só
  // no da construtora. Cada termo é uma consulta ao Meta (cadência anti-ban).
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
    return { ok: true, note, meta: null };
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

async function datastoneCompany(cnpj) {
  const token = process.env.DATASTONE_API_TOKEN;
  if (!token) return { ok: true, data: null, note: 'datastone_desativado' };
  const digits = onlyDigits(cnpj);
  if (digits.length !== 14) return { ok: false, data: null };
  try {
    const res = await fetchWithTimeout(
      `https://api.datastone.com.br/v1/companies/?cnpj=${digits}`,
      { headers: { Authorization: `Token ${token}`, accept: 'application/json' } },
      15000,
    );
    if (res.status === 401 || res.status === 403) return { ok: false, data: null, note: 'datastone_auth' };
    if (res.status === 429) return { ok: false, data: null }; // limite transitório — reprocessa depois
    if (!res.ok) {
      // Sem créditos = condição PERMANENTE: degrada sem travar nem reprocessar.
      const body = await res.text().catch(() => '');
      if (/insufficient_credits|cr[eé]dito/i.test(body)) return { ok: true, data: null, note: 'datastone_sem_creditos' };
      return { ok: false, data: null };
    }
    const j = await res.json();
    const d = Array.isArray(j) ? j[0] : j.results ? j.results[0] : j;
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
  let comp;
  try {
    const res = await fetchWithTimeout(
      `${DATASTONE_BASE}/companies/?cnpj=${digits}`,
      { headers: { Authorization: `Token ${token}`, accept: 'application/json' } },
      15000,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Sem créditos = permanente: degrada (Lemit assume) sem travar/reprocessar.
      if (/insufficient_credits|cr[eé]dito/i.test(body)) return { ok: true, people: [], note: 'datastone_sem_creditos' };
      return { ok: false, people: [] };
    }
    const j = await res.json();
    comp = Array.isArray(j) ? j[0] : j.results ? j.results[0] : j;
  } catch {
    return { ok: false, people: [] };
  }
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
function sbHeaders(token) {
  return {
    apikey: AUTH_SUPABASE_ANON,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
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
    empreendimentos: (row.empreendimentos ?? []).map((e) => ({ nome: e.nome, cidade: e.cidade, status: e.status })),
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
async function importarLeadsKommo({ leadIds, token }) {
  const funil = await funilCadencia();
  if (!funil || !funil.etapas['Fila']) return { ok: false, error: `funil "${FUNIL_CADENCIA_NOME}" não encontrado no Kommo` };
  const sub = process.env.KOMMO_SUBDOMAIN;
  const resultados = [];
  let criados = 0;

  for (const leadId of leadIds ?? []) {
    try {
      const row = (await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=*`))?.[0];
      if (!row) { resultados.push({ leadId, pulado: 'não encontrado' }); continue; }
      if (row.kommo_lead_id) { resultados.push({ leadId, empresa: row.razao_social, pulado: `já no Kommo (${row.kommo_lead_id})` }); continue; }

      const decisores = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=nome,is_primary,phone_whatsapp,phone_personal`)) ?? [];
      const { fone, dono } = foneParaKommo(row, decisores);
      const nomeCard = row.nome_fantasia || marcaDe(row.razao_social || row.company_name_raw || '') || row.company_name_raw;
      const nomeContato = dono || decisores.find((d) => d.is_primary)?.nome || decisores[0]?.nome || nomeCard;

      const contato = { name: String(nomeContato).slice(0, 250) };
      if (fone) contato.custom_fields_values = [{ field_code: 'PHONE', values: [{ value: fone, enum_code: 'WORK' }] }];

      const rc = await kommoApi('POST', '/api/v4/leads/complex', [{
        name: String(nomeCard).slice(0, 250),
        pipeline_id: funil.id,
        status_id: funil.etapas['Fila'],
        _embedded: { contacts: [contato] },
      }]);
      const kommoId = rc.body?.[0]?.id ?? rc.body?._embedded?.leads?.[0]?.id ?? null;
      if (!rc.ok || !kommoId) {
        resultados.push({ leadId, empresa: row.razao_social, erro: `Kommo HTTP ${rc.status}: ${JSON.stringify(rc.body).slice(0, 150)}` });
        continue;
      }

      await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { kommo_lead_id: String(kommoId), updated_at: new Date().toISOString() });
      await kommoNote(kommoId, `ENRIQUECEDOR — lead importado pra cadência outbound (etapa Fila).\nMova pra "Passo 1 enviado" pra disparar a mensagem 1.\nLead completo: ${linkDoLead(leadId)}`);

      // Espelho no controle de leads do SalesHub (canal outbound) — 1 por CNPJ.
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

      criados += 1;
      resultados.push({ leadId, empresa: nomeCard, kommo_lead_id: String(kommoId), fone: fone ?? 'SEM TELEFONE — completar no card' });
      await sleep(250); // folga de rate na Kommo
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
async function prepararCadencia({ leadId, token, sdrNome, persistir = true }) {
  const rows = await sbSelect(token, 'enriquecedor_leads', `id=eq.${leadId}&select=*`);
  const row = rows?.[0];
  if (!row) return { ok: false, error: 'lead não encontrado' };
  const audit = (await sbSelect(token, 'enriquecedor_site_audits', `lead_id=eq.${leadId}&select=*`))?.[0] ?? null;
  const catalogo = (await sbSelect(token, 'enriquecedor_cadencia_falhas', 'ativo=eq.true&select=*&order=prioridade')) ?? [];
  const templates = (await sbSelect(token, 'enriquecedor_cadencia_templates', 'canal=eq.whatsapp&ativo=eq.true&select=*')) ?? [];

  const falhas = detectarFalhas(row, audit);
  const primaria = falhas[0] ?? null;
  const secundaria = falhas[1] ?? null;
  const apto = !!primaria && !row.optout;

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
      motivo: row.optout
        ? 'lead pediu pra não receber (optout)'
        : 'nenhuma falha verificável medida — rode F2/F3/F4 antes; mensagem sem falha concreta é spam',
    };
  }

  const avisos = [];
  const tpl = (nome) => templates.find((t) => t.nome === nome) ?? null;
  // Rotação 50/50 determinística por lead (não depende de estado externo).
  const rot = [...String(leadId)].reduce((a, c) => a + c.charCodeAt(0), 0) % 2;

  const decisores = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=nome,cargo`)) ?? [];
  let nome1 = primeiroNome(nomeDecisor(row, decisores));
  if (!nome1) { nome1 = 'tudo bem?'; avisos.push('decisor não identificado — {{1}} caiu no genérico "tudo bem?"'); }
  nome1 = cortaPalavra(nome1, 20);
  let sdr = cortaPalavra(String(sdrNome || '').trim(), 20);
  if (!sdr) { sdr = '[SDR]'; avisos.push('sdrNome não informado — preencha {{2}} antes do disparo'); }
  const fantasia = cortaPalavra(row.nome_fantasia || marcaDe(row.razao_social || row.company_name_raw || ''), 40);

  const fr1 = frasesDaFalha(primaria, catalogo);
  if (!fr1) return { ok: false, error: `falha '${primaria.codigo}' sem registro no catálogo` };
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

  const p1 = msg(tpl(rot === 0 ? 'sdna_p1_auditoria_v1' : 'sdna_p1_auditoria_v2'), [nome1, sdr, fantasia, v4, v5]);
  const fr2 = secundaria ? frasesDaFalha(secundaria, catalogo) : null;
  const p2 = fr2
    ? msg(tpl('sdna_p2_segunda_falha_v1'), [nome1, fantasia, fr2.rotulo])
    : msg(tpl('sdna_p2_aprofunda_v1'), [nome1, fantasia]);
  const p3 = msg(tpl(rot === 0 ? 'sdna_p3_breakup_v1' : 'sdna_p3_breakup_v2'), [nome1, fantasia]);

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

async function runEsteira({ leadId, kommoLeadId, token }) {
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
    await setStatus('esteira_f2');
    const [ds, pessoas, lemit] = await Promise.all([
      datastoneCompany(digits).catch(() => null),
      datastonePessoas(digits).catch(() => null),
      lemitEnrich(digits).catch(() => null),
    ]);
    const patch2 = {};
    if (ds?.ok && ds.data) {
      patch2.datastone = ds.data;
      if (ds.data.organograma) patch2.organograma = ds.data.organograma;
    }
    if (lemit?.ok && lemit.company) patch2.lemit_company = lemit.company;
    let social = null;
    try {
      social = await discoverSociosSocial({
        company: row.razao_social ?? row.company_name_raw,
        socios: (row.socios ?? []).map((s) => s.nome).filter(Boolean),
      });
    } catch { /* busca indisponível */ }
    if (social?.companyInstagram) patch2.company_instagram = social.companyInstagram;
    if (social?.companyFacebook) patch2.company_facebook = social.companyFacebook;
    if (Object.keys(patch2).length) {
      await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, patch2);
      Object.assign(row, patch2);
    }
    if (pessoas?.ok && (pessoas.people ?? []).length) {
      await sbDelete(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}`);
      const rowsDm = pessoas.people.slice(0, 12).map((p, i) => {
        const cel = (p.phones ?? []).find((x) => x.whatsapp) ?? (p.phones ?? [])[0] ?? null;
        return {
          lead_id: leadId,
          nome: p.nome,
          cargo: null,
          is_primary: i === 0,
          cpf: p.cpf ?? null,
          phone_personal: cel?.numero ?? null,
          phone_whatsapp: !!cel?.whatsapp,
          email_personal: (p.emails ?? [])[0] ?? null,
          confidence: 70,
          source: 'datastone',
        };
      });
      await sbUpsert(token, 'enriquecedor_decision_makers', rowsDm);
    }

    // ── F3 · Diagnóstico digital (site, GMN, empreendimentos, briefing) ─────
    await setStatus('esteira_f3');
    let audit = null;
    try {
      const disc = await discoverSite({
        companyName: row.razao_social ?? row.company_name_raw,
        nomeFantasia: row.nome_fantasia,
        emailDomain: row.email_raw?.includes('@') ? row.email_raw.split('@')[1] : null,
        cidade: row.cidade,
        siteUrl: row.site_url,
      });
      if (disc?.url) {
        audit = await auditUrl(disc.url).catch(() => null);
        if (audit) {
          try { audit.pagespeed = await pagespeed(audit.siteUrl); } catch { /* sem nota */ }
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
          await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { site_url: audit.siteUrl });
          row.site_url = audit.siteUrl;
        }
      }
    } catch { /* site não encontrado */ }
    try {
      const gb = await serperPlacesCached(row.razao_social ?? row.company_name_raw, row.cidade);
      if (gb) {
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { google_business: gb });
        row.google_business = gb;
      }
    } catch { /* GMN indisponível */ }
    if ((row.perfil ?? 'construtoras') !== 'geral') {
      try {
        const emp = await discoverEmpreendimentos({
          company: row.razao_social ?? row.company_name_raw,
          nomeFantasia: row.nome_fantasia,
          cidade: row.cidade,
          siteUrl: row.site_url,
        });
        if (emp?.ok && (emp.empreendimentos ?? []).length) {
          await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { empreendimentos: emp.empreendimentos });
          row.empreendimentos = emp.empreendimentos;
        }
      } catch { /* sem empreendimentos */ }
    }
    const decisores = (await sbSelect(token, 'enriquecedor_decision_makers', `lead_id=eq.${leadId}&select=nome,cargo`)) ?? [];
    let briefing = null;
    const b1 = await generateBriefing(payloadBriefing(row, audit, decisores, null));
    if (b1?.ok && b1.briefing) {
      briefing = { ...b1.briefing, model: b1.model ?? null, generatedAt: new Date().toISOString() };
      await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { briefing });
    }

    // ── F4 · Anúncios (Meta headless) + briefing ATUALIZADO com a mídia ─────
    await setStatus('esteira_f4');
    let anunciosMeta = null;
    try {
      const hostDe = (u) => { try { return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, ''); } catch { return null; } };
      const an = await anunciosHeadless({
        company: marcaDe(row.nome_fantasia ?? row.razao_social ?? row.company_name_raw),
        fbHandle: row.company_facebook ? (row.company_facebook.match(/facebook\.com\/([^/?#]+)/i)?.[1] ?? null) : null,
        siteDomain: row.site_url ? hostDe(row.site_url) : null,
        cidade: row.cidade,
        empreendimentos: (row.empreendimentos ?? [])
          .filter((e) => e.status === 'lancamento' || e.status === 'em_obra')
          .map((e) => ({ nome: e.nome, domain: e.lp ? hostDe(e.lp) : null })),
      });
      if (an?.meta) {
        anunciosMeta = an.meta;
        await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, {
          anuncios: { meta: an.meta, checkedAt: new Date().toISOString() },
        });
        // Fases seguintes ATUALIZAM o discurso: re-gera o briefing com a mídia.
        const b2 = await generateBriefing(payloadBriefing(row, audit, decisores, an.meta));
        if (b2?.ok && b2.briefing) {
          briefing = { ...b2.briefing, model: b2.model ?? null, generatedAt: new Date().toISOString() };
          await sbPatch(token, 'enriquecedor_leads', `id=eq.${leadId}`, { briefing });
        }
      }
    } catch (err) {
      console.warn('[esteira] anúncios falharam:', String(err?.message || err).slice(0, 150));
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
  } catch (err) {
    console.warn('[esteira] falhou:', String(err?.message || err));
    await setStatus('esteira_erro');
    void logErroToken(token, '/api/esteira', `esteira falhou: ${String(err?.message || err)}`, {
      leadId, kommoLeadId: kommoLeadId ?? null,
    });
    if (kommoLeadId) {
      await kommoNote(kommoLeadId, `ENRIQUECEDOR — o enriquecimento automático falhou (${String(err?.message || err).slice(0, 200)}). Acompanhe/re-rode em: ${linkDoLead(leadId)}`);
    }
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);

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
      const cached = await serperPlacesCached(body.company, body.cidade);
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
      const r = await importarLeadsKommo({ leadIds, token });
      if (r?.ok === false) void logErroMotor(req, '/api/cadencia/importar-kommo', r.error, { qtd: leadIds.length });
      return send(res, r?.ok === false ? 422 : 200, r);
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

    if (url.pathname === '/api/esteira' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body?.leadId) return send(res, 400, { error: 'leadId obrigatório' });
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      // 202 na hora; a esteira roda em background e escreve o progresso no lead.
      void runEsteira({ leadId: body.leadId, kommoLeadId: body.kommoLeadId ?? null, token });
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
