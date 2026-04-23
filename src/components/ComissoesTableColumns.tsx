// =============================================================
// ComissoesTableColumns — catalogo + seletor + persistencia
// =============================================================
// Sistema de colunas customizaveis pra tabela de Comissoes.
// Espelha PipelineTableColumns.
// =============================================================

import React, { useState, useEffect, useCallback } from 'react';
import { X, Settings, ChevronUp, ChevronDown, RotateCcw, Lock } from 'lucide-react';
import { ComissaoRegistro, STATUS_LABELS, STATUS_COLORS, CATEGORIA_LABELS } from '../hooks/comissoes/types';
import { cn } from './Layout';

const STORAGE_KEY = 'comissoes_table_columns_v1';

// ---------- tipos ----------
export type SortValue = number | string | null | undefined;

export interface ColumnDef {
  id: string;
  label: string;
  sortValue?: (r: ComissaoRegistro) => SortValue;
  align?: 'left' | 'right' | 'center';
  defaultVisible: boolean;
  render: (r: ComissaoRegistro) => React.ReactNode;
}

export interface ColumnConfig {
  id: string;
  visible: boolean;
}

// ---------- helpers ----------
const muted = <span className="text-[var(--color-v4-text-muted)]">—</span>;

function fmtBRL(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v);
}
function fmtDate(d?: string | null) {
  if (!d) return '—';
  return new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Percentual pode vir como 0-1 ou 0-100 (historico). Normaliza display.
function pctDisplay(p: number): string {
  if (p == null || isNaN(p)) return '0%';
  const v = Math.abs(p) <= 1 ? p * 100 : p;
  return `${v.toFixed(v < 10 && v % 1 !== 0 ? 1 : 0)}%`;
}

const TIPO_COLORS: Record<string, string> = {
  mrr: 'bg-green-500/15 text-green-400',
  ot: 'bg-blue-500/15 text-blue-400',
  variavel: 'bg-purple-500/15 text-purple-400',
};

const STATUS_ORDER: Record<string, number> = {
  aguardando_pgto: 0, liberada: 1, paga: 2,
};

// ---------- catalogo de colunas ----------
export const ALL_COMISSOES_COLUMNS: ColumnDef[] = [
  {
    id: 'empresa', label: 'Empresa', defaultVisible: true,
    sortValue: (r) => (r.empresa || '').toLowerCase(),
    render: (r) => (
      <span className="text-white font-medium flex items-center gap-1.5">
        {r.empresa || '—'}
        {r.editado_manualmente && (
          <Lock
            size={10}
            className="text-amber-400/60"
            strokeWidth={2.5}
          />
        )}
      </span>
    ),
  },
  {
    id: 'colaborador', label: 'Colaborador', defaultVisible: true,
    sortValue: (r) => (r.member_name || '').toLowerCase(),
    render: (r) => <span className="text-white">{r.member_name || '—'}</span>,
  },
  {
    id: 'combo', label: 'Role · Tipo · Cat · %', defaultVisible: true,
    sortValue: (r) => `${r.role_comissao}_${r.tipo}`,
    render: (r) => (
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">{r.role_comissao}</span>
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', TIPO_COLORS[r.tipo] || '')}>
          {r.tipo === 'variavel' ? 'Variável' : r.tipo?.toUpperCase()}
        </span>
        {r.categoria && (
          <span className="text-[10px] text-[var(--color-v4-text-muted)]">
            {CATEGORIA_LABELS[r.categoria] || r.categoria}
          </span>
        )}
        <span className="text-[10px] text-[var(--color-v4-text-muted)]">· {pctDisplay(r.percentual || 0)}</span>
      </div>
    ),
  },
  {
    id: 'role', label: 'Role', defaultVisible: false,
    sortValue: (r) => r.role_comissao || '',
    align: 'center',
    render: (r) => <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">{r.role_comissao}</span>,
  },
  {
    id: 'tipo', label: 'Tipo', defaultVisible: false,
    sortValue: (r) => r.tipo || '',
    align: 'center',
    render: (r) => (
      <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', TIPO_COLORS[r.tipo] || '')}>
        {r.tipo === 'variavel' ? 'Variável' : r.tipo?.toUpperCase()}
      </span>
    ),
  },
  {
    id: 'categoria', label: 'Categoria', defaultVisible: false,
    sortValue: (r) => r.categoria || '',
    align: 'center',
    render: (r) => (
      <span className="text-[var(--color-v4-text-muted)] text-xs">
        {CATEGORIA_LABELS[r.categoria] || r.categoria || '—'}
      </span>
    ),
  },
  {
    id: 'percentual', label: '%', defaultVisible: false,
    sortValue: (r) => r.percentual || 0,
    align: 'center',
    render: (r) => <span className="text-white">{pctDisplay(r.percentual || 0)}</span>,
  },
  {
    id: 'parcela', label: 'Parcela', defaultVisible: false,
    sortValue: (r) => r.numero_parcela || 1,
    align: 'center',
    render: (r) => (
      <span className="text-[var(--color-v4-text-muted)] text-xs">
        {r.numero_parcela ? `${r.numero_parcela}ª` : '—'}
      </span>
    ),
  },
  {
    id: 'valor_base', label: 'Valor Base', defaultVisible: true,
    sortValue: (r) => r.valor_base || 0,
    align: 'right',
    render: (r) => <span className="text-white">{fmtBRL(r.valor_base || 0)}</span>,
  },
  {
    id: 'comissao', label: 'Comissão', defaultVisible: true,
    sortValue: (r) => r.valor_comissao || 0,
    align: 'right',
    render: (r) => <span className="font-bold text-white">{fmtBRL(r.valor_comissao || 0)}</span>,
  },
  {
    id: 'data_pgto', label: 'Pgto Contrato', defaultVisible: true,
    sortValue: (r) => r.data_pgto ? new Date(r.data_pgto).getTime() : null,
    align: 'center',
    render: (r) => <span className="text-[var(--color-v4-text-muted)] text-xs">{fmtDate(r.data_pgto)}</span>,
  },
  {
    id: 'data_liberacao', label: 'Liberação', defaultVisible: true,
    sortValue: (r) => r.data_liberacao ? new Date(r.data_liberacao).getTime() : null,
    align: 'center',
    render: (r) => <span className="text-[var(--color-v4-text-muted)] text-xs">{fmtDate(r.data_liberacao)}</span>,
  },
  {
    id: 'data_pgto_real', label: 'Pgto Real', defaultVisible: true,
    sortValue: (r) => r.data_pgto_real ? new Date(r.data_pgto_real).getTime() : null,
    align: 'center',
    render: (r) => <span className="text-[var(--color-v4-text-muted)] text-xs">{fmtDate(r.data_pgto_real)}</span>,
  },
  {
    id: 'data_pgto_vendedor', label: 'Pgto Vendedor', defaultVisible: true,
    sortValue: (r) => r.data_pgto_vendedor ? new Date(r.data_pgto_vendedor).getTime() : null,
    align: 'center',
    render: (r) => <span className="text-[var(--color-v4-text-muted)] text-xs">{fmtDate(r.data_pgto_vendedor)}</span>,
  },
  {
    id: 'status', label: 'Status', defaultVisible: true,
    sortValue: (r) => STATUS_ORDER[r.status_comissao] ?? 99,
    align: 'center',
    render: (r) => (
      <span className={cn('px-2 py-0.5 rounded text-[10px] font-medium', STATUS_COLORS[r.status_comissao] || '')}>
        {STATUS_LABELS[r.status_comissao] || r.status_comissao}
      </span>
    ),
  },
];

// ---------- persistencia ----------
function defaultConfig(): ColumnConfig[] {
  return ALL_COMISSOES_COLUMNS.map(c => ({ id: c.id, visible: c.defaultVisible }));
}

function loadConfig(): ColumnConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    const parsed: ColumnConfig[] = JSON.parse(raw);
    const known = new Set(ALL_COMISSOES_COLUMNS.map(c => c.id));
    const filtered = parsed.filter(c => known.has(c.id));
    const presentIds = new Set(filtered.map(c => c.id));
    for (const col of ALL_COMISSOES_COLUMNS) {
      if (!presentIds.has(col.id)) filtered.push({ id: col.id, visible: col.defaultVisible });
    }
    return filtered;
  } catch {
    return defaultConfig();
  }
}

function saveConfig(config: ColumnConfig[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* ignore */ }
}

export interface UseComissoesColumnsResult {
  config: ColumnConfig[];
  visibleColumns: ColumnDef[];
  setConfig: (c: ColumnConfig[]) => void;
  resetDefaults: () => void;
}

export function useComissoesColumns(): UseComissoesColumnsResult {
  const [config, setConfigState] = useState<ColumnConfig[]>(loadConfig);

  const setConfig = useCallback((c: ColumnConfig[]) => {
    setConfigState(c);
    saveConfig(c);
  }, []);

  const resetDefaults = useCallback(() => setConfig(defaultConfig()), [setConfig]);

  const visibleColumns = React.useMemo(() => {
    const byId = new Map(ALL_COMISSOES_COLUMNS.map(c => [c.id, c]));
    return config
      .filter(c => c.visible)
      .map(c => byId.get(c.id))
      .filter((c): c is ColumnDef => !!c);
  }, [config]);

  return { config, visibleColumns, setConfig, resetDefaults };
}

// Sort engine
export function sortByColumn(
  rows: ComissaoRegistro[],
  sortValue: (r: ComissaoRegistro) => SortValue,
  direction: 'asc' | 'desc',
): ComissaoRegistro[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a);
    const vb = sortValue(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // nulls sempre no fim
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return sign * (va - vb);
    return sign * String(va).localeCompare(String(vb), 'pt-BR');
  });
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

  const byId = new Map(ALL_COMISSOES_COLUMNS.map(c => [c.id, c]));

  const toggle = (id: string) => setLocal(prev => prev.map(c => c.id === id ? { ...c, visible: !c.visible } : c));
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= local.length) return;
    const copy = [...local];
    [copy[idx], copy[j]] = [copy[j], copy[idx]];
    setLocal(copy);
  };
  const apply = () => { onChange(local); onClose(); };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl w-full max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div>
            <h3 className="text-white font-semibold">Configurar colunas</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mt-0.5">
              {local.filter(c => c.visible).length} de {local.length} visíveis
            </p>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white p-1 rounded">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {local.map((c, idx) => {
            const def = byId.get(c.id);
            if (!def) return null;
            return (
              <div key={c.id} className="flex items-center gap-3 py-2 border-b border-[var(--color-v4-border)]/40 last:border-b-0">
                <input type="checkbox" checked={c.visible} onChange={() => toggle(c.id)}
                       className="accent-[var(--color-v4-red)] w-4 h-4 cursor-pointer" />
                <span className={cn('flex-1 text-sm', c.visible ? 'text-white' : 'text-[var(--color-v4-text-muted)]')}>
                  {def.label}
                </span>
                <div className="flex gap-1">
                  <button onClick={() => move(idx, -1)} disabled={idx === 0}
                          className="p-1 rounded hover:bg-[var(--color-v4-surface)] disabled:opacity-20">
                    <ChevronUp size={14} className="text-[var(--color-v4-text-muted)]" />
                  </button>
                  <button onClick={() => move(idx, 1)} disabled={idx === local.length - 1}
                          className="p-1 rounded hover:bg-[var(--color-v4-surface)] disabled:opacity-20">
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

export const ColumnsSettingsButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button onClick={onClick} title="Configurar colunas"
          className="p-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white hover:border-[var(--color-v4-red)] transition-colors">
    <Settings size={14} />
  </button>
);
