// =============================================
// PostMeetingOrchestrator
// Coordena o fluxo completo de automacao pos-reuniao
// =============================================

import { supabase } from './supabase';
import { fetchTranscriptWithPolling, type TranscriptResult } from './googleDrive';
import { analyzeTranscript } from './callAnalyzer';
import { getLeadMessages, complementReferralsFromChat } from './kommoChat';
import type {
  CallAnalysisResult,
  PostMeetingAutomation,
  Reuniao,
  Deal,
  Lead,
} from '../types';

export interface OrchestratorCallbacks {
  /** Chamado quando o status da automacao muda */
  onStatusChange: (automationId: string, status: PostMeetingAutomation['status']) => void;
  /** Chamado quando a transcricao esta sendo buscada (polling) */
  onPollingUpdate?: (attempt: number, maxAttempts: number) => void;
  /** Chamado quando o fluxo termina com sucesso */
  onComplete: (automationId: string, actions: ActionsTaken) => void;
  /** Chamado quando o fluxo termina com erro */
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

// ID da SDR "Lary" - hardcoded para MVP
// TODO: tornar configuravel por equipe
const LARY_SDR_NAME = 'Lary';

async function findLarySdrId(): Promise<string | null> {
  const { data } = await supabase
    .from('team_members')
    .select('id')
    .ilike('name', `%${LARY_SDR_NAME}%`)
    .eq('role', 'sdr')
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}

/**
 * Executa o fluxo completo de automacao pos-reuniao.
 *
 * 1. Cria registro de automacao (status: pending)
 * 2. Busca transcricao no Google Drive (status: fetching_transcript)
 * 3. Analisa com Gemini (status: analyzing)
 * 4. Aplica acoes: update deal, criar leads, agendar reuniao (status: applying)
 * 5. Finaliza (status: completed)
 */
export async function runPostMeetingAutomation(
  reuniaoId: string,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  let automationId: string | null = null;

  try {
    // ====== STEP 0: Buscar dados da reuniao e deal ======
    const { data: reuniao } = await supabase
      .from('reunioes')
      .select('*, closer:team_members!closer_id(*), sdr:team_members!sdr_id(*)')
      .eq('id', reuniaoId)
      .single();

    if (!reuniao) throw new Error('Reuniao nao encontrada');
    if (!reuniao.realizada || !reuniao.show) throw new Error('Reuniao nao foi confirmada como show');

    // Buscar deal associado
    const { data: deal } = await supabase
      .from('deals')
      .select('*')
      .eq('reuniao_id', reuniaoId)
      .maybeSingle();

    // Se nao tem deal por reuniao_id, tentar por lead_id
    let dealRecord = deal;
    if (!dealRecord && reuniao.lead_id) {
      const { data: dealByLead } = await supabase
        .from('deals')
        .select('*')
        .eq('lead_id', reuniao.lead_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      dealRecord = dealByLead;
    }

    // ====== STEP 1: Criar registro de automacao ======
    const { data: automation, error: createError } = await supabase
      .from('post_meeting_automations')
      .insert({
        reuniao_id: reuniaoId,
        deal_id: dealRecord?.id || null,
        status: 'pending',
      })
      .select('*')
      .single();

    if (createError) {
      if (createError.code === '23505') {
        throw new Error('Automacao ja foi executada para esta reuniao');
      }
      throw new Error(`Erro ao criar automacao: ${createError.message}`);
    }

    automationId = automation.id;

    // ====== STEP 2: Buscar transcricao ======
    await updateStatus(automationId, 'fetching_transcript');
    callbacks.onStatusChange(automationId, 'fetching_transcript');

    const transcriptResult = await fetchTranscriptWithPolling(
      reuniaoId,
      callbacks.onPollingUpdate,
      2 * 60 * 1000, // 2 minutos
      30, // 30 tentativas = 60 minutos
    );

    if (transcriptResult.needs_reauth) {
      throw new Error('Google Drive nao autorizado. Peca ao organizador reconectar na tela de Equipe.');
    }

    if (transcriptResult.status !== 'found' || !transcriptResult.transcript_text) {
      throw new Error('Transcricao nao encontrada apos 60 minutos de busca.');
    }

    // Salvar transcricao cacheada
    await supabase.from('post_meeting_automations').update({
      transcript_text: transcriptResult.transcript_text,
    }).eq('id', automationId);

    // ====== STEP 3: Analisar com Gemini ======
    await updateStatus(automationId, 'analyzing');
    callbacks.onStatusChange(automationId, 'analyzing');

    const analysis = await analyzeTranscript(transcriptResult.transcript_text);

    // Salvar resultado da IA
    await supabase.from('post_meeting_automations').update({
      ai_result: analysis as any,
    }).eq('id', automationId);

    // ====== STEP 4: Aplicar acoes ======
    await updateStatus(automationId, 'applying');
    callbacks.onStatusChange(automationId, 'applying');

    const actions = await applyActions(
      reuniao,
      dealRecord,
      analysis,
      transcriptResult,
    );

    // ====== STEP 5: Finalizar ======
    await supabase.from('post_meeting_automations').update({
      status: 'completed',
      actions_taken: actions as any,
      leads_created: actions.lead_ids,
      next_reuniao_id: actions.next_reuniao_id || null,
      completed_at: new Date().toISOString(),
    }).eq('id', automationId);

    callbacks.onComplete(automationId, actions);

  } catch (error: any) {
    const errorMsg = error.message || 'Erro desconhecido';
    console.error('PostMeetingOrchestrator error:', error);

    if (automationId) {
      await supabase.from('post_meeting_automations').update({
        status: 'error',
        error_message: errorMsg,
      }).eq('id', automationId);
    }

    callbacks.onError(automationId || '', errorMsg);
  }
}

/**
 * Aplica todas as acoes automaticas baseadas na analise da IA.
 */
async function applyActions(
  reuniao: any,
  deal: Deal | null,
  analysis: CallAnalysisResult,
  transcriptResult: TranscriptResult,
): Promise<ActionsTaken> {
  const actions: ActionsTaken = {
    deal_updated: false,
    deal_fields: [],
    leads_created: 0,
    lead_ids: [],
    meeting_scheduled: false,
    transcript_url: transcriptResult.transcript_url || undefined,
    recording_url: transcriptResult.recording_url || undefined,
  };

  // ====== 4a: Atualizar Deal ======
  if (deal) {
    const dealUpdates: Partial<Deal> = {};
    const updatedFields: string[] = [];

    // MOVER DE "dar_feedback" PARA "negociacao" — a IA ja fez o feedback!
    if (deal.status === 'dar_feedback') {
      dealUpdates.status = 'negociacao';
      updatedFields.push('status');
    }

    // Temperatura
    if (analysis.temperatura) {
      dealUpdates.temperatura = analysis.temperatura;
      updatedFields.push('temperatura');
    }

    // Valores
    if (analysis.valor_escopo > 0) {
      dealUpdates.valor_escopo = analysis.valor_escopo;
      dealUpdates.valor_ot = analysis.valor_escopo; // manter campo legado sincronizado
      updatedFields.push('valor_escopo');
    }
    if (analysis.valor_recorrente > 0) {
      dealUpdates.valor_recorrente = analysis.valor_recorrente;
      dealUpdates.valor_mrr = analysis.valor_recorrente; // manter campo legado sincronizado
      updatedFields.push('valor_recorrente');
    }

    // Produtos
    if (analysis.produtos_ot.length > 0) {
      dealUpdates.produtos_ot = analysis.produtos_ot;
      updatedFields.push('produtos_ot');
    }
    if (analysis.produtos_mrr.length > 0) {
      dealUpdates.produtos_mrr = analysis.produtos_mrr;
      updatedFields.push('produtos_mrr');
    }

    // BANT
    if (analysis.bant) {
      dealUpdates.bant = analysis.bant;
      updatedFields.push('bant');
    }

    // Tier
    if (analysis.tier) {
      dealUpdates.tier = analysis.tier;
      updatedFields.push('tier');
    }

    // Resumo executivo -> observacoes
    if (analysis.resumo_executivo) {
      dealUpdates.observacoes = analysis.resumo_executivo;
      updatedFields.push('observacoes');
    }

    // Links da gravacao e transcricao
    if (transcriptResult.recording_url) {
      dealUpdates.link_call_vendas = transcriptResult.recording_url;
      updatedFields.push('link_call_vendas');
    }
    if (transcriptResult.transcript_url) {
      dealUpdates.link_transcricao = transcriptResult.transcript_url;
      updatedFields.push('link_transcricao');
    }

    if (updatedFields.length > 0) {
      const { error } = await supabase.from('deals').update(dealUpdates).eq('id', deal.id);
      if (error) {
        console.error('Erro ao atualizar deal:', error);
      } else {
        actions.deal_updated = true;
        actions.deal_fields = updatedFields;
      }
    }
  }

  // ====== 4b: Complementar indicacoes via Kommo WhatsApp ======
  let indicacoesFinais = analysis.indicacoes;
  if (analysis.indicacoes.length > 0 && reuniao.kommo_id) {
    try {
      const messages = await getLeadMessages(reuniao.kommo_id);
      if (messages.length > 0) {
        indicacoesFinais = await complementReferralsFromChat(messages, analysis.indicacoes);
        console.log(`Kommo WhatsApp: ${messages.length} mensagens analisadas, indicacoes complementadas`);
      }
    } catch (e) {
      // Kommo WhatsApp e opcional - nao deve bloquear o fluxo
      console.warn('Kommo WhatsApp complemento falhou (graceful degradation):', e);
    }
  }

  // ====== 4c: Criar leads de indicacao ======
  if (indicacoesFinais.length > 0) {
    const larySdrId = await findLarySdrId();

    for (const indicacao of indicacoesFinais) {
      if (!indicacao.nome || !indicacao.empresa) continue;

      const newLead: Partial<Lead> = {
        empresa: indicacao.empresa,
        nome_contato: indicacao.nome,
        telefone: indicacao.telefone || undefined,
        canal: 'recomendacao',
        status: 'sem_contato',
        sdr_id: larySdrId || reuniao.sdr_id || undefined,
        data_cadastro: new Date().toISOString().split('T')[0],
        mes_referencia: new Date().toISOString().slice(0, 7), // YYYY-MM
      };

      const { data: createdLead, error } = await supabase
        .from('leads')
        .insert(newLead)
        .select('*')
        .single();

      if (error) {
        // Duplicata nao e erro critico, continuar com os outros
        console.warn(`Lead indicacao nao criado (${indicacao.empresa}):`, error.message);
      } else if (createdLead) {
        actions.leads_created++;
        actions.lead_ids.push(createdLead.id);
      }
    }
  }

  // ====== 4d: Agendar proxima reuniao ======
  if (analysis.proxima_reuniao) {
    try {
      const { data: dataStr, hora } = analysis.proxima_reuniao;
      // Montar data ISO da proxima reuniao
      const dataReuniaoISO = `${dataStr}T${hora}:00-03:00`; // timezone Sao Paulo

      const newReuniao: Partial<Reuniao> = {
        lead_id: reuniao.lead_id || undefined,
        closer_id: reuniao.closer_confirmado_id || reuniao.closer_id || undefined,
        sdr_id: reuniao.sdr_id || undefined,
        empresa: reuniao.empresa,
        nome_contato: reuniao.nome_contato,
        canal: reuniao.canal,
        data_agendamento: new Date().toISOString().split('T')[0],
        data_reuniao: dataReuniaoISO,
        realizada: false,
      };

      const { data: createdReuniao, error } = await supabase
        .from('reunioes')
        .insert(newReuniao)
        .select('*')
        .single();

      if (error) {
        console.error('Erro ao agendar proxima reuniao:', error);
      } else if (createdReuniao) {
        actions.meeting_scheduled = true;
        actions.next_reuniao_id = createdReuniao.id;

        // Atualizar lead para reuniao_marcada
        if (reuniao.lead_id) {
          await supabase.from('leads')
            .update({ status: 'reuniao_marcada' })
            .eq('id', reuniao.lead_id);
        }
      }
    } catch (e) {
      console.error('Erro ao processar proxima reuniao:', e);
    }
  }

  return actions;
}

/** Helper para atualizar status da automacao */
async function updateStatus(automationId: string, status: PostMeetingAutomation['status']): Promise<void> {
  await supabase.from('post_meeting_automations').update({ status }).eq('id', automationId);
}
