import React, { useState, useMemo } from "react";
import { useAppStore } from "../store";
import { DEAL_STATUS_LABELS, TEMPERATURA_LABELS, type Deal, type DealStatus, type Temperatura } from "../types";
import { cn } from "./Layout";
import { Plus, ExternalLink, Search, ArrowUpDown } from "lucide-react";
import { DealDrawer } from "./DealDrawer";
import { FeedbackDrawer } from "./FeedbackDrawer";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { validateGanho, validateContratoNaRua } from "../lib/ganhoValidation";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";
import { DateFilter, filterByDate, type DatePreset } from "./ui/DateFilter";

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

type SortOption = 'default' | 'valor_mrr_desc' | 'valor_mrr_asc' | 'created_at_desc' | 'created_at_asc' | 'temperatura';

const SORT_LABELS: Record<SortOption, string> = {
  default: 'Padrão',
  valor_mrr_desc: 'Maior MRR',
  valor_mrr_asc: 'Menor MRR',
  created_at_desc: 'Mais recente',
  created_at_asc: 'Mais antigo',
  temperatura: 'Temperatura',
};

const TEMP_ORDER: Record<string, number> = { quente: 0, morno: 1, frio: 2 };

function sortDeals(deals: Deal[], sort: SortOption): Deal[] {
  if (sort === 'default') return deals;
  return [...deals].sort((a, b) => {
    switch (sort) {
      case 'valor_mrr_desc': return (b.valor_recorrente || b.valor_mrr || 0) - (a.valor_recorrente || a.valor_mrr || 0);
      case 'valor_mrr_asc': return (a.valor_recorrente || a.valor_mrr || 0) - (b.valor_recorrente || b.valor_mrr || 0);
      case 'created_at_desc': return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case 'created_at_asc': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      case 'temperatura': return (TEMP_ORDER[a.temperatura || ''] ?? 3) - (TEMP_ORDER[b.temperatura || ''] ?? 3);
      default: return 0;
    }
  });
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

export const PipelineView: React.FC = () => {
  const { deals, members, moveDeal, updateDeal } = useAppStore();
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [filterCloser, setFilterCloser] = useState('');
  const [filterSdr, setFilterSdr] = useState('');
  const [filterTemp, setFilterTemp] = useState<Temperatura | ''>('');
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('default');
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [dealToComplete, setDealToComplete] = useState<{ deal: Deal; targetStatus: DealStatus } | null>(null);

  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const sdrs = members.filter(m => (m.role === 'sdr' || m.role === 'gestor') && m.active);

  const activeFilterCount = [filterCloser, filterSdr, filterTemp, search, datePreset !== 'all' ? 'x' : ''].filter(Boolean).length;

  const filteredDeals = useMemo(() => {
    let result = deals.filter(d => {
      if (filterCloser && d.closer_id !== filterCloser) return false;
      if (filterSdr && d.sdr_id !== filterSdr) return false;
      if (filterTemp && d.temperatura !== filterTemp) return false;
      if (search && !d.empresa.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    result = filterByDate(result, d => d.created_at, datePreset, dateFrom, dateTo);
    return sortDeals(result, sortBy);
  }, [deals, filterCloser, filterSdr, filterTemp, search, datePreset, dateFrom, dateTo, sortBy]);

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
    if (dealToComplete) {
      setSelectedDeal(dealToComplete.deal);
      setDealToComplete(null);
    }
  };

  const handleDateChange = (preset: DatePreset, from?: string, to?: string) => {
    setDatePreset(preset);
    setDateFrom(from || '');
    setDateTo(to || '');
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

      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input type="text" placeholder="Buscar empresa..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]" />
        </div>
        <select value={filterCloser} onChange={e => setFilterCloser(e.target.value)}
          className={`px-3 py-2 rounded-lg border text-sm transition-colors ${filterCloser ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
          <option value="">Todos os Closers</option>
          {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filterSdr} onChange={e => setFilterSdr(e.target.value)}
          className={`px-3 py-2 rounded-lg border text-sm transition-colors ${filterSdr ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
          <option value="">Todos os SDRs</option>
          {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={filterTemp} onChange={e => setFilterTemp(e.target.value as any)}
          className={`px-3 py-2 rounded-lg border text-sm transition-colors ${filterTemp ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
          <option value="">Temperatura</option>
          <option value="quente">🔥 Quente</option>
          <option value="morno">🌤 Morno</option>
          <option value="frio">❄️ Frio</option>
        </select>
        <DateFilter value={datePreset} customFrom={dateFrom} customTo={dateTo} onChange={handleDateChange} />
        <div className="flex items-center gap-1.5">
          <ArrowUpDown size={14} className="text-[var(--color-v4-text-muted)]" />
          <select value={sortBy} onChange={e => setSortBy(e.target.value as SortOption)}
            className={`px-3 py-2 rounded-lg border text-sm transition-colors ${sortBy !== 'default' ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
            {Object.entries(SORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {activeFilterCount > 0 && (
          <button onClick={() => { setFilterCloser(''); setFilterSdr(''); setFilterTemp(''); setSearch(''); setDatePreset('all'); setDateFrom(''); setDateTo(''); setSortBy('default'); }}
            className="px-2.5 py-2 rounded-lg text-xs text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)] transition-colors">
            Limpar filtros ({activeFilterCount})
          </button>
        )}
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
                          <Draggable draggableId={deal.id} index={index} key={deal.id}>
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
