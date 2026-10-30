// =============================================================
// Prep Call — disparo do briefing pré-reunião
// =============================================================
// O briefing é gerado pelo motor do Enriquecedor (Railway). O navegador só
// abre a tentativa: RPC prep_call_disparar (JWT do usuário; dono do briefing
// ou gestor), que põe o job na fila prep_call_jobs. O motor pega o job, coleta,
// escreve e grava em prep_briefings — a tela acompanha pelo realtime.
// =============================================================

import { supabase } from './supabase';

export interface DisparoPrepCall {
  attempt_id: string;
  deadline_at: string;
  reaproveitar_coleta: boolean;
}

/**
 * Abre uma tentativa (Gerar ou Reenviar). `reaproveitar` reusa a coleta já
 * feita pelo motor (Reenviar depois de erro na IA, ou para reescrever o texto).
 */
export async function dispararPrepCall(briefingId: string, { reaproveitar = false } = {}): Promise<DisparoPrepCall> {
  const { data, error } = await supabase.rpc('prep_call_disparar', {
    p_briefing_id: briefingId,
    p_reaproveitar: reaproveitar,
  });
  if (error) throw new Error(error.message || 'falha ao disparar o briefing');
  return data as DisparoPrepCall;
}

/** Coleta do motor do Enriquecedor (a do legado não é reaproveitada). */
export function temColetaDoMotor(scraped: unknown): boolean {
  return !!scraped && typeof scraped === 'object' && (scraped as Record<string, unknown>).fonte === 'enriquecedor';
}
