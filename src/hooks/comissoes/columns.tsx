import React from 'react';
import { ComissaoRegistro, StatusComissao, STATUS_LABELS, STATUS_COLORS, CATEGORIA_LABELS } from './types';
import { formatBR } from '../../lib/datemath';

function fmtBRL(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v);
}

// Percent value can come as 0-1 (e.g. 0.05) or 0-100 (e.g. 5). Normalize for display.
export function pctDisplay(p: number): string {
  if (p == null || isNaN(p)) return '0%';
  const v = Math.abs(p) <= 1 ? p * 100 : p;
  return `${v.toFixed(v < 10 && v % 1 !== 0 ? 1 : 0)}%`;
}

export type DateField = 'data_pgto' | 'data_liberacao' | 'data_pgto_real' | 'data_pgto_vendedor';

export const DATE_FIELD_LABELS: Record<DateField, string> = {
  data_pgto: 'Pgto Contrato',
  data_liberacao: 'Liberação',
  data_pgto_real: 'Pgto Real',
  data_pgto_vendedor: 'Pgto Vendedor',
};

export interface ColumnDef {
  key: string;
  header: string;
  align?: 'left' | 'center' | 'right';
  render: (line: ComissaoRegistro, ctx: { dateField: DateField }) => React.ReactNode;
}

export const COMISSAO_COLUMNS: ColumnDef[] = [
  {
    key: 'empresa',
    header: 'Empresa',
    align: 'left',
    render: (line) => (
      <span className="text-white">
        {line.empresa}
        {line.origem === 'monetizacao' && <span className="text-[8px] text-purple-400 ml-1">monet.</span>}
      </span>
    ),
  },
  {
    key: 'vendedor',
    header: 'Vendedor',
    align: 'left',
    render: (line) => <span className="text-white">{line.member_name}</span>,
  },
  {
    key: 'role',
    header: 'Role',
    align: 'center',
    render: (line) => <span className="text-[var(--color-v4-text-muted)] uppercase text-[10px]">{line.role_comissao}</span>,
  },
  {
    key: 'tipo',
    header: 'Tipo',
    align: 'center',
    render: (line) => (
      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
        line.tipo === 'mrr' ? 'bg-green-500/15 text-green-400' :
        line.tipo === 'variavel' ? 'bg-purple-500/15 text-purple-400' :
        'bg-blue-500/15 text-blue-400'
      }`}>
        {line.tipo === 'variavel' ? 'Variável' : line.tipo.toUpperCase()}
      </span>
    ),
  },
  {
    key: 'categoria',
    header: 'Cat.',
    align: 'center',
    render: (line) => (
      <span className="text-[var(--color-v4-text-muted)]">
        {CATEGORIA_LABELS[line.categoria] || line.categoria}
      </span>
    ),
  },
  {
    key: 'valor_base',
    header: 'Valor Base',
    align: 'right',
    render: (line) => <span className="text-white">{fmtBRL(line.valor_base)}</span>,
  },
  {
    key: 'percentual',
    header: '%',
    align: 'center',
    render: (line) => <span className="text-white">{pctDisplay(line.percentual)}</span>,
  },
  {
    key: 'comissao',
    header: 'Comissão',
    align: 'right',
    render: (line) => <span className="font-bold text-white">{fmtBRL(line.valor_comissao)}</span>,
  },
  {
    key: 'data_dyn',
    header: '', // dynamic, set at render time from DATE_FIELD_LABELS[dateField]
    align: 'center',
    render: (line, { dateField }) => {
      const v = (line as any)[dateField] as string | undefined;
      return <span className="text-[var(--color-v4-text-muted)]">{formatBR(v)}</span>;
    },
  },
  {
    key: 'status',
    header: 'Status',
    align: 'center',
    render: (line) => {
      const status = line.status_comissao as StatusComissao;
      return (
        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[status]}`}>
          {STATUS_LABELS[status]}
        </span>
      );
    },
  },
];

// Standard column order shown in all views.
export const STANDARD_COLUMN_KEYS = [
  'empresa', 'vendedor', 'role', 'tipo', 'categoria',
  'valor_base', 'percentual', 'comissao', 'data_dyn', 'status',
];

export function getStandardColumns(): ColumnDef[] {
  return STANDARD_COLUMN_KEYS
    .map((k) => COMISSAO_COLUMNS.find((c) => c.key === k))
    .filter((c): c is ColumnDef => !!c);
}
