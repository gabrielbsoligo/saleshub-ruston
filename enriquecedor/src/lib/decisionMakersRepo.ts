import type { DecisionMaker } from '../types';
import { supabase, supabaseConfigured } from './supabase';

const KEY = 'sdna_outbound_decisores';

function readLocal(): DecisionMaker[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as DecisionMaker[];
  } catch {
    return [];
  }
}

function writeLocal(v: DecisionMaker[]): void {
  localStorage.setItem(KEY, JSON.stringify(v));
}

export const decisionMakersRepo = {
  // Lista todos os sócios-pessoas de um lead (primário primeiro).
  async listByLead(leadId: string): Promise<DecisionMaker[]> {
    if (!supabaseConfigured) {
      return readLocal()
        .filter((d) => d.leadId === leadId)
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
    }
    const { data } = await supabase
      .from('enriquecedor_decision_makers')
      .select('*')
      .eq('lead_id', leadId)
      .order('is_primary', { ascending: false });
    return (data ?? []).map(fromRow);
  },

  // Substitui todos os sócios de um lead pela nova lista.
  async replaceForLead(leadId: string, people: DecisionMaker[]): Promise<void> {
    if (!supabaseConfigured) {
      const others = readLocal().filter((d) => d.leadId !== leadId);
      writeLocal([...others, ...people]);
      return;
    }
    await supabase.from('enriquecedor_decision_makers').delete().eq('lead_id', leadId);
    if (people.length > 0) {
      const { error } = await supabase.from('enriquecedor_decision_makers').insert(people.map(toRow));
      if (error) throw error;
    }
  },
};

function toRow(d: DecisionMaker): Record<string, unknown> {
  return {
    lead_id: d.leadId,
    nome: d.nome,
    cargo: d.cargo,
    is_primary: d.isPrimary,
    cpf: d.cpf,
    phone_personal: d.phonePersonal,
    phone_whatsapp: d.phoneWhatsapp,
    email_personal: d.emailPersonal,
    instagram: d.instagram,
    facebook: d.facebook,
    linkedin: d.linkedin,
    confidence: d.confidence,
    source: d.source,
    kommo_contact_id: d.kommoContactId,
    companies_count: d.companiesCount,
    companies: d.companies,
    lemit: d.lemit,
  };
}

function fromRow(r: Record<string, unknown>): DecisionMaker {
  return {
    id: (r.id as string) ?? `${r.lead_id}`,
    leadId: r.lead_id as string,
    nome: (r.nome as string) ?? '',
    cargo: (r.cargo as string) ?? null,
    isPrimary: Boolean(r.is_primary),
    cpf: (r.cpf as string) ?? null,
    phonePersonal: (r.phone_personal as string) ?? null,
    phoneWhatsapp: Boolean(r.phone_whatsapp),
    emailPersonal: (r.email_personal as string) ?? null,
    instagram: (r.instagram as string) ?? null,
    facebook: (r.facebook as string) ?? null,
    linkedin: (r.linkedin as string) ?? null,
    confidence: (r.confidence as number) ?? 0,
    source: (r.source as string) ?? null,
    kommoContactId: (r.kommo_contact_id as string) ?? null,
    companiesCount: (r.companies_count as number) ?? 0,
    companies: (r.companies as DecisionMaker['companies']) ?? [],
    lemit: (r.lemit as DecisionMaker['lemit']) ?? null,
  };
}
