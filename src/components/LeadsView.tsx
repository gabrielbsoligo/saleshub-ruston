import React, { useState } from "react";
import { useAppStore } from "../store";
import { LEAD_STATUS_LABELS, CANAL_LABELS, type Lead, type LeadCanal, type LeadStatus } from "../types";
import { cn } from "./Layout";
import { Plus, Search, ExternalLink, Phone, Building2, Calendar, LayoutGrid, List } from "lucide-react";
import { LeadDrawer } from "./LeadDrawer";
import { MktlabImporter } from "./MktlabImporter";
import { AgendarReuniaoModal } from "./AgendarReuniaoModal";
import { ConfirmarReuniaoModal } from "./ConfirmarReuniaoModal";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import type { Reuniao } from "../types";

const STATUS_COLORS: Record<string, string> = {
  sem_contato: 'bg-gray-500/20 text-gray-400',
  em_follow: 'bg-blue-500/20 text-blue-400',
  reuniao_marcada: 'bg-yellow-500/20 text-yellow-400',
  reuniao_realizada: 'bg-green-500/20 text-green-400',
  aguardando_feedback: 'bg-amber-500/20 text-amber-400',
  noshow: 'bg-orange-500/20 text-orange-400',
  perdido: 'bg-red-500/20 text-red-400',
  estorno: 'bg-purple-500/20 text-purple-400',
  convertido: 'bg-emerald-500/20 text-emerald-400',
};

const KANBAN_STAGES: LeadStatus[] = ['sem_contato', 'em_follow', 'reuniao_marcada', 'reuniao_realizada', 'noshow'];
const STAGE_BORDER: Record<string, string> = {
  sem_contato: 'border-gray-500', em_follow: 'border-blue-500', reuniao_marcada: 'border-yellow-500',
  reuniao_realizada: 'border-green-500', noshow: 'border-orange-500',
};

export const LeadsView: React.FC = () => {
  const { leads, members, addReuniao, updateLead, updateReuniao, reunioes, currentUser } = useAppStore();
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showMktlab, setShowMktlab] = useState(false);
  const [agendarLead, setAgendarLead] = useState<Lead | null>(null);
  const [confirmarLead, setConfirmarLead] = useState<{ lead: Lead; reuniao: Reuniao } | null>(null);
  const [view, setView] = useState<'table' | 'kanban'>('kanban');
  const [filterCanal, setFilterCanal] = useState<LeadCanal | ''>('');
  const [filterStatus, setFilterStatus] = useState<LeadStatus | ''>('');
  const [filterSdr, setFilterSdr] = useState('');
  const [search, setSearch] = useState('');

  const sdrs = members.filter(m => (m.role === 'sdr' || m.role === 'gestor') && m.active);

  const filtered = leads.filter(l => {
    if (filterCanal && l.canal !== filterCanal) return false;
    if (filterStatus && l.status !== filterStatus) return false;
    if (filterSdr && l.sdr_id !== filterSdr) return false;
    if (search && !l.empresa.toLowerCase().includes(search.toLowerCase()) && !(l.nome_contato || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleLeadDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const leadId = result.draggableId;
    const newStatus = result.destination.droppableId as LeadStatus;
    const lead = leads.find(l => l.id === leadId);
    if (!lead || lead.status === newStatus) return;

    // Mover para reuniao_marcada → abre modal de agendar (se nao tem reuniao ativa)
    if (newStatus === 'reuniao_marcada') {
      const hasActive = reunioes.find(r => r.lead_id === lead.id && !r.realizada);
      if (hasActive && lead.status === 'reuniao_marcada') {
        return; // Ja esta em reuniao_marcada com reuniao ativa, nao faz nada
      }
      setAgendarLead(lead);
      return; // Nao move ate confirmar no modal
    }

    // Mover para reuniao_realizada → abre modal de confirmar reuniao
    if (newStatus === 'reuniao_realizada') {
      const leadReuniao = reunioes.find(r => r.lead_id === lead.id && !r.realizada);
      if (leadReuniao) {
        setConfirmarLead({ lead, reuniao: leadReuniao });
      } else {
        // Nao tem reuniao agendada, nao pode mover
        alert('Este lead não tem reunião agendada. Agende uma reunião primeiro.');
      }
      return;
    }

    await updateLead(leadId, { status: newStatus });
  };

  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [pendingAgendar, setPendingAgendar] = useState<{ iso: string; closerId: string } | null>(null);

  const handleAgendarConfirm = async (dataReuniaoISO: string, closerId: string, participantesExtras?: string[], leadEmail?: string) => {
    if (!agendarLead) return;
    try {
      await addReuniao({
        lead_id: agendarLead.id,
        empresa: agendarLead.empresa,
        nome_contato: agendarLead.nome_contato || undefined,
        canal: agendarLead.canal,
        sdr_id: agendarLead.sdr_id || currentUser?.id || undefined,
        closer_id: closerId || undefined,
        kommo_id: agendarLead.kommo_id || undefined,
        data_agendamento: new Date().toISOString().split('T')[0],
        data_reuniao: dataReuniaoISO,
        participantes_extras: participantesExtras || undefined,
        lead_email: leadEmail || undefined,
      } as any);
      setAgendarLead(null);
    } catch (e: any) {
      if (e.message === 'REUNIAO_ATIVA_EXISTENTE') {
        setPendingAgendar({ iso: dataReuniaoISO, closerId });
        setShowReplaceConfirm(true);
      }
    }
  };

  const [isReplacing, setIsReplacing] = useState(false);

  const handleReplaceReuniao = async () => {
    if (!agendarLead || !pendingAgendar || isReplacing) return;
    setIsReplacing(true);
    await addReuniao({
      lead_id: agendarLead.id,
      empresa: agendarLead.empresa,
      nome_contato: agendarLead.nome_contato || undefined,
      canal: agendarLead.canal,
      sdr_id: agendarLead.sdr_id || currentUser?.id || undefined,
      closer_id: pendingAgendar.closerId || undefined,
      kommo_id: agendarLead.kommo_id || undefined,
      data_agendamento: new Date().toISOString().split('T')[0],
      data_reuniao: pendingAgendar.iso,
    } as any, true); // replaceExisting = true
    setShowReplaceConfirm(false);
    setPendingAgendar(null);
    setAgendarLead(null);
    setIsReplacing(false);
  };

  const handleConfirmarReuniao = async (show: boolean, closerConfirmadoId: string) => {
    if (!confirmarLead) return;
    await updateReuniao(confirmarLead.reuniao.id, {
      realizada: true,
      show,
      closer_confirmado_id: closerConfirmadoId,
    });
    setConfirmarLead(null);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-display font-bold text-white">
          Leads <span className="text-[var(--color-v4-text-muted)] text-lg font-normal">({filtered.length})</span>
        </h2>
        <div className="flex gap-2">
          <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
            <button onClick={() => setView('kanban')} className={`p-2 rounded ${view === 'kanban' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}><LayoutGrid size={16} /></button>
            <button onClick={() => setView('table')} className={`p-2 rounded ${view === 'table' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}><List size={16} /></button>
          </div>
          <a href="/extensao.html" target="_blank" className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm no-underline">⚡ MKTLAB</a>
          <button onClick={() => setShowNew(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm"><Plus size={16} /> Novo Lead</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input type="text" placeholder="Buscar empresa ou contato..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]" />
        </div>
        <select value={filterCanal} onChange={e => setFilterCanal(e.target.value as any)} className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
          <option value="">Todos os Canais</option>
          {Object.entries(CANAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {view === 'table' && (
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
            <option value="">Todos os Status</option>
            {Object.entries(LEAD_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        <select value={filterSdr} onChange={e => setFilterSdr(e.target.value)} className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
          <option value="">Todos os SDRs</option>
          {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {/* KANBAN VIEW */}
      {view === 'kanban' && (
        <DragDropContext onDragEnd={handleLeadDragEnd}>
          <div className="flex-1 overflow-x-auto">
            <div className="flex gap-3 min-w-max h-full pb-4">
              {KANBAN_STAGES.map(stage => {
                const stageLeads = filtered.filter(l => l.status === stage);
                return (
                  <div key={stage} className="w-64 flex-shrink-0 flex flex-col">
                    <div className={cn("px-3 py-2.5 rounded-t-xl bg-[var(--color-v4-card)] border-t-2", STAGE_BORDER[stage] || 'border-gray-500')}>
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-semibold text-white">{LEAD_STATUS_LABELS[stage]}</h3>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{stageLeads.length}</span>
                      </div>
                    </div>
                    <Droppable droppableId={stage}>
                      {(provided, snapshot) => (
                        <div ref={provided.innerRef} {...provided.droppableProps}
                          className={cn(
                            "flex-1 overflow-y-auto space-y-2 p-2 bg-[var(--color-v4-bg)] rounded-b-xl border border-t-0 border-[var(--color-v4-border)] transition-colors min-h-[80px]",
                            snapshot.isDraggingOver && "bg-[var(--color-v4-surface)] border-[var(--color-v4-border-strong)]"
                          )}>
                          {stageLeads.slice(0, 50).map((lead, index) => (
                            <Draggable draggableId={lead.id} index={index}>
                              {(provided, snapshot) => (
                                <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}
                                  onClick={() => setSelectedLead(lead)}
                                  className={cn(
                                    "p-2.5 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-border-strong)] cursor-pointer transition-colors group",
                                    snapshot.isDragging && "shadow-xl shadow-black/30 border-[var(--color-v4-red)] rotate-1"
                                  )}>
                                  <div className="flex items-start justify-between mb-1">
                                    <h4 className="text-xs font-medium text-white truncate flex-1">{lead.empresa}</h4>
                                    {lead.kommo_link && <a href={lead.kommo_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="text-[var(--color-v4-text-muted)] hover:text-white ml-1"><ExternalLink size={10} /></a>}
                                  </div>
                                  {lead.nome_contato && <p className="text-[10px] text-[var(--color-v4-text-muted)] mb-1">{lead.nome_contato} {lead.telefone ? `· ${lead.telefone}` : ''}</p>}
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{CANAL_LABELS[lead.canal]}</span>
                                    <span className="text-[10px] text-[var(--color-v4-text-muted)]">{lead.sdr?.name?.split(' ')[0]}</span>
                                  </div>
                                  {['sem_contato', 'em_follow'].includes(lead.status) && (
                                    <button onClick={e => { e.stopPropagation(); setAgendarLead(lead); }}
                                      className="mt-2 w-full flex items-center justify-center gap-1 py-1.5 rounded text-[10px] font-medium bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 opacity-0 group-hover:opacity-100 transition-opacity">
                                      <Calendar size={10} /> Agendar Reunião
                                    </button>
                                  )}
                                </div>
                              )}
                            </Draggable>
                          ))}
                          {provided.placeholder}
                        </div>
                      )}
                    </Droppable>
                  </div>
                );
              })}
            </div>
          </div>
        </DragDropContext>
      )}

      {/* TABLE VIEW */}
      {view === 'table' && (
        <div className="flex-1 overflow-auto rounded-xl border border-[var(--color-v4-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-v4-card)] sticky top-0">
              <tr className="text-left text-[var(--color-v4-text-muted)]">
                <th className="px-4 py-3 font-medium">Empresa</th>
                <th className="px-4 py-3 font-medium">Contato</th>
                <th className="px-4 py-3 font-medium">Canal</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">SDR</th>
                <th className="px-4 py-3 font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map(lead => (
                <tr key={lead.id} onClick={() => setSelectedLead(lead)}
                  className="border-t border-[var(--color-v4-border)] hover:bg-[var(--color-v4-card-hover)] cursor-pointer transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 size={14} className="text-[var(--color-v4-text-muted)]" />
                      <span className="text-white font-medium">{lead.empresa}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-white">{lead.nome_contato || '—'}</div>
                    {lead.telefone && <div className="text-xs text-[var(--color-v4-text-muted)] flex items-center gap-1"><Phone size={10} />{lead.telefone}</div>}
                  </td>
                  <td className="px-4 py-3"><span className="text-xs px-2 py-1 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{CANAL_LABELS[lead.canal]}</span></td>
                  <td className="px-4 py-3"><span className={cn("text-xs px-2 py-1 rounded", STATUS_COLORS[lead.status])}>{LEAD_STATUS_LABELS[lead.status]}</span></td>
                  <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{lead.sdr?.name?.split(' ')[0] || '—'}</td>
                  <td className="px-4 py-3">
                    {['sem_contato', 'em_follow'].includes(lead.status) && (
                      <button onClick={e => { e.stopPropagation(); setAgendarLead(lead); }}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20">
                        <Calendar size={10} /> Agendar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={6} className="px-4 py-12 text-center text-[var(--color-v4-text-muted)]">Nenhum lead encontrado</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {(selectedLead || showNew) && <LeadDrawer lead={showNew ? null : selectedLead} onClose={() => { setSelectedLead(null); setShowNew(false); }} />}
      {showMktlab && <MktlabImporter onClose={() => setShowMktlab(false)} />}
      {agendarLead && !showReplaceConfirm && <AgendarReuniaoModal lead={agendarLead} onConfirm={handleAgendarConfirm} onClose={() => { setAgendarLead(null); setPendingAgendar(null); }} />}
      {confirmarLead && <ConfirmarReuniaoModal reuniao={confirmarLead.reuniao} onConfirm={handleConfirmarReuniao} onClose={() => setConfirmarLead(null)} />}

      {showReplaceConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setShowReplaceConfirm(false); setPendingAgendar(null); setAgendarLead(null); }} />
          <div className="relative w-full max-w-sm bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-2">Reunião já existente</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">Este lead já tem uma reunião ativa. Deseja substituir pela nova?</p>
            <div className="flex gap-3">
              <button onClick={() => { setShowReplaceConfirm(false); setPendingAgendar(null); setAgendarLead(null); }}
                className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
              <button onClick={handleReplaceReuniao} disabled={isReplacing}
                className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 disabled:opacity-30 text-black font-bold text-sm">{isReplacing ? 'Substituindo...' : 'Substituir'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
