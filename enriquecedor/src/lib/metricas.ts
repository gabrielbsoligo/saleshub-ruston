import { supabase, supabaseConfigured } from './supabase';

// Métricas de tempo por fase/fonte (enriquecedor_metricas, migration_151).
// Antes não existia nenhuma medição — só log de erro. Best-effort: nunca
// atrapalha a fase; sem Supabase, só console.
export interface Metrica {
  leadId?: string | null;
  fase?: string | null; // F1..F4 ou nome da ação
  fonte: string; // ex.: 'fase', 'site-audit', 'anuncios'
  durationMs: number;
  ok?: boolean;
  note?: string | null;
}

export async function registrarMetrica(m: Metrica): Promise<void> {
  if (!supabaseConfigured) return;
  try {
    await supabase.from('enriquecedor_metricas').insert({
      lead_id: m.leadId ?? null,
      origem: 'app',
      fase: m.fase ?? null,
      fonte: m.fonte,
      duration_ms: Math.round(m.durationMs),
      ok: m.ok !== false,
      note: m.note ?? null,
    });
  } catch {
    /* métrica nunca derruba a fase */
  }
}

/** Mede uma função assíncrona e registra; relança o erro depois de registrar. */
export async function medir<T>(meta: Omit<Metrica, 'durationMs' | 'ok'>, fn: () => Promise<T>, okDe?: (r: T) => boolean): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    void registrarMetrica({ ...meta, durationMs: performance.now() - t0, ok: okDe ? okDe(r) : true });
    return r;
  } catch (e) {
    void registrarMetrica({ ...meta, durationMs: performance.now() - t0, ok: false, note: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) });
    throw e;
  }
}
