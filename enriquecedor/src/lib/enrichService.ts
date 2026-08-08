import pLimit from 'p-limit';
import PQueue from 'p-queue';
import type { AdItem, DecisionMaker, DecisorEmail, DecisorPhone, DatastonePersonData, Empreendimento, EnrichIssue, Lead, SiteAudit } from '../types';
import { computeScore } from './leadScore';
import { motorFetch } from './motorClient';
import { computeDores, whatsappAudit } from './dores';
import { leadsRepo } from './leadsRepo';
import { decisionMakersRepo } from './decisionMakersRepo';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function emailDomain(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  return at === -1 ? null : email.slice(at + 1).trim().toLowerCase();
}

function normName(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const onlyDigits = (s: string | null | undefined): string => (s ?? '').replace(/\D/g, '');

// Converte o resultado de uma fonte (ok + note do backend) num aviso amigável.
// `note` de "desativado" não é falha (a fonte foi pulada de propósito).
function issueFor(source: string, ok: boolean, note?: string | null): EnrichIssue | null {
  switch (note) {
    case 'datastone_sem_creditos':
      return { source: 'DataStone', reason: 'sem créditos — recarregue o saldo no backoffice' };
    case 'datastone_auth':
      return { source: 'DataStone', reason: 'token inválido ou sem permissão' };
    case 'datastone_desativado':
    case 'ia_desativada':
    case 'serper_desativado':
    case 'headless_indisponivel':
      return null; // desativado/indisponível de propósito — não é falha
    case 'quota':
      return { source, reason: 'limite/cota atingido' };
    case 'meta_bloqueado':
      return { source: 'Anúncios (Meta)', reason: 'Meta em pausa de segurança (anti-bot) — a fila retenta automaticamente' };
    case 'meta_cap':
      return { source: 'Anúncios (Meta)', reason: 'teto diário de consultas atingido — continua amanhã' };
    case 'proxy_sem_trafego':
      return { source: 'Anúncios (Meta)', reason: 'proxy (Decodo) sem tráfego — recarregue a franquia de GB para medir anúncios' };
    case 'proxy_auth':
      return { source: 'Anúncios (Meta)', reason: 'proxy (Decodo) recusou a autenticação — confira usuário/senha em .env.local' };
    case 'proxy_conexao':
      return { source: 'Anúncios (Meta)', reason: 'proxy (Decodo) sem resposta — verifique o serviço/rede' };
    case 'meta_sem_resultado':
      return null; // rodou mas não achou nada — não é falha
    default:
      return ok ? null : { source, reason: 'instável no momento — re-enriquecer para tentar de novo' };
  }
}

interface LemitPhoneLike {
  numero: string | null;
  whatsapp?: boolean;
}
interface DsPhoneLike {
  numero: string;
  whatsapp?: boolean;
  hot?: boolean;
}

/**
 * Funde telefones das duas fontes (Lemit + DataStone) por número. Marca
 * `validado` quando o mesmo número aparece nas DUAS. Ordena: validado >
 * WhatsApp > quente. Assim o topo é sempre "o telefone mais quente validado".
 */
function mergePhones(lemit: LemitPhoneLike[], datastone: DsPhoneLike[]): DecisorPhone[] {
  const map = new Map<string, DecisorPhone>();
  const add = (numero: string | null, whatsapp: boolean, hot: boolean, source: string) => {
    if (!numero) return;
    const d = onlyDigits(numero);
    if (d.length < 10) return;
    const key = d.slice(-11);
    const ex = map.get(key) ?? { numero, whatsapp: false, hot: false, sources: [], validado: false };
    ex.whatsapp = ex.whatsapp || whatsapp;
    ex.hot = ex.hot || hot;
    if (numero.length >= ex.numero.length) ex.numero = numero;
    if (!ex.sources.includes(source)) ex.sources.push(source);
    map.set(key, ex);
  };
  (lemit ?? []).forEach((p) => add(p.numero, !!p.whatsapp, false, 'lemit'));
  (datastone ?? []).forEach((p) => add(p.numero, !!p.whatsapp, !!p.hot, 'datastone'));
  return [...map.values()]
    .map((p) => ({ ...p, validado: p.sources.length >= 2 }))
    .sort(
      (a, b) =>
        Number(b.validado) - Number(a.validado) ||
        Number(b.whatsapp) - Number(a.whatsapp) ||
        Number(b.hot) - Number(a.hot),
    );
}

function mergeEmails(lemit: string[], datastone: string[]): DecisorEmail[] {
  const map = new Map<string, DecisorEmail>();
  const add = (email: string, source: string) => {
    const k = email.toLowerCase().trim();
    if (!k) return;
    const ex = map.get(k) ?? { email: k, sources: [], validado: false };
    if (!ex.sources.includes(source)) ex.sources.push(source);
    map.set(k, ex);
  };
  (lemit ?? []).forEach((e) => e && add(e, 'lemit'));
  (datastone ?? []).forEach((e) => e && add(e, 'datastone'));
  return [...map.values()]
    .map((e) => ({ ...e, validado: e.sources.length >= 2 }))
    .sort((a, b) => Number(b.validado) - Number(a.validado));
}

interface DatastonePessoa {
  cpf: string;
  nome: string;
  phones: { numero: string; whatsapp: boolean; hot: boolean }[];
  fixos: string[];
  emails: string[];
  renda: string | null;
  ocupacao: string | null;
  empregador: string | null;
  pep: boolean;
  idade: number | null;
  empresas: DatastonePersonData['empresas'];
  familia: DatastonePersonData['familia'];
}

// ============================================================================
// SITE (descoberta + auditoria). searchFailed=true quando a busca não pôde
// rodar (cota/limite/backend fora) — sinal para reprocessar, não "não achou".
// ============================================================================
interface SiteAuditResponse {
  discoveredUrl: string | null;
  source: string;
  audit: Omit<SiteAudit, 'id' | 'leadId' | 'source'> | null;
  searchFailed?: boolean;
  notes?: string[];
}

export async function auditLeadSite(
  lead: Lead,
): Promise<{ audit: SiteAudit; searchFailed: boolean }> {
  const body = {
    companyName: lead.razaoSocial ?? lead.companyNameRaw,
    nomeFantasia: lead.nomeFantasia,
    cidade: lead.cidade,
    uf: lead.uf,
    emailDomain: emailDomain(lead.emailRaw),
    siteUrl: lead.siteUrl,
  };
  const empty: SiteAudit = {
    id: lead.id,
    leadId: lead.id,
    siteUrl: null,
    source: null,
    isOnline: false,
    httpStatus: null,
    httpsValid: false,
    loadTimeMs: null,
    whatsappButtons: [],
    hasWhatsappWidget: false,
    hasMetaPixel: false,
    hasGoogleTag: false,
    siteInstagram: null,
    siteFacebook: null,
    pagespeed: null,
    notes: [],
    checkedAt: new Date().toISOString(),
  };

  try {
    const res = await motorFetch('/api/site-audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { audit: { ...empty, notes: ['Backend indisponível.'] }, searchFailed: true };
    }
    const j = (await res.json()) as SiteAuditResponse;
    if (!j.audit) {
      return {
        audit: { ...empty, source: j.source, notes: j.notes ?? ['Site não encontrado.'] },
        searchFailed: !!j.searchFailed,
      };
    }
    return {
      audit: {
        ...j.audit,
        id: lead.id,
        leadId: lead.id,
        source: j.source,
        pagespeed: null,
        checkedAt: new Date().toISOString(),
      },
      searchFailed: !!j.searchFailed,
    };
  } catch {
    return { audit: { ...empty, notes: ['Sem backend de enriquecimento.'] }, searchFailed: true };
  }
}

/** PageSpeed Insights (Google) — notas reais do site. Best-effort (lento). */
export async function fetchPagespeed(url: string | null): Promise<SiteAudit['pagespeed']> {
  if (!url) return null;
  try {
    const res = await motorFetch('/api/pagespeed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.ok) return null;
    return {
      performance: j.performance ?? null,
      seo: j.seo ?? null,
      bestPractices: j.bestPractices ?? null,
      accessibility: j.accessibility ?? null,
      lcpMs: j.lcpMs ?? null,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// SÓCIOS: social (Brave) + contatos (Lemit), combinados por nome.
// ============================================================================
function isPersonSocio(nome: string): boolean {
  return !/\b(s\.?a\.?|s\/a|ltda|holding|empreendiment|participac|eireli|incorporad|construtora|imobiliaria|inc|grupo|fund|spe)\b/i.test(
    nome.toLowerCase(),
  );
}

interface SociosSocialResponse {
  companyInstagram: string | null;
  companyFacebook: string | null;
  people: Array<{ nome: string; linkedin: string | null; instagram: string | null }>;
  searchFailed?: boolean;
}
interface LemitResponse {
  ok: boolean;
  company: (Lead['lemitCompany'] & { phone?: string | null; whatsapp?: boolean; email?: string | null }) | null;
  people: Array<{
    cpf: string;
    nome: string;
    phone: string | null;
    whatsapp: boolean;
    email: string | null;
    companiesCount?: number;
    companies?: DecisionMaker['companies'];
    lemit?: DecisionMaker['lemit'];
  }>;
}

/**
 * Enriquece os sócios: redes (Brave) + telefone/e-mail por sócio (Lemit).
 * Nunca sobrescreve dado bom com vazio: se uma fonte falhar, mantém o que já
 * havia. Retorna {ok} — só true quando Brave E Lemit rodaram sem falha.
 */
export async function discoverPeople(
  lead: Lead,
  siteSocials?: { instagram: string | null; facebook: string | null },
): Promise<{ ok: boolean; issues: EnrichIssue[] }> {
  const empresa = lead.razaoSocial ?? lead.companyNameRaw;
  const sociosPessoas = lead.socios
    .filter((s) => isPersonSocio(s.nome))
    .sort(
      (a, b) =>
        Number(/administrador/i.test(b.qualificacao ?? '')) -
        Number(/administrador/i.test(a.qualificacao ?? '')),
    );

  // --- Brave (redes) ---
  let social: SociosSocialResponse = {
    companyInstagram: null,
    companyFacebook: null,
    people: [],
    searchFailed: false,
  };
  let braveFailed = false;
  try {
    const res = await motorFetch('/api/socios-social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company: empresa, socios: sociosPessoas.map((s) => s.nome) }),
    });
    if (res.ok) {
      social = await res.json();
      braveFailed = !!social.searchFailed;
    } else braveFailed = true;
  } catch {
    braveFailed = true;
  }

  // --- Lemit (contatos) ---
  let lemit: LemitResponse = { ok: false, company: null, people: [] };
  let lemitFailed = false;
  try {
    const res = await motorFetch('/api/lemit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cnpj: lead.cnpj }),
    });
    if (res.ok) {
      lemit = await res.json();
      lemitFailed = !lemit.ok;
    } else lemitFailed = true;
  } catch {
    lemitFailed = true;
  }

  // --- DataStone (contatos do decisor por CPF: telefone quente/WhatsApp) ---
  let dsPeople: DatastonePessoa[] = [];
  let dsFailed = false;
  let dsNote: string | undefined;
  try {
    const res = await motorFetch('/api/datastone-pessoas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cnpj: lead.cnpj }),
    });
    if (res.ok) {
      const j = (await res.json()) as { ok: boolean; people: DatastonePessoa[]; note?: string };
      dsPeople = j.people ?? [];
      dsFailed = j.ok === false;
      dsNote = j.note;
    } else dsFailed = true;
  } catch {
    dsFailed = true;
  }

  // Redes institucionais: o link no PRÓPRIO site tem prioridade (mais confiável
  // que busca). Só usa a busca como complemento quando o site não tem.
  const siteIg = siteSocials?.instagram ?? null;
  const siteFb = siteSocials?.facebook ?? null;
  if (siteIg) lead.companyInstagram = siteIg;
  else if (!braveFailed) lead.companyInstagram = social.companyInstagram ?? null;
  if (siteFb) lead.companyFacebook = siteFb;
  else if (!braveFailed) lead.companyFacebook = social.companyFacebook ?? null;

  // Dados completos da empresa na Lemit (não sobrescreve com vazio se falhou).
  if (!lemitFailed && lemit.company) {
    lead.lemitCompany = {
      phones: lemit.company.phones ?? [],
      fixos: lemit.company.fixos ?? [],
      emails: lemit.company.emails ?? [],
      endereco: lemit.company.endereco ?? null,
      dataFundacao: lemit.company.dataFundacao ?? null,
      nomeFantasia: lemit.company.nomeFantasia ?? null,
      carros: lemit.company.carros ?? [],
    };
  }

  // Mapas por nome normalizado.
  const existing = await decisionMakersRepo.listByLead(lead.id);
  const exByName = new Map(existing.map((p) => [normName(p.nome), p]));
  const braveByName = new Map((social.people ?? []).map((p) => [normName(p.nome), p]));
  const lemitByName = new Map((lemit.people ?? []).map((p) => [normName(p.nome), p]));
  const dsByName = new Map(dsPeople.map((p) => [normName(p.nome), p]));
  const dsByCpf = new Map(dsPeople.map((p) => [onlyDigits(p.cpf), p]));

  // União de nomes: sócios da Receita + pessoas da Lemit + pessoas da DataStone.
  const universe = new Map<string, { nome: string; cargo: string | null }>();
  for (const s of sociosPessoas) universe.set(normName(s.nome), { nome: s.nome, cargo: s.qualificacao });
  for (const lp of lemit.people ?? []) {
    if (!universe.has(normName(lp.nome))) universe.set(normName(lp.nome), { nome: lp.nome, cargo: null });
  }
  for (const dp of dsPeople) {
    if (!universe.has(normName(dp.nome))) universe.set(normName(dp.nome), { nome: dp.nome, cargo: null });
  }

  const list = [...universe.values()];
  const isAdmin = (q: string | null) => /administrador/i.test(q ?? '');
  const firstAdmin = list.findIndex((x) => isAdmin(x.cargo));
  const primaryIdx = firstAdmin >= 0 ? firstAdmin : 0;

  const people: DecisionMaker[] = list.map((x, i) => {
    const key = normName(x.nome);
    const ex = exByName.get(key);
    const bp = braveByName.get(key);
    const lp = lemitByName.get(key);
    const cpf = lemitFailed ? ex?.cpf ?? null : lp?.cpf ?? ex?.cpf ?? null;
    const dp = dsFailed ? undefined : dsByCpf.get(onlyDigits(cpf ?? '')) ?? dsByName.get(key);
    // redes: se Brave falhou, mantém o que já havia
    const linkedin = braveFailed ? ex?.linkedin ?? null : bp?.linkedin ?? null;
    const instagram = braveFailed ? ex?.instagram ?? null : bp?.instagram ?? null;

    // Contatos com VALIDAÇÃO CRUZADA (Lemit + DataStone).
    const merged = {
      phones: mergePhones(
        lemitFailed ? [] : lp?.lemit?.phones ?? [],
        dsFailed ? [] : dp?.phones ?? [],
      ),
      emails: mergeEmails(
        lemitFailed ? [] : lp?.lemit?.emails ?? [],
        dsFailed ? [] : dp?.emails ?? [],
      ),
    };
    // Se as duas fontes falharam, preserva o que já existia.
    const phones: DecisorPhone[] = merged.phones.length ? merged.phones : ex?.phones ?? [];
    const emails: DecisorEmail[] = merged.emails.length ? merged.emails : ex?.emails ?? [];
    const best = phones[0];
    const phone = best?.numero ?? (lemitFailed ? ex?.phonePersonal ?? null : lp?.phone ?? null);
    const whatsapp = best?.whatsapp ?? (lemitFailed ? ex?.phoneWhatsapp ?? false : lp?.whatsapp ?? false);
    const email = emails[0]?.email ?? (lemitFailed ? ex?.emailPersonal ?? null : lp?.email ?? null);
    const companies = lemitFailed ? ex?.companies ?? [] : lp?.companies ?? [];
    const companiesCount = lemitFailed ? ex?.companiesCount ?? 0 : lp?.companiesCount ?? 0;
    const lemitData = lemitFailed ? ex?.lemit ?? null : lp?.lemit ?? null;
    const dsData: DatastonePersonData | null = dsFailed
      ? ex?.datastone ?? null
      : dp
        ? {
            phones: dp.phones,
            fixos: dp.fixos,
            emails: dp.emails,
            renda: dp.renda,
            ocupacao: dp.ocupacao,
            empregador: dp.empregador,
            pep: dp.pep,
            idade: dp.idade,
            empresas: dp.empresas,
            familia: dp.familia,
          }
        : ex?.datastone ?? null;
    return {
      id: `${lead.id}-${i}`,
      leadId: lead.id,
      nome: x.nome,
      cargo: x.cargo,
      isPrimary: i === primaryIdx,
      cpf,
      phonePersonal: phone,
      phoneWhatsapp: whatsapp,
      emailPersonal: email,
      instagram,
      facebook: null,
      linkedin,
      confidence:
        (linkedin ? 20 : 0) + (instagram ? 10 : 0) + (best?.validado ? 30 : phone ? 20 : 0) + (emails[0]?.validado ? 20 : email ? 15 : 0),
      source: 'socio_receita',
      kommoContactId: ex?.kommoContactId ?? null,
      companiesCount,
      companies,
      lemit: lemitData,
      phones,
      emails,
      datastone: dsData,
    };
  });
  if (people.length > 0 && !people.some((p) => p.isPrimary)) people[0].isPrimary = true;

  await decisionMakersRepo.replaceForLead(lead.id, people);

  const issues: EnrichIssue[] = [];
  if (braveFailed)
    issues.push({ source: 'Busca (Brave)', reason: 'limite/cota atingido ou backend fora — LinkedIn/Instagram podem faltar' });
  if (lemitFailed)
    issues.push({ source: 'Lemit', reason: 'instável ou sem token — contatos do decisor podem faltar' });
  const dsIssue = issueFor('DataStone', !dsFailed, dsNote);
  if (dsIssue) issues.push(dsIssue);

  return { ok: !braveFailed && !lemitFailed && !dsFailed, issues };
}

// ============================================================================
// Orquestração com coerência: só marca 'enriquecido' quando site + social +
// Lemit completaram; senão fica 'incompleto' e é REPROCESSADO automaticamente.
// ============================================================================
export interface EnrichProgress {
  done: number;
  total: number;
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const lim = pLimit(Math.max(1, limit || 1));
  await Promise.all(items.map((item) => lim(() => worker(item))));
}

interface SourceResult {
  ok: boolean;
  note?: string;
}

async function fetchEmpreendimentos(lead: Lead, siteUrl?: string | null): Promise<SourceResult> {
  // Etapa específica do perfil construtoras — no perfil versátil (geral) não há
  // "empreendimentos" para extrair; pula sem marcar falha.
  if (lead.perfil === 'geral') return { ok: true, note: 'nao_aplicavel_perfil' };
  try {
    const res = await motorFetch('/api/empreendimentos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        company: lead.razaoSocial ?? lead.companyNameRaw,
        nomeFantasia: lead.nomeFantasia,
        cidade: lead.cidade,
        perfil: lead.perfil ?? 'construtoras',
        siteUrl: siteUrl ?? lead.siteUrl, // site descoberto → prioriza LP no domínio da empresa
      }),
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    if (Array.isArray(j.empreendimentos) && j.empreendimentos.length > 0) {
      lead.empreendimentos = j.empreendimentos;
    }
    return { ok: j.ok !== false, note: j.note }; // ia_desativada conta como ok (etapa pulada)
  } catch {
    return { ok: false };
  }
}

async function fetchGoogleBusiness(lead: Lead): Promise<SourceResult> {
  try {
    const res = await motorFetch('/api/google-negocio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company: lead.razaoSocial ?? lead.companyNameRaw, cidade: lead.cidade }),
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    if (j.found) {
      lead.googleBusiness = {
        title: j.title ?? null,
        rating: j.rating ?? null,
        reviews: j.reviews ?? null,
        category: j.category ?? null,
        address: j.address ?? null,
        phone: j.phone ?? null,
        website: j.website ?? null,
      };
    }
    return { ok: j.ok !== false, note: j.note }; // serper_desativado conta como ok (etapa pulada)
  } catch {
    return { ok: false };
  }
}

// Termo de busca "de marca" para o Meta. A razão social crua ("R. D. C.
// CONSTRUTORA E INCORPORADORA LTDA") traz ruído; o Meta acha os anúncios pelo
// nome como a empresa se anuncia. Prefere o handle do Facebook; senão limpa o
// nome (tira pontos/sufixos jurídicos e junta siglas: "R D C" → "RDC").
function adSearchTerm(lead: Lead): string {
  if (lead.companyFacebook) {
    const h = lead.companyFacebook.match(/facebook\.com\/([^/?#]+)/i)?.[1];
    if (h && !/^\d+$/.test(h) && h.length > 2) return h.replace(/[._-]+/g, ' ').trim();
  }
  const nome = (lead.nomeFantasia || lead.razaoSocial || lead.companyNameRaw || '').trim();
  let t = nome.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(ltda|s\/?a|eireli|epp|mei|me)\b/gi, '').replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let acc = '';
  for (const w of t.split(' ').filter(Boolean)) {
    if (w.length === 1) acc += w;
    else { if (acc) { out.push(acc); acc = ''; } out.push(w); }
  }
  if (acc) out.push(acc);
  return out.join(' ').trim() || nome;
}

// Título a partir do domínio: "reserva-muriquis" → "Reserva Muriquis".
function prettyDomainName(root: string): string {
  const cleaned = root.replace(/[-_]+/g, ' ').trim();
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Nome "bonito" do empreendimento a partir do TEXTO do anúncio que aponta pra
// esse domínio (ex.: copy "Reserva Muriquis" casa com o domínio "reservamuriquis").
// Resolve o problema de nomes colados quando o domínio junta as palavras.
function nameFromAdCopy(domain: string, root: string, validados: AdItem[]): string | null {
  const norm = (s: string) => normName(s).replace(/[^a-z0-9]/g, '');
  const dk = norm(root);
  for (const a of validados) {
    if (!a.dest?.some((d) => d.toLowerCase().replace(/^www\./, '') === domain)) continue;
    const words = `${a.trecho ?? ''} ${a.empreendimento ?? ''}`.match(/[A-Za-zÀ-ÿ]{2,}/g) || [];
    for (let i = 0; i < words.length; i++) {
      for (let len = Math.min(3, words.length - i); len >= 1; len--) {
        const cand = words.slice(i, i + len);
        if (norm(cand.join('')) === dk) {
          return cand.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }
      }
    }
  }
  return null;
}

// Realimenta os empreendimentos do lead com as LPs de DESTINO dos anúncios de
// ALTA confiança (conta oficial). Se a LP casa com um empreendimento existente,
// preenche a `lp` dele; se é nova, cria o empreendimento. Retorna o que mudou.
function reconcileLpsFromAds(
  lead: Lead,
  validados: AdItem[],
): Array<{ domain: string; empreendimento: string; novo: boolean }> {
  const key = (s: string | null | undefined) => normName(s).replace(/[^a-z0-9]/g, '');
  const hostOf = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const domains = new Set<string>();
  for (const a of validados) {
    if (a.destTipo === 'lp') for (const d of a.dest) if (d) domains.add(d.toLowerCase().replace(/^www\./, ''));
  }
  const emps: Empreendimento[] = lead.empreendimentos ? [...lead.empreendimentos] : [];
  const out: Array<{ domain: string; empreendimento: string; novo: boolean }> = [];
  for (const domain of domains) {
    const dk = key(domain.split('.')[0]);
    if (dk.length < 4) continue;
    if (emps.some((e) => hostOf(e.lp) === domain)) continue; // já mapeada
    const match = emps.find((e) => {
      const nk = key(e.nome);
      return nk.length >= 4 && (dk.includes(nk) || nk.includes(dk));
    });
    if (match) {
      if (!match.lp) {
        match.lp = `https://${domain}`;
        out.push({ domain, empreendimento: match.nome, novo: false });
      }
    } else {
      const root = domain.split('.')[0];
      const nome = nameFromAdCopy(domain, root, validados) ?? prettyDomainName(root);
      emps.push({ nome, cidade: lead.cidade ?? null, status: 'lancamento', lp: `https://${domain}`, lpAudit: null });
      out.push({ domain, empreendimento: nome, novo: true });
    }
  }
  if (out.length) lead.empreendimentos = emps;
  return out;
}

/** Anúncios do Meta (headless + validação cruzada). Muta lead.anuncios. Best-effort. */
async function fetchAnuncios(lead: Lead, audit: SiteAudit): Promise<SourceResult> {
  const hostOf = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  try {
    const fbHandle = lead.companyFacebook
      ? lead.companyFacebook.match(/facebook\.com\/([^/?#]+)/i)?.[1] ?? null
      : null;
    const siteDomain = hostOf(audit.siteUrl ?? lead.siteUrl);
    const empAtivos = (lead.empreendimentos ?? [])
      .filter((e) => e.status === 'lancamento' || e.status === 'em_obra')
      .map((e) => ({ nome: e.nome, domain: hostOf(e.lp) }));
    // Timeout de segurança: a busca multi-termo é pesada; se passar disto,
    // aborta e avisa (em vez de deixar a tela "travada" sem resposta).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150_000);
    let res: Response;
    try {
      res = await motorFetch('/api/anuncios', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          company: adSearchTerm(lead), // nome de marca (não a razão social crua)
          fbHandle,
          siteDomain,
          cidade: lead.cidade,
          empreendimentos: empAtivos, // lançamentos + obras (busca também por eles)
        }),
      });
    } catch (e) {
      return { ok: false, note: (e as Error)?.name === 'AbortError' ? 'timeout' : undefined };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false };
    const j = await res.json();
    if (j.meta) {
      // Realimenta empreendimentos com as LPs descobertas nos anúncios do cliente.
      j.meta.lpsDescobertas = reconcileLpsFromAds(lead, j.meta.validados ?? []);
      lead.anuncios = { meta: j.meta, checkedAt: new Date().toISOString() };
    }
    // Só é sucesso quando a medição veio de verdade (meta preenchido) — resposta
    // "ok" sem meta significa que NADA foi medido (não pode virar "Auditado").
    return { ok: j.ok !== false && !!j.meta, note: j.note };
  } catch {
    return { ok: false };
  }
}

/** DataStone: organograma (diretoria + gerência) + porte. Muta o lead. */
async function fetchDatastone(lead: Lead): Promise<SourceResult> {
  try {
    const res = await motorFetch('/api/datastone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cnpj: lead.cnpj }),
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    if (j.data) {
      lead.organograma = j.data.organograma ?? null;
      lead.datastone = {
        estimatedRevenue: j.data.estimatedRevenue ?? null,
        segment: j.data.segment ?? null,
        employeeCount: j.data.employeeCount ?? null,
        cnaeDescription: j.data.cnaeDescription ?? null,
      };
    }
    return { ok: j.ok !== false, note: j.note }; // datastone_desativado conta como ok (etapa pulada)
  } catch {
    return { ok: false };
  }
}

/**
 * Briefing por IA (Data Intel): análise estratégica + scripts por canal.
 * Roda por ÚLTIMO — usa todo o contexto já coletado (site, empreendimentos,
 * PageSpeed, Google, decisores, porte). Muta lead.briefing.
 */
async function fetchBriefing(lead: Lead, audit: SiteAudit): Promise<SourceResult> {
  try {
    const dmList = await decisionMakersRepo.listByLead(lead.id);
    const decisores = dmList.map((d) => ({ nome: d.nome, cargo: d.cargo }));
    // Sinais confirmados (mesma fonte da UI) — garante que o WhatsApp quebrado e
    // demais gaps ENTREM nas dores/ganchos/scripts do briefing.
    const sinaisConfirmados = computeDores(lead, audit, dmList);
    // WhatsApp CONSOLIDADO (site + LPs + Google) — mesma fonte da UI.
    const waAud = whatsappAudit(lead, audit);
    const wa = waAud.problemas.length
      ? `PROBLEMA de WhatsApp — ${waAud.problemas.join('; ')}`
      : 'WhatsApp funcionando (site e LPs)';
    const brokenBtns = (audit.whatsappButtons ?? []).filter((b) => !b.working);
    const payload = {
      perfil: lead.perfil ?? 'construtoras',
      sinaisConfirmados,
      empresa: lead.razaoSocial ?? lead.companyNameRaw,
      nomeFantasia: lead.nomeFantasia,
      cnae: lead.datastone?.cnaeDescription ?? lead.cnae,
      segmento: lead.datastone?.segment ?? lead.segmento,
      cidade: lead.cidade,
      uf: lead.uf,
      situacao: lead.situacaoCadastral,
      receita: lead.datastone?.estimatedRevenue ?? lead.revenueBandRaw,
      funcionarios: lead.datastone?.employeeCount ?? null,
      site: audit.isOnline
        ? {
            url: audit.siteUrl,
            online: true,
            https: audit.httpsValid,
            loadTimeMs: audit.loadTimeMs,
            pagespeed: audit.pagespeed,
            whatsapp: wa,
            whatsappBroken: brokenBtns.length,
            whatsappStatus: waAud.status,
            whatsappProblemas: waAud.problemas,
            pixel: audit.hasMetaPixel,
            googleTag: audit.hasGoogleTag,
            googleAds: audit.hasGoogleAds ?? false,
            tiktokPixel: audit.hasTiktokPixel ?? false,
            instagram: audit.siteInstagram,
            facebook: audit.siteFacebook,
          }
        : { online: false, obs: 'empresa sem site no ar' },
      empreendimentos: (lead.empreendimentos ?? []).map((e) => ({
        nome: e.nome,
        cidade: e.cidade,
        status: e.status,
      })),
      google: lead.googleBusiness
        ? {
            rating: lead.googleBusiness.rating,
            reviews: lead.googleBusiness.reviews,
            category: lead.googleBusiness.category,
          }
        : null,
      anunciosMeta: lead.anuncios?.meta
        ? {
            validados: lead.anuncios.meta.validados.length,
            aValidar: lead.anuncios.meta.aValidar.length,
            porEmpreendimento: lead.anuncios.meta.porEmpreendimento,
          }
        : null,
      decisores,
    };
    const res = await motorFetch('/api/briefing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false };
    const j = await res.json();
    if (j.briefing) {
      lead.briefing = { ...j.briefing, model: j.model ?? null, generatedAt: new Date().toISOString() };
    }
    return { ok: j.ok !== false, note: j.note }; // ia_desativada conta como ok (etapa pulada)
  } catch {
    return { ok: false };
  }
}

async function enrichOne(lead: Lead): Promise<boolean> {
  const issues: EnrichIssue[] = [];
  const { audit, searchFailed: siteFailed } = await auditLeadSite(lead);
  if (siteFailed)
    issues.push({ source: 'Site / Busca', reason: 'site não descoberto ou busca indisponível — presença digital pode faltar' });
  // PageSpeed (Google) — best-effort; não bloqueia a conclusão.
  if (audit.isOnline && audit.siteUrl) {
    audit.pagespeed = await fetchPagespeed(audit.siteUrl);
    if (!audit.pagespeed)
      issues.push({ source: 'PageSpeed (Google)', reason: 'indisponível ou limite atingido — nota do site aproximada' });
  }
  await leadsRepo.saveAudit(audit);
  const people = await discoverPeople(lead, {
    instagram: audit.siteInstagram,
    facebook: audit.siteFacebook,
  }); // muta lead.companyInstagram/Facebook
  issues.push(...people.issues);
  const ds = await fetchDatastone(lead); // muta lead.organograma / lead.datastone
  const dsI = issueFor('DataStone', ds.ok, ds.note);
  if (dsI) issues.push(dsI);
  const empre = await fetchEmpreendimentos(lead, audit.siteUrl); // muta lead.empreendimentos
  const eI = issueFor('Empreendimentos (IA)', empre.ok, empre.note);
  if (eI) issues.push(eI);
  const gmn = await fetchGoogleBusiness(lead); // muta lead.googleBusiness
  const gI = issueFor('Google Meu Negócio', gmn.ok, gmn.note);
  if (gI) issues.push(gI);
  // NOTA: os anúncios (headless/Meta) NÃO rodam aqui — vão para uma fila em
  // background cadenciada (runAdsQueue), para não tomar bloqueio/ban.
  const briefing = await fetchBriefing(lead, audit); // por último: usa todo o contexto
  const bI = issueFor('Briefing (IA)', briefing.ok, briefing.note);
  if (bI) issues.push(bI);

  // Dedupe por (fonte + motivo).
  const seen = new Set<string>();
  lead.enrichIssues = issues.filter((i) => {
    const k = `${i.source}|${i.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const complete = !siteFailed && people.ok && ds.ok && empre.ok && gmn.ok && briefing.ok;
  const updated: Lead = {
    ...lead,
    status: complete ? 'enriquecido' : 'incompleto',
    score: computeScore(lead, audit),
    updatedAt: new Date().toISOString(),
  };
  await leadsRepo.update(updated);
  lead.status = updated.status; // reflete para o loop de reprocesso
  return complete;
}

// ===========================================================================
// Enriquecimento POR FASE — executado dentro do funil, 1 fase por vez.
// Cada função é IDEMPOTENTE: se o lead já tem o dado daquela fase, NÃO refaz
// (não gasta crédito). Se faltou (ex.: fonte estava fora), completa agora.
// ===========================================================================
export interface FaseResult {
  ok: boolean;
  note?: string;
  resumo?: string;
}

// F2 — Qualificação: organograma/porte (DataStone) + decisor + contatos (Lemit + DataStone).
export async function enrichQualificacao(lead: Lead): Promise<FaseResult> {
  const jaFeito = !!(lead.organograma || lead.datastone); // booleano evita o narrowing do TS
  if (jaFeito) {
    return { ok: true, note: 'ja_feito', resumo: 'já qualificado (dado existente)' };
  }
  const people = await discoverPeople(lead, { instagram: lead.companyInstagram, facebook: lead.companyFacebook });
  const ds = await fetchDatastone(lead);
  lead.score = computeScore(lead);
  lead.updatedAt = new Date().toISOString();
  await leadsRepo.update(lead);
  const dir = lead.organograma?.diretoria?.length ?? 0;
  const ger = lead.organograma?.gerencia?.length ?? 0;
  return { ok: people.ok && ds.ok, note: ds.note, resumo: `diretoria ${dir} · gerência ${ger} · sócios ${lead.socios?.length ?? 0}` };
}

// F3 — Diagnóstico digital: site + PageSpeed + empreendimentos + GMN + briefing.
export async function enrichDiagnostico(lead: Lead, opts?: { force?: boolean }): Promise<FaseResult> {
  if (lead.briefing && !opts?.force) {
    return { ok: true, note: 'ja_feito', resumo: 'já diagnosticado (dado existente)' };
  }
  const { audit, searchFailed } = await auditLeadSite(lead);
  if (audit.isOnline && audit.siteUrl) audit.pagespeed = await fetchPagespeed(audit.siteUrl);
  await leadsRepo.saveAudit(audit);
  const empre = await fetchEmpreendimentos(lead, audit.siteUrl);
  const gmn = await fetchGoogleBusiness(lead);
  const briefing = await fetchBriefing(lead, audit);
  lead.score = computeScore(lead, audit);
  lead.updatedAt = new Date().toISOString();
  await leadsRepo.update(lead);
  const emps = lead.empreendimentos?.length ?? 0;
  return {
    ok: !searchFailed && empre.ok && gmn.ok && briefing.ok,
    resumo: `site ${audit.isOnline ? '✓' : '—'} · ${emps} empreend · GMN ${lead.googleBusiness?.rating ?? '—'}★`,
  };
}

export async function enrichLeads(
  leads: Lead[],
  onProgress?: (p: EnrichProgress) => void,
): Promise<void> {
  const total = leads.length;
  let firstRoundDone = 0;
  let pending = leads.slice();

  // Até 3 rodadas: reprocessa automaticamente o que ficou incompleto.
  for (let round = 0; round < 3 && pending.length > 0; round++) {
    const failed: Lead[] = [];
    await mapLimit(pending, 5, async (lead) => {
      const ok = await enrichOne(lead);
      if (!ok) failed.push(lead);
      if (round === 0) {
        firstRoundDone += 1;
        onProgress?.({ done: firstRoundDone, total });
      }
    });
    pending = failed;
    if (pending.length > 0 && round < 2) await sleep(2500); // backoff entre rodadas
  }
  // Anúncios (headless Meta) NÃO rodam automaticamente — são medidos SOB DEMANDA
  // (botão "Medir agora" por lead), para nunca tomar ban por rajada de requisições.
}

/** Curadoria manual: marca um anúncio como do cliente/descartado (ou limpa). */
export async function setAdDecision(
  lead: Lead,
  adId: string,
  decision: 'validado' | 'a_validar' | 'descartado' | null,
): Promise<void> {
  const meta = lead.anuncios?.meta;
  if (!meta || Array.isArray(meta)) return;
  const dec = { ...(meta.decisoes ?? {}) };
  if (decision === null) delete dec[adId];
  else dec[adId] = decision;
  lead.anuncios = { ...lead.anuncios!, meta: { ...meta, decisoes: dec } };
  await leadsRepo.update(lead);
}

// Audita as LPs que ainda não têm auditoria (ex.: descobertas pelos anúncios):
// velocidade mobile+desktop, SEO, WhatsApp e formulário. Best-effort, sequencial
// (PageSpeed é lento e tem cota).
async function auditPendingLps(lead: Lead): Promise<number> {
  const emps = lead.empreendimentos ?? [];
  // Audita LPs sem auditoria E re-audita as antigas (sem a confirmação headless de
  // pixels) — assim elas ganham desktop + pixels confirmados. `pixelsConfirmed`
  // é o campo mais novo: sua ausência marca auditoria defasada.
  const pendentes = emps.filter((e) => e.lp && (!e.lpAudit || !e.lpAudit.pixelsConfirmed)).slice(0, 10);
  let feitas = 0;
  for (const e of pendentes) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000); // não deixa uma LP travar tudo
    try {
      const res = await motorFetch('/api/audit-lp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ url: e.lp }),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.ok && j.lpAudit) {
          e.lpAudit = j.lpAudit;
          feitas += 1;
        }
      }
    } catch {
      /* best-effort (timeout/rede) — segue pras próximas */
    } finally {
      clearTimeout(timer);
    }
  }
  return feitas;
}

/** Mede os anúncios de UM lead sob demanda (botão "Medir agora"). */
export async function measureLeadAds(lead: Lead): Promise<{ ok: boolean; note?: string }> {
  const audit = await leadsRepo.getAudit(lead.id);
  const r = await fetchAnuncios(lead, audit ?? ({ siteUrl: null } as SiteAudit));
  await auditPendingLps(lead); // audita as LPs recém-descobertas nos anúncios
  await leadsRepo.update(lead);
  return r;
}

/**
 * F4 (Anúncios Meta) do funil: mede e, com a medição feita, RE-GERA o briefing
 * para que dores/ganchos/scripts incorporem os dados de mídia paga — as fases
 * seguintes atualizam o discurso, que não fica preso ao retrato do F3.
 * "ok" SÓ com a medição realmente gravada no lead.
 */
export async function runAnuncios(lead: Lead): Promise<FaseResult> {
  const r = await measureLeadAds(lead);
  const fresh = await leadsRepo.get(lead.id);
  const meta = fresh?.anuncios?.meta;
  const medido = !!meta && !Array.isArray(meta);
  let resumo: string | undefined;
  if (r.ok && medido && fresh) {
    const audit = (await leadsRepo.getAudit(lead.id)) ?? ({ leadId: lead.id, isOnline: false } as unknown as SiteAudit);
    await fetchBriefing(fresh, audit); // re-gera com anúncios no contexto
    fresh.updatedAt = new Date().toISOString();
    await leadsRepo.update(fresh);
    resumo = `${meta.validados.length} validados · ${meta.aValidar.length} a validar · briefing atualizado`;
  }
  return {
    ok: r.ok && medido,
    note: r.note ?? (medido ? undefined : 'meta_nao_medido'),
    resumo,
  };
}

// Espaçamento entre consultas de anúncios no cliente (motor também tem gate).
const ADS_QUEUE_INTERVAL_MS = 40000;
// p-queue: 1 por vez (concurrency 1) e no máximo 1 início a cada ~40s
// (interval + intervalCap) — mesma cadência anti-ban de antes.
const adsQueue = new PQueue({ concurrency: 1, interval: ADS_QUEUE_INTERVAL_MS, intervalCap: 1 });

/**
 * Fila em background: processa os anúncios (Meta headless) lead a lead, com
 * cadência (~40s) para nunca tomar bloqueio. Só um processamento por vez.
 */
export async function runAdsQueue(leads: Lead[]): Promise<void> {
  const fila = leads.filter((l) => !l.anuncios); // pula quem já tem
  await adsQueue.addAll(
    fila.map((lead) => async () => {
      const audit = await leadsRepo.getAudit(lead.id);
      const an = await fetchAnuncios(lead, audit ?? ({ siteUrl: null } as SiteAudit));
      await auditPendingLps(lead); // audita as LPs recém-descobertas nos anúncios (mesmo padrão do measureLeadAds)
      // guarda o aviso da plataforma junto dos demais (sem duplicar)
      const aI = issueFor('Anúncios (Meta)', an.ok, an.note);
      if (aI) {
        const cur = lead.enrichIssues ?? [];
        if (!cur.some((x) => x.source === aI.source)) lead.enrichIssues = [...cur, aI];
      }
      await leadsRepo.update(lead);
    }),
  );
}
