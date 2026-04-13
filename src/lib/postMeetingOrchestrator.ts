// =============================================
// PostMeetingOrchestrator (client thin wrapper)
//
// O fluxo pesado (fetch transcript -> analyze -> apply) roda 100% server-side
// via Edge Function `google-drive` + pg_cron (a cada 5 min).
//
// Este modulo apenas:
//  1. Cria o registro em post_meeting_automations
//  2. Dispara um tick imediato no Edge Function (para feedback rapido na UI)
//  3. Inscreve via Realtime nas mudancas de status para alimentar callbacks
// =============================================

import { supabase } from './supabase';
import type { PostMeetingAutomation } from '../types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface OrchestratorCallbacks {
  onStatusChange: (automationId: string, status: PostMeetingAutomation['status']) => void;
  onPollingUpdate?: (attempt: number, maxAttempts: number) => void; // mantido por compatibilidade da UI
  onComplete: (automationId: string, actions: ActionsTaken) => void;
  onError: (automationId: string, error: string) => void;
}

export interface ActionsTaken {
  deal_updated: boolean;
  deal_fields: string[];
  leads_created: number;
  lead_ids: string[];
  meeting_scheduled: boolean;
  next_reuniao_id?: string;
  transcript_url?: string;
  recording_url?: string;
}

async function triggerProcessPending(): Promise<void> {
  // best-effort: dispara um tick imediato para reduzir latencia perceptiva.
  // Falhas aqui sao OK -- o pg_cron vai pegar no proximo intervalo.
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/google-drive`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ action: 'process_pending' }),
    });
  } catch (e) {
    console.warn('triggerProcessPending falhou (cron vai pegar):', e);
  }
}

/**
 * Cria a automacao e se inscreve nas mudancas de status.
 * Resolve quando atingir 'completed' ou 'error'.
 */
export async function runPostMeetingAutomation(
  reuniaoId: string,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  // Buscar deal associado
  const { data: reuniao } = await supabase
    .from('reunioes')
    .select('id, lead_id, realizada, show')
    .eq('id', reuniaoId)
    .single();

  if (!reuniao) throw new Error('Reuniao nao encontrada');
  if (!reuniao.realizada || !reuniao.show) throw new Error('Reuniao nao foi confirmada como show');

  let dealId: string | null = null;
  const { data: dealByReuniao } = await supabase.from('deals').select('id').eq('reuniao_id', reuniaoId).maybeSingle();
  if (dealByReuniao?.id) dealId = dealByReuniao.id;
  else if (reuniao.lead_id) {
    const { data: dealByLead } = await supabase.from('deals')
      .select('id').eq('lead_id', reuniao.lead_id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    dealId = dealByLead?.id || null;
  }

  // Criar automacao (UNIQUE em reuniao_id garante idempotencia)
  const { data: automation, error: createError } = await supabase
    .from('post_meeting_automations')
    .insert({ reuniao_id: reuniaoId, deal_id: dealId, status: 'pending' })
    .select('*')
    .single();

  if (createError) {
    if (createError.code === '23505') throw new Error('Automacao ja foi executada para esta reuniao');
    throw new Error(`Erro ao criar automacao: ${createError.message}`);
  }

  const automationId = automation.id;
  callbacks.onStatusChange(automationId, 'pending');

  // Dispara tick imediato (best-effort)
  triggerProcessPending();

  // Inscreve em Realtime para mudancas de status
  const channel = supabase
    .channel(`automation:${automationId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'post_meeting_automations', filter: `id=eq.${automationId}` },
      (payload: any) => {
        const row = payload.new as PostMeetingAutomation;
        callbacks.onStatusChange(automationId, row.status);
        if (row.status === 'completed') {
          const actions = (row.actions_taken as any) || {
            deal_updated: false, deal_fields: [], leads_created: 0, lead_ids: [], meeting_scheduled: false,
          };
          callbacks.onComplete(automationId, actions as ActionsTaken);
          supabase.removeChannel(channel);
        } else if (row.status === 'error') {
          callbacks.onError(automationId, row.error_message || 'Erro desconhecido');
          supabase.removeChannel(channel);
        }
      },
    )
    .subscribe();

  // Fallback: polling leve por status, caso Realtime falhe (5s)
  const pollStart = Date.now();
  const POLL_TIMEOUT = 2 * 60 * 60 * 1000; // 2h
  const poll = setInterval(async () => {
    if (Date.now() - pollStart > POLL_TIMEOUT) { clearInterval(poll); return; }
    const { data } = await supabase.from('post_meeting_automations')
      .select('status, actions_taken, error_message')
      .eq('id', automationId).maybeSingle();
    if (!data) return;
    if (data.status === 'completed' || data.status === 'error') {
      clearInterval(poll);
      supabase.removeChannel(channel);
      if (data.status === 'completed') {
        const actions = (data.actions_taken as any) || {
          deal_updated: false, deal_fields: [], leads_created: 0, lead_ids: [], meeting_scheduled: false,
        };
        callbacks.onComplete(automationId, actions as ActionsTaken);
      } else {
        callbacks.onError(automationId, data.error_message || 'Erro desconhecido');
      }
    }
  }, 5000);
}
