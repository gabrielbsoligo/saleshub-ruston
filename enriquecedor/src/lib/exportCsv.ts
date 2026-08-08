import type { Lead } from '../types';
import { formatCnpj } from './validation';
import { QUALITY_LABELS } from './labels';

function cell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exporta os leads para CSV (separador ';' para abrir direto no Excel-BR). */
export function exportLeadsCsv(leads: Lead[]): void {
  const headers = [
    'CNPJ',
    'Razao Social',
    'Nome Fantasia',
    'Segmento',
    'Cidade',
    'UF',
    'Situacao',
    'Faturamento',
    'Telefone (contato)',
    'Email (contato)',
    'Qualidade',
    'Score',
  ];
  const lines = leads.map((l) =>
    [
      formatCnpj(l.cnpj ?? l.cnpjRaw),
      l.razaoSocial ?? l.companyNameRaw,
      l.nomeFantasia ?? '',
      l.segmento ?? '',
      l.cidade ?? '',
      l.uf ?? '',
      l.situacaoCadastral ?? '',
      l.revenueBandRaw ?? '',
      l.phoneRaw ?? '',
      l.emailRaw ?? '',
      QUALITY_LABELS[l.dataQuality],
      l.score ?? '',
    ]
      .map(cell)
      .join(';'),
  );

  const csv = '﻿' + [headers.join(';'), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
