import * as XLSX from 'xlsx';
import { z } from 'zod';

// Colunas de entrada. As listas vêm com nomes variados e, no caso de exports
// tipo "PJ", o telefone/e-mail do CONTATO (decisor) vem separado do corporativo
// — sempre preferimos o do contato. A ordem dos aliases define a prioridade.
export interface RawLeadRow {
  cnpj: string;
  companyName: string;
  revenueBand: string;
  phone: string;
  email: string;
  site: string;
}

// Contrato do dado que entra no sistema (lenient: campo ausente vira ''). Não
// rejeita linha válida — só garante que toda linha tem o formato esperado.
const RawLeadRowSchema = z.object({
  cnpj: z.string().catch(''),
  companyName: z.string().catch(''),
  revenueBand: z.string().catch(''),
  phone: z.string().catch(''),
  email: z.string().catch(''),
  site: z.string().catch(''),
});

const COLUMN_ALIASES: Record<keyof RawLeadRow, string[]> = {
  cnpj: ['cnpj'],
  companyName: [
    'razao',
    'razao social',
    'razao_social',
    'empresa',
    'nome da empresa',
    'nome',
    'fantasia',
    'nome fantasia',
  ],
  revenueBand: ['faturamento', 'faixa de faturamento', 'faixa', 'receita'],
  phone: [
    'telefone_contato',
    'telefone do decisor',
    'celular',
    'whatsapp',
    'telefone',
    'fone',
    'telefone_corporativo',
    'telefone_contato_fixo',
    'telefone_corporativo_fixo',
  ],
  email: ['email_contato', 'email', 'e-mail', 'e mail', 'email_corporativo'],
  site: ['site', 'website', 'url', 'pagina'],
};

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // remove acentos (mantém _ e espaços)
}

// Converte célula para string sem notação científica nem perda de precisão.
// (CNPJ salvo como número no Excel vira "4.69579E+11" com raw:false — por isso
// lemos com raw:true e formatamos o inteiro aqui.)
function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  return String(v).trim();
}

// Prioridade = ordem dos aliases (não a ordem das colunas na planilha).
function mapHeaders(headers: string[]): Partial<Record<keyof RawLeadRow, number>> {
  const norm = headers.map(normalizeHeader);
  const map: Partial<Record<keyof RawLeadRow, number>> = {};
  (Object.keys(COLUMN_ALIASES) as (keyof RawLeadRow)[]).forEach((field) => {
    for (const alias of COLUMN_ALIASES[field]) {
      const idx = norm.indexOf(alias);
      if (idx !== -1) {
        map[field] = idx;
        break;
      }
    }
  });
  return map;
}

export interface ParseResult {
  rows: RawLeadRow[];
  missingColumns: (keyof RawLeadRow)[];
  totalRows: number;
}

/** Lê CSV/XLSX (ArrayBuffer) e devolve as linhas mapeadas às colunas esperadas. */
export function parseSpreadsheet(buffer: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // raw:true preserva números (CNPJ) sem virar notação científica.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: true,
  });

  if (matrix.length === 0) {
    return {
      rows: [],
      missingColumns: ['cnpj', 'companyName'],
      totalRows: 0,
    };
  }

  const headers = matrix[0].map((h) => cellToString(h));
  const colMap = mapHeaders(headers);
  const required: (keyof RawLeadRow)[] = ['cnpj', 'companyName'];
  const missingColumns = required.filter((f) => colMap[f] === undefined);

  const get = (row: unknown[], field: keyof RawLeadRow): string => {
    const idx = colMap[field];
    return idx === undefined ? '' : cellToString(row[idx]);
  };

  const rows: RawLeadRow[] = matrix
    .slice(1)
    .map((row) =>
      RawLeadRowSchema.parse({
        cnpj: get(row, 'cnpj'),
        companyName: get(row, 'companyName'),
        revenueBand: get(row, 'revenueBand'),
        phone: get(row, 'phone'),
        email: get(row, 'email'),
        site: get(row, 'site'),
      }),
    )
    .filter((r) => r.cnpj || r.companyName);

  return { rows, missingColumns, totalRows: rows.length };
}
