// =============================================================
// Pipeline Table Columns — catálogo + seletor + persistência
// =============================================================
// Sistema de colunas customizáveis pra view de tabela do Pipeline.
// - Catálogo de todas colunas possíveis (ALL_COLUMNS)
// - Hook usePipelineColumns() lê/salva config no localStorage
// - ColumnsSettingsModal: checkboxes + reorder via setas
// =============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { X, Settings, ChevronUp, ChevronDown, RotateCcw, ExternalLink } from 'lucide-react';
import { DEAL_STATUS_LABELS, TEMPERATURA_LABELS, type Deal } from '../types';
import { cn } from './Layout';

const STORAGE_KEY = 'pipeline_table_columns_v1';

// ---------- tipos ----------
// Sort field agora eh string (id da coluna) - sort engine generico
export type TableSortField = string;

// Valor a ser usado pra ordenar. Retorna numero, string ou null (empurra pro final).
export type SortValue = number | string | null | undefined;

export interface ColumnDef {
  id: string;
  label: string;
  /** Se fornecido, coluna fica ordenavel. Retorna valor comparavel. */
  sortValue?: (deal: Deal) => SortValue;
  align?: 'left' | 'right';
  defaultVisible: boolean;
  render: (deal: Deal, helpers: ColumnHelpers) => React.ReactNode;
}

// ---------- orders ----------
const STATUS_ORDER: Record<string, number> = {
  dar_feedback: 0, follow_longo: 1, negociacao: 2, contrato_na_rua: 3, contrato_assinado: 4, perdido: 5,
};
const TEMP_ORDER: Record<string, number> = { quente: 0, morno: 1, frio: 2 };
const TIER_ORDER: Record<string, number> = { tiny: 0, small: 1, medium: 2, large: 3, enterprise: 4 };

const dateMs = (d?: string | null) => d ? new Date(d).getTime() : NaN;

export interface ColumnHelpers {
  formatCurrency: (n: number) => string;
  formatDate: (d?: string | null) => string;
  stageBg: Record<string, string>;
  tempColors: Record<string, string>;
}

// ---------- helpers compartilhados ----------
const muted = <span className="text-[var(--color-v4-text-muted)]">—</span>;

// ---------- catálogo de colunas ----------
export const ALL_COLUMNS: ColumnDef[] = [
  {
    id: 'empresa', label: 'Empresa', defaultVisible: true,
    sortValue: (d) => d.empresa.toLowerCase(),
    render: (deal) => (
      <div className="flex items-center gap-2">
        <span className="text-white font-medium">{deal.empresa}</span>
        {deal.kommo_link && (
          <a href={deal.kommo_link} target="_blank" rel="noopener"
             onClick={e => e.stopPropagation()}
             className="text-[var(--color-v4-text-muted)] hover:text-white">
            <ExternalLink size={11} />
          </a>
        )}
        {deal.bant === 4 && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-400 font-semibold">BANT 4</span>
        )}
      </div>
    ),
  },
  {
    id: 'produtos', label: 'Produtos', defaultVisible: true,
    render: (deal) => (
      <div className="flex flex-wrap gap-1 max-w-[200px]">
        {(deal.produtos_mrr || []).map(p => (
          <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">{p}</span>
        ))}
        {(deal.produtos_ot || []).map(p => (
          <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">{p}</span>
        ))}
        {deal.produto && !(deal.produtos_mrr?.length || deal.produtos_ot?.length) && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{deal.produto}</span>
        )}
      </div>
    ),
  },
  {
    id: 'status', label: 'Etapa', defaultVisible: true,
    sortValue: (d) => STATUS_ORDER[d.status] ?? 99,
    render: (deal, h) => (
      <span className={cn('text-xs px-2 py-1 rounded', h.stageBg[deal.status])}>
        {DEAL_STATUS_LABELS[deal.status]}
      </span>
    ),
  },
  {
    id: 'temperatura', label: 'Temp.', defaultVisible: true,
    sortValue: (d) => TEMP_ORDER[d.temperatura || ''] ?? 99,
    render: (deal, h) => deal.temperatura
      ? <span className={cn('text-xs px-2 py-0.5 rounded', h.tempColors[deal.temperatura])}>{TEMPERATURA_LABELS[deal.temperatura]}</span>
      : muted,
  },
  {
    id: 'valor_mrr', label: 'MRR', align: 'right', defaultVisible: true,
    sortValue: (d) => d.valor_recorrente || d.valor_mrr || 0,
    render: (deal, h) => {
      const mrr = deal.valor_recorrente || deal.valor_mrr || 0;
      return mrr > 0
        ? <span className="text-white font-medium">{h.formatCurrency(mrr)}<span className="text-[var(--color-v4-text-muted)] text-xs">/mês</span></span>
        : muted;
    },
  },
  {
    id: 'valor_ot', label: 'OT', align: 'right', defaultVisible: true,
    sortValue: (d) => d.valor_escopo || d.valor_ot || 0,
    render: (deal, h) => {
      const ot = deal.valor_escopo || deal.valor_ot || 0;
      return ot > 0
        ? <span className="text-white font-medium">{h.formatCurrency(ot)}</span>
        : muted;
    },
  },
  {
    id: 'closer', label: 'Closer', defaultVisible: true,
    sortValue: (d) => (d.closer?.name || '').toLowerCase(),
    render: (deal) => (
      <span className="text-[var(--color-v4-text-muted)]">{deal.closer?.name?.split(' ')[0] || '—'}</span>
    ),
  },
  {
    id: 'sdr', label: 'SDR', defaultVisible: true,
    sortValue: (d) => (d.sdr?.name || '').toLowerCase(),
    render: (deal) => (
      <span className="text-[var(--color-v4-text-muted)]">{deal.sdr?.name?.split(' ')[0] || '—'}</span>
    ),
  },
  {
    id: 'created_at', label: 'Criado', defaultVisible: true,
    sortValue: (d) => dateMs(d.created_at),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.created_at)}</span>,
  },

  // ---------- colunas OPCIONAIS (default: oculto) ----------
  {
    id: 'bant', label: 'BANT', align: 'right', defaultVisible: false,
    sortValue: (d) => d.bant ?? null,
    render: (deal) => deal.bant
      ? <span className="text-white">{deal.bant}</span>
      : muted,
  },
  {
    id: 'tier', label: 'Tier', defaultVisible: false,
    sortValue: (d) => d.tier ? TIER_ORDER[d.tier] ?? 99 : null,
    render: (deal) => deal.tier
      ? <span className="text-xs px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-400">{deal.tier}</span>
      : muted,
  },
  {
    id: 'origem', label: 'Origem', defaultVisible: false,
    sortValue: (d) => (d.origem || '').toLowerCase() || null,
    render: (deal) => deal.origem
      ? <span className="text-[var(--color-v4-text-muted)] text-xs">{deal.origem}</span>
      : muted,
  },
  {
    id: 'kommo_id', label: 'Kommo ID', defaultVisible: false,
    sortValue: (d) => d.kommo_id ? Number(d.kommo_id) || d.kommo_id : null,
    render: (deal) => deal.kommo_id
      ? <span className="text-[var(--color-v4-text-muted)] text-xs font-mono">{deal.kommo_id}</span>
      : muted,
  },
  {
    id: 'curva_dias', label: 'Curva (dias)', align: 'right', defaultVisible: false,
    sortValue: (d) => typeof d.curva_dias === 'number' ? d.curva_dias : null,
    render: (deal) => typeof deal.curva_dias === 'number'
      ? <span className="text-white">{deal.curva_dias}</span>
      : muted,
  },
  {
    id: 'motivo_perda', label: 'Motivo perda', defaultVisible: false,
    sortValue: (d) => (d.motivo_perda || '').toLowerCase() || null,
    render: (deal) => deal.motivo_perda
      ? <span className="text-xs text-red-400">{deal.motivo_perda}</span>
      : muted,
  },

  // datas
  {
    id: 'data_call', label: 'Data Call', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_call),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_call)}</span>,
  },
  {
    id: 'data_fechamento', label: 'Fechamento', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_fechamento),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_fechamento)}</span>,
  },
  {
    id: 'data_primeiro_pagamento', label: '1º Pgto', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_primeiro_pagamento),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_primeiro_pagamento)}</span>,
  },
  {
    id: 'data_retorno', label: 'Retorno', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_retorno),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_retorno)}</span>,
  },
  {
    id: 'data_inicio_escopo', label: 'Início Escopo', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_inicio_escopo),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_inicio_escopo)}</span>,
  },
  {
    id: 'data_pgto_escopo', label: 'Pgto Escopo', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_pgto_escopo),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_pgto_escopo)}</span>,
  },
  {
    id: 'data_inicio_recorrente', label: 'Início Recor.', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_inicio_recorrente),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_inicio_recorrente)}</span>,
  },
  {
    id: 'data_pgto_recorrente', label: 'Pgto Recor.', defaultVisible: false,
    sortValue: (d) => dateMs(d.data_pgto_recorrente),
    render: (deal, h) => <span className="text-xs text-[var(--color-v4-text-muted)]">{h.formatDate(deal.data_pgto_recorrente)}</span>,
  },

  // links + obs
  {
    id: 'link_call_vendas', label: 'Link Call', defaultVisible: false,
    render: (deal) => deal.link_call_vendas
      ? <a href={deal.link_call_vendas} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
           className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1">Abrir <ExternalLink size={10} /></a>
      : muted,
  },
  {
    id: 'link_transcricao', label: 'Transcrição', defaultVisible: false,
    render: (deal) => deal.link_transcricao
      ? <a href={deal.link_transcricao} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
           className="text-xs text-blue-400 hover:underline inline-flex items-center gap-1">Abrir <ExternalLink size={10} /></a>
      : muted,
  },
  {
    id: 'observacoes', label: 'Observações', defaultVisible: false,
    render: (deal) => deal.observacoes
      ? <span className="text-xs text-[var(--color-v4-text-muted)] line-clamp-2 max-w-[220px]" title={deal.observacoes}>{deal.observacoes}</span>
      : muted,
  },
];

// ---------- sort engine generico ----------
/**
 * Ordena deals por um sortValue generico (numero ou string).
 * Valores null/undefined/NaN vao pro fim (independente da direcao).
 */
export function sortDealsByColumn(
  deals: Deal[],
  sortValueFn: (d: Deal) => SortValue,
  dir: 'asc' | 'desc',
): Deal[] {
  const isNullish = (v: SortValue): boolean =>
    v === null || v === undefined || (typeof v === 'number' && isNaN(v));

  return [...deals].sort((a, b) => {
    const va = sortValueFn(a);
    const vb = sortValueFn(b);
    const nullA = isNullish(va);
    const nullB = isNullish(vb);
    if (nullA && nullB) return 0;
    if (nullA) return 1;   // null sempre no fim
    if (nullB) return -1;

    let cmp = 0;
    if (typeof va === 'number' && typeof vb === 'number') {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return dir === 'desc' ? -cmp : cmp;
  });
}

// ---------- estado persistido ----------
interface ColumnConfig {
  id: string;
  visible: boolean;
}

function defaultConfig(): ColumnConfig[] {
  return ALL_COLUMNS.map(c => ({ id: c.id, visible: c.defaultVisible }));
}

function loadConfig(): ColumnConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed: ColumnConfig[] = JSON.parse(raw);

    // Reconcilia: remove IDs que não existem mais, adiciona novas ao final
    const known = new Set(ALL_COLUMNS.map(c => c.id));
    const filtered = parsed.filter(c => known.has(c.id));
    const presentIds = new Set(filtered.map(c => c.id));
    for (const col of ALL_COLUMNS) {
      if (!presentIds.has(col.id)) filtered.push({ id: col.id, visible: col.defaultVisible });
    }
    return filtered;
  } catch {
    return defaultConfig();
  }
}

function saveConfig(config: ColumnConfig[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore quota */ }
}

export interface UsePipelineColumnsResult {
  config: ColumnConfig[];
  visibleColumns: ColumnDef[];
  setConfig: (c: ColumnConfig[]) => void;
  resetDefaults: () => void;
}

export function usePipelineColumns(): UsePipelineColumnsResult {
  const [config, setConfigState] = useState<ColumnConfig[]>(loadConfig);

  const setConfig = useCallback((c: ColumnConfig[]) => {
    setConfigState(c);
    saveConfig(c);
  }, []);

  const resetDefaults = useCallback(() => setConfig(defaultConfig()), [setConfig]);

  // Mapeia config -> ColumnDef[] preservando a ordem do config e só os visíveis
  const visibleColumns = React.useMemo(() => {
    const byId = new Map(ALL_COLUMNS.map(c => [c.id, c]));
    return config
      .filter(c => c.visible)
      .map(c => byId.get(c.id))
      .filter((c): c is ColumnDef => !!c);
  }, [config]);

  return { config, visibleColumns, setConfig, resetDefaults };
}

// ---------- Modal de configuração ----------
interface ColumnsSettingsModalProps {
  open: boolean;
  onClose: () => void;
  config: ColumnConfig[];
  onChange: (c: ColumnConfig[]) => void;
  onReset: () => void;
}

export const ColumnsSettingsModal: React.FC<ColumnsSettingsModalProps> = ({
  open, onClose, config, onChange, onReset,
}) => {
  const [local, setLocal] = useState(config);

  useEffect(() => { if (open) setLocal(config); }, [open, config]);

  if (!open) return null;

  const byId = new Map(ALL_COLUMNS.map(c => [c.id, c]));

  const toggle = (id: string) => {
    setLocal(prev => prev.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= local.length) return;
    const copy = [...local];
    [copy[idx], copy[j]] = [copy[j], copy[idx]];
    setLocal(copy);
  };
  const apply = () => { onChange(local); onClose(); };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
         onClick={onClose}>
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl w-full max-w-md max-h-[85vh] flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div>
            <h3 className="text-white font-semibold">Configurar colunas</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mt-0.5">
              {local.filter(c => c.visible).length} de {local.length} visíveis
            </p>
          </div>
          <button onClick={onClose}
                  className="text-[var(--color-v4-text-muted)] hover:text-white p-1 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {local.map((c, idx) => {
            const def = byId.get(c.id);
            if (!def) return null;
            return (
              <div key={c.id}
                   className="flex items-center gap-3 py-2 border-b border-[var(--color-v4-border)]/40 last:border-b-0">
                <input type="checkbox" checked={c.visible} onChange={() => toggle(c.id)}
                       className="accent-[var(--color-v4-red)] w-4 h-4 cursor-pointer" />
                <span className={cn('flex-1 text-sm', c.visible ? 'text-white' : 'text-[var(--color-v4-text-muted)]')}>
                  {def.label}
                </span>
                <div className="flex gap-1">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0}
                          className="p-1 rounded hover:bg-[var(--color-v4-surface)] disabled:opacity-20 disabled:cursor-not-allowed">
                    <ChevronUp size={14} className="text-[var(--color-v4-text-muted)]" />
                  </button>
                  <button onClick={() => move(idx, 1)} disabled={idx === local.length - 1}
                          className="p-1 rounded hover:bg-[var(--color-v4-surface)] disabled:opacity-20 disabled:cursor-not-allowed">
                    <ChevronDown size={14} className="text-[var(--color-v4-text-muted)]" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-[var(--color-v4-border)]">
          <button onClick={() => { onReset(); setLocal(defaultConfig()); }}
                  className="flex items-center gap-1.5 text-xs text-[var(--color-v4-text-muted)] hover:text-white">
            <RotateCcw size={12} /> Restaurar padrão
          </button>
          <div className="flex gap-2">
            <button onClick={onClose}
                    className="px-3 py-1.5 text-xs rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
              Cancelar
            </button>
            <button onClick={apply}
                    className="px-4 py-1.5 text-xs rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium">
              Aplicar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Botão de engrenagem que abre o modal — exportado pra uso inline
export const ColumnsSettingsButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button onClick={onClick}
          title="Configurar colunas"
          className="p-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white hover:border-[var(--color-v4-red)] transition-colors">
    <Settings size={14} />
  </button>
);
