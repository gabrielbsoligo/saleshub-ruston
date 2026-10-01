import { supabase, supabaseConfigured } from './supabase';
import { motorFetch } from './motorClient';

// Fila de jobs de enriquecimento (enriquecedor_enrichment_jobs, migration_152).
// O front ENFILEIRA (lead × fase) e acompanha por Realtime; quem executa é o
// worker do motor. Fechar a aba, trocar de tela ou minimizar o lead não
// interrompe nada. Quando o worker está desligado (sem chave de serviço no
// Railway), o funil volta a executar na aba (fallback legado).
export type FaseJob = 'f2' | 'f3' | 'f4' | 'all';
export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
export interface Job {
  id: string;
  leadId: string;
  fase: FaseJob;
  status: JobStatus;
  attempts: number;
  projectId: string | null;
  error: string | null;
  result: { resumo?: string; ok?: boolean } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}
const fromRow = (r: Record<string, unknown>): Job => ({
  id: String(r.id),
  leadId: String(r.lead_id),
  fase: (r.fase as FaseJob) ?? 'all',
  status: r.status as JobStatus,
  attempts: Number(r.attempts ?? 0),
  projectId: (r.project_id as string) ?? null,
  error: (r.error as string) ?? null,
  result: (r.result as Job['result']) ?? null,
  createdAt: String(r.created_at),
  startedAt: (r.started_at as string) ?? null,
  finishedAt: (r.finished_at as string) ?? null,
  durationMs: (r.duration_ms as number) ?? null,
});

// Índice da etapa do Workflow (1=F2, 2=F3, 3=F4) → fase do job.
export const FASE_DA_ETAPA: Record<number, FaseJob> = { 1: 'f2', 2: 'f3', 3: 'f4' };
export const ETAPA_DA_FASE: Record<FaseJob, number> = { f2: 1, f3: 2, f4: 3, all: 3 };

let _worker: { ativo: boolean; exp: number } | null = null;
/** O worker do motor está ligado? (health do motor, cache 60 s). Sem Supabase → false. */
export async function workerAtivo(): Promise<boolean> {
  if (!supabaseConfigured) return false;
  if (_worker && _worker.exp > Date.now()) return _worker.ativo;
  try {
    const r = await motorFetch('/api/health', { timeoutMs: 8000 });
    const j = await r.json();
    _worker = { ativo: !!j?.worker?.ativo, exp: Date.now() + 60_000 };
  } catch {
    _worker = { ativo: false, exp: Date.now() + 15_000 };
  }
  return _worker.ativo;
}

export const jobsRepo = {
  /** Enfileira (lead × fase); quem já tem job pendente/rodando na mesma fase é pulado. Devolve quantos entraram. */
  async enfileirar(leadIds: string[], fase: FaseJob, projectId: string | null, priority = 0): Promise<number> {
    if (!supabaseConfigured || !leadIds.length) return 0;
    const { data: ativos } = await supabase
      .from('enriquecedor_enrichment_jobs')
      .select('lead_id')
      .in('lead_id', leadIds)
      .eq('fase', fase)
      .in('status', ['pending', 'running']);
    const ja = new Set((ativos ?? []).map((r) => String(r.lead_id)));
    const novos = [...new Set(leadIds)].filter((id) => !ja.has(id));
    if (!novos.length) return 0;
    const { data: sess } = await supabase.auth.getSession();
    const rows = novos.map((leadId) => ({ lead_id: leadId, type: 'fase', fase, status: 'pending', project_id: projectId, priority, requested_by: sess.session?.user?.email ?? null }));
    const { error } = await supabase.from('enriquecedor_enrichment_jobs').insert(rows);
    if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
    return novos.length;
  },

  /** Último job por (lead, fase) do projeto — o estado atual do funil. */
  async listarProjeto(projectId: string): Promise<Job[]> {
    if (!supabaseConfigured) return [];
    const { data } = await supabase
      .from('enriquecedor_enrichment_jobs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(2000);
    const vistos = new Set<string>();
    const out: Job[] = [];
    for (const r of data ?? []) {
      const j = fromRow(r);
      const k = `${j.leadId}|${j.fase}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(j);
    }
    return out;
  },

  async listarLead(leadId: string): Promise<Job[]> {
    if (!supabaseConfigured) return [];
    const { data } = await supabase.from('enriquecedor_enrichment_jobs').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(20);
    return (data ?? []).map(fromRow);
  },

  async cancelarPendentes(projectId: string, fase?: FaseJob): Promise<void> {
    if (!supabaseConfigured) return;
    let q = supabase.from('enriquecedor_enrichment_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('project_id', projectId).eq('status', 'pending');
    if (fase) q = q.eq('fase', fase);
    await q;
  },

  /**
   * Acompanha os jobs (Realtime + releitura a cada 15 s como rede de segurança).
   * `filtro` = `project_id=eq.<id>` ou `lead_id=eq.<id>`. Chama `onChange` com a
   * linha que mudou (ou null na releitura periódica). Devolve o unsubscribe.
   */
  subscribe(filtro: string, onChange: (job: Job | null) => void): () => void {
    if (!supabaseConfigured) return () => {};
    const ch = supabase
      .channel(`jobs-${filtro}-${Math.random().toString(36).slice(2, 7)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'enriquecedor_enrichment_jobs', filter: filtro }, (payload) => {
        const r = (payload.new ?? payload.old) as Record<string, unknown> | undefined;
        onChange(r && r.id ? fromRow(r) : null);
      })
      .subscribe();
    const timer = setInterval(() => onChange(null), 15_000);
    return () => {
      clearInterval(timer);
      void supabase.removeChannel(ch);
    };
  },
};
