import React, { useState } from "react";
import { useAppStore } from "../store";
import { DEAL_STATUS_LABELS, TEMPERATURA_LABELS, type Deal, type DealStatus } from "../types";
import { cn } from "./Layout";
import { Plus, ExternalLink, Thermometer, Search } from "lucide-react";
import { DealDrawer } from "./DealDrawer";
import { FeedbackDrawer } from "./FeedbackDrawer";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { validateGanho, validateContratoNaRua } from "../lib/ganhoValidation";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";

// Nova ordem do kanban
const PIPELINE_STAGES: DealStatus[] = ['dar_feedback', 'follow_longo', 'negociacao', 'contrato_na_rua', 'contrato_assinado', 'perdido'];

const STAGE_COLORS: Record<DealStatus, string> = {
  dar_feedback: 'border-amber-400',
  follow_longo: 'border-orange-500',
  negociacao: 'border-blue-500',
  contrato_na_rua: 'border-yellow-500',
  contrato_assinado: 'border-green-500',
  perdido: 'border-red-500',
};

const TEMP_COLORS: Record<string, string> = {
  quente: 'text-red-400 bg-red-400/10',
  morno: 'text-yellow-400 bg-yellow-400/10',
  frio: 'text-blue-400 bg-blue-400/10',
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

export const PipelineView: React.FC = () => {
  const { deals, members, moveDeal, updateDeal } = useAppStore();
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [filterCloser, setFilterCloser] = useState('');
  const [search, setSearch] = useState('');
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  // Deal que precisa completar dados para mover (abre FeedbackDrawer pra completar)
  const [dealToComplete, setDealToComplete] = useState<{ deal: Deal; targetStatus: DealStatus } | null>(null);

  const closers = members.filter(m => m.role === 'closer' || m.role === 'gestor');

  const filteredDeals = deals.filter(d => {
    if (filterCloser && d.closer_id !== filterCloser) return false;
    if (search && !d.empresa.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const dealId = result.draggableId;
    const newStatus = result.destination.droppableId as DealStatus;
    const deal = deals.find(d => d.id === dealId);
    if (!deal || deal.status === newStatus) return;

    // Não deixa arrastar pra dar_feedback
    if (newStatus === 'dar_feedback') return;

    // Contrato na Rua: precisa de produtos + preços
    if (newStatus === 'contrato_na_rua') {
      const validation = validateContratoNaRua({
        produtos_ot: deal.produtos_ot || [],
        produtos_mrr: deal.produtos_mrr || [],
        valor_escopo: deal.valor_escopo || 0,
        valor_recorrente: deal.valor_recorrente || 0,
      });
      if (!validation.valid) {
        // Abre o deal pra completar, mostrando o que falta
        setMissingFields(validation.missing);
        setDealToComplete({ deal, targetStatus: newStatus });
        return;
      }
    }

    // Contrato Assinado: validação completa de ganho
    if (newStatus === 'contrato_assinado') {
      const validation = validateGanho({
        produtos_ot: deal.produtos_ot || [],
        produtos_mrr: deal.produtos_mrr || [],
        valor_escopo: deal.valor_escopo || 0,
        valor_recorrente: deal.valor_recorrente || 0,
        data_inicio_escopo: deal.data_inicio_escopo || '',
        data_pgto_escopo: deal.data_pgto_escopo || '',
        data_inicio_recorrente: deal.data_inicio_recorrente || '',
        data_pgto_recorrente: deal.data_pgto_recorrente || '',
        link_call_vendas: deal.link_call_vendas || '',
        link_transcricao: deal.link_transcricao || '',
        contrato_url: deal.contrato_url || '',
        tier: deal.tier || '',
        closer_id: deal.closer_id || '',
        temperatura: deal.temperatura || '',
        bant: deal.bant || 0,
      });
      if (!validation.valid) {
        setMissingFields(validation.missing);
        setDealToComplete({ deal, targetStatus: newStatus });
        return;
      }
      await updateDeal(dealId, { status: newStatus, data_fechamento: new Date().toISOString().split('T')[0] });
      return;
    }

    await moveDeal(dealId, newStatus);
  };

  const handleMissingClose = () => {
    setMissingFields(null);
    // Abre o drawer do deal pra completar
    if (dealToComplete) {
      setSelectedDeal(dealToComplete.deal);
      setDealToComplete(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Pipeline de Negociações</h2>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm transition-colors">
          <Plus size={16} /> Nova Negociação
        </button>
      </div>

      <div className="flex gap-3 mb-4">
        <div className="relative flex-1 max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input type="text" placeholder="Buscar empresa..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]" />
        </div>
        <select value={filterCloser} onChange={e => setFilterCloser(e.target.value)}
          className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm">
          <option value="">Todos os Closers</option>
          {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-x-auto">
          <div className="flex gap-4 min-w-max h-full pb-4">
            {PIPELINE_STAGES.map(stage => {
              const stageDeals = filteredDeals.filter(d => d.status === stage);
              const totalMrr = stageDeals.reduce((acc, d) => acc + (d.valor_recorrente || d.valor_mrr || 0), 0);
              const totalOt = stageDeals.reduce((acc, d) => acc + (d.valor_escopo || d.valor_ot || 0), 0);

              return (
                <div key={stage} className="w-72 flex-shrink-0 flex flex-col">
                  <div className={cn("px-4 py-3 rounded-t-xl bg-[var(--color-v4-card)] border-t-2", STAGE_COLORS[stage])}>
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-white">{DEAL_STATUS_LABELS[stage]}</h3>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{stageDeals.length}</span>
                    </div>
                    <div className="flex gap-3 mt-1">
                      {totalMrr > 0 && <span className="text-xs text-white/70">MRR {formatCurrency(totalMrr)}</span>}
                      {totalOt > 0 && <span className="text-xs text-white/70">OT {formatCurrency(totalOt)}</span>}
                    </div>
                  </div>

                  <Droppable droppableId={stage}>
                    {(provided, snapshot) => (
                      <div ref={provided.innerRef} {...provided.droppableProps}
                        className={cn(
                          "flex-1 overflow-y-auto space-y-2 p-2 bg-[var(--color-v4-bg)] rounded-b-xl border border-t-0 border-[var(--color-v4-border)] transition-colors min-h-[100px]",
                          snapshot.isDraggingOver && "bg-[var(--color-v4-surface)] border-[var(--color-v4-border-strong)]"
                        )}>
                        {stageDeals.map((deal, index) => (
                          <Draggable draggableId={deal.id} index={index}>
                            {(provided, snapshot) => (
                              <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}
                                onClick={() => setSelectedDeal(deal)}
                                className={cn(
                                  "p-3 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-border-strong)] cursor-pointer transition-colors",
                                  snapshot.isDragging && "shadow-xl shadow-black/30 border-[var(--color-v4-red)] rotate-1"
                                )}>
                                <div className="flex items-start justify-between mb-1">
                                  <h4 className="text-sm font-medium text-white truncate flex-1">{deal.empresa}</h4>
                                  {deal.kommo_link && <a href={deal.kommo_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="text-[var(--color-v4-text-muted)] hover:text-white ml-1"><ExternalLink size={12} /></a>}
                                </div>
                                <div className="flex flex-wrap gap-1 mb-2">
                                  {(deal.produtos_mrr || []).map(p => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{p}</span>)}
                                  {(deal.produtos_ot || []).map(p => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{p}</span>)}
                                  {deal.produto && !(deal.produtos_mrr?.length || deal.produtos_ot?.length) && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{deal.produto}</span>
                                  )}
                                  {deal.temperatura && <span className={cn("text-[10px] px-1.5 py-0.5 rounded", TEMP_COLORS[deal.temperatura])}>{TEMPERATURA_LABELS[deal.temperatura]}</span>}
                                  {deal.bant === 4 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 font-semibold">BANT 4</span>}
                                </div>
                                <div className="flex items-center justify-between text-xs">
                                  <div className="flex gap-2">
                                    {((deal.valor_recorrente || deal.valor_mrr || 0) > 0) && <span className="text-white">{formatCurrency(deal.valor_recorrente || deal.valor_mrr)}/mês</span>}
                                    {((deal.valor_escopo || deal.valor_ot || 0) > 0) && <span className="text-white">{formatCurrency(deal.valor_escopo || deal.valor_ot)}</span>}
                                  </div>
                                  <span className="text-[var(--color-v4-text-muted)]">{deal.closer?.name?.split(' ')[0] || '—'}</span>
                                </div>
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

      {selectedDeal && selectedDeal.status === 'dar_feedback' && !dealToComplete && (
        <FeedbackDrawer deal={selectedDeal} onClose={() => setSelectedDeal(null)} />
      )}

      {((selectedDeal && selectedDeal.status !== 'dar_feedback') || showNew) && (
        <DealDrawer deal={showNew ? null : selectedDeal} onClose={() => { setSelectedDeal(null); setShowNew(false); }} />
      )}

      {missingFields && <MissingFieldsPopup missing={missingFields} onClose={handleMissingClose} />}
    </div>
  );
};
