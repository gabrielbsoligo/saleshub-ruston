// =============================================================
// Claude Code Routine — "Analise Pre-Reuniao" client
// =============================================================
// A chamada pra Claude Code Routine roda server-side via
// Edge Function `prep-call-fire`. O browser NAO pode chamar
// api.anthropic.com diretamente (CORS + exposicao de token).
// =============================================================

import { supabase } from './supabase';
import type { PrepBriefingInputs } from '../types';

interface FireResult {
  session_id: string;
  session_url: string;
}

/**
 * Dispara a Routine via Edge Function. Injeta briefing_id pra a Routine
 * ecoar no callback. Token + routine_id ficam server-side.
 */
export async function firePrepCallRoutine(
  briefingId: string,
  empresa: string,
  inputs: PrepBriefingInputs
): Promise<FireResult> {
  const { data, error } = await supabase.functions.invoke('prep-call-fire', {
    body: {
      briefing_id: briefingId,
      empresa,
      inputs,
    },
  });

  if (error) {
    // supabase-js traz a mensagem da edge function se ela mandou status != 2xx
    throw new Error(error.message || 'Falha ao chamar prep-call-fire');
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Resposta invalida da edge function');
  }

  if ((data as any).error) {
    throw new Error((data as any).error);
  }

  return {
    session_id: (data as any).session_id || '',
    session_url: (data as any).session_url || '',
  };
}
