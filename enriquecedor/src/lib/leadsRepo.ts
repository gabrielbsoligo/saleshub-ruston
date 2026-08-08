import type { Lead, SiteAudit } from '../types';
import { supabase, supabaseConfigured } from './supabase';

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

  async get(id: string): Promise<Lead | null> {
    if (!supabaseConfigured) {
      return readLocal<Lead>(LEADS_KEY).find((l) => l.id === id) ?? null;
    }
    const { data, error } = await supabase.from('enriquecedor_leads').select('*').eq('id', id).single();
    if (error) return null;
    return fromRow(data);
  },

  async upsertMany(leads: Lead[]): Promise<void> {
    if (!supabaseConfigured) {
      const existing = readLocal<Lead>(LEADS_KEY);
      const byCnpj = new Map(existing.map((l) => [l.cnpj ?? l.cnpjRaw, l]));
      for (const lead of leads) byCnpj.set(lead.cnpj ?? lead.cnpjRaw, lead);
      writeLocal(LEADS_KEY, [...byCnpj.values()]);
      return;
    }
    const { error } = await supabase
      .from('enriquecedor_leads')
      .upsert(leads.map(toRow), { onConflict: 'cnpj' });
    if (error) throw error;
  },

  async update(lead: Lead): Promise<void> {
    if (!supabaseConfigured) {
      const all = readLocal<Lead>(LEADS_KEY).map((l) => (l.id === lead.id ? lead : l));
      writeLocal(LEADS_KEY, all);
      return;
    }
    const { error } = await supabase.from('enriquecedor_leads').update(toRow(lead)).eq('id', lead.id);
    if (error) throw error;
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

  async saveAudit(audit: SiteAudit): Promise<void> {
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
    dataQuality: (r.data_quality as Lead['dataQuality']) ?? 'suspeito',
    validationNotes: (r.validation_notes as string[]) ?? [],
    status: (r.status as Lead['status']) ?? 'importado',
    score: (r.score as number) ?? null,
    kommoLeadId: (r.kommo_lead_id as string) ?? null,
    createdAt: (r.created_at as string) ?? new Date().toISOString(),
    updatedAt: (r.updated_at as string) ?? new Date().toISOString(),
  };
}

function toRow(l: Lead): Record<string, unknown> {
  return {
    id: l.id,
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
    data_quality: l.dataQuality,
    validation_notes: l.validationNotes,
    status: l.status,
    score: l.score,
    kommo_lead_id: l.kommoLeadId,
    updated_at: new Date().toISOString(),
  };
}
