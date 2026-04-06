import React, { useState, useMemo } from "react";
import { useAppStore } from "../store";
import { CANAL_LABELS, LEAD_STATUS_LABELS, type Lead } from "../types";
import { Plus, Check, X as XIcon, Calendar, Search, User, Video, ChevronDown, ChevronRight, AlertTriangle, RefreshCw } from "lucide-react";
import { createCalendarEvent } from "../lib/googleCalendar";
import toast from "react-hot-toast";
import { ConfirmarReuniaoModal } from "./ConfirmarReuniaoModal";
import { AgendarReuniaoModal } from "./AgendarReuniaoModal";
import type { Reuniao } from "../types";

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();

  // Compare using local date strings to avoid timezone issues
  const targetDate = date.toLocaleDateString('pt-BR');
  const todayDate = now.toLocaleDateString('pt-BR');
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toLocaleDateString('pt-BR');

  if (targetDate === todayDate) return 'Hoje';
  if (targetDate === tomorrowDate) return 'Amanhã';

  // Check if past
  const targetDayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (targetDayStart < todayStart) return `${targetDate} (atrasada)`;

  return date.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function groupByDay(reunioes: Reuniao[]): { label: string; date: string; items: Reuniao[] }[] {
  const groups: Record<string, Reuniao[]> = {};
  for (const r of reunioes) {
    const day = r.data_reuniao ? new Date(r.data_reuniao).toLocaleDateString('pt-BR') : 'sem-data';
    if (!groups[day]) groups[day] = [];
    groups[day].push(r);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      label: date === 'sem-data' ? 'Sem data' : formatRelativeDate(date),
      date,
      items: items.sort((a, b) => (a.data_reuniao || '').localeCompare(b.data_reuniao || '')),
    }));
}

export const ReunioesView: React.FC = () => {
  const { reunioes, leads, addReuniao, updateReuniao, members } = useAppStore();
  const [showLeadPicker, setShowLeadPicker] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [confirmar, setConfirmar] = useState<Reuniao | null>(null);
  const [leadSearch, setLeadSearch] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingAgendar, setPendingAgendar] = useState<{ iso: string; closerId: string; extras?: string[]; leadEmail?: string } | null>(null);
  const [showHistorico, setShowHistorico] = useState(false);
  const [filterNoshowReagendados, setFilterNoshowReagendados] = useState(false);
  const [showNoshowsAntigos, setShowNoshowsAntigos] = useState(false);
  const [filterCloser, setFilterCloser] = useState('');
  const [filterSdr, setFilterSdr] = useState('');

  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const sdrs = members.filter(m => (m.role === 'sdr' || m.role === 'gestor') && m.active);

  const leadsDisponiveis = leads.filter(l =>
    !['perdido', 'estorno', 'convertido'].includes(l.status) &&
    (leadSearch ? l.empresa.toLowerCase().includes(leadSearch.toLowerCase()) : true)
  );

  // Separate reunions
  const proximas = useMemo(() => {
    let items = reunioes.filter(r => !r.realizada);
    if (filterCloser) items = items.filter(r => r.closer_id === filterCloser);
    if (filterSdr) items = items.filter(r => r.sdr_id === filterSdr);
    return items;
  }, [reunioes, filterCloser, filterSdr]);

  const noshows = useMemo(() => {
    let items = reunioes.filter(r => r.realizada && r.show === false);
    if (filterCloser) items = items.filter(r => r.closer_id === filterCloser);
    if (filterSdr) items = items.filter(r => r.sdr_id === filterSdr);
    return items;
  }, [reunioes, filterCloser, filterSdr]);

  const realizadas = useMemo(() => {
    let items = reunioes.filter(r => r.realizada && r.show === true);
    if (filterCloser) items = items.filter(r => r.closer_id === filterCloser);
    if (filterSdr) items = items.filter(r => r.sdr_id === filterSdr);
    return items;
  }, [reunioes, filterCloser, filterSdr]);

  const proximasAgrupadas = useMemo(() => groupByDay(proximas), [proximas]);

  // Get lead info for a reunion
  const getLeadInfo = (r: Reuniao) => {
    const lead = r.lead_id ? leads.find(l => l.id === r.lead_id) : null;
    return { faturamento: lead?.faturamento, nome_contato: lead?.nome_contato || r.nome_contato };
  };

  const handleSelectLead = (lead: Lead) => { setSelectedLead(lead); setShowLeadPicker(false); setLeadSearch(''); };

  const { currentUser } = useAppStore();

  const handleAgendarConfirm = async (dataReuniaoISO: string, closerId: string, participantesExtras?: string[], leadEmail?: string) => {
    if (!selectedLead || isProcessing) return;
    setIsProcessing(true);
    try {
      await addReuniao({
        lead_id: selectedLead.id, empresa: selectedLead.empresa,
        nome_contato: selectedLead.nome_contato || undefined, canal: selectedLead.canal,
        sdr_id: selectedLead.sdr_id || currentUser?.id || undefined, closer_id: closerId || undefined,
        kommo_id: selectedLead.kommo_id || undefined,
        data_agendamento: new Date().toISOString().split('T')[0], data_reuniao: dataReuniaoISO,
        participantes_extras: participantesExtras || undefined, lead_email: leadEmail || undefined,
      } as any);
      setSelectedLead(null);
    } catch (e: any) {
      if (e.message === 'REUNIAO_ATIVA_EXISTENTE') {
        setPendingAgendar({ iso: dataReuniaoISO, closerId, extras: participantesExtras, leadEmail });
        setShowReplace(true);
      }
    } finally { setIsProcessing(false); }
  };

  const handleReplaceReuniao = async () => {
    if (!selectedLead || !pendingAgendar || isProcessing) return;
    setIsProcessing(true);
    try {
      await addReuniao({
        lead_id: selectedLead.id, empresa: selectedLead.empresa,
        nome_contato: selectedLead.nome_contato || undefined, canal: selectedLead.canal,
        sdr_id: selectedLead.sdr_id || currentUser?.id || undefined, closer_id: pendingAgendar.closerId || undefined,
        kommo_id: selectedLead.kommo_id || undefined,
        data_agendamento: new Date().toISOString().split('T')[0], data_reuniao: pendingAgendar.iso,
        participantes_extras: pendingAgendar.extras || undefined, lead_email: pendingAgendar.leadEmail || undefined,
      } as any, true);
      setSelectedLead(null); setShowReplace(false); setPendingAgendar(null);
    } finally { setIsProcessing(false); }
  };

  const handleConfirm = async (show: boolean, closerConfirmadoId: string) => {
    if (!confirmar) return;
    await updateReuniao(confirmar.id, { realizada: true, show, closer_confirmado_id: closerConfirmadoId });
    setConfirmar(null);
  };

  // Check if a noshow has been rescheduled (newer reuniao exists for same lead)
  const isRescheduled = (r: Reuniao) => {
    if (!r.lead_id) return false;
    return reunioes.some(other => other.id !== r.id && other.lead_id === r.lead_id && new Date(other.created_at) > new Date(r.created_at));
  };

  const [retryingId, setRetryingId] = useState<string | null>(null);

  const handleRetryInvite = async (r: Reuniao) => {
    if (retryingId) return;
    setRetryingId(r.id);
    try {
      const lead = r.lead_id ? leads.find(l => l.id === r.lead_id) : null;
      const result = await createCalendarEvent({
        empresa: r.empresa,
        data_reuniao: r.data_reuniao,
        closer_id: r.closer_id || undefined,
        sdr_id: r.sdr_id || undefined,
        lead_id: r.lead_id || undefined,
        reuniao_id: r.id,
        lead_email: lead?.email || undefined,
      });
      if (result) {
        await updateReuniao(r.id, { calendar_event_id: result.event_id, meet_link: result.meet_link } as any);
        toast.success(`Invite enviado para ${r.empresa}!`);
      }
    } catch (e: any) {
      toast.error(e.message || 'Erro ao criar invite');
    } finally { setRetryingId(null); }
  };

  const ReuniaoCard: React.FC<{ r: Reuniao; showActions?: boolean; showReagendar?: boolean }> = ({ r, showActions = false, showReagendar = false }) => {
    const { faturamento, nome_contato } = getLeadInfo(r);
    const rescheduled = showReagendar && isRescheduled(r);

    return (
      <div className={`flex items-center justify-between bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-lg px-4 py-3 hover:border-[var(--color-v4-border-strong)] transition-colors ${rescheduled ? 'opacity-50' : ''}`}>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {r.realizada ? (
            r.show ? <Check size={16} className="text-green-400 flex-shrink-0" /> : <XIcon size={16} className="text-red-400 flex-shrink-0" />
          ) : (
            <Calendar size={16} className="text-yellow-400 flex-shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm text-white font-medium truncate">{r.empresa}</span>
              {nome_contato && <span className="text-xs text-[var(--color-v4-text-muted)]">({nome_contato})</span>}
              {rescheduled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">Reagendado</span>}
            </div>
            {faturamento && <span className="text-[10px] text-[var(--color-v4-text-muted)]">{faturamento}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-[var(--color-v4-text-muted)]">{r.sdr?.name?.split(' ')[0] || ''}</span>
          {r.closer && <span className="text-xs text-blue-400 flex items-center gap-1"><User size={10} />{r.closer.name.split(' ')[0]}</span>}
          {r.data_reuniao && <span className="text-xs text-white">{new Date(r.data_reuniao).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>}
          {(r as any).meet_link ? (
            <a href={(r as any).meet_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
              className="px-2 py-1 rounded text-xs font-medium bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 flex items-center gap-1">
              <Video size={10} /> Meet
            </a>
          ) : !r.realizada && (
            <button onClick={(e) => { e.stopPropagation(); handleRetryInvite(r); }} disabled={retryingId === r.id}
              className="px-2 py-1 rounded text-xs font-medium bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25 flex items-center gap-1 disabled:opacity-50">
              <RefreshCw size={10} className={retryingId === r.id ? 'animate-spin' : ''} /> {retryingId === r.id ? '...' : 'Enviar Invite'}
            </button>
          )}
          {showActions && !r.realizada && (
            <button onClick={() => setConfirmar(r)}
              className="px-3 py-1.5 rounded text-xs font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30">
              Confirmar
            </button>
          )}
          {showReagendar && !rescheduled && r.lead_id && (
            <button onClick={() => {
              const lead = leads.find(l => l.id === r.lead_id);
              if (lead) { setSelectedLead(lead); }
            }}
              className="px-2 py-1.5 rounded text-xs font-medium bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 flex items-center gap-1">
              <Calendar size={10} /> Reagendar
            </button>
          )}
          {r.realizada && (
            <span className={`text-xs px-2 py-0.5 rounded ${r.show ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
              {r.show ? 'Show' : 'No-show'}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-display font-bold text-white">Reuniões</h2>
        <button onClick={() => setShowLeadPicker(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm">
          <Plus size={16} /> Agendar Reunião
        </button>
      </div>

      {/* Filtros */}
      <div className="flex gap-3 mb-6">
        <select value={filterCloser} onChange={e => setFilterCloser(e.target.value)}
          className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
          <option value="">Todos os Closers</option>
          {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filterSdr} onChange={e => setFilterSdr(e.target.value)}
          className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
          <option value="">Todos os SDRs</option>
          {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* PRÓXIMAS - agrupadas por dia */}
      <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-3">
        Próximas ({proximas.length})
      </h3>
      {proximasAgrupadas.length > 0 ? (
        <div className="space-y-4 mb-8">
          {proximasAgrupadas.map(group => (
            <div key={group.date}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                  group.label === 'Hoje' ? 'bg-yellow-500/20 text-yellow-400' :
                  group.label === 'Amanhã' ? 'bg-blue-500/20 text-blue-400' :
                  group.label.includes('atrasada') ? 'bg-red-500/20 text-red-400' :
                  'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'
                }`}>{group.label}</span>
                <span className="text-[10px] text-[var(--color-v4-text-muted)]">{group.items.length} reunião(ões)</span>
              </div>
              <div className="space-y-2">
                {group.items.map(r => <ReuniaoCard key={r.id} r={r} showActions />)}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--color-v4-text-muted)] mb-8 py-4">Nenhuma reunião agendada</p>
      )}

      {/* NO-SHOWS */}
      {noshows.length > 0 && (() => {
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const noshowsPendentes = noshows.filter(r => !isRescheduled(r));
        const noshowsReagendados = noshows.filter(r => isRescheduled(r));
        const noshowsRecentes = (filterNoshowReagendados ? noshowsReagendados : noshowsPendentes)
          .filter(r => r.data_reuniao && new Date(r.data_reuniao) >= twoWeeksAgo);
        const noshowsAntigos = (filterNoshowReagendados ? noshowsReagendados : noshowsPendentes)
          .filter(r => !r.data_reuniao || new Date(r.data_reuniao) < twoWeeksAgo);

        return (
          <>
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle size={14} className="text-red-400" />
              <h3 className="text-sm font-semibold text-red-400 uppercase tracking-wider">No-shows ({noshows.length})</h3>
              <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5 ml-2">
                <button onClick={() => setFilterNoshowReagendados(false)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${!filterNoshowReagendados ? 'bg-red-500/20 text-red-400' : 'text-[var(--color-v4-text-muted)]'}`}>
                  Pendentes ({noshowsPendentes.length})
                </button>
                <button onClick={() => setFilterNoshowReagendados(true)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${filterNoshowReagendados ? 'bg-green-500/20 text-green-400' : 'text-[var(--color-v4-text-muted)]'}`}>
                  Reagendados ({noshowsReagendados.length})
                </button>
              </div>
            </div>

            {noshowsRecentes.length > 0 && (
              <>
                <span className="text-[10px] text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-2 block">Últimas 2 semanas</span>
                <div className="space-y-2 mb-4">
                  {noshowsRecentes.map(r => <ReuniaoCard key={r.id} r={r} showReagendar />)}
                </div>
              </>
            )}

            {noshowsAntigos.length > 0 && (
              <>
                <button onClick={() => setShowNoshowsAntigos(!showNoshowsAntigos)}
                  className="flex items-center gap-2 text-[10px] text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-2 hover:text-white transition-colors">
                  {showNoshowsAntigos ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Anteriores ({noshowsAntigos.length})
                </button>
                {showNoshowsAntigos && (
                  <div className="space-y-2 mb-4">
                    {noshowsAntigos.map(r => <ReuniaoCard key={r.id} r={r} showReagendar />)}
                  </div>
                )}
              </>
            )}

            {noshowsRecentes.length === 0 && noshowsAntigos.length === 0 && (
              <p className="text-sm text-[var(--color-v4-text-muted)] mb-4 py-2">Nenhum no-show {filterNoshowReagendados ? 'reagendado' : 'pendente'}</p>
            )}
          </>
        );
      })()}

      {/* REALIZADAS - colapsavel */}
      <button onClick={() => setShowHistorico(!showHistorico)}
        className="flex items-center gap-2 mb-3 text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider hover:text-white transition-colors">
        {showHistorico ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Realizadas ({realizadas.length})
      </button>
      {showHistorico && (
        <div className="space-y-2">
          {realizadas.slice(0, 30).map(r => <ReuniaoCard key={r.id} r={r} />)}
        </div>
      )}

      {/* Lead Picker Modal */}
      {showLeadPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowLeadPicker(false)} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-[var(--color-v4-border)] flex items-center justify-between">
              <h3 className="text-sm font-bold text-white">Selecionar Lead</h3>
              <button onClick={() => setShowLeadPicker(false)} className="text-[var(--color-v4-text-muted)] hover:text-white"><XIcon size={18} /></button>
            </div>
            <div className="p-3 border-b border-[var(--color-v4-border)]">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
                <input className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm" placeholder="Buscar lead..." value={leadSearch} onChange={e => setLeadSearch(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {leadsDisponiveis.slice(0, 30).map(l => (
                <button key={l.id} onClick={() => handleSelectLead(l)}
                  className="w-full text-left px-4 py-3 hover:bg-[var(--color-v4-card-hover)] border-b border-[var(--color-v4-border)] last:border-0 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm text-white font-medium">{l.empresa}</span>
                      <p className="text-xs text-[var(--color-v4-text-muted)]">{l.nome_contato || '—'} · {CANAL_LABELS[l.canal]}</p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{LEAD_STATUS_LABELS[l.status]}</span>
                  </div>
                </button>
              ))}
              {leadsDisponiveis.length === 0 && <p className="text-sm text-[var(--color-v4-text-muted)] text-center py-8">Nenhum lead encontrado</p>}
            </div>
          </div>
        </div>
      )}

      {selectedLead && !showReplace && <AgendarReuniaoModal lead={selectedLead} onConfirm={handleAgendarConfirm} onClose={() => setSelectedLead(null)} />}
      {confirmar && <ConfirmarReuniaoModal reuniao={confirmar} onConfirm={handleConfirm} onClose={() => setConfirmar(null)} />}

      {showReplace && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setShowReplace(false); setPendingAgendar(null); setSelectedLead(null); }} />
          <div className="relative w-full max-w-sm bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-2">Reunião já existente</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">Este lead já tem uma reunião ativa. Deseja substituir?</p>
            <div className="flex gap-3">
              <button onClick={() => { setShowReplace(false); setPendingAgendar(null); setSelectedLead(null); }}
                className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
              <button onClick={handleReplaceReuniao} disabled={isProcessing}
                className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 disabled:opacity-30 text-black font-bold text-sm">{isProcessing ? 'Substituindo...' : 'Substituir'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
