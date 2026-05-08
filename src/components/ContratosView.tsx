// =============================================================
// ContratosView — lista de deals fechados com link do contrato
// =============================================================
// Acesso: gestor + financeiro (gating no Layout via allowedRoles).
//
// Pra quem serve:
//  - Financeiro: tem que faturar/cobrar o cliente, precisa do contrato.
//  - Gestor: cobra anexar o contrato nos que ainda nao tem.
//
// Filtros: search empresa, periodo (data_fechamento), status anexo
//   (todos / com / sem). Click na linha abre DealDrawer.
// =============================================================
import React, { useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { FileText, ExternalLink, AlertCircle, Search, Calendar, Download } from 'lucide-react';
import { DealDrawer } from './DealDrawer';
import type { Deal } from '../types';

function fmtBRL(v: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(v);
}

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  return new Date(s + (s.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

type StatusAnexo = 'todos' | 'com' | 'sem';

export const ContratosView: React.FC = () => {
  const { deals, currentUser } = useAppStore();
  const [searchEmpresa, setSearchEmpresa] = useState('');
  const [yearMonth, setYearMonth] = useState(''); // YYYY-MM ou vazio
  const [statusAnexo, setStatusAnexo] = useState<StatusAnexo>('todos');
  const [drawerDeal, setDrawerDeal] = useState<Deal | null>(null);

  const ganhos = useMemo(() => deals.filter(d => d.status === 'contrato_assinado'), [deals]);

  const filtrados = useMemo(() => {
    let arr = ganhos;

    if (yearMonth) {
      const [y, m] = yearMonth.split('-').map(Number);
      arr = arr.filter(d => {
        const ref = d.data_fechamento || d.data_call;
        if (!ref) return false;
        const dt = new Date(ref + (ref.length === 10 ? 'T12:00:00' : ''));
        return dt.getFullYear() === y && (dt.getMonth() + 1) === m;
      });
    }

    if (statusAnexo === 'com') arr = arr.filter(d => !!d.contrato_url);
    if (statusAnexo === 'sem') arr = arr.filter(d => !d.contrato_url);

    if (searchEmpresa.trim()) {
      const s = searchEmpresa.trim().toLowerCase();
      arr = arr.filter(d => (d.empresa || '').toLowerCase().includes(s));
    }

    // Ordena por data_fechamento DESC
    return [...arr].sort((a, b) => {
      const ad = a.data_fechamento || a.data_call || '';
      const bd = b.data_fechamento || b.data_call || '';
      return bd.localeCompare(ad);
    });
  }, [ganhos, yearMonth, statusAnexo, searchEmpresa]);

  const totals = useMemo(() => {
    const total = filtrados.length;
    const comAnexo = filtrados.filter(d => !!d.contrato_url).length;
    const semAnexo = total - comAnexo;
    const valorMrr = filtrados.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
    const valorOt = filtrados.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);
    return { total, comAnexo, semAnexo, valorMrr, valorOt };
  }, [filtrados]);

  const isFinanceiro = currentUser?.role === 'financeiro';

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <FileText size={22} className="text-[var(--color-v4-red)]" />
          <h2 className="text-2xl font-display font-bold text-white">
            Contratos
            <span className="text-[var(--color-v4-text-muted)] text-lg font-normal ml-2">
              ({filtrados.length})
            </span>
          </h2>
        </div>
        <p className="text-xs text-[var(--color-v4-text-muted)]">
          {isFinanceiro
            ? 'Deals fechados aguardando faturamento. Click numa linha pra abrir o detalhe.'
            : 'Deals fechados (contrato_assinado). Cobra o anexo dos que faltam.'}
        </p>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input
            type="text"
            placeholder="Buscar empresa…"
            value={searchEmpresa}
            onChange={e => setSearchEmpresa(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]"
          />
        </div>

        <input
          type="month"
          value={yearMonth}
          onChange={e => setYearMonth(e.target.value)}
          className={`px-3 py-1.5 rounded-lg border text-xs ${
            yearMonth
              ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-white'
              : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)]'
          }`}
          placeholder="todos os meses"
        />

        <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
          <button
            onClick={() => setStatusAnexo('todos')}
            className={`px-3 py-1 rounded text-xs ${statusAnexo === 'todos' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}
          >
            Todos
          </button>
          <button
            onClick={() => setStatusAnexo('com')}
            className={`px-3 py-1 rounded text-xs ${statusAnexo === 'com' ? 'bg-green-500/40 text-white' : 'text-[var(--color-v4-text-muted)]'}`}
          >
            Com anexo
          </button>
          <button
            onClick={() => setStatusAnexo('sem')}
            className={`px-3 py-1 rounded text-xs ${statusAnexo === 'sem' ? 'bg-amber-500/40 text-white' : 'text-[var(--color-v4-text-muted)]'}`}
          >
            Sem anexo
          </button>
        </div>

        {(yearMonth || statusAnexo !== 'todos' || searchEmpresa) && (
          <button
            onClick={() => { setYearMonth(''); setStatusAnexo('todos'); setSearchEmpresa(''); }}
            className="px-2.5 py-1.5 rounded-lg text-[10px] text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]"
          >
            Limpar filtros
          </button>
        )}
      </div>

      {/* Tabela */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto rounded-xl border border-[var(--color-v4-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--color-v4-card)] sticky top-0 z-10">
              <tr className="text-left text-[var(--color-v4-text-muted)] uppercase text-[10px]">
                <th className="px-3 py-2.5 font-medium">Empresa</th>
                <th className="px-3 py-2.5 font-medium">Closer / SDR</th>
                <th className="px-3 py-2.5 font-medium">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={10} /> Fechamento
                  </span>
                </th>
                <th className="px-3 py-2.5 font-medium text-right">MRR</th>
                <th className="px-3 py-2.5 font-medium text-right">OT</th>
                <th className="px-3 py-2.5 font-medium text-right">Total</th>
                <th className="px-3 py-2.5 font-medium text-center">Contrato</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-[var(--color-v4-text-muted)]">
                    Nenhum contrato encontrado com esses filtros.
                  </td>
                </tr>
              )}
              {filtrados.map(d => {
                const mrr = d.valor_recorrente || d.valor_mrr || 0;
                const ot = d.valor_escopo || d.valor_ot || 0;
                const total = mrr + ot;
                const temAnexo = !!d.contrato_url;
                return (
                  <tr
                    key={d.id}
                    onClick={() => setDrawerDeal(d)}
                    className="border-t border-[var(--color-v4-border)] hover:bg-[var(--color-v4-card-hover)] cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2.5">
                      <div className="text-white font-medium truncate max-w-[200px]">{d.empresa}</div>
                      {d.tier && <div className="text-[10px] text-[var(--color-v4-text-muted)]">{d.tier.toUpperCase()}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-white truncate max-w-[160px]">{d.closer?.name?.split(' ')[0] || '—'}</div>
                      {d.sdr?.name && (
                        <div className="text-[10px] text-[var(--color-v4-text-muted)] truncate">SDR: {d.sdr.name.split(' ')[0]}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-white">
                      {fmtDate(d.data_fechamento)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={mrr > 0 ? 'text-green-400 font-medium' : 'text-[var(--color-v4-text-muted)]'}>
                        {fmtBRL(mrr)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={ot > 0 ? 'text-blue-400' : 'text-[var(--color-v4-text-muted)]'}>
                        {fmtBRL(ot)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-white font-bold">
                      {fmtBRL(total)}
                    </td>
                    <td className="px-3 py-2.5 text-center" onClick={e => e.stopPropagation()}>
                      {temAnexo ? (
                        <a
                          href={d.contrato_url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-green-500/15 hover:bg-green-500/25 text-green-400 text-[10px] font-medium border border-green-500/30"
                          title={d.contrato_filename || 'Abrir contrato'}
                        >
                          <Download size={10} /> Abrir
                        </a>
                      ) : (
                        <button
                          onClick={() => setDrawerDeal(d)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-[10px] font-medium border border-amber-500/30"
                          title="Anexar contrato pelo drawer do deal"
                        >
                          <AlertCircle size={10} /> Anexar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {filtrados.length > 0 && (
              <tfoot className="bg-[var(--color-v4-card)] sticky bottom-0 border-t-2 border-[var(--color-v4-border-strong)]">
                <tr className="text-white font-bold">
                  <td className="px-3 py-2.5" colSpan={3}>Total ({filtrados.length})</td>
                  <td className="px-3 py-2.5 text-right text-green-400">{fmtBRL(totals.valorMrr)}</td>
                  <td className="px-3 py-2.5 text-right text-blue-400">{fmtBRL(totals.valorOt)}</td>
                  <td className="px-3 py-2.5 text-right">{fmtBRL(totals.valorMrr + totals.valorOt)}</td>
                  <td className="px-3 py-2.5 text-center text-[10px] text-[var(--color-v4-text-muted)]">
                    {totals.comAnexo}/{totals.total}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Drawer (mesmo do Pipeline pra editar/anexar).
          Renderiza so' quando ha um deal selecionado — DealDrawer com
          deal=null abre em modo "Nova Negociacao", que nao queremos aqui. */}
      {drawerDeal && (
        <DealDrawer
          deal={drawerDeal}
          onClose={() => setDrawerDeal(null)}
        />
      )}
    </div>
  );
};
