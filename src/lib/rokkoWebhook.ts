// =============================================================
// Rokko webhook emitter — "lead ganho"
// =============================================================
// Quando um deal transiciona para contrato_assinado, dispara o webhook
// no Rokko (https://rokko.rustontools.tech/api/webhooks/lead-intake)
// que abre um projeto de onboarding pro time de operacoes.
//
// O secret vive no Supabase como ROKKO_WEBHOOK_SECRET. O frontend
// chama uma Edge Function (notify-rokko-ganho) que faz o proxy
// autenticado — secret nunca vai pro browser.
//
// Payload Rokko:
//   client_name, contact_name, contact_email, contact_phone,
//   kommo_lead_id, kommo_link, sold_by_email,
//   valor_recorrente, produtos_recorrente, project_start_date
//
// Comportamento: fire-and-forget — erros so' logam, nao bloqueiam
// o fluxo principal do "ganho".
// =============================================================
import { supabase } from './supabase';
import type { Deal } from '../types';

interface RokkoPayload {
  client_name: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  kommo_lead_id?: string | null;
  kommo_link?: string | null;
  sold_by_email?: string | null;
  valor_recorrente?: number | null;
  produtos_recorrente?: string[];
  project_start_date?: string | null;
}

export async function emitDealGanhoWebhook(deal: Partial<Deal>): Promise<void> {
  if (!deal.id) {
    console.warn('[rokkoWebhook] Deal sem id — pulando.');
    return;
  }

  // Resolve closer email + lead contato em paralelo (latencia minima)
  const [closerRes, leadRes] = await Promise.all([
    deal.closer_id
      ? supabase.from('team_members').select('email').eq('id', deal.closer_id).maybeSingle()
      : Promise.resolve({ data: null } as any),
    deal.lead_id
      ? supabase.from('leads').select('nome_contato, email, telefone').eq('id', deal.lead_id).maybeSingle()
      : Promise.resolve({ data: null } as any),
  ]);

  const closerEmail: string | null = closerRes?.data?.email || null;
  const lead = leadRes?.data || null;

  const payload: RokkoPayload = {
    client_name: deal.empresa || '(sem nome)',
    contact_name: lead?.nome_contato || null,
    contact_email: lead?.email || null,
    contact_phone: lead?.telefone || null,
    kommo_lead_id: deal.kommo_id || null,
    kommo_link: deal.kommo_link || null,
    sold_by_email: closerEmail,
    valor_recorrente: deal.valor_recorrente || deal.valor_mrr || 0,
    produtos_recorrente: deal.produtos_mrr || [],
    project_start_date: deal.data_inicio_recorrente || deal.data_fechamento || null,
  };

  console.log('[rokkoWebhook] disparando', { empresa: payload.client_name });

  try {
    const { data, error } = await supabase.functions.invoke('notify-rokko-ganho', {
      body: payload,
    });
    if (error) {
      console.error('[rokkoWebhook] Edge function erro:', error);
      return;
    }
    console.log('[rokkoWebhook] OK', data);
  } catch (err) {
    console.error('[rokkoWebhook] Erro inesperado:', err);
  }
}
