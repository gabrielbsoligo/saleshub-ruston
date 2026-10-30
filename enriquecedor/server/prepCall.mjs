// ============================================================================
// Prep Call no motor do Enriquecedor (substitui GitHub Actions + Claude Routine).
//
// O briefing pré-call continua com o MESMO modelo de resposta e a MESMA análise
// do prompt v3 (markdown do closer + "## BRIEFING JSON" schema v1 da página de
// apresentação). O que muda é a COLETA: ela usa as ferramentas do Enriquecedor
// (auditoria do site com navegador, PageSpeed, Google Meu Negócio, Instagram,
// Biblioteca de Anúncios com proxy, Google Transparency) e captura imagens
// (tela do site, do perfil e dos criativos) que entram na página do briefing.
//
// Este módulo é PURO: tudo que toca rede/banco chega por `deps` (index.mjs),
// para os testes rodarem sem segredo nem internet (prepCall.test.mjs).
// ============================================================================

export const PREP_PROMPT_VERSAO = 'v3-enriquecedor-1';

// Prazos por etapa (ms). A soma fica abaixo do prazo da tentativa no banco
// (prep_call_disparar: 15 min), que é quem decide o "estourou".
export const PRAZOS_PADRAO = {
  site: 90_000,
  pagespeed: 60_000,
  gmn: 30_000,
  instagram: 60_000,
  meta: 150_000,
  google: 90_000,
  visual: 45_000,
  coleta: 360_000,
  ia: 480_000,
};

export function comPrazo(promessa, ms, etapa) {
  let t;
  const estouro = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`prazo de ${Math.round(ms / 1000)}s estourado em ${etapa}`)), ms);
  });
  return Promise.race([Promise.resolve(promessa), estouro]).finally(() => clearTimeout(t));
}

export function normalizarUrl(u) {
  const s = String(u ?? '').trim();
  if (!s) return null;
  const comEsquema = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { return new URL(comEsquema).toString(); } catch { return null; }
}

export function dominioDe(u) {
  const n = normalizarUrl(u);
  if (!n) return null;
  try { return new URL(n).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

// '@handle', 'handle' ou URL do perfil → handle (sem @). Nunca post/reel.
export function handleInstagram(s) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  const m = v.match(/instagram\.com\/([^/?#]+)/i);
  const h = (m ? m[1] : v.replace(/^@/, '')).trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(h) || ['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts'].includes(h)) return null;
  return h;
}

// "12,3 mil" / "1.234" / "12.3K" / "1M" → número.
export function numeroSocial(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/^([\d.,]+)\s*(k|m|mil|mi|milhões|milhão)?$/);
  if (!m) return null;
  let base = m[1];
  const mult = m[2] === 'k' || m[2] === 'mil' ? 1e3 : m[2] ? 1e6 : 1;
  if (mult > 1) base = base.replace(',', '.');
  else base = base.replace(/[.,](?=\d{3}\b)/g, '');
  const n = Number(base.replace(/,/g, '.'));
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

// Contagens do perfil a partir da meta og:description pública do Instagram
// ("1.234 Followers, 56 Following, 78 Posts - …" ou "1.234 seguidores, …").
export function contagensInstagram(html) {
  const h = String(html ?? '');
  const meta = h.match(/<meta[^>]+(?:property|name)=["'](?:og:)?description["'][^>]*content=["']([^"']+)["']/i)?.[1]
    ?? h.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:)?description["']/i)?.[1]
    ?? '';
  const txt = meta.replace(/&#x2c;|&#44;/gi, ',').replace(/&amp;/g, '&');
  const pega = (re) => { const m = txt.match(re); return m ? numeroSocial(m[1]) : null; };
  const seguidores = pega(/([\d.,]+\s*(?:k|m|mil|mi)?)\s*(?:followers|seguidores)/i);
  const seguindo = pega(/([\d.,]+\s*(?:k|m|mil|mi)?)\s*(?:following|seguindo)/i);
  const posts = pega(/([\d.,]+\s*(?:k|m|mil|mi)?)\s*(?:posts|publica[çc][õo]es)/i);
  const bio = txt.includes(' on Instagram: "') ? txt.split(' on Instagram: "')[1]?.replace(/"$/, '') ?? null
    : txt.includes(' no Instagram: "') ? txt.split(' no Instagram: "')[1]?.replace(/"$/, '') ?? null : null;
  return { seguidores, seguindo, posts, bio: bio ? bio.slice(0, 300) : null };
}

const erroMsg = (e) => String(e?.message || e || 'erro').slice(0, 200);

// ---------------------------------------------------------------------------
// COLETA — devolve o scraped_data (fonte 'enriquecedor') que o prompt lê.
// Cada etapa é independente: falha vira item em `errors` (alerta do closer),
// nunca derruba o briefing. Só um erro de infraestrutura (deps lança
// ErroCritico) atravessa.
// ---------------------------------------------------------------------------
export class ErroCritico extends Error {}

export async function coletar(entrada, deps, { prazos = PRAZOS_PADRAO, aoMudarEtapa = async () => {} } = {}) {
  const agora = () => (deps.agora ? deps.agora() : new Date()).toISOString();
  const inputs = entrada.inputs ?? {};
  const empresa = String(entrada.empresa ?? '').trim();
  const cidade = entrada.cidade ?? null;
  const errors = [];
  const visuais = { site: null, instagram: null, google_ads: null, meta_ads: [] };
  const tenta = async (stage, ms, fn) => {
    try {
      return await comPrazo(fn(), ms, stage);
    } catch (e) {
      if (e instanceof ErroCritico) throw e;
      errors.push({ stage, message: erroMsg(e) });
      return null;
    }
  };
  const salvar = async (nome, conteudo, tipo) => {
    if (!conteudo || !deps.salvarVisual) return null;
    return tenta(`visual_${nome}`, prazos.visual, () => deps.salvarVisual(nome, conteudo, tipo));
  };

  await aoMudarEtapa('scraping');

  // 1) Google Meu Negócio (antes do site: a ficha conferida aponta o site real).
  const gmnBruto = deps.googleNegocio ? await tenta('google_meu_negocio', prazos.gmn, () => deps.googleNegocio(empresa, cidade)) : null;
  const google_meu_negocio = gmnBruto && gmnBruto.found !== false && (gmnBruto.title || gmnBruto.rating != null)
    ? { fetched: true, nome: gmnBruto.title ?? null, nota: gmnBruto.rating ?? null, avaliacoes: gmnBruto.reviews ?? null, categoria: gmnBruto.category ?? null, endereco: gmnBruto.address ?? null, telefone: gmnBruto.phone ?? null, site: gmnBruto.website ?? null, maps_url: gmnBruto.cid ? `https://maps.google.com/?cid=${gmnBruto.cid}` : null }
    : { fetched: false };

  // 2) Site: o do formulário; sem ele, a descoberta do Enriquecedor.
  let siteUrl = normalizarUrl(inputs.site);
  let origemSite = siteUrl ? 'formulario' : null;
  if (!siteUrl && deps.descobrirSite) {
    const d = await tenta('site_descoberta', prazos.site, () => deps.descobrirSite({ empresa, cidade, gmn: gmnBruto }));
    if (d?.url) { siteUrl = normalizarUrl(d.url); origemSite = 'descoberta'; }
  }
  let site = { fetched: false, url: siteUrl, origem: origemSite };
  let audit = null;
  if (siteUrl && deps.auditar) {
    // PageSpeed e a tela do site correm em paralelo com a auditoria.
    const psP = deps.pagespeed ? tenta('site_pagespeed', prazos.pagespeed, () => deps.pagespeed(siteUrl)) : Promise.resolve(null);
    const telaP = deps.telaSite ? tenta('visual_site', prazos.visual, () => deps.telaSite(siteUrl)) : Promise.resolve(null);
    audit = await tenta('scrape_site', prazos.site, () => deps.auditar(siteUrl));
    const [ps, tela] = await Promise.all([psP, telaP]);
    if (audit) {
      const botoes = audit.whatsappButtons ?? [];
      site = {
        fetched: true,
        url: audit.siteUrl ?? siteUrl,
        origem: origemSite,
        online: !!audit.isOnline,
        http_status: audit.httpStatus ?? null,
        bloqueia_robos: !!audit.bloqueado,
        https: !!audit.httpsValid,
        load_ms: audit.loadTimeMs ?? null,
        title: audit.title ?? null,
        meta_description: audit.metaDescription ?? null,
        pixel_meta: !!audit.hasMetaPixel,
        gtm: !!audit.hasGoogleTag,
        google_ads_tag: !!audit.hasGoogleAds,
        tiktok_pixel: !!audit.hasTiktokPixel,
        rd_station: !!audit.hasRdStation,
        hubspot: !!audit.hasHubspot,
        blog: !!audit.hasBlog,
        whatsapp_button: botoes.some((b) => b.working) || (!botoes.length && !!audit.hasWhatsappWidget),
        whatsapp_quebrados: botoes.filter((b) => !b.working).length,
        whatsapp_widget: !!audit.hasWhatsappWidget,
        has_form: !!audit.form?.hasForm,
        form_campos: audit.form?.fields ?? null,
        form_suspeito: !!audit.form?.actionSuspeita,
        notas: (audit.notes ?? []).slice(0, 8),
        pagespeed: ps && ps.ok !== false ? { performance: ps.performance ?? null, seo: ps.seo ?? null, lcp_ms: ps.lcpMs ?? null } : null,
        instagram_no_site: audit.siteInstagram ?? null,
        facebook_no_site: audit.siteFacebook ?? null,
        coletado_em: agora(),
      };
    }
    const img = tela ? await salvar('site', tela, 'image/jpeg') : null;
    if (img) visuais.site = { url: site.url, imagem: img };
  } else if (!siteUrl) {
    errors.push({ stage: 'scrape_site', message: 'site não informado e não encontrado na busca' });
  }

  // 3) Instagram: formulário > link no próprio site > busca.
  let igHandle = handleInstagram(inputs.instagram) ?? handleInstagram(site.instagram_no_site);
  let origemIg = handleInstagram(inputs.instagram) ? 'formulario' : igHandle ? 'site' : null;
  if (!igHandle && deps.acharInstagram) {
    const r = await tenta('instagram_busca', prazos.instagram, () => deps.acharInstagram(empresa, { cidade, siteDomain: dominioDe(site.url) }));
    igHandle = handleInstagram(r?.url);
    if (igHandle) origemIg = 'busca';
  }
  let instagram = { fetched: false, handle: igHandle ? `@${igHandle}` : null, url: igHandle ? `https://www.instagram.com/${igHandle}/` : null, origem: origemIg };
  if (igHandle && deps.perfilInstagram) {
    const p = await tenta('scrape_instagram', prazos.instagram, () => deps.perfilInstagram(igHandle));
    if (p && p.existe !== false) {
      instagram = {
        ...instagram,
        fetched: p.seguidores != null || p.posts != null,
        followers: p.seguidores ?? null,
        followees: p.seguindo ?? null,
        posts_total: p.posts ?? null,
        biography: p.bio ?? null,
        coletado_em: agora(),
      };
      const img = p.tela ? await salvar('instagram', p.tela, 'image/jpeg') : null;
      if (img) visuais.instagram = { url: instagram.url, imagem: img };
      if (!instagram.fetched) errors.push({ stage: 'scrape_instagram', message: 'perfil encontrado, mas o Instagram não mostrou seguidores/posts para o robô' });
    } else if (p && p.existe === false) {
      errors.push({ stage: 'scrape_instagram', message: `perfil @${igHandle} não existe ou está indisponível` });
      instagram = { ...instagram, url: null };
    }
  } else if (!igHandle) {
    errors.push({ stage: 'scrape_instagram', message: 'perfil do Instagram não informado e não encontrado' });
  }

  // 4) Mídia paga (Meta ‖ Google), em paralelo.
  const fbUrl = site.facebook_no_site ?? null;
  const metaP = (async () => {
    if (!deps.anunciosMeta) return { fetched: false };
    const pageIdLink = String(inputs.meta_ads_library_url ?? '').match(/view_all_page_id=(\d{5,})/)?.[1] ?? null;
    let pagina = pageIdLink ? { pageId: pageIdLink, pageName: null } : null;
    if (!pagina && fbUrl && deps.metaPagina) pagina = await tenta('meta_pagina', prazos.meta, () => deps.metaPagina(fbUrl, empresa));
    const r = await tenta('scrape_meta_ads', prazos.meta, () => deps.anunciosMeta({
      company: empresa,
      fbHandle: fbUrl ? (fbUrl.match(/facebook\.com\/([^/?#]+)/i)?.[1] ?? null) : null,
      siteDomain: dominioDe(site.url),
      cidade,
      metaPageId: pagina?.pageId ?? null,
    }));
    if (!r) return { fetched: false };
    if (r.ok === false || !r.meta) {
      errors.push({ stage: 'scrape_meta_ads', message: `Biblioteca de Anúncios não medida (${r.note ?? 'sem resultado'})` });
      return { fetched: false };
    }
    const m = r.meta;
    const validados = m.validados ?? [];
    const ads = validados.slice(0, 20).map((a) => ({ creative_body: a.trecho ?? null, formato: a.midiaTipo ?? null, destino: a.destTipo ?? null, dest: (a.dest ?? []).slice(0, 2), sinais: a.signals ?? [], _imagem: a.imagem ?? null }));
    // Criativos: as URLs do fbcdn expiram — a imagem é copiada para o nosso storage.
    for (const [i, a] of ads.entries()) {
      if (i < 8 && a._imagem) {
        const img = await salvar(`meta_${i + 1}`, a._imagem, 'image/jpeg');
        if (img) { a.imagem = img; visuais.meta_ads.push({ imagem: img, trecho: a.creative_body, formato: a.formato, destino: a.destino }); }
      }
      delete a._imagem;
    }
    return {
      fetched: true,
      modo: m.modo ?? 'keyword',
      pagina_id: pagina?.pageId ?? null,
      pagina_nome: pagina?.pageName ?? null,
      active_count: validados.length,
      a_validar_count: (m.aValidar ?? []).length,
      termo: m.termo ?? null,
      library_url: inputs.meta_ads_library_url || (pagina?.pageId ? `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&view_all_page_id=${pagina.pageId}` : null),
      ads,
      coletado_em: agora(),
    };
  })();
  const googleP = (async () => {
    if (!deps.anunciosGoogle) return { fetched: false };
    const advertiserId = String(inputs.google_ads_transparency_url ?? '').match(/advertiser\/(AR\d{6,})/i)?.[1] ?? null;
    const domain = dominioDe(site.url);
    if (!advertiserId && !domain) {
      errors.push({ stage: 'scrape_google_ads', message: 'sem site nem link do Google Transparency para medir Google Ads' });
      return { fetched: false };
    }
    const g = await tenta('scrape_google_ads', prazos.google, () => deps.anunciosGoogle({ advertiserId, domain: advertiserId ? null : domain }));
    if (!g || g.ok === false) {
      if (g) errors.push({ stage: 'scrape_google_ads', message: `Google Transparency não medido (${g.note ?? 'sem resultado'})` });
      return { fetched: false };
    }
    if (g.url && deps.telaPagina && (g.criativos ?? 0) > 0) {
      const tela = await tenta('visual_google_ads', prazos.visual, () => deps.telaPagina(g.url));
      const img = tela ? await salvar('google_ads', tela, 'image/jpeg') : null;
      if (img) visuais.google_ads = { url: g.url, imagem: img };
    }
    return {
      fetched: true,
      url: g.url ?? null,
      advertiser_id: advertiserId ?? g.anunciantes?.[0]?.id ?? null,
      anunciante: g.anunciantes?.[0]?.nome ?? null,
      ads_count: g.criativos ?? 0,
      total_informado: g.totalTexto ?? null,
      formatos: g.formatos ?? { video: 0, imagem: 0, texto: 0 },
      amostra: (g.amostra ?? []).slice(0, 12).map((c) => ({ formato: c.formato, texto: c.texto, url: c.url })),
      sem_anuncios: !!g.semAnuncios,
      coletado_em: agora(),
    };
  })();
  const [meta_ads, google_ads] = await Promise.all([metaP, googleP]);

  return {
    fonte: 'enriquecedor',
    versao: 1,
    coletado_em: agora(),
    empresa,
    site,
    instagram,
    facebook: { url: fbUrl },
    google_meu_negocio,
    meta_ads,
    google_ads,
    visuais,
    errors,
  };
}

// Coleta reaproveitável no "Reenviar": só a feita por este motor.
export function coletaReaproveitavel(sd) {
  return !!(sd && typeof sd === 'object' && sd.fonte === 'enriquecedor' && sd.versao === 1);
}

// ---------------------------------------------------------------------------
// SCORE DE MATURIDADE — a rubrica do v3, calculada em CÓDIGO (determinística)
// e adaptada aos sinais que o Enriquecedor mede. O modelo recebe o resultado
// pronto e o JSON final é sobrescrito com ele (nunca diverge da evidência).
// ---------------------------------------------------------------------------
export function statusDaNota(n) {
  if (n >= 9) return 'Excelente';
  if (n >= 6) return 'Bom';
  if (n >= 3) return 'Médio';
  return 'Crítico';
}

export function calcularScore(sd) {
  const s = sd?.site ?? {};
  const ig = sd?.instagram ?? {};
  const gmn = sd?.google_meu_negocio ?? {};
  const meta = sd?.meta_ads ?? {};
  const gads = sd?.google_ads ?? {};
  const dim = (nome, itens) => {
    const marcados = itens.filter(([ok]) => ok);
    const nota = Math.min(10, marcados.reduce((t, [, p]) => t + p, 0));
    return { nome, nota, evidencia: marcados.length ? marcados.map(([, p, txt]) => `${txt} +${p}`).join(', ') : 'nenhum sinal medido' };
  };
  const site = s.fetched === true;
  const formatosMeta = new Set((meta.ads ?? []).map((a) => a.formato).filter(Boolean));
  const seguidores = ig.followers ?? null;
  const avals = gmn.avaliacoes ?? 0;
  const dims = [
    dim('Tráfego', [
      [site && s.pixel_meta, 3, 'Meta Pixel detectado'],
      [site && (s.gtm || s.google_ads_tag), 2, 'Google Tag/GTM detectado'],
      [meta.fetched && meta.active_count > 0, 3, `${meta.active_count ?? 0} anúncio(s) Meta ativos`],
      [gads.fetched && gads.ads_count > 0, 2, `${gads.ads_count ?? 0} anúncio(s) Google`],
    ]),
    dim('Engajamento', [
      [site && !!s.title && !!s.meta_description, 2, 'título + meta description (SEO)'],
      [seguidores != null && seguidores >= 10000, 3, `${seguidores} seguidores no Instagram`],
      [seguidores != null && seguidores >= 1000 && seguidores < 10000, 2, `${seguidores} seguidores no Instagram`],
      [seguidores != null && seguidores < 1000 && seguidores > 0, 1, `${seguidores} seguidores no Instagram`],
      [gmn.fetched && avals >= 50, 2, `${avals} avaliações no Google`],
      [gmn.fetched && avals >= 10 && avals < 50, 1, `${avals} avaliações no Google`],
      [formatosMeta.size >= 2, 3, `anúncios Meta em ${formatosMeta.size} formatos`],
    ]),
    dim('Conversão', [
      [site && s.has_form && !s.form_suspeito, 3, 'formulário de captura'],
      [site && s.whatsapp_button && !s.whatsapp_quebrados, 2, 'botão de WhatsApp funcionando'],
      [site && (s.pagespeed?.performance ?? 0) >= 50, 2, `PageSpeed mobile ${s.pagespeed?.performance}`],
      [site && s.https, 1, 'HTTPS'],
      [site && s.load_ms != null && s.load_ms < 3000, 2, `home em ${s.load_ms} ms`],
    ]),
    dim('Retenção', [
      [site && (s.rd_station || s.hubspot), 3, s.rd_station ? 'RD Station no site' : 'HubSpot no site'],
      [site && s.blog, 2, 'blog no site'],
      [gmn.fetched && (gmn.nota ?? 0) >= 4.5, 2, `nota ${gmn.nota} no Google`],
      [ig.fetched && (ig.posts_total ?? 0) >= 100, 3, `${ig.posts_total} posts no Instagram`],
    ]),
  ];
  const media = Math.round((dims.reduce((t, d) => t + d.nota, 0) / dims.length) * 10) / 10;
  return { dimensoes: dims.map((d) => ({ ...d, status: statusDaNota(d.nota) })), media, status: statusDaNota(media) };
}

// ---------------------------------------------------------------------------
// PROMPT — o v3, adaptado ao scraped_data do Enriquecedor. Mesmo markdown,
// mesmo JSON (schema v1), mesmas regras de honestidade e tom. Sem callback:
// o motor grava. Sem web_search: concorrentes vêm do formulário e do
// conhecimento do modelo, marcados "a validar".
// ---------------------------------------------------------------------------
export function montarPrompt(entrada, sd, score, { hoje = new Date() } = {}) {
  const inputs = entrada.inputs ?? {};
  const dados = {
    empresa: entrada.empresa,
    segmento: inputs.segmento || '',
    site_informado: inputs.site || '',
    instagram_informado: inputs.instagram || '',
    faturamento_atual: inputs.faturamento_atual || '',
    meta_faturamento: inputs.meta_faturamento || '',
    concorrentes_conhecidos: inputs.concorrentes_conhecidos || '',
    contexto: inputs.contexto || '',
    meta_ads_library_url: inputs.meta_ads_library_url || sd?.meta_ads?.library_url || '',
    google_ads_transparency_url: inputs.google_ads_transparency_url || sd?.google_ads?.url || '',
    score_calculado: score,
    scraped_data: { ...sd, visuais: undefined },
  };
  const data = hoje.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Você é um Especialista em Growth Marketing da V4 Company escrevendo a análise pré-reunião
que o closer lê antes da call. Os dados abaixo já foram coletados pelo motor de enriquecimento
(site auditado com navegador, PageSpeed, Google Meu Negócio, Instagram, Biblioteca de Anúncios da
Meta e Google Ads Transparency). Seu trabalho: ANALISAR e escrever o briefing em DOIS formatos:
markdown (consumo interno do closer) + JSON estruturado (renderizado numa página de apresentação).

====================================================================
REGRAS DE HONESTIDADE (valem para markdown E JSON)
====================================================================
1. Use APENAS os dados fornecidos. Se um bloco veio "fetched": false ou ausente, OMITA a análise
   correspondente (no JSON: null ou array vazio).
2. Site: "bloqueia_robos": true ou "online": false → alerta "site não pôde ser auditado por
   completo — validar UX na call". Use as "notas" da auditoria como evidência.
3. Pixel/GTM/RD/HubSpot/WhatsApp: use EXATAMENTE os flags de scraped_data.site. true = presente;
   false = "não detectado". "whatsapp_quebrados" > 0 é bandeira vermelha (cite).
4. Instagram: se scraped_data.instagram.fetched == false, omita a sub-seção no markdown e deixe
   analise_detalhada.instagram = null no JSON, com o alerta "perfil Instagram sem números
   acessíveis — pedir dados na call". Se fetched == true, use os números REAIS (seguidores, posts).
   Não há dado de frequência de posts por mês: não invente.
5. Meta Ads (capítulo 2): SOMENTE se scraped_data.meta_ads.fetched == true E active_count > 0 E ads
   tem itens. Senão omita o capítulo e deixe meta_ads = null. Os anúncios vêm com trecho do texto
   (creative_body), formato (imagem/video/carrossel), destino (whatsapp/lp/perfil) e domínios.
   Se a_validar_count > 0, cite que há anúncios a confirmar.
6. Google Ads (capítulo 3): SOMENTE se scraped_data.google_ads.fetched == true E ads_count > 0.
   Senão omita e deixe google_ads = null. A amostra traz formato (texto/imagem/video) e texto;
   "texto" ≈ Search.
7. Concorrentes: use concorrentes_conhecidos e o seu conhecimento do mercado. Concorrente que não
   veio do formulário leva "(a validar)" no nome. Só liste se tiver pelo menos 2; senão omita a
   tabela e deixe analise_competitiva = null.
8. scraped_data.errors: cada entrada vira uma linha nos "⚠️ ALERTAS" (markdown) e um item em
   alertas[] (JSON) dizendo o que o closer deve validar manualmente.
9. Fontes: liste as URLs coletadas (site, Instagram, Google Meu Negócio, Biblioteca da Meta,
   Google Transparency) em fontes[] e na seção de fontes do markdown.
10. Nunca invente números. Seguidores, notas, avaliações, contagens de anúncios: só valores que
    venham nos dados.

====================================================================
TOM
====================================================================
- Português BR. Direto, cru, cirúrgico — SEM hedging ("talvez", "possivelmente" proibidos).
- "Copy fraca", "bandeira vermelha", "crítico" são aceitos. O cliente vai LER parte disso na
  página de apresentação: provoque desconforto produtivo, não suavize.
- Frases curtas. 5 min de leitura para o closer. Sem preâmbulo.

====================================================================
SCORE DE MATURIDADE DIGITAL (JÁ CALCULADO — use exatamente)
====================================================================
O campo score_calculado traz as 4 dimensões (Tráfego, Engajamento, Conversão, Retenção) com nota,
status e evidência, e a média. Copie essas notas e evidências para a tabela do markdown e para
score_maturidade/lead.score_geral do JSON. Não recalcule. Status: 0-2 🔴 Crítico · 3-5 🟡 Médio ·
6-8 🟢 Bom · 9-10 ⭐ Excelente.

====================================================================
TAREFA
====================================================================
Capítulo 1 — Core (sempre): análise do site (evidências concretas), Instagram (se fetched), mídia
paga em visão leve (Meta + Google), Google Meu Negócio (nota e avaliações, se fetched), competitiva,
score, gaps e quick wins ancorados em evidência, pergunta de impacto (ancorada no maior gap) e
resumo falado (3 bullets, 60 s de fala, voz do closer abrindo a call).
Capítulo 2 — Meta Ads Deep Dive (condicional, regra 5): formato dominante, copies recorrentes,
gatilhos emocionais, CTAs/destinos, estágio de funil, top 3-5 criativos campeões ("por que
funciona"), gaps e recomendações.
Capítulo 3 — Google Ads Deep Dive (condicional, regra 6): distribuição por formato, textos
recorrentes, keywords implícitas, posicionamento, gaps e recomendações.

====================================================================
FORMATO FINAL (OBRIGATÓRIO — DOIS BLOCOS, nesta ordem, nada antes nem depois)
====================================================================
BLOCO 1 — MARKDOWN

# BRIEFING PRÉ-CALL · {EMPRESA}

**Segmento:** {confirmado ou corrigido}
**Faturamento atual → Meta:** {fat} → {meta}
**Data:** ${data}

---

## 🎯 SUMÁRIO EXECUTIVO
| Frente | Status | Resumo |
|---|---|---|
| Site | 🔴/🟡/🟢 | ... |
| Instagram | ... | ... |
| Mídia paga | ... | ... |
| Oportunidade | ... | ... |

---

## 📊 SCORE DE MATURIDADE DIGITAL
| Dimensão | Nota | Status | Evidência |
|---|---|---|---|
| Tráfego | X/10 | ... | ... |
| Engajamento | X/10 | ... | ... |
| Conversão | X/10 | ... | ... |
| Retenção | X/10 | ... | ... |
| **MÉDIA** | **X.X/10** | **...** | — |

---

## 🔍 ANÁLISE DETALHADA
### Site
### Instagram
### Google Meu Negócio
### Mídia paga (visão leve)

---

## ⚔️ ANÁLISE COMPETITIVA
[Tabela se 2+ concorrentes, senão omite com nota]
**Maior ameaça:** [...]
**Oportunidade exclusiva:** [...]

---

## 💸 GAPS
1. [...]

---

## 🚀 QUICK WINS
**1. [...] · ⏱ [tempo]**

---

## 🎤 PERGUNTA DE IMPACTO
> "[...]"

---

## 🗣️ RESUMO FALADO (60s para abrir a call)
- [bullet 1]
- [bullet 2]
- [bullet 3]

---

## ⚠️ ALERTAS PARA O CLOSER
- [...]

---

[SE capítulo 2 rodou]
## 💎 META ADS — ANÁLISE PROFUNDA

[SE capítulo 3 rodou]
## 🎯 GOOGLE ADS — ANÁLISE PROFUNDA

---

## 🔗 FONTES USADAS
- {url} — {descrição}

BLOCO 2 — JSON (depois do markdown, exatamente com este cabeçalho e cerca)

## BRIEFING JSON

\`\`\`json
{
  "schema_version": "v1",
  "generated_at": "<ISO8601>",
  "lead": { "nome": "<EMPRESA>", "tagline": "<manchete do diagnóstico, até 140 chars>", "segmento": "<ou 'Não informado'>", "faturamento_atual": "<ou 'Não informado'>", "meta_faturamento": "<ou 'Não informada'>", "score_geral": <média do score_calculado> },
  "sumario_executivo": [ {"frente": "Site", "status": "forte|madura|pendente|critica", "resumo": "..."}, {"frente": "Instagram", "status": "...", "resumo": "..."}, {"frente": "Mídia Paga", "status": "...", "resumo": "..."}, {"frente": "Oportunidade", "status": "alta|media|baixa", "resumo": "..."} ],
  "score_maturidade": { "dimensoes": [ {"nome": "Tráfego", "nota": 0, "evidencia": "..."}, {"nome": "Engajamento", "nota": 0, "evidencia": "..."}, {"nome": "Conversão", "nota": 0, "evidencia": "..."}, {"nome": "Retenção", "nota": 0, "evidencia": "..."} ], "media": 0.0 },
  "analise_detalhada": {
    "site": { "url": "<url>", "pontos": [ {"label": "...", "texto": "..."} ] },
    "instagram": { "handle": "@handle", "pontos": [ {"label": "...", "texto": "..."} ] },
    "google_meu_negocio": { "pontos": [ {"label": "...", "texto": "..."} ] },
    "midia_paga": { "pontos": [ {"label": "Meta Ads", "texto": "..."}, {"label": "Google Ads", "texto": "..."} ] }
  },
  "analise_competitiva": { "concorrentes": [ {"nome": "...", "posicionamento": "...", "ameaca": "alta|muito-alta|media|baixa"} ], "maior_ameaca": {"nome": "...", "descricao": "..."}, "oportunidade": {"descricao": "..."} },
  "gaps": [ {"numero": 1, "titulo": "...", "descricao": "..."} ],
  "quick_wins": [ {"numero": 1, "titulo": "...", "prazo": "7 dias|14 dias|21 dias|1 dia|meio dia", "descricao": "..."} ],
  "meta_ads": { "volume": 0, "pagina_id": "<id ou null>", "pagina_nome": "<nome ou null>", "distribuicao_formato": [ {"formato": "VIDEO|IMAGE|CAROUSEL", "qtd": 0, "pct": 0, "obs": "..."} ], "estagio_funil": [ {"estagio": "...", "descricao": "..."} ], "produtos": [ {"nome": "...", "qtd_ads": 0, "angulo": "..."} ], "ctas": [ {"cta": "...", "qtd": 0, "obs": "..."} ], "gatilhos": [ {"gatilho": "...", "produtos": ["..."]} ], "top_criativos": [ {"rank": 1, "titulo": "...", "formato": "...", "data": null, "cta": "...", "copy": "<trecho literal do creative_body>", "por_que": "..."} ], "gaps_recomendacoes": [ {"titulo": "...", "descricao": "..."} ] },
  "google_ads": { "volume": 0, "advertiser_id": "<id ou null>", "distribuicao": {"search": 0, "display": 0, "youtube": 0}, "bandeira_vermelha": "<ou null>", "insights": [ {"titulo": "...", "descricao": "..."} ], "gaps_recomendacoes": [ {"titulo": "...", "descricao": "..."} ] },
  "fontes": [ {"url": "...", "descricao": "...", "categoria": "lead|biblioteca|benchmark"} ],
  "resumo_falado": [ "...", "...", "..." ],
  "pergunta_impacto": "2-4 frases, ancorada no maior gap com números.",
  "alertas": [ {"titulo": "...", "descricao": "..."} ],
  "dados_coleta": { "site": {"coletado_em": "<ISO ou null>", "status": "ok|erro|pendente"}, "instagram": {...}, "meta_ads": {...}, "google_ads": {...} }
}
\`\`\`

IMPORTANTE sobre o JSON:
- schema_version DEVE ser "v1". JSON válido (sem comentários, sem vírgula sobrando).
- meta_ads, google_ads, analise_competitiva, analise_detalhada.instagram e
  analise_detalhada.google_meu_negocio podem ser null conforme as regras acima.
- Tamanhos: sumario_executivo 3-5, score_maturidade.dimensoes exatamente 4, gaps 3-10,
  quick_wins 2-5, meta_ads.top_criativos 3-5, resumo_falado exatamente 3.
- top_criativos[].copy: trecho LITERAL de um creative_body dos dados (é assim que a página mostra
  a imagem do criativo ao lado).
- dados_coleta.coletado_em: copie o coletado_em de cada bloco; null se não veio.

====================================================================
DADOS (JSON)
====================================================================
${JSON.stringify(dados, null, 1)}
`;
}

// ---------------------------------------------------------------------------
// RESPOSTA → { markdown, json }. O markdown guardado é só o BLOCO 1 (o que o
// closer lê); o JSON é validado e recebe o score calculado e os visuais.
// ---------------------------------------------------------------------------
export function extrairResultado(texto) {
  const t = String(texto ?? '');
  const idx = t.search(/^##\s*BRIEFING\s+JSON\s*$/im);
  if (idx < 0) throw new Error('resposta sem o bloco "## BRIEFING JSON"');
  const markdown = t.slice(0, idx).replace(/\n-{3,}\s*$/, '').trim();
  const m = t.slice(idx).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!m) throw new Error('bloco JSON sem cerca ```json');
  let json;
  try { json = JSON.parse(m[1]); } catch (e) { throw new Error(`JSON do briefing inválido: ${erroMsg(e)}`); }
  if (!markdown.startsWith('# ')) throw new Error('markdown do briefing sem o título "# BRIEFING PRÉ-CALL"');
  if (!json || typeof json !== 'object' || json.schema_version !== 'v1') throw new Error('JSON do briefing sem schema_version "v1"');
  return { markdown, json };
}

// Une o que é do MOTOR (score medido, visuais, versão do prompt) ao JSON do modelo.
export function finalizarJson(json, score, sd, { modelo = null, agora = new Date() } = {}) {
  const out = { ...json };
  out.score_maturidade = {
    dimensoes: score.dimensoes.map((d) => ({ nome: d.nome, nota: d.nota, evidencia: d.evidencia })),
    media: score.media,
  };
  out.lead = { ...(json.lead ?? {}), score_geral: score.media };
  if (!Array.isArray(out.resumo_falado)) out.resumo_falado = [];
  out.visuais = montarVisuais(sd, json);
  out.motor = { fonte: 'enriquecedor', prompt: PREP_PROMPT_VERSAO, modelo, gerado_em: agora.toISOString() };
  return out;
}

const normTrecho = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);

// Visuais da página: telas capturadas + imagem de cada criativo campeão
// (casada pelo trecho do copy, que o prompt manda ser literal).
export function montarVisuais(sd, json) {
  const v = sd?.visuais ?? {};
  const metaImgs = v.meta_ads ?? [];
  const tops = Array.isArray(json?.meta_ads?.top_criativos) ? json.meta_ads.top_criativos : [];
  const porCriativo = tops.map((c) => {
    const alvo = normTrecho(c.copy);
    const hit = alvo ? metaImgs.find((x) => { const tr = normTrecho(x.trecho); return tr && (tr.includes(alvo.slice(0, 30)) || alvo.includes(tr.slice(0, 30))); }) : null;
    return hit ? { rank: c.rank ?? null, imagem: hit.imagem } : null;
  }).filter(Boolean);
  return {
    site: v.site ?? null,
    instagram: v.instagram ?? null,
    google_ads: v.google_ads ?? null,
    meta_ads: metaImgs.slice(0, 8),
    top_criativos: porCriativo,
  };
}

// ---------------------------------------------------------------------------
// EXECUÇÃO de um job (claim feito no banco). `db` é a ponte para as RPCs
// condicionais da migration (prep_call_renovar/concluir/falhar): se a tentativa
// deixou de ser a vigente (Reenviar, watchdog), o motor PARA e não grava nada.
// ---------------------------------------------------------------------------
export class TentativaEncerrada extends Error {}

export async function executarPrep(job, { deps, db, gerarTexto, prazos = PRAZOS_PADRAO, modelo = null, log = () => {} }) {
  const entrada = { empresa: job.empresa, inputs: job.inputs ?? {}, cidade: job.cidade ?? null };
  const marca = async (etapa) => {
    const ok = await db.renovar(job, etapa);
    if (!ok) throw new TentativaEncerrada('tentativa não é mais a vigente');
  };
  let sd = null;
  let etapa = 'scraping';
  try {
    if (job.reaproveitar_coleta && coletaReaproveitavel(job.scraped_data)) {
      sd = job.scraped_data;
      log(`reaproveitando coleta de ${sd.coletado_em}`);
    } else {
      await marca('scraping');
      const hb = setInterval(() => { db.renovar(job, null).catch(() => {}); }, 30_000);
      try {
        sd = await comPrazo(coletar(entrada, deps, { prazos }), prazos.coleta, 'coleta');
      } finally {
        clearInterval(hb);
      }
    }
    etapa = 'analyzing';
    await marca('analyzing');
    const score = calcularScore(sd);
    const prompt = montarPrompt(entrada, sd, score);
    const hb = setInterval(() => { db.renovar(job, null).catch(() => {}); }, 30_000);
    let texto;
    try {
      texto = await comPrazo(gerarTexto(prompt), prazos.ia, 'ia');
    } finally {
      clearInterval(hb);
    }
    const { markdown, json } = extrairResultado(texto);
    const final = finalizarJson(json, score, sd, { modelo });
    const gravou = await db.concluir(job, { markdown, json: final, scraped: sd, modelo });
    if (!gravou) throw new TentativaEncerrada('tentativa encerrada antes de gravar o resultado');
    return { ok: true };
  } catch (e) {
    if (e instanceof TentativaEncerrada) {
      log(`job ${job.job_id}: ${e.message} — nada gravado`);
      return { ok: false, encerrada: true };
    }
    // Nova tentativa ou erro final é decisão do banco (tentativas e prazo da tentativa).
    await db.falhar(job, { etapa: etapa === 'analyzing' ? 'ia' : 'coleta', mensagem: erroMsg(e), scraped: sd }).catch(() => {});
    return { ok: false, erro: erroMsg(e) };
  }
}
