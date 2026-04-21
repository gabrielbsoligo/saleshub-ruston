// =============================================================
// Claude Code Routine — "Analise Pre-Reuniao" client
// =============================================================
// Dispara a Routine via /fire e retorna a sessao criada.
// Token + routine_id ficam em integracao_config (carregados on-demand).
//
// A resposta do /fire NAO contem o briefing pronto — apenas confirma
// que a sessao comecou. O resultado chega depois via webhook na
// Edge Function prep-call-callback.
// =============================================================

import { supabase } from './supabase';
import type { PrepBriefingInputs } from '../types';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/claude_code/routines';
const ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01';
const ANTHROPIC_VERSION = '2023-06-01';

interface RoutineConfig {
  token: string;
  routineId: string;
}

interface FireResult {
  session_id: string;
  session_url: string;
}

async function loadConfig(): Promise<RoutineConfig> {
  const { data, error } = await supabase
    .from('integracao_config')
    .select('key, value')
    .in('key', ['claude_code_routine_token', 'claude_code_routine_id']);

  if (error) throw new Error(`Erro ao buscar config: ${error.message}`);

  const map: Record<string, string> = {};
  (data || []).forEach(r => { map[r.key] = r.value; });

  if (!map.claude_code_routine_token) {
    throw new Error('Token da Routine não configurado (integracao_config.claude_code_routine_token vazio)');
  }
  if (!map.claude_code_routine_id) {
    throw new Error('ID da Routine não configurado (integracao_config.claude_code_routine_id vazio)');
  }

  return {
    token: map.claude_code_routine_token,
    routineId: map.claude_code_routine_id,
  };
}

/**
 * Dispara a Routine de briefing. Injeta briefing_id no payload pra
 * a Routine ecoar no callback.
 */
export async function firePrepCallRoutine(
  briefingId: string,
  empresa: string,
  inputs: PrepBriefingInputs
): Promise<FireResult> {
  const { token, routineId } = await loadConfig();

  const payload = {
    briefing_id: briefingId,
    empresa,
    segmento: inputs.segmento || '',
    site: inputs.site || '',
    instagram: inputs.instagram || '',
    faturamento_atual: inputs.faturamento_atual || '',
    meta_faturamento: inputs.meta_faturamento || '',
    concorrentes_conhecidos: inputs.concorrentes_conhecidos || '',
    contexto: inputs.contexto || '',
  };

  const response = await fetch(`${ANTHROPIC_API}/${routineId}/fire`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': ANTHROPIC_BETA,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: JSON.stringify(payload),
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Routine /fire falhou (${response.status}): ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    session_id: data.claude_code_session_id || data.session_id || '',
    session_url: data.claude_code_session_url || data.session_url || '',
  };
}
