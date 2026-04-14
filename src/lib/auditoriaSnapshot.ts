// Helper: serializa um lead/deal + relações no momento da auditoria.
// Usado pra preencher snapshot_saleshub no auditoria_registros.

import type { Lead, Deal, Reuniao, TeamMember } from '../types';

export interface SaleshubSnapshot {
  item_tipo: 'lead' | 'deal';
  item_id: string;
  captured_at: string;
  item: any;
  sdr?: TeamMember | null;
  closer?: TeamMember | null;
  reunioes: Reuniao[];
  related_lead?: Lead | null;
  related_deal?: Deal | null;
}

export function snapshotLead(
  lead: Lead,
  members: TeamMember[],
  reunioes: Reuniao[],
  deals: Deal[],
): SaleshubSnapshot {
  const sdr = lead.sdr_id ? members.find(m => m.id === lead.sdr_id) : null;
  const lead_reunioes = reunioes.filter(r => r.lead_id === lead.id);
  const related_deal = deals.find(d => d.lead_id === lead.id) || null;
  return {
    item_tipo: 'lead',
    item_id: lead.id,
    captured_at: new Date().toISOString(),
    item: { ...lead },
    sdr: sdr || null,
    reunioes: lead_reunioes,
    related_deal,
  };
}

export function snapshotDeal(
  deal: Deal,
  members: TeamMember[],
  reunioes: Reuniao[],
  leads: Lead[],
): SaleshubSnapshot {
  const sdr = deal.sdr_id ? members.find(m => m.id === deal.sdr_id) : null;
  const closer = deal.closer_id ? members.find(m => m.id === deal.closer_id) : null;
  const deal_reunioes = reunioes.filter(r => r.deal_id === deal.id);
  const related_lead = deal.lead_id ? (leads.find(l => l.id === deal.lead_id) || null) : null;
  return {
    item_tipo: 'deal',
    item_id: deal.id,
    captured_at: new Date().toISOString(),
    item: { ...deal },
    sdr: sdr || null,
    closer: closer || null,
    reunioes: deal_reunioes,
    related_lead,
  };
}

export function getResponsavelId(snapshot: SaleshubSnapshot): string | undefined {
  // Closer prevalece quando existe, senao SDR.
  return snapshot.closer?.id || snapshot.sdr?.id;
}

export function getKommoLeadIdFromItem(item: Lead | Deal): number | null {
  const raw = (item as any).kommo_id;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
