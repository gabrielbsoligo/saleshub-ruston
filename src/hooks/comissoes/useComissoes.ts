import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { monthRange } from '../../lib/datemath';
import { useGroupBy, GroupResult } from '../useGroupBy';
import { ComissaoRegistro, StatusComissao } from './types';
import { getStandardColumns, ColumnDef, DateField } from './columns';

export type ViewMode = 'cliente' | 'time' | 'sdr';

export interface ComissoesFilters {
  status?: string[];
  empresa?: string;
  vendedor?: string[];
}

export interface ComissoesConfig {
  view: ViewMode;
  dateField: DateField;
  yearMonth: string;
  filters?: ComissoesFilters;
}

export interface ComissoesTotals {
  total: number;
  aguardando: number;
  liberado: number;
  pago: number;
  count: number;
}

export interface UseComissoesResult {
  rows: ComissaoRegistro[];
  groups: GroupResult<ComissaoRegistro>[];
  columns: ColumnDef[];
  totals: ComissoesTotals;
  vendedoresUnicos: string[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

const sumComissao = (items: ComissaoRegistro[]) =>
  items.reduce((s, r) => s + (r.valor_comissao || 0), 0);

const sumByStatus = (status: StatusComissao) => (items: ComissaoRegistro[]) =>
  items.filter((r) => r.status_comissao === status).reduce((s, r) => s + (r.valor_comissao || 0), 0);

function groupKeyForView(view: ViewMode): (r: ComissaoRegistro) => string {
  if (view === 'cliente') return (r) => r.empresa || '—';
  // time and sdr both group by member
  return (r) => r.member_name || 'Sem nome';
}

export function useComissoes(config: ComissoesConfig): UseComissoesResult {
  const { view, dateField, yearMonth, filters } = config;
  const [registros, setRegistros] = useState<ComissaoRegistro[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRegistros = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // yearMonth vazio = sem filtro de periodo (mostra tudo).
      // Quando preenchido (YYYY-MM), aplica gte/lte no dateField escolhido.
      let query = supabase
        .from('comissoes_registros')
        .select('*')
        .order('empresa');

      if (yearMonth) {
        const { start, end } = monthRange(yearMonth);
        query = query.gte(dateField, start).lte(dateField, end);
      }

      if (filters?.status && filters.status.length > 0) query = query.in('status_comissao', filters.status);
      if (filters?.vendedor && filters.vendedor.length > 0) query = query.in('member_name', filters.vendedor);

      // Quando sem filtro de mes, limita em 2000 pra nao estourar payload
      if (!yearMonth) query = query.limit(2000);

      const { data, error: dbError } = await query;
      if (dbError) {
        setError(dbError.message);
        setRegistros([]);
      } else {
        setRegistros((data || []) as ComissaoRegistro[]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [yearMonth, dateField, JSON.stringify(filters?.status), JSON.stringify(filters?.vendedor)]);

  useEffect(() => { fetchRegistros(); }, [fetchRegistros]);

  // Client-side filters: text search on empresa + role filter for SDR view
  const rows = useMemo(() => {
    const search = (filters?.empresa || '').toLowerCase().trim();
    return registros.filter((r) => {
      if (view === 'sdr' && r.role_comissao !== 'sdr') return false;
      if (search && !(r.empresa || '').toLowerCase().includes(search)) return false;
      return true;
    });
  }, [registros, filters?.empresa, view]);

  const keyFn = useMemo(() => groupKeyForView(view), [view]);
  const aggFns = useMemo(() => ({
    total: sumComissao,
    liberado: sumByStatus('liberada'),
    pago: sumByStatus('paga'),
    aguardando: sumByStatus('aguardando_pgto'),
  }), []);

  const groups = useGroupBy<ComissaoRegistro>(rows, keyFn, aggFns, 'total');

  const totals = useMemo<ComissoesTotals>(() => ({
    total: sumComissao(rows),
    aguardando: sumByStatus('aguardando_pgto')(rows),
    liberado: sumByStatus('liberada')(rows),
    pago: sumByStatus('paga')(rows),
    count: rows.length,
  }), [rows]);

  const vendedoresUnicos = useMemo(() => {
    return Array.from(new Set(registros.map((r) => r.member_name).filter(Boolean))).sort();
  }, [registros]);

  const columns = useMemo(() => getStandardColumns(), []);

  return { rows, groups, columns, totals, vendedoresUnicos, isLoading, error, refetch: fetchRegistros };
}
