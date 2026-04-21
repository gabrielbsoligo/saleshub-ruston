// =============================================================
// PrepCallView — aba "Prep Call" na sidebar
// =============================================================
// Closer dispara analise pre-reuniao (Claude Code Routine) via
// formulario, acompanha status em realtime, ve briefing em markdown
// quando pronto.
// =============================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import { firePrepCallRoutine } from '../lib/prepCallRoutine';
import { MarkdownView } from './ui/MarkdownView';
import type { PrepBriefing, PrepBriefingInputs, PrepBriefingStatus, PrepBriefingProgressStage, Lead } from '../types';
import { cn } from './Layout';
import {
  Sparkles, Plus, X, Loader2, Check, AlertCircle, Clock,
  Search, ExternalLink, Copy, RefreshCw, Trash2, RotateCw
} from 'lucide-react';
import toast from 'react-hot-toast';

const STATUS_COLORS: Record<PrepBriefingStatus, string> = {
  pending: 'bg-gray-500/15 text-gray-400',
  processing: 'bg-blue-500/15 text-blue-400',
  completed: 'bg-green-500/15 text-green-400',
  error: 'bg-red-500/15 text-red-400',
};

const STATUS_LABELS: Record<PrepBriefingStatus, string> = {
  pending: 'Pendente',
  processing: 'Gerando...',
  completed: 'Pronto',
  error: 'Erro',
};

const STATUS_ICONS: Record<PrepBriefingStatus, React.ComponentType<{ size?: number }>> = {
  pending: Clock,
  processing: Loader2,
  completed: Check,
  error: AlertCircle,
};

export const PrepCallView: React.FC = () => {
  const { currentUser, leads } = useAppStore();
  const [briefings, setBriefings] = useState<PrepBriefing[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [openBriefingId, setOpenBriefingId] = useState<string | null>(null);
  // openBriefing eh DERIVADO do array briefings — sempre reflete o estado
  // mais recente do banco. Evita drift entre drawer e realtime/fetch.
  const openBriefing = useMemo(
    () => (openBriefingId ? briefings.find(b => b.id === openBriefingId) || null : null),
    [openBriefingId, briefings]
  );
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<PrepBriefingStatus | 'all'>('all');

  const fetchBriefings = useCallback(async () => {
    const { data, error } = await supabase
      .from('prep_briefings')
      .select('*, requested_by:team_members!requested_by_id(id,name), lead:leads!lead_id(id,empresa)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      toast.error(`Erro ao carregar briefings: ${error.message}`);
    } else {
      setBriefings((data as PrepBriefing[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchBriefings(); }, [fetchBriefings]);

  // Realtime: UI atualiza quando callback muda status
  useEffect(() => {
    const channel = supabase
      .channel('prep_briefings_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'prep_briefings' },
        () => fetchBriefings()
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [fetchBriefings]);

  const filtered = useMemo(() => {
    return briefings.filter(b => {
      if (filterStatus !== 'all' && b.status !== filterStatus) return false;
      if (search && !b.empresa.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [briefings, filterStatus, search]);

  const handleCreated = () => {
    setShowForm(false);
    fetchBriefings();
    toast.success('Briefing disparado. Demora 1-3 min.', { icon: '✨' });
  };

  const retryBriefing = async (b: PrepBriefing) => {
    // Smart retry: se tem scraped_data util, chama prep-call-rerun direto
    // (pula GitHub Action). Senao, full flow via prep-call-fire.
    const hasScraped = b.scraped_data && typeof b.scraped_data === 'object' && (
      b.scraped_data.site?.fetched ||
      b.scraped_data.instagram?.fetched ||
      b.scraped_data.meta_ads?.fetched ||
      b.scraped_data.google_ads?.fetched
    );

    const toastId = toast.loading(hasScraped ? 'Rerunning Routine (dados ja coletados)...' : 'Reenviando...');

    try {
      if (hasScraped) {
        // Rerun: chama nova edge function que usa scraped_data existente
        const { data, error } = await supabase.functions.invoke('prep-call-rerun', {
          body: { briefing_id: b.id },
        });
        if (error || (data && data.should_fallback)) {
          // Fallback pra full flow se rerun nao puder
          throw new Error('fallback');
        }
        toast.success('Rerun OK. Analisando... 1-3 min.', { id: toastId, icon: '✨' });
      } else {
        // Full flow via prep-call-fire
        await supabase.from('prep_briefings').update({
          status: 'pending',
          progress_stage: 'queued',
          error_message: null,
          briefing_markdown: null,
          failed_stage: null,
          completed_at: null,
        }).eq('id', b.id);
        await firePrepCallRoutine(b.id, b.empresa, b.inputs || {});
        toast.success('Reenviado. Demora 3-5 min.', { id: toastId, icon: '✨' });
      }
      fetchBriefings();
    } catch (err: any) {
      if (err.message === 'fallback') {
        // Rerun disse pra fazer fallback — dispara full flow
        try {
          await supabase.from('prep_briefings').update({
            status: 'pending', progress_stage: 'queued',
            error_message: null, briefing_markdown: null, failed_stage: null, completed_at: null,
          }).eq('id', b.id);
          await firePrepCallRoutine(b.id, b.empresa, b.inputs || {});
          toast.success('Full retry disparado.', { id: toastId });
          fetchBriefings();
          return;
        } catch (e: any) {
          err = e;
        }
      }
      await supabase.from('prep_briefings').update({
        status: 'error',
        failed_stage: 'retry',
        error_message: err.message || String(err),
      }).eq('id', b.id);
      toast.error(`Falhou: ${err.message || 'erro'}`, { id: toastId });
      fetchBriefings();
    }
  };

  if (!currentUser) return null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-white flex items-center gap-2">
            <Sparkles size={22} className="text-[var(--color-v4-red)]" />
            Prep Call
          </h2>
          <p className="text-xs text-[var(--color-v4-text-muted)] mt-1">
            Análise pré-reunião gerada por IA — site, Instagram, Meta Ads, concorrentes, gaps, quick wins.
          </p>
        </div>
        <button onClick={() => setShowForm(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm">
          <Plus size={16} /> Novo Briefing
        </button>
      </div>

      {/* Filtros */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input type="text" placeholder="Buscar empresa..." value={search} onChange={e => setSearch(e.target.value)}
                 className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
                className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
          <option value="all">Todos</option>
          <option value="processing">Gerando</option>
          <option value="completed">Pronto</option>
          <option value="error">Erro</option>
          <option value="pending">Pendente</option>
        </select>
        <button onClick={fetchBriefings}
                title="Recarregar"
                className="p-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Lista */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-12 text-[var(--color-v4-text-muted)]">
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-[var(--color-v4-text-muted)]">
            <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
            <p className="text-sm">Nenhum briefing encontrado</p>
            <p className="text-xs mt-1">Clique em "Novo Briefing" pra começar</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map(b => (
              <BriefingCard key={b.id} briefing={b}
                            onClick={() => setOpenBriefingId(b.id)}
                            onRetry={() => retryBriefing(b)} />
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <PrepCallForm
          leads={leads}
          currentUserId={currentUser.id}
          onClose={() => setShowForm(false)}
          onCreated={handleCreated}
        />
      )}

      {openBriefing && (
        <BriefingDrawer
          briefing={openBriefing}
          onClose={() => setOpenBriefingId(null)}
          onRetry={() => retryBriefing(openBriefing)}
          onDelete={async () => {
            if (!window.confirm(`Apagar briefing de "${openBriefing.empresa}"?`)) return;
            const { error } = await supabase.from('prep_briefings').delete().eq('id', openBriefing.id);
            if (error) { toast.error(error.message); return; }
            toast.success('Briefing apagado');
            setOpenBriefingId(null);
            fetchBriefings();
          }}
        />
      )}
    </div>
  );
};

// ---------- Card ----------
const BriefingCard: React.FC<{
  briefing: PrepBriefing;
  onClick: () => void;
  onRetry: () => void;
}> = ({ briefing: b, onClick, onRetry }) => {
  const StatusIcon = STATUS_ICONS[b.status];
  const isProcessing = b.status === 'processing' || b.status === 'pending';
  return (
    <div onClick={onClick}
         className="cursor-pointer text-left bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 hover:border-[var(--color-v4-red)]/50 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-white flex-1 truncate">{b.empresa}</h3>
        <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${STATUS_COLORS[b.status]}`}>
          <StatusIcon size={10} />
          {STATUS_LABELS[b.status]}
        </span>
      </div>
      {b.inputs?.segmento && (
        <p className="text-xs text-[var(--color-v4-text-muted)] truncate">{b.inputs.segmento}</p>
      )}
      <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-3">
        {new Date(b.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        {b.requested_by?.name && ` · por ${b.requested_by.name.split(' ')[0]}`}
      </p>
      {isProcessing && (
        <div className="mt-3">
          <ProgressTracker briefing={b} />
        </div>
      )}
      {b.status === 'error' && (
        <div className="mt-3 flex items-start gap-2">
          <div className="flex-1 text-[10px] text-red-400 truncate" title={b.error_message || ''}>
            {b.error_message || 'Erro'}
          </div>
          <button onClick={e => { e.stopPropagation(); onRetry(); }}
                  title="Reenviar"
                  className="flex-shrink-0 p-1 rounded bg-red-500/15 hover:bg-red-500/25 text-red-400">
            <RotateCw size={11} />
          </button>
        </div>
      )}
    </div>
  );
};

// ---------- Form ----------
const PrepCallForm: React.FC<{
  leads: Lead[];
  currentUserId: string;
  onClose: () => void;
  onCreated: () => void;
}> = ({ leads, currentUserId, onClose, onCreated }) => {
  const [leadId, setLeadId] = useState<string | null>(null);
  const [leadSearch, setLeadSearch] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [inputs, setInputs] = useState<PrepBriefingInputs>({});
  const [submitting, setSubmitting] = useState(false);

  const leadOptions = useMemo(() => {
    if (!leadSearch) return leads.slice(0, 20);
    return leads.filter(l => l.empresa.toLowerCase().includes(leadSearch.toLowerCase())).slice(0, 20);
  }, [leads, leadSearch]);

  const selectLead = (l: Lead) => {
    setLeadId(l.id);
    setLeadSearch(l.empresa);
    setEmpresa(l.empresa);
    setInputs(prev => ({
      ...prev,
      faturamento_atual: prev.faturamento_atual || l.faturamento || '',
    }));
  };

  const clearLead = () => {
    setLeadId(null);
    setLeadSearch('');
  };

  const setField = (k: keyof PrepBriefingInputs, v: string) => {
    setInputs(prev => ({ ...prev, [k]: v }));
  };

  const canSubmit = empresa.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 1. INSERT registro pending
      const { data: created, error: insErr } = await supabase
        .from('prep_briefings')
        .insert({
          requested_by_id: currentUserId,
          lead_id: leadId,
          empresa: empresa.trim(),
          inputs,
          status: 'pending',
        })
        .select('id')
        .single();
      if (insErr || !created) throw new Error(insErr?.message || 'Falha ao criar registro');

      // 2. Dispara Routine
      try {
        const { session_id, session_url } = await firePrepCallRoutine(created.id, empresa.trim(), inputs);
        await supabase.from('prep_briefings').update({
          status: 'processing',
          routine_session_id: session_id,
          routine_session_url: session_url,
        }).eq('id', created.id);
        onCreated();
      } catch (routineErr: any) {
        // Se Routine falhou, marca como error
        await supabase.from('prep_briefings').update({
          status: 'error',
          error_message: routineErr.message || String(routineErr),
        }).eq('id', created.id);
        toast.error(`Routine falhou: ${routineErr.message || 'erro desconhecido'}`);
        onCreated(); // fecha mesmo assim pra mostrar o erro na listagem
      }
    } catch (e: any) {
      toast.error(e.message || 'Erro ao disparar briefing');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelCls = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl w-full max-w-xl max-h-[90vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <h3 className="text-white font-semibold">Novo Briefing Pré-Call</h3>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Lead / Empresa */}
          <div>
            <label className={labelCls}>Lead existente (ou empresa manual) *</label>
            <div className="relative">
              <input
                type="text"
                className={inputCls}
                placeholder="Buscar empresa..."
                value={leadSearch}
                onChange={e => {
                  setLeadSearch(e.target.value);
                  setEmpresa(e.target.value);
                  if (leadId) setLeadId(null);
                }}
              />
              {leadId && (
                <button type="button" onClick={clearLead}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)] hover:text-white">
                  <X size={14} />
                </button>
              )}
            </div>
            {leadSearch && !leadId && leadOptions.length > 0 && (
              <div className="mt-1 max-h-40 overflow-y-auto border border-[var(--color-v4-border)] rounded-lg bg-[var(--color-v4-bg)]">
                {leadOptions.map(l => (
                  <button key={l.id} type="button" onClick={() => selectLead(l)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-v4-surface)] text-white flex justify-between items-center">
                    <span>{l.empresa}</span>
                    <span className="text-[10px] text-[var(--color-v4-text-muted)]">{l.canal}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">
              Digite o nome pra buscar um lead cadastrado. Se não existir, pode digitar manualmente.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Site</label>
              <input type="text" className={inputCls} placeholder="https://..."
                     value={inputs.site || ''} onChange={e => setField('site', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Instagram</label>
              <input type="text" className={inputCls} placeholder="@handle ou URL"
                     value={inputs.instagram || ''} onChange={e => setField('instagram', e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Segmento</label>
            <input type="text" className={inputCls} placeholder="Ex: e-commerce de roupa fitness"
                   value={inputs.segmento || ''} onChange={e => setField('segmento', e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Faturamento atual</label>
              <input type="text" className={inputCls} placeholder="R$ X/mês"
                     value={inputs.faturamento_atual || ''} onChange={e => setField('faturamento_atual', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Meta de faturamento</label>
              <input type="text" className={inputCls} placeholder="R$ Y/mês"
                     value={inputs.meta_faturamento || ''} onChange={e => setField('meta_faturamento', e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls}>Concorrentes conhecidos</label>
            <input type="text" className={inputCls} placeholder="Lista livre (opcional)"
                   value={inputs.concorrentes_conhecidos || ''} onChange={e => setField('concorrentes_conhecidos', e.target.value)} />
          </div>

          <div>
            <label className={labelCls}>Contexto do SDR</label>
            <textarea className={`${inputCls} h-24 resize-none`} placeholder="Observações sobre a qualificação, dor, timing..."
                      value={inputs.contexto || ''} onChange={e => setField('contexto', e.target.value)} />
          </div>

          {/* V2: Análise profunda de mídia paga */}
          <div className="border-t border-[var(--color-v4-border)]/40 pt-4 mt-2">
            <p className="text-xs font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-1">
              💎 Análise profunda (opcional)
            </p>
            <p className="text-[10px] text-[var(--color-v4-text-muted)] mb-3">
              Se preencher, a IA analisa criativos campeões, copies vencedoras e padrões de mídia paga. Deixe vazio se o lead não anuncia ou você não tem acesso aos links.
            </p>

            <div className="space-y-3">
              <div>
                <label className={labelCls}>Meta Ads Library (URL pré-filtrada)</label>
                <input type="text" className={inputCls}
                       placeholder="https://www.facebook.com/ads/library/?q=empresa&country=BR&active_status=all"
                       value={inputs.meta_ads_library_url || ''}
                       onChange={e => setField('meta_ads_library_url', e.target.value)} />
                <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">
                  Acesse facebook.com/ads/library, busque o nome do lead, copie a URL depois de filtrar.
                </p>
              </div>

              <div>
                <label className={labelCls}>Google Ads Transparency (URL do advertiser)</label>
                <input type="text" className={inputCls}
                       placeholder="https://adstransparency.google.com/advertiser/AR..."
                       value={inputs.google_ads_transparency_url || ''}
                       onChange={e => setField('google_ads_transparency_url', e.target.value)} />
                <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">
                  Acesse adstransparency.google.com, busque o lead, copie a URL do perfil do advertiser.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--color-v4-border)]">
          <button onClick={onClose}
                  className="px-3 py-2 text-xs rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
            Cancelar
          </button>
          <button onClick={submit} disabled={!canSubmit}
                  className="flex items-center gap-2 px-4 py-2 text-xs rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium disabled:opacity-50">
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Gerar Briefing
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------- ProgressTracker (mostra etapa atual + ETA) ----------
const STAGE_META: Record<string, { label: string; order: number; etaMin: number; etaMax: number }> = {
  queued:          { label: 'Na fila',              order: 0, etaMin: 0,   etaMax: 5 },
  dispatched:      { label: 'Disparando pro worker',order: 1, etaMin: 2,   etaMax: 10 },
  scraping:        { label: 'Coletando dados',      order: 2, etaMin: 15,  etaMax: 90 },
  calling_routine: { label: 'Enviando pra IA',      order: 3, etaMin: 1,   etaMax: 5 },
  analyzing:       { label: 'IA analisando',        order: 4, etaMin: 60,  etaMax: 240 },
  completed:       { label: 'Pronto',               order: 5, etaMin: 0,   etaMax: 0 },
  error:           { label: 'Erro',                 order: 5, etaMin: 0,   etaMax: 0 },
};

const STAGES_ORDER: PrepBriefingProgressStage[] = ['queued', 'dispatched', 'scraping', 'calling_routine', 'analyzing'];

const ProgressTracker: React.FC<{ briefing: PrepBriefing }> = ({ briefing: b }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(i);
  }, []);

  const stage = b.progress_stage || 'queued';
  const currentOrder = STAGE_META[stage]?.order ?? 0;
  const elapsedSec = Math.floor((now - new Date(b.created_at).getTime()) / 1000);
  const isStuck = elapsedSec > 480 && b.status === 'processing'; // > 8 min
  const stageLabel = STAGE_META[stage]?.label || stage;

  return (
    <div className="w-full">
      {/* Barra de etapas */}
      <div className="flex items-center gap-1 mb-3">
        {STAGES_ORDER.map((s, idx) => {
          const meta = STAGE_META[s];
          const passed = currentOrder > meta.order;
          const current = currentOrder === meta.order && b.status === 'processing';
          return (
            <div key={s} className="flex-1 flex items-center gap-1">
              <div className={cn(
                'h-1.5 rounded-full flex-1 transition-colors',
                passed && 'bg-[var(--color-v4-red)]',
                current && 'bg-blue-500 animate-pulse',
                !passed && !current && 'bg-[var(--color-v4-surface)]',
              )} />
              {idx < STAGES_ORDER.length - 1 && <span className="text-[var(--color-v4-text-muted)] text-[8px]">•</span>}
            </div>
          );
        })}
      </div>

      {/* Label da etapa atual */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {b.status === 'processing' && <Loader2 size={14} className="animate-spin text-blue-400" />}
          <span className="text-sm font-medium text-white">{stageLabel}</span>
        </div>
        <span className="text-xs text-[var(--color-v4-text-muted)] tabular-nums">
          {Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, '0')}
        </span>
      </div>

      {/* ETA ou aviso de trava */}
      {b.status === 'processing' && (
        <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">
          {isStuck
            ? '⚠️ Demorando mais que o normal — pode estar travado'
            : `Estimado: ${STAGE_META[stage]?.etaMin || 0}-${STAGE_META[stage]?.etaMax || 0}s nessa etapa`}
        </p>
      )}

      {/* Aviso amarelo se stuck */}
      {isStuck && b.github_run_url && (
        <div className="mt-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-xs">
          <p className="text-yellow-400 font-medium mb-1">⚠️ Pode estar travando</p>
          <p className="text-[var(--color-v4-text-muted)] mb-2">
            Briefing está em "{stageLabel}" há {Math.floor(elapsedSec / 60)} min. Aos 10 min, marcaremos como erro automaticamente.
          </p>
          <a href={b.github_run_url} target="_blank" rel="noopener"
             className="inline-flex items-center gap-1 text-yellow-400 hover:underline">
            <ExternalLink size={11} /> Ver logs do GitHub Actions
          </a>
        </div>
      )}
    </div>
  );
};

// ---------- Painel de links manuais (fallback se scraping falhar) ----------
const ManualLinksPanel: React.FC<{ inputs: PrepBriefingInputs; empresa: string }> = ({ inputs, empresa }) => {
  const links: { label: string; url: string }[] = [];
  if (inputs.site) {
    const site = inputs.site.startsWith('http') ? inputs.site : `https://${inputs.site}`;
    links.push({ label: 'Site do lead', url: site });
  }
  if (inputs.instagram) {
    const handle = inputs.instagram.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
    if (handle) links.push({ label: 'Instagram', url: `https://www.instagram.com/${handle}/` });
  }
  if (inputs.meta_ads_library_url) {
    links.push({ label: 'Meta Ads Library', url: inputs.meta_ads_library_url });
  } else if (empresa) {
    const q = encodeURIComponent(empresa);
    links.push({ label: 'Buscar na Meta Ads Library', url: `https://www.facebook.com/ads/library/?q=${q}&country=BR&active_status=all` });
  }
  if (inputs.google_ads_transparency_url) {
    links.push({ label: 'Google Ads Transparency', url: inputs.google_ads_transparency_url });
  }

  if (links.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t border-[var(--color-v4-border)]/40">
      <h4 className="text-xs font-bold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-2">
        🔗 Abrir manualmente
      </h4>
      <p className="text-[10px] text-[var(--color-v4-text-muted)] mb-3">
        Fallback caso algum scraping tenha falhado. Clique pra validar visualmente antes da call.
      </p>
      <div className="flex flex-wrap gap-2">
        {links.map((l, i) => (
          <a key={i} href={l.url} target="_blank" rel="noopener"
             className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white hover:border-[var(--color-v4-red)]/50 text-xs">
            <ExternalLink size={11} /> {l.label}
          </a>
        ))}
      </div>
    </div>
  );
};

// ---------- Drawer ----------
const BriefingDrawer: React.FC<{
  briefing: PrepBriefing;
  onClose: () => void;
  onDelete: () => void;
  onRetry: () => void;
}> = ({ briefing: b, onClose, onDelete, onRetry }) => {
  const copyMarkdown = async () => {
    if (!b.briefing_markdown) return;
    try {
      await navigator.clipboard.writeText(b.briefing_markdown);
      toast.success('Markdown copiado!');
    } catch {
      toast.error('Não foi possível copiar');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div className="bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] w-full max-w-3xl h-full flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex-1 min-w-0">
            <h3 className="text-white font-semibold truncate">{b.empresa}</h3>
            <p className="text-[11px] text-[var(--color-v4-text-muted)] mt-0.5">
              {new Date(b.created_at).toLocaleString('pt-BR')}
              {b.requested_by?.name && ` · ${b.requested_by.name}`}
              {b.completed_at && ` · Pronto em ${Math.round((new Date(b.completed_at).getTime() - new Date(b.created_at).getTime()) / 60000)} min`}
            </p>
          </div>
          <div className="flex gap-1 ml-3">
            {b.status === 'completed' && b.briefing_markdown && (
              <button onClick={copyMarkdown} title="Copiar markdown"
                      className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
                <Copy size={14} />
              </button>
            )}
            {(b.status === 'error' || b.status === 'completed') && (
              <button onClick={onRetry} title="Reenviar com os mesmos dados"
                      className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
                <RotateCw size={14} />
              </button>
            )}
            {b.routine_session_url && (
              <a href={b.routine_session_url} target="_blank" rel="noopener" title="Abrir sessão Claude"
                 className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
                <ExternalLink size={14} />
              </a>
            )}
            <button onClick={onDelete} title="Apagar"
                    className="p-2 rounded hover:bg-red-500/10 text-[var(--color-v4-text-muted)] hover:text-red-400">
              <Trash2 size={14} />
            </button>
            <button onClick={onClose} className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {b.status === 'pending' || b.status === 'processing' ? (
            <div className="py-8 px-2">
              <ProgressTracker briefing={b} />
              <p className="text-xs text-[var(--color-v4-text-muted)] text-center mt-6">
                A tela atualiza sozinha quando terminar.
              </p>
            </div>
          ) : b.status === 'error' ? (
            <div className="flex flex-col items-start bg-red-500/5 border border-red-500/20 rounded-lg p-4">
              <div className="flex items-center gap-2 text-red-400 mb-2">
                <AlertCircle size={16} />
                <span className="font-semibold text-sm">Erro ao gerar briefing</span>
              </div>
              <p className="text-sm text-[var(--color-v4-text)] whitespace-pre-wrap mb-4">
                {b.error_message || 'Erro desconhecido'}
              </p>
              <button onClick={onRetry}
                      className="flex items-center gap-2 px-4 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-medium">
                <RotateCw size={14} /> Reenviar
              </button>
              <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-2">
                Vai usar os mesmos dados do formulário original.
              </p>
            </div>
          ) : b.briefing_markdown ? (
            <>
              <MarkdownView source={b.briefing_markdown} />
              <ManualLinksPanel inputs={b.inputs} empresa={b.empresa} />
            </>
          ) : (
            <p className="text-sm text-[var(--color-v4-text-muted)]">Sem conteúdo.</p>
          )}
        </div>
      </div>
    </div>
  );
};
