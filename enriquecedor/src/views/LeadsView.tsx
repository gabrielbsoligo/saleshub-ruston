import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, Users2, Download, Trash2, Sparkles, Loader2, RefreshCw } from 'lucide-react';
import type { DataQuality, Lead } from '../types';
import { leadsRepo } from '../lib/leadsRepo';
import { enrichLeads, type EnrichProgress } from '../lib/enrichService';
import { exportLeadsCsv } from '../lib/exportCsv';
import { isSituacaoAtiva } from '../lib/leadScore';
import { QUALITY_COLORS, QUALITY_LABELS, STATUS_COLORS, STATUS_LABELS } from '../lib/labels';
import { formatCnpj } from '../lib/validation';
import { useAuth } from '../lib/auth';

const PAGE_SIZE = 50;
const inputCls =
  'rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none focus:border-v4-red';

export function LeadsView({ onOpenLead }: { onOpenLead: (id: string) => void }) {
  const { permissions } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [qualityFilter, setQualityFilter] = useState<DataQuality | 'todos'>('todos');
  const [onlyActive, setOnlyActive] = useState(false);
  const [page, setPage] = useState(0);
  const [enriching, setEnriching] = useState<EnrichProgress | null>(null);

  const reload = () =>
    leadsRepo
      .list()
      .then(setLeads)
      .finally(() => setLoading(false));

  useEffect(() => {
    reload();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads
      .filter((lead) => {
        if (qualityFilter !== 'todos' && lead.dataQuality !== qualityFilter) return false;
        if (onlyActive && !isSituacaoAtiva(lead.situacaoCadastral)) return false;
        if (!q) return true;
        return (
          (lead.razaoSocial ?? lead.companyNameRaw).toLowerCase().includes(q) ||
          (lead.cnpj ?? lead.cnpjRaw).includes(q) ||
          (lead.segmento ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }, [leads, search, qualityFilter, onlyActive]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageLeads = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleEnrichPending = async () => {
    const pending = leads.filter((l) => l.status === 'importado' || l.status === 'incompleto');
    if (pending.length === 0) {
      toast('Nenhum lead pendente.');
      return;
    }
    setEnriching({ done: 0, total: pending.length });
    await enrichLeads(pending, setEnriching);
    setEnriching(null);
    await reload();
    toast.success(`${pending.length} leads enriquecidos.`);
  };

  const handleReenrichAll = async () => {
    if (leads.length === 0) return;
    if (!confirm(`Re-enriquecer TODOS os ${leads.length} leads? Consome cota das APIs.`)) return;
    setEnriching({ done: 0, total: leads.length });
    await enrichLeads(leads, setEnriching);
    setEnriching(null);
    await reload();
    toast.success(`${leads.length} leads re-enriquecidos.`);
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await leadsRepo.remove(id);
    await reload();
  };

  const handleClear = async () => {
    if (!confirm('Apagar TODOS os leads? Esta ação não pode ser desfeita.')) return;
    await leadsRepo.clear();
    await reload();
    toast.success('Base de leads limpa.');
  };

  const pendingCount = leads.filter((l) => l.status === 'importado' || l.status === 'incompleto').length;

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-v4-text">Leads</h1>
          <p className="text-sm text-v4-text-muted">
            {leads.length} na base · {filtered.length} no filtro
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {permissions?.canEditLeads && pendingCount > 0 && (
            <button
              onClick={handleEnrichPending}
              disabled={!!enriching}
              className="flex items-center gap-2 rounded-lg bg-v4-red px-3 py-2 text-sm font-medium text-white hover:bg-v4-red-hover disabled:opacity-60"
            >
              {enriching ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {enriching ? `Enriquecendo ${enriching.done}/${enriching.total}` : `Enriquecer pendentes (${pendingCount})`}
            </button>
          )}
          {permissions?.canEditLeads && leads.length > 0 && (
            <button
              onClick={handleReenrichAll}
              disabled={!!enriching}
              className="flex items-center gap-2 rounded-lg border border-v4-red px-3 py-2 text-sm font-medium text-v4-red-hover hover:bg-v4-red-muted disabled:opacity-60"
            >
              <RefreshCw size={16} /> Re-enriquecer todos
            </button>
          )}
          {leads.length > 0 && (
            <button
              onClick={() => exportLeadsCsv(filtered)}
              className="flex items-center gap-2 rounded-lg border border-v4-border-strong px-3 py-2 text-sm font-medium text-v4-text-muted hover:bg-v4-surface"
            >
              <Download size={16} /> Exportar CSV
            </button>
          )}
          {permissions?.canEditLeads && leads.length > 0 && (
            <button
              onClick={handleClear}
              className="flex items-center gap-2 rounded-lg border border-v4-border-strong px-3 py-2 text-sm font-medium text-v4-error hover:bg-v4-surface"
            >
              <Trash2 size={16} /> Limpar
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-v4-text-muted" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Buscar por empresa, CNPJ ou segmento…"
            className={`${inputCls} w-full pl-9`}
          />
        </div>
        <select
          value={qualityFilter}
          onChange={(e) => {
            setQualityFilter(e.target.value as DataQuality | 'todos');
            setPage(0);
          }}
          className={inputCls}
        >
          <option value="todos">Toda qualidade</option>
          {(Object.keys(QUALITY_LABELS) as DataQuality[]).map((q) => (
            <option key={q} value={q}>
              {QUALITY_LABELS[q]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text-muted">
          <input type="checkbox" checked={onlyActive} onChange={(e) => { setOnlyActive(e.target.checked); setPage(0); }} />
          Só ativas
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-v4-text-muted">Carregando…</p>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-v4-border bg-v4-card p-12 text-center text-v4-text-muted">
          <Users2 size={36} />
          <p className="text-sm">Nenhum lead encontrado.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-v4-border bg-v4-card">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-v4-border text-xs uppercase text-v4-text-muted">
                <tr>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Empresa</th>
                  <th className="px-4 py-3">Segmento</th>
                  <th className="px-4 py-3">UF</th>
                  <th className="px-4 py-3">Situação</th>
                  <th className="px-4 py-3">Qualidade</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {pageLeads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => onOpenLead(lead.id)}
                    className="cursor-pointer border-b border-v4-border transition last:border-0 hover:bg-v4-surface"
                  >
                    <td className="px-4 py-3">
                      <span className="inline-flex min-w-[2rem] justify-center rounded bg-v4-surface px-2 py-0.5 text-xs font-semibold text-v4-text">
                        {lead.score ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-v4-text">{lead.razaoSocial ?? lead.companyNameRaw}</div>
                      <div className="text-xs text-v4-text-muted">{formatCnpj(lead.cnpj ?? lead.cnpjRaw)}</div>
                    </td>
                    <td className="px-4 py-3 text-v4-text-muted">{lead.segmento ?? '—'}</td>
                    <td className="px-4 py-3 text-v4-text-muted">{lead.uf ?? '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      <span className={isSituacaoAtiva(lead.situacaoCadastral) ? 'text-v4-success' : 'text-v4-error'}>
                        {lead.situacaoCadastral ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${QUALITY_COLORS[lead.dataQuality]}`}>
                        {QUALITY_LABELS[lead.dataQuality]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[lead.status]}`}>
                        {STATUS_LABELS[lead.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {permissions?.canEditLeads && (
                        <button
                          onClick={(e) => handleDelete(e, lead.id)}
                          className="rounded p-1 text-v4-text-disabled hover:bg-v4-surface hover:text-v4-error"
                          title="Apagar lead"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-sm">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-lg border border-v4-border px-3 py-1.5 text-v4-text disabled:opacity-40"
              >
                Anterior
              </button>
              <span className="text-v4-text-muted">Página {page + 1} de {pageCount}</span>
              <button
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
                className="rounded-lg border border-v4-border px-3 py-1.5 text-v4-text disabled:opacity-40"
              >
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
