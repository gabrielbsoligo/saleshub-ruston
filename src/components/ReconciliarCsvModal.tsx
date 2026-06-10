// =============================================================
// ReconciliarCsvModal — reconcilia precos do LeadBroker via CSV
// =============================================================
// Sobe o CSV de aquisicoes exportado do LeadBroker, casa por empresa
// e atualiza valor_lead/data_cadastro/canal em lote no banco via RPC
// reconcile_leadbroker_csv (migration 033) — atomico, server-side.
//
// Fonte-da-verdade dos precos: este CSV. Independe do scraping do DOM
// do MKTLAB (que ja quebrou 3x).
//
// Acesso: gestor/financeiro (botao escondido + guard na RPC).
// =============================================================
import React, { useState, useMemo } from 'react';
import { X, Upload, CheckCircle2, AlertTriangle, FileText } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';
import { parseBRL } from '../lib/parseBRL';

interface Props {
  open: boolean;
  onClose: () => void;
  onReconciled: () => void;
}

interface ParsedRow {
  empresa: string;
  valorRaw: string;
  valor: number | null;
  data: string | null; // ISO YYYY-MM-DD
  canal: string;
}

interface ResultRow {
  empresa: string;
  status: 'updated' | 'not_found' | 'invalid';
  matched: number;
  valor: number | null;
}

function fmtBRL(v: number | null): string {
  if (v == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

// Converte "dd/mm/yyyy" → "yyyy-mm-dd". Aceita ISO direto tambem.
function toISODate(s: string): string | null {
  if (!s) return null;
  const t = s.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

// Split de linha CSV respeitando aspas (campos podem ter ; dentro de aspas).
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === sep && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$/g, '').trim());
}

// Parser do CSV de aquisicoes do LeadBroker.
// Detecta colunas pelo header (robusto a reordenacao).
function parseLeadBrokerCsv(text: string): { rows: ParsedRow[]; error?: string } {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], error: 'CSV vazio ou só com cabeçalho.' };

  // Detecta separador (; ou ,) pela primeira linha
  const sep = (lines[0].match(/;/g)?.length || 0) >= (lines[0].match(/,/g)?.length || 0) ? ';' : ',';
  const header = splitCsvLine(lines[0], sep).map(h => h.toLowerCase());

  const idxEmpresa = header.findIndex(h => h.includes('nome da empresa'));
  const idxValor = header.findIndex(h => h === 'valor' || h.includes('valor'));
  const idxArrematador = header.findIndex(h => h.includes('arrematador'));
  const idxDataAq = header.findIndex(h => h.includes('data de aquisi'));
  const idxData = header.findIndex(h => h === 'data');

  if (idxEmpresa < 0 || idxValor < 0) {
    return { rows: [], error: 'CSV não tem colunas "Nome da empresa" e "Valor". É o export do LeadBroker?' };
  }

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], sep);
    const empresa = (cols[idxEmpresa] || '').trim();
    if (!empresa) continue;
    const valorRaw = (cols[idxValor] || '').trim();
    const arrematador = idxArrematador >= 0 ? (cols[idxArrematador] || '') : '';
    const dataStr = idxDataAq >= 0 ? cols[idxDataAq] : (idxData >= 0 ? cols[idxData] : '');
    const canal = /black\s*box/i.test(arrematador) ? 'blackbox' : 'leadbroker';
    rows.push({
      empresa,
      valorRaw,
      valor: parseBRL(valorRaw),
      data: toISODate(dataStr || ''),
      canal,
    });
  }
  return { rows };
}

export const ReconciliarCsvModal: React.FC<Props> = ({ open, onClose, onReconciled }) => {
  const [rawText, setRawText] = useState('');
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultRow[] | null>(null);
  const [running, setRunning] = useState(false);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const text = String(e.target?.result || '');
      setRawText(text);
      doParse(text);
    };
    reader.readAsText(file, 'utf-8');
  };

  const doParse = (text: string) => {
    setResult(null);
    const { rows, error } = parseLeadBrokerCsv(text);
    setParseError(error || null);
    setParsed(rows);
  };

  const stats = useMemo(() => {
    const total = parsed.length;
    const validos = parsed.filter(r => r.valor != null).length;
    const invalidos = total - validos;
    const soma = parsed.reduce((a, r) => a + (r.valor || 0), 0);
    return { total, validos, invalidos, soma };
  }, [parsed]);

  const handleReconcile = async () => {
    const validRows = parsed.filter(r => r.valor != null);
    if (validRows.length === 0) {
      toast.error('Nenhuma linha válida pra reconciliar.');
      return;
    }
    setRunning(true);
    try {
      const payload = validRows.map(r => ({
        empresa: r.empresa,
        valor: r.valor,
        data: r.data,
        canal: r.canal,
      }));
      const { data, error } = await supabase.rpc('reconcile_leadbroker_csv', { p_rows: payload });
      if (error) throw error;
      const res = (data as ResultRow[]) || [];
      setResult(res);
      const updated = res.filter(r => r.status === 'updated').length;
      const notFound = res.filter(r => r.status === 'not_found').length;
      toast.success(`${updated} atualizados${notFound > 0 ? ` · ${notFound} não encontrados` : ''}`);
      onReconciled();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao reconciliar');
    } finally {
      setRunning(false);
    }
  };

  const handleClose = () => {
    setRawText(''); setParsed([]); setParseError(null); setResult(null);
    onClose();
  };

  if (!open) return null;

  const notFoundList = result?.filter(r => r.status === 'not_found') || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl p-6">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <FileText size={18} className="text-[var(--color-v4-red)]" />
            <h3 className="text-base font-bold text-white">Reconciliar preços (CSV LeadBroker)</h3>
          </div>
          <button onClick={handleClose} className="text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] text-[var(--color-v4-text-muted)] mb-4">
          Sobe o CSV de aquisições exportado do LeadBroker. O sistema casa por nome da empresa e
          atualiza o valor pago, data e canal de cada lead — em lote, direto no banco.
        </p>

        {/* Resultado (apos reconciliar) */}
        {result ? (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-green-400">{result.filter(r => r.status === 'updated').length}</p>
                <p className="text-[10px] text-[var(--color-v4-text-muted)]">Atualizados</p>
              </div>
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-amber-400">{notFoundList.length}</p>
                <p className="text-[10px] text-[var(--color-v4-text-muted)]">Não encontrados</p>
              </div>
              <div className="bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-3 text-center">
                <p className="text-2xl font-bold text-white">{result.filter(r => r.status === 'invalid').length}</p>
                <p className="text-[10px] text-[var(--color-v4-text-muted)]">Inválidos</p>
              </div>
            </div>

            {notFoundList.length > 0 && (
              <div className="bg-[var(--color-v4-bg)] border border-amber-500/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle size={13} className="text-amber-400" />
                  <span className="text-xs text-amber-400 font-medium">
                    Não estão no SalesHub ({notFoundList.length}) — importe esses leads primeiro
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {notFoundList.map((r, i) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20">
                      {r.empresa}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <button onClick={handleClose}
              className="w-full py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-bold">
              Fechar
            </button>
          </div>
        ) : (
          <>
            {/* Upload */}
            <label className="block border-2 border-dashed border-[var(--color-v4-border)] rounded-xl p-6 text-center cursor-pointer hover:border-[var(--color-v4-red)]/50 transition-colors mb-3">
              <Upload size={24} className="mx-auto text-[var(--color-v4-text-muted)] mb-2" />
              <span className="text-sm text-white">Clique pra escolher o arquivo CSV</span>
              <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">
                Ou cole o conteúdo no campo abaixo
              </p>
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
            </label>

            <textarea
              value={rawText}
              onChange={e => { setRawText(e.target.value); doParse(e.target.value); }}
              placeholder="Nome do Produto;Valor;Arrematador;Data;..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-[11px] font-mono mb-3"
            />

            {parseError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400 mb-3">
                {parseError}
              </div>
            )}

            {/* Preview */}
            {parsed.length > 0 && (
              <>
                <div className="flex items-center gap-3 text-xs mb-2">
                  <span className="text-white"><b>{stats.total}</b> linhas</span>
                  <span className="text-green-400"><b>{stats.validos}</b> válidas</span>
                  {stats.invalidos > 0 && <span className="text-amber-400"><b>{stats.invalidos}</b> sem valor</span>}
                  <span className="text-[var(--color-v4-text-muted)] ml-auto">Σ {fmtBRL(stats.soma)}</span>
                </div>
                <div className="max-h-[260px] overflow-y-auto rounded-lg border border-[var(--color-v4-border)] mb-3">
                  <table className="w-full text-[11px]">
                    <thead className="bg-[var(--color-v4-bg)] sticky top-0">
                      <tr className="text-left text-[var(--color-v4-text-muted)]">
                        <th className="px-2 py-1.5">Empresa</th>
                        <th className="px-2 py-1.5 text-right">Valor</th>
                        <th className="px-2 py-1.5">Data</th>
                        <th className="px-2 py-1.5">Canal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.map((r, i) => (
                        <tr key={i} className="border-t border-[var(--color-v4-border)]/40">
                          <td className="px-2 py-1.5 text-white truncate max-w-[220px]">{r.empresa}</td>
                          <td className={`px-2 py-1.5 text-right ${r.valor != null ? 'text-green-400' : 'text-amber-400'}`}>
                            {r.valor != null ? fmtBRL(r.valor) : '⚠ ' + (r.valorRaw || 'vazio')}
                          </td>
                          <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{r.data || '—'}</td>
                          <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{r.canal}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="flex gap-2">
              <button onClick={handleClose}
                className="flex-1 py-2 rounded-lg border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">
                Cancelar
              </button>
              <button onClick={handleReconcile} disabled={running || stats.validos === 0}
                className="flex-1 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-bold flex items-center justify-center gap-1 disabled:opacity-50">
                <CheckCircle2 size={14} />
                {running ? 'Reconciliando…' : `Reconciliar ${stats.validos > 0 ? stats.validos : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
