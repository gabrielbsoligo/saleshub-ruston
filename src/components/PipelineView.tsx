import React, { useState, useMemo } from "react";
import { useAppStore } from "../store";
import { DEAL_STATUS_LABELS, TEMPERATURA_LABELS, type Deal, type DealStatus, type Temperatura } from "../types";
import { cn } from "./Layout";
import { Plus, ExternalLink, Search, ArrowUpDown, LayoutGrid, List, ChevronUp, ChevronDown, Thermometer } from "lucide-react";
import { DealDrawer } from "./DealDrawer";
import { FeedbackDrawer } from "./FeedbackDrawer";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { validateGanho, validateContratoNaRua } from "../lib/ganhoValidation";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";
import { DateFilter, filterByDate, type DatePreset } from "./ui/DateFilter";
import { SendToAuditoriaButton } from "./SendToAuditoriaButton";

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

const STAGE_BG: Record<DealStatus, string> = {
  dar_feedback: 'bg-amber-500/20 text-amber-400',
  follow_longo: 'bg-orange-500/20 text-orange-400',
  negociacao: 'bg-blue-500/20 text-blue-400',
  contrato_na_rua: 'bg-yellow-500/20 text-yellow-400',
  contrato_assinado: 'bg-green-500/20 text-green-400',
  perdido: 'bg-red-500/20 text-red-400',
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

// Table sort
type TableSortField = 'empresa' | 'status' | 'temperatura' | 'valor_mrr' | 'valor_ot' | 'created_at';
type SortDir = 'asc' | 'desc';

const STATUS_ORDER: Record<string, number> = {
  dar_feedback: 0, follow_longo: 1, negociacao: 2, contrato_na_rua: 3, contrato_assinado: 4, perdido: 5,
};

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

function sortDealsTable(deals: Deal[], field: TableSortField, dir: SortDir): Deal[] {
  return [...deals].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'empresa': cmp = a.empresa.localeCompare(b.empresa); break;
      case 'status': cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99); break;
      case 'temperatura': cmp = (TEMP_ORDER[a.temperatura || ''] ?? 3) - (TEMP_ORDER[b.temperatura || ''] ?? 3); break;
      case 'valor_mrr': cmp = (a.valor_recorrente || a.valor_mrr || 0) - (b.valor_recorrente || b.valor_mrr || 0); break;
      case 'valor_ot': cmp = (a.valor_escopo || a.valor_ot || 0) - (b.valor_escopo || b.valor_ot || 0); break;
      case 'created_at': cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
    }
    return dir === 'desc' ? -cmp : cmp;
  });
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

export const PipelineView: React.FC = () => {
  const { deals, members, moveDeal, updateDeal } = useAppStore();
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [view, setView] = useState<'kanban' | 'table'>('kanban');
  const [filterCloser, setFilterCloser] = useState('');
  const [filterSdr, setFilterSdr] = useState('');
  const [filterTemp, setFilterTemp] = useState<Temperatura | ''>('');
  const [filterStatus, setFilterStatus] = useState<DealStatus | ''>('');
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('default');
  const [tableSortField, setTableSortField] = useState<TableSortField>('created_at');
  const [tableSortDir, setTableSortDir] = useState<SortDir>('desc');
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [dealToComplete, setDealToComplete] = useState<{ deal: Deal; targetStatus: DealStatus } | null>(null);

  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const sdrs = members.filter(m => (m.role === 'sdr' || m.role === 'gestor') && m.active);

  const activeFilterCount = [filterCloser, filterSdr, filterTemp, filterStatus, search, datePreset !== 'all' ? 'x' : ''].filter(Boolean).length;

  const filteredDeals = useMemo(() => {
    let result = deals.filter(d => {
      if (filterCloser && d.closer_id !== filterCloser) return false;
      if (filterSdr && d.sdr_id !== filterSdr) return false;
      if (filterTemp && d.temperatura !== filterTemp) return false;
      if (filterStatus && d.status !== filterStatus) return false;
      if (search && !d.empresa.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    result = filterByDate(result, d => d.created_at, datePreset, dateFrom, dateTo);
    return sortDeals(result, sortBy);
  }, [deals, filterCloser, filterSdr, filterTemp, filterStatus, search, datePreset, dateFrom, dateTo, sortBy]);

  const sortedForTable = useMemo(() => sortDealsTable(filteredDeals, tableSortField, tableSortDir), [filteredDeals, tableSortField, tableSortDir]);

  const handleTableSort = (field: TableSortField) => {
    if (tableSortField === field) {
      setTableSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setTableSortField(field);
      setTableSortDir(field === 'empresa' ? 'asc' : 'desc');
    }
  };

  const TableSortIcon: React.FC<{ field: TableSortField }> = ({ field }) => {
    if (tableSortField !== field) return <ChevronDown size={12} className="text-[var(--color-v4-text-muted)]/40" />;
    return tableSortDir === 'asc'
      ? <ChevronUp size={12} className="text-[var(--color-v4-red)]" />
      : <ChevronDown size={12} className="text-[var(--color-v4-red)]" />;
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const dealId = result.draggableId;
    const newStatus = result.destination.droppableId as DealStatus;
    const deal = deals.find(d => d.id === dealId);
    if (!deal || deal.status === newStatus) return;

    if (newStatus === 'dar_feedback') return;

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
        <h2 className="text-2xl font-display font-bold text-white">
          Pipeline de Negociações <span className="text-[var(--color-v4-text-muted)] text-lg font-normal">({filteredDeals.length})</span>
        </h2>
        <div className="flex gap-2">
          <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
            <button onClick={() => setView('kanban')} className={`p-2 rounded ${view === 'kanban' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}><LayoutGrid size={16} /></button>
            <button onClick={() => setView('table')} className={`p-2 rounded ${view === 'table' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}><List size={16} /></button>
          </div>
          <SendToAuditoriaButton
            items={filteredDeals.map(d => ({ tipo: 'deal' as const, id: d.id }))}
            origem="pipeline_view"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-medium text-sm disabled:opacity-50"
          />
          <button onClick={() => setShowNew(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm transition-colors">
            <Plus size={16} /> Nova Negociação
          </button>
        </div>
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
        {view === 'table' && (
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
            className={`px-3 py-2 rounded-lg border text-sm transition-colors ${filterStatus ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
            <option value="">Todos os Status</option>
            {PIPELINE_STAGES.map(s => <option key={s} value={s}>{DEAL_STATUS_LABELS[s]}</option>)}
          </select>
        )}
        <DateFilter value={datePreset} customFrom={dateFrom} customTo={dateTo} onChange={handleDateChange} />
        {view === 'kanban' && (
          <div className="flex items-center gap-1.5">
            <ArrowUpDown size={14} className="text-[var(--color-v4-text-muted)]" />
            <select value={sortBy} onChange={e => setSortBy(e.target.value as SortOption)}
              className={`px-3 py-2 rounded-lg border text-sm transition-colors ${sortBy !== 'default' ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
              {Object.entries(SORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        )}
        {activeFilterCount > 0 && (
          <button onClick={() => { setFilterCloser(''); setFilterSdr(''); setFilterTemp(''); setFilterStatus(''); setSearch(''); setDatePreset('all'); setDateFrom(''); setDateTo(''); setSortBy('default'); }}
            className="px-2.5 py-2 rounded-lg text-xs text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)] transition-colors">
            Limpar filtros ({activeFilterCount})
          </button>
        )}
      </div>

      {/* KANBAN VIEW */}
      {view === 'kanban' && (
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
      )}

      {/* TABLE VIEW */}
      {view === 'table' && (
        <div className="flex-1 overflow-auto rounded-xl border border-[var(--color-v4-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-v4-card)] sticky top-0">
              <tr className="text-left text-[var(--color-v4-text-muted)]">
                <th className="px-4 py-3 font-medium cursor-pointer hover:text-white select-none" onClick={() => handleTableSort('empresa')}>
                  <span className="flex items-center gap-1">Empresa <TableSortIcon field="empresa" /></span>
                </th>
                <th className="px-4 py-3 font-medium">Produtos</th>
                <th className="px-4 py-3 font-medium cursor-pointer hover:text-white select-none" onClick={() => handleTableSort('status')}>
                  <span className="flex items-center gap-1">Etapa <TableSortIcon field="status" /></span>
                </th>
                <th className="px-4 py-3 font-medium cursor-pointer hover:text-white select-none" onClick={() => handleTableSort('temperatura')}>
                  <span className="flex items-center gap-1">Temp. <TableSortIcon field="temperatura" /></span>
                </th>
                <th className="px-4 py-3 font-medium cursor-pointer hover:text-white select-none text-right" onClick={() => handleTableSort('valor_mrr')}>
                  <span className="flex items-center gap-1 justify-end">MRR <TableSortIcon field="valor_mrr" /></span>
                </th>
                <th className="px-4 py-3 font-medium cursor-pointer hover:text-white select-none text-right" onClick={() => handleTableSort('valor_ot')}>
                  <span className="flex items-center gap-1 justify-end">OT <TableSortIcon field="valor_ot" /></span>
                </th>
                <th className="px-4 py-3 font-medium">Closer</th>
                <th className="px-4 py-3 font-medium">SDR</th>
                <th className="px-4 py-3 font-medium cursor-pointer hover:text-white select-none" onClick={() => handleTableSort('created_at')}>
                  <span className="flex items-center gap-1">Criado <TableSortIcon field="created_at" /></span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedForTable.slice(0, 150).map(deal => {
                const mrr = deal.valor_recorrente || deal.valor_mrr || 0;
                const ot = deal.valor_escopo || deal.valor_ot || 0;
                return (
                  <tr key={deal.id} onClick={() => setSelectedDeal(deal)}
                    className="border-t border-[var(--color-v4-border)] hover:bg-[var(--color-v4-card-hover)] cursor-pointer transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{deal.empresa}</span>
                        {deal.kommo_link && <a href={deal.kommo_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className="text-[var(--color-v4-text-muted)] hover:text-white"><ExternalLink size={11} /></a>}
                        {deal.bant === 4 && <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-400 font-semibold">BANT 4</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {(deal.produtos_mrr || []).map(p => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">{p}</span>)}
                        {(deal.produtos_ot || []).map(p => <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">{p}</span>)}
                        {deal.produto && !(deal.produtos_mrr?.length || deal.produtos_ot?.length) && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{deal.produto}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-xs px-2 py-1 rounded", STAGE_BG[deal.status])}>{DEAL_STATUS_LABELS[deal.status]}</span>
                    </td>
                    <td className="px-4 py-3">
                      {deal.temperatura ? (
                        <span className={cn("text-xs px-2 py-0.5 rounded", TEMP_COLORS[deal.temperatura])}>{TEMPERATURA_LABELS[deal.temperatura]}</span>
                      ) : <span className="text-[var(--color-v4-text-muted)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {mrr > 0 ? <span className="text-white font-medium">{formatCurrency(mrr)}<span className="text-[var(--color-v4-text-muted)] text-xs">/mês</span></span> : <span className="text-[var(--color-v4-text-muted)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {ot > 0 ? <span className="text-white font-medium">{formatCurrency(ot)}</span> : <span className="text-[var(--color-v4-text-muted)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{deal.closer?.name?.split(' ')[0] || '—'}</td>
                    <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{deal.sdr?.name?.split(' ')[0] || '—'}</td>
                    <td className="px-4 py-3 text-xs text-[var(--color-v4-text-muted)]">
                      {new Date(deal.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </td>
                  </tr>
                );
              })}
              {filteredDeals.length === 0 && <tr><td colSpan={9} className="px-4 py-12 text-center text-[var(--color-v4-text-muted)]">Nenhuma negociação encontrada</td></tr>}
            </tbody>
          </table>
        </div>
      )}

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
