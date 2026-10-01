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

  /**
   * Grava edições do operador (seleção, Manter/Apagar de redes) nos decisores
   * JÁ existentes — upsert por id. Antes era apagar-e-inserir, que trocava os
   * ids (perdia o vínculo com os envios da cadência) e não era atômico.
   */
  async upsertMany(people: DecisionMaker[]): Promise<void> {
    if (!people.length) return;
    if (!supabaseConfigured) {
      const ids = new Set(people.map((p) => p.id));
      writeLocal([...readLocal().filter((d) => !ids.has(d.id)), ...people]);
      return;
    }
    const comId = people.filter((p) => UUID_RE.test(p.id));
    const semId = people.filter((p) => !UUID_RE.test(p.id));
    if (comId.length) {
      const { error } = await supabase.from('enriquecedor_decision_makers').upsert(comId.map((d) => ({ id: d.id, ...toRow(d) })), { onConflict: 'id' });
      if (error) throw error;
    }
    if (semId.length) {
      const { error } = await supabase.from('enriquecedor_decision_makers').insert(semId.map(toRow));
      if (error) throw error;
    }
  },

  /**
   * Sincroniza a lista descoberta pelo enriquecimento com a que existe no
   * banco: casa por CPF ou nome normalizado; quem já existe é ATUALIZADO
   * preservando o que o operador fez (selecionado, telefones/e-mails marcados,
   * card do Kommo, validação de redes); quem é novo entra; ninguém é apagado.
   * Mesma regra da esteira do motor. Substitui o antigo apagar-e-inserir.
   */
  async syncForLead(leadId: string, novos: DecisionMaker[]): Promise<void> {
    const atuais = await this.listByLead(leadId);
    if (!atuais.length) {
      await this.replaceForLead(leadId, novos);
      return;
    }
    const porCpf = new Map(atuais.filter((d) => d.cpf).map((d) => [digits(d.cpf), d]));
    const porNome = new Map(atuais.map((d) => [normNome(d.nome), d]));
    const inserts: DecisionMaker[] = [];
    const updates: DecisionMaker[] = [];
    for (const n of novos) {
      const ex = (n.cpf ? porCpf.get(digits(n.cpf)) : undefined) ?? porNome.get(normNome(n.nome));
      if (!ex) { inserts.push({ ...n, leadId, id: `novo-${Math.random().toString(36).slice(2)}` }); continue; }
      updates.push({
        ...n,
        id: ex.id,
        leadId,
        cargo: ex.cargo ?? n.cargo,
        isPrimary: ex.isPrimary || n.isPrimary,
        selecionado: ex.selecionado ?? n.selecionado,
        kommoLeadId: ex.kommoLeadId ?? n.kommoLeadId ?? null,
        kommoContactId: ex.kommoContactId ?? n.kommoContactId ?? null,
        instagram: ex.instagramValidacao === 'validado' && ex.instagram ? ex.instagram : n.instagram,
        instagramConfianca: ex.instagramValidacao === 'validado' && ex.instagram ? ex.instagramConfianca : n.instagramConfianca,
        instagramValidacao: ex.instagramValidacao === 'validado' && ex.instagram ? 'validado' : n.instagramValidacao ?? null,
        instagramRejeitados: [...new Set([...(ex.instagramRejeitados ?? []), ...(n.instagramRejeitados ?? [])])],
        linkedin: ex.linkedinValidacao === 'validado' && ex.linkedin ? ex.linkedin : n.linkedin,
        linkedinConfianca: ex.linkedinValidacao === 'validado' && ex.linkedin ? ex.linkedinConfianca : n.linkedinConfianca,
        linkedinValidacao: ex.linkedinValidacao === 'validado' && ex.linkedin ? 'validado' : n.linkedinValidacao ?? null,
        linkedinRejeitados: [...new Set([...(ex.linkedinRejeitados ?? []), ...(n.linkedinRejeitados ?? [])])],
        phones: (n.phones ?? []).map((ph) => ({ ...ph, selecionado: ex.phones?.find((x) => digits(x.numero).slice(-11) === digits(ph.numero).slice(-11))?.selecionado ?? ph.selecionado })),
        emails: (n.emails ?? []).map((em) => ({ ...em, selecionado: ex.emails?.find((x) => x.email.toLowerCase() === em.email.toLowerCase())?.selecionado ?? em.selecionado })),
      });
    }
    if (!supabaseConfigured) {
      const others = readLocal().filter((d) => d.leadId !== leadId);
      const mantidos = atuais.filter((d) => !updates.some((u) => u.id === d.id));
      writeLocal([...others, ...mantidos, ...updates, ...inserts]);
      return;
    }
    if (updates.length) {
      const { error } = await supabase.from('enriquecedor_decision_makers').upsert(updates.map((d) => ({ id: d.id, ...toRow(d) })), { onConflict: 'id' });
      if (error) throw error;
    }
    if (inserts.length) {
      const { error } = await supabase.from('enriquecedor_decision_makers').insert(inserts.map(toRow));
      if (error) throw error;
    }
  },

  // Substitui todos os sócios de um lead pela nova lista (usado só quando não há nenhum).
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
const normNome = (s: string | null | undefined) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

function toRow(d: DecisionMaker): Record<string, unknown> {
  return {
    lead_id: d.leadId,
    nome: d.nome,
    cargo: d.cargo,
    is_primary: d.isPrimary,
    kommo_lead_id: d.kommoLeadId ?? null,
    // Escolha do F2 (quem vai ser trabalhado / pro Kommo) e os contatos
    // consolidados (Lemit + DataStone) com a flag de seleção — antes ficavam só
    // na tela e sumiam ao recarregar (migration_149).
    selecionado: !!d.selecionado,
    phones: d.phones ?? null,
    emails: d.emails ?? null,
    cpf: d.cpf,
    phone_personal: d.phonePersonal,
    phone_whatsapp: d.phoneWhatsapp,
    email_personal: d.emailPersonal,
    instagram: d.instagram,
    instagram_confianca: d.instagramConfianca ?? null,
    instagram_validacao: d.instagramValidacao ?? null,
    instagram_rejeitados: d.instagramRejeitados ?? [],
    facebook: d.facebook,
    linkedin: d.linkedin,
    linkedin_confianca: d.linkedinConfianca ?? null,
    linkedin_validacao: d.linkedinValidacao ?? null,
    linkedin_rejeitados: d.linkedinRejeitados ?? [],
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
    kommoLeadId: (r.kommo_lead_id as string) ?? null,
    selecionado: Boolean(r.selecionado),
    phones: (r.phones as DecisionMaker['phones']) ?? undefined,
    emails: (r.emails as DecisionMaker['emails']) ?? undefined,
    cpf: (r.cpf as string) ?? null,
    phonePersonal: (r.phone_personal as string) ?? null,
    phoneWhatsapp: Boolean(r.phone_whatsapp),
    emailPersonal: (r.email_personal as string) ?? null,
    instagram: (r.instagram as string) ?? null,
    instagramConfianca: (r.instagram_confianca as DecisionMaker['instagramConfianca']) ?? null,
    instagramValidacao: (r.instagram_validacao as DecisionMaker['instagramValidacao']) ?? null,
    instagramRejeitados: (r.instagram_rejeitados as string[]) ?? [],
    facebook: (r.facebook as string) ?? null,
    linkedin: (r.linkedin as string) ?? null,
    linkedinConfianca: (r.linkedin_confianca as DecisionMaker['linkedinConfianca']) ?? null,
    linkedinValidacao: (r.linkedin_validacao as DecisionMaker['linkedinValidacao']) ?? null,
    linkedinRejeitados: (r.linkedin_rejeitados as string[]) ?? [],
    confidence: (r.confidence as number) ?? 0,
    source: (r.source as string) ?? null,
    kommoContactId: (r.kommo_contact_id as string) ?? null,
    companiesCount: (r.companies_count as number) ?? 0,
    companies: (r.companies as DecisionMaker['companies']) ?? [],
    lemit: (r.lemit as DecisionMaker['lemit']) ?? null,
  };
}
