import type { Lead, SiteAudit } from '../types';
import { supabase, supabaseConfigured } from './supabase';
import { preservarValidacoes } from './chavesBusca';

// Repositório de leads. Em modo local (sem Supabase) persiste em localStorage,
// para permitir testar o fluxo completo antes de existir o banco. Quando o
// Supabase estiver configurado, as mesmas operações vão para o Postgres.

const LEADS_KEY = 'sdna_outbound_leads';
const AUDITS_KEY = 'sdna_outbound_audits';

function readLocal<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as T[];
  } catch {
    return [];
  }
}

function writeLocal<T>(key: string, value: T[]): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export const leadsRepo = {
  async list(): Promise<Lead[]> {
    if (!supabaseConfigured) {
      return readLocal<Lead>(LEADS_KEY).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
    }
    const { data, error } = await supabase
      .from('enriquecedor_leads')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(fromRow);
  },

  /**
   * O que já foi auditado, inferido dos DADOS (não do status do projeto): F2 = tem
   * decisores; F3 = tem briefing e auditoria de site; F4 = mediu a Meta. Serve pra
   * leads enriquecidos pela esteira/LeadDetail antes do funil gravar status — sem
   * re-rodar (e pagar) o que já está feito.
   */
  async auditoriasFeitas(ids: string[]): Promise<Record<string, { f2: boolean; f3: boolean; f4: boolean }>> {
    const out: Record<string, { f2: boolean; f3: boolean; f4: boolean }> = {};
    if (!ids.length || !supabaseConfigured) return out;
    for (let i = 0; i < ids.length; i += 200) {
      const lote = ids.slice(i, i + 200);
      const [{ data: leads }, { data: decs }, { data: auds }] = await Promise.all([
        supabase.from('enriquecedor_leads').select('id, briefing, anuncios').in('id', lote),
        supabase.from('enriquecedor_decision_makers').select('lead_id').in('lead_id', lote),
        supabase.from('enriquecedor_site_audits').select('lead_id').in('lead_id', lote),
      ]);
      const comDecisor = new Set((decs ?? []).map((d) => String(d.lead_id)));
      const comAudit = new Set((auds ?? []).map((a) => String(a.lead_id)));
      for (const r of leads ?? []) {
        const id = String(r.id);
        const an = r.anuncios as { meta?: unknown } | null;
        out[id] = { f2: comDecisor.has(id), f3: r.briefing != null && comAudit.has(id), f4: !!an?.meta };
      }
    }
    return out;
  },

  /** Quem já tem card no Kommo, em UMA consulta (F8 — antes era 1 GET por lead). */
  async kommoIds(ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {};
    if (!supabaseConfigured) {
      const out: Record<string, string> = {};
      for (const l of readLocal<Lead>(LEADS_KEY)) if (ids.includes(l.id) && l.kommoLeadId) out[l.id] = l.kommoLeadId;
      return out;
    }
    const out: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('enriquecedor_leads').select('id, kommo_lead_id').in('id', ids.slice(i, i + 200)).not('kommo_lead_id', 'is', null);
      for (const r of data ?? []) if (r.kommo_lead_id) out[String(r.id)] = String(r.kommo_lead_id);
    }
    return out;
  },

  async get(id: string): Promise<Lead | null> {
    if (!supabaseConfigured) {
      return readLocal<Lead>(LEADS_KEY).find((l) => l.id === id) ?? null;
    }
    const { data, error } = await supabase.from('enriquecedor_leads').select('*').eq('id', id).single();
    if (error) return null;
    return fromRow(data);
  },

  /**
   * Importação. CNPJ que JÁ existe no banco NÃO perde o enriquecimento: só os
   * dados da planilha (cnpj_raw, nome, faixa, telefone, e-mail) e o perfil são
   * atualizados, e o lead devolvido carrega o id que já existia (o funil aponta
   * pra ele). CNPJ novo é inserido inteiro. Devolve os leads como ficaram.
   */
  async upsertMany(leads: Lead[]): Promise<Lead[]> {
    if (!supabaseConfigured) {
      const existing = readLocal<Lead>(LEADS_KEY);
      const byCnpj = new Map(existing.map((l) => [l.cnpj ?? l.cnpjRaw, l]));
      const out: Lead[] = [];
      for (const lead of leads) {
        const k = lead.cnpj ?? lead.cnpjRaw;
        const ex = byCnpj.get(k);
        const next = ex ? { ...ex, cnpjRaw: lead.cnpjRaw, companyNameRaw: lead.companyNameRaw, revenueBandRaw: lead.revenueBandRaw, phoneRaw: lead.phoneRaw, emailRaw: lead.emailRaw, perfil: lead.perfil, updatedAt: new Date().toISOString() } : lead;
        byCnpj.set(k, next);
        out.push(next);
      }
      writeLocal(LEADS_KEY, [...byCnpj.values()]);
      return out;
    }
    const cnpjs = leads.map((l) => l.cnpj).filter((c): c is string => !!c);
    const existentes = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < cnpjs.length; i += 200) {
      const { data, error } = await supabase.from('enriquecedor_leads').select('*').in('cnpj', cnpjs.slice(i, i + 200));
      if (error) throw erroLegivel(error);
      for (const r of data ?? []) existentes.set(String(r.cnpj), r);
    }
    const novos: Lead[] = [];
    const out: Lead[] = [];
    for (const lead of leads) {
      const r = lead.cnpj ? existentes.get(lead.cnpj) : undefined;
      if (!r) { novos.push(lead); out.push(lead); continue; }
      const patch = {
        cnpj_raw: lead.cnpjRaw,
        company_name_raw: lead.companyNameRaw,
        revenue_band_raw: lead.revenueBandRaw,
        phone_raw: lead.phoneRaw,
        email_raw: lead.emailRaw,
        perfil: lead.perfil,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('enriquecedor_leads').update(patch).eq('id', String(r.id));
      if (error) throw erroLegivel(error);
      out.push({ ...fromRow(r), ...fromRow({ ...r, ...patch }) });
    }
    // Lote de novos: um CNPJ repetido dentro do lote derruba o lote inteiro —
    // quem chama deduplica (WorkflowView faz).
    for (let i = 0; i < novos.length; i += 100) {
      const { error } = await supabase.from('enriquecedor_leads').upsert(novos.slice(i, i + 100).map(toRow), { onConflict: 'cnpj' });
      if (error) throw erroLegivel(error);
    }
    return out;
  },

  /**
   * Grava o lead inteiro. Por padrão PROTEGE o que o operador validou/apagou no
   * banco enquanto a execução rodava (ver preservarValidacoes). O bloco Chaves de
   * busca passa `forcarChaves: true` porque ele é justamente quem muda validação.
   */
  async update(lead: Lead, opts: { forcarChaves?: boolean } = {}): Promise<void> {
    if (!supabaseConfigured) {
      const all = readLocal<Lead>(LEADS_KEY).map((l) => (l.id === lead.id ? lead : l));
      writeLocal(LEADS_KEY, all);
      return;
    }
    let final = lead;
    if (!opts.forcarChaves) {
      const { data } = await supabase.from('enriquecedor_leads').select('chaves_busca, site_url, company_instagram, company_facebook, google_business').eq('id', lead.id).maybeSingle();
      if (data) final = preservarValidacoes(lead, fromRow({ ...data, id: lead.id }));
    }
    const { error } = await supabase.from('enriquecedor_leads').update(toRow(final)).eq('id', lead.id);
    if (error) throw erroLegivel(error);
  },

  /**
   * Grava SÓ as colunas tocadas (patch). É o caminho padrão das fases: cada uma
   * escreve o que produziu, sem levar junto um retrato velho das outras colunas
   * (era isso que apagava F4/cadência quando o F3 terminava). Mesma proteção de
   * chaves validadas do update() quando o patch toca site/redes/GMN.
   */
  async patch(id: string, parcial: Partial<Lead>, opts: { forcarChaves?: boolean } = {}): Promise<void> {
    const chavesTocadas = Object.keys(parcial) as (keyof Lead)[];
    if (!chavesTocadas.length) return;
    if (!supabaseConfigured) {
      const all = readLocal<Lead>(LEADS_KEY).map((l) => (l.id === id ? { ...l, ...parcial, updatedAt: new Date().toISOString() } : l));
      writeLocal(LEADS_KEY, all);
      return;
    }
    let p: Partial<Lead> = { ...parcial };
    const protegidas: (keyof Lead)[] = ['siteUrl', 'companyInstagram', 'companyFacebook', 'googleBusiness', 'chavesBusca'];
    if (!opts.forcarChaves && chavesTocadas.some((k) => protegidas.includes(k))) {
      const { data } = await supabase.from('enriquecedor_leads').select('chaves_busca, site_url, company_instagram, company_facebook, google_business').eq('id', id).maybeSingle();
      if (data) {
        const db = fromRow({ ...data, id });
        const merged = preservarValidacoes({ ...db, ...parcial, id } as Lead, db);
        p = {};
        for (const k of [...chavesTocadas, 'chavesBusca'] as (keyof Lead)[]) (p as Record<string, unknown>)[k] = merged[k];
      }
    }
    const row = toRow({ id, ...p } as unknown as Lead);
    const sel: Record<string, unknown> = { updated_at: row.updated_at };
    for (const k of Object.keys(p) as (keyof Lead)[]) {
      const col = COLUNA[k];
      if (col && col in row) sel[col] = row[col];
    }
    const { error } = await supabase.from('enriquecedor_leads').update(sel).eq('id', id);
    if (error) throw erroLegivel(error);
  },

  async remove(id: string): Promise<void> {
    if (!supabaseConfigured) {
      writeLocal(
        LEADS_KEY,
        readLocal<Lead>(LEADS_KEY).filter((l) => l.id !== id),
      );
      writeLocal(
        AUDITS_KEY,
        readLocal<SiteAudit>(AUDITS_KEY).filter((a) => a.leadId !== id),
      );
      return;
    }
    const { error } = await supabase.from('enriquecedor_leads').delete().eq('id', id);
    if (error) throw error;
  },

  async clear(): Promise<void> {
    if (!supabaseConfigured) {
      localStorage.removeItem(LEADS_KEY);
      localStorage.removeItem(AUDITS_KEY);
      return;
    }
    const { error } = await supabase.from('enriquecedor_leads').delete().neq('id', '');
    if (error) throw error;
  },

  /**
   * Grava a auditoria do site. Uma auditoria VAZIA (motor fora, busca falhou)
   * não sobrescreve uma auditoria boa já existente — antes o "Re-enriquecer"
   * com o motor instável zerava site/pixels/WhatsApp do lead.
   */
  async saveAudit(audit: SiteAudit, opts: { preservarBoa?: boolean } = {}): Promise<void> {
    if (opts.preservarBoa !== false && !audit.isOnline && !audit.siteUrl) {
      const ex = await this.getAudit(audit.leadId);
      if (ex?.isOnline && ex.siteUrl) return;
    }
    if (!supabaseConfigured) {
      const audits = readLocal<SiteAudit>(AUDITS_KEY).filter((a) => a.leadId !== audit.leadId);
      audits.push(audit);
      writeLocal(AUDITS_KEY, audits);
      return;
    }
    const { error } = await supabase
      .from('enriquecedor_site_audits')
      .upsert(auditToRow(audit), { onConflict: 'lead_id' });
    if (error) throw error;
  },

  /** Atualiza só partes da auditoria (ex.: PageSpeed que chegou depois, fora do caminho crítico). */
  async patchAudit(leadId: string, parcial: Partial<Pick<SiteAudit, 'pagespeed' | 'notes'>>): Promise<void> {
    if (!supabaseConfigured) {
      const audits = readLocal<SiteAudit>(AUDITS_KEY).map((a) => (a.leadId === leadId ? { ...a, ...parcial } : a));
      writeLocal(AUDITS_KEY, audits);
      return;
    }
    const row: Record<string, unknown> = {};
    if ('pagespeed' in parcial) row.pagespeed = parcial.pagespeed ?? null;
    if ('notes' in parcial) row.notes = parcial.notes ?? [];
    if (!Object.keys(row).length) return;
    const { error } = await supabase.from('enriquecedor_site_audits').update(row).eq('lead_id', leadId);
    if (error) throw error;
  },

  async getAudit(leadId: string): Promise<SiteAudit | null> {
    if (!supabaseConfigured) {
      return readLocal<SiteAudit>(AUDITS_KEY).find((a) => a.leadId === leadId) ?? null;
    }
    const { data } = await supabase.from('enriquecedor_site_audits').select('*').eq('lead_id', leadId).single();
    return data ? auditFromRow(data) : null;
  },
};

function auditToRow(a: SiteAudit): Record<string, unknown> {
  return {
    lead_id: a.leadId,
    site_url: a.siteUrl,
    source: a.source,
    is_online: a.isOnline,
    http_status: a.httpStatus,
    https_valid: a.httpsValid,
    load_time_ms: a.loadTimeMs,
    whatsapp_buttons: a.whatsappButtons,
    has_whatsapp_widget: a.hasWhatsappWidget,
    has_meta_pixel: a.hasMetaPixel,
    has_google_tag: a.hasGoogleTag,
    site_instagram: a.siteInstagram,
    site_facebook: a.siteFacebook,
    pagespeed: a.pagespeed,
    notes: a.notes,
    checked_at: a.checkedAt,
  };
}

function auditFromRow(r: Record<string, unknown>): SiteAudit {
  return {
    id: (r.id as string) ?? (r.lead_id as string),
    leadId: r.lead_id as string,
    siteUrl: (r.site_url as string) ?? null,
    source: (r.source as string) ?? null,
    isOnline: Boolean(r.is_online),
    httpStatus: (r.http_status as number) ?? null,
    bloqueado: Boolean(r.is_online) && Number(r.http_status ?? 200) >= 400,
    httpsValid: Boolean(r.https_valid),
    loadTimeMs: (r.load_time_ms as number) ?? null,
    whatsappButtons: (r.whatsapp_buttons as SiteAudit['whatsappButtons']) ?? [],
    hasWhatsappWidget: Boolean(r.has_whatsapp_widget),
    hasMetaPixel: Boolean(r.has_meta_pixel),
    hasGoogleTag: Boolean(r.has_google_tag),
    siteInstagram: (r.site_instagram as string) ?? null,
    siteFacebook: (r.site_facebook as string) ?? null,
    pagespeed: (r.pagespeed as SiteAudit['pagespeed']) ?? null,
    notes: (r.notes as string[]) ?? [],
    checkedAt: (r.checked_at as string) ?? new Date().toISOString(),
  };
}

// Mapeamento snake_case (Postgres) <-> camelCase (app). Só usado com Supabase.
function fromRow(r: Record<string, unknown>): Lead {
  return {
    id: r.id as string,
    perfil: (r.perfil as Lead['perfil']) ?? 'construtoras',
    cnpjRaw: (r.cnpj_raw as string) ?? '',
    companyNameRaw: (r.company_name_raw as string) ?? '',
    revenueBandRaw: (r.revenue_band_raw as string) ?? null,
    phoneRaw: (r.phone_raw as string) ?? null,
    emailRaw: (r.email_raw as string) ?? null,
    siteUrl: (r.site_url as string) ?? null,
    cnpj: (r.cnpj as string) ?? null,
    razaoSocial: (r.razao_social as string) ?? null,
    nomeFantasia: (r.nome_fantasia as string) ?? null,
    cnae: (r.cnae as string) ?? null,
    segmento: (r.segmento as string) ?? null,
    cidade: (r.cidade as string) ?? null,
    uf: (r.uf as string) ?? null,
    situacaoCadastral: (r.situacao_cadastral as string) ?? null,
    socios: (r.socios as Lead['socios']) ?? [],
    companyInstagram: (r.company_instagram as string) ?? null,
    companyFacebook: (r.company_facebook as string) ?? null,
    empreendimentos: (r.empreendimentos as Lead['empreendimentos']) ?? [],
    googleBusiness: (r.google_business as Lead['googleBusiness']) ?? null,
    lemitCompany: (r.lemit_company as Lead['lemitCompany']) ?? null,
    organograma: (r.organograma as Lead['organograma']) ?? null,
    datastone: (r.datastone as Lead['datastone']) ?? null,
    briefing: (r.briefing as Lead['briefing']) ?? null,
    enrichIssues: (r.enrich_issues as Lead['enrichIssues']) ?? [],
    anuncios: (r.anuncios as Lead['anuncios']) ?? null,
    chavesBusca: (r.chaves_busca as Lead['chavesBusca']) ?? {},
    falhaPrimaria: (r.falha_primaria as Lead['falhaPrimaria']) ?? null,
    falhaSecundaria: (r.falha_secundaria as Lead['falhaSecundaria']) ?? null,
    falhasDetectadas: (r.falhas_detectadas as Lead['falhasDetectadas']) ?? [],
    aptoCadencia: (r.apto_cadencia as boolean) ?? false,
    cadenciaConfig: (r.cadencia_config as Lead['cadenciaConfig']) ?? null,
    optout: (r.optout as boolean) ?? false,
    dataQuality: (r.data_quality as Lead['dataQuality']) ?? 'suspeito',
    validationNotes: (r.validation_notes as string[]) ?? [],
    status: (r.status as Lead['status']) ?? 'importado',
    score: (r.score as number) ?? null,
    kommoLeadId: (r.kommo_lead_id as string) ?? null,
    createdAt: (r.created_at as string) ?? new Date().toISOString(),
    updatedAt: (r.updated_at as string) ?? new Date().toISOString(),
  };
}

function erroLegivel(error: { message: string; details?: string | null; code?: string | null }): Error {
  return new Error(`${error.message}${error.details ? ` — ${error.details}` : ''}${error.code ? ` (${error.code})` : ''}`);
}

// camelCase (app) → coluna. Usado pelo patch() para gravar só o que foi tocado.
const COLUNA: Partial<Record<keyof Lead, string>> = {
  perfil: 'perfil', cnpjRaw: 'cnpj_raw', companyNameRaw: 'company_name_raw', revenueBandRaw: 'revenue_band_raw', phoneRaw: 'phone_raw', emailRaw: 'email_raw',
  siteUrl: 'site_url', cnpj: 'cnpj', razaoSocial: 'razao_social', nomeFantasia: 'nome_fantasia', cnae: 'cnae', segmento: 'segmento', cidade: 'cidade', uf: 'uf',
  situacaoCadastral: 'situacao_cadastral', socios: 'socios', companyInstagram: 'company_instagram', companyFacebook: 'company_facebook', empreendimentos: 'empreendimentos',
  googleBusiness: 'google_business', lemitCompany: 'lemit_company', organograma: 'organograma', datastone: 'datastone', briefing: 'briefing', enrichIssues: 'enrich_issues',
  anuncios: 'anuncios', chavesBusca: 'chaves_busca', falhaPrimaria: 'falha_primaria', falhaSecundaria: 'falha_secundaria', falhasDetectadas: 'falhas_detectadas',
  aptoCadencia: 'apto_cadencia', cadenciaConfig: 'cadencia_config', optout: 'optout', dataQuality: 'data_quality', validationNotes: 'validation_notes', status: 'status',
  score: 'score', kommoLeadId: 'kommo_lead_id',
};

function toRow(l: Lead): Record<string, unknown> {
  return {
    id: l.id,
    perfil: l.perfil ?? 'construtoras',
    cnpj_raw: l.cnpjRaw,
    company_name_raw: l.companyNameRaw,
    revenue_band_raw: l.revenueBandRaw,
    phone_raw: l.phoneRaw,
    email_raw: l.emailRaw,
    site_url: l.siteUrl,
    cnpj: l.cnpj,
    razao_social: l.razaoSocial,
    nome_fantasia: l.nomeFantasia,
    cnae: l.cnae,
    segmento: l.segmento,
    cidade: l.cidade,
    uf: l.uf,
    situacao_cadastral: l.situacaoCadastral,
    socios: l.socios,
    company_instagram: l.companyInstagram,
    company_facebook: l.companyFacebook,
    empreendimentos: l.empreendimentos,
    google_business: l.googleBusiness,
    lemit_company: l.lemitCompany,
    organograma: l.organograma ?? null,
    datastone: l.datastone ?? null,
    briefing: l.briefing ?? null,
    enrich_issues: l.enrichIssues ?? [],
    anuncios: l.anuncios ?? null,
    chaves_busca: l.chavesBusca ?? {},
    falha_primaria: l.falhaPrimaria ?? null,
    falha_secundaria: l.falhaSecundaria ?? null,
    falhas_detectadas: l.falhasDetectadas ?? [],
    apto_cadencia: l.aptoCadencia ?? false,
    cadencia_config: l.cadenciaConfig ?? {},
    optout: l.optout ?? false,
    data_quality: l.dataQuality,
    validation_notes: l.validationNotes,
    status: l.status,
    score: l.score,
    kommo_lead_id: l.kommoLeadId,
    updated_at: new Date().toISOString(),
  };
}
