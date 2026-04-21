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

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

/**
 * Dispara a Routine via Edge Function. Chamada direta via fetch
 * pra conseguir ler o body de erro quando a function retorna non-2xx
 * (supabase.functions.invoke esconde a mensagem especifica).
 */
export async function firePrepCallRoutine(
  briefingId: string,
  empresa: string,
  inputs: PrepBriefingInputs
): Promise<FireResult> {
  // Edge function nao exige JWT (incompatibilidade ES256 no gateway).
  // A seguranca vem da checagem server-side que o briefing_id existe
  // na tabela — e pra criar o registro, RLS ja exigiu usuario autenticado.
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/prep-call-fire`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      briefing_id: briefingId,
      empresa,
      inputs,
    }),
  });

  const text = await resp.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

  if (!resp.ok) {
    const msg = (body && (body.error || body.message || body.raw)) || `HTTP ${resp.status}`;
    throw new Error(msg);
  }

  return {
    session_id: body?.session_id || '',
    session_url: body?.session_url || '',
  };
}
