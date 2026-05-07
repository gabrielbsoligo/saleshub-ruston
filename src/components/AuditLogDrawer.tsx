// =============================================================
// AuditLogDrawer — visualizador de mudancas em comissoes_registros
// =============================================================
// Lista entries de comissoes_registros_audit com filtros (empresa,
// colaborador, acao, range de data) e diff legivel campo a campo.
//
// Uso:
//   - Visao geral: <AuditLogDrawer open onClose=... />
//   - Filtrado por uma comissao: <AuditLogDrawer open onClose=... comissaoId="uuid" />
//
// Acesso: o componente nao verifica role — quem chama deve esconder
// o trigger pra non-gestor. RLS no banco ja' bloqueia leitura
// (policy comaudit_select: gestor | financeiro).
// =============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { X, History, ChevronDown, ChevronRight, Search, Filter } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';

interface Props {
  open: boolean;
  onClose: () => void;
  comissaoId?: string;
}

interface AuditEntry {
  id: string;
  comissao_id: string | null;
  acao: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  snapshot_antes: Record<string, any> | null;
  snapshot_depois: Record<string, any> | null;
  mudado_por: string | null;
  mudado_em: string;
}

// Campos ignorados no diff (ruido — sempre mudam ou nao sao informativos)
const FIELDS_IGNORE = new Set(['updated_at', 'created_at', 'id']);

// Labels humanos pros campos de comissoes_registros
const FIELD_LABELS: Record<string, string> = {
  empresa: 'Empresa',
  member_id: 'Colaborador (id)',
  member_name: 'Colaborador',
  role_comissao: 'Role',
  tipo: 'Tipo',
  categoria: 'Categoria',
  valor_base: 'Valor base',
  percentual: '%',
  valor_comissao: 'Valor comissão',
  data_pgto: 'Data pgto contrato',
  data_liberacao: 'Data liberação',
  data_pgto_real: 'Data pgto real',
  valor_recebido: 'Valor recebido',
  data_pgto_vendedor: 'Data pgto vendedor',
  status_comissao: 'Status',
  observacao: 'Observação',
  editado_manualmente: 'Editado manualmente',
  numero_parcela: 'Parcela',
  confirmado_por: 'Confirmado por',
  origem: 'Origem',
  deal_id: 'Deal',
  recebimento_id: 'Recebimento',
};

// Formatador de valor pra exibicao no diff
function fmtValue(field: string, v: any): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (field === 'percentual' && typeof v === 'number') return `${(v * 100).toFixed(2)}%`;
  if (field.startsWith('valor_') && typeof v === 'number') {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
  }
  if (field.startsWith('data_') && typeof v === 'string' && v.length === 10) {
    // YYYY-MM-DD
    return v.split('-').reverse().join('/');
  }
  // UUID — encurta
  if (typeof v === 'string' && /^[0-9a-f]{8}-/.test(v)) return v.slice(0, 8) + '…';
  return String(v).slice(0, 60);
}

function fmtDateTime(d: string): string {
  return new Date(d).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// Diff entre dois snapshots — retorna lista de campos que mudaram
function diffSnapshot(antes: Record<string, any> | null, depois: Record<string, any> | null) {
  if (!antes && depois) {
    // INSERT — mostra os campos significativos do depois
    return Object.keys(depois)
      .filter(k => !FIELDS_IGNORE.has(k) && depois[k] !== null && depois[k] !== '')
      .map(k => ({ field: k, before: null, after: depois[k] }));
  }
  if (antes && !depois) {
    // DELETE — mostra os campos que existiam
    return Object.keys(antes)
      .filter(k => !FIELDS_IGNORE.has(k) && antes[k] !== null && antes[k] !== '')
      .map(k => ({ field: k, before: antes[k], after: null }));
  }
  if (!antes || !depois) return [];
  // UPDATE — apenas os que mudaram
  const keys = new Set([...Object.keys(antes), ...Object.keys(depois)]);
  const out: { field: string; before: any; after: any }[] = [];
  for (const k of keys) {
    if (FIELDS_IGNORE.has(k)) continue;
    if (JSON.stringify(antes[k]) !== JSON.stringify(depois[k])) {
      out.push({ field: k, before: antes[k], after: depois[k] });
    }
  }
  return out;
}

// Resumo curto da entry pra uma linha (label do header) — antes de expandir
function resumirEntry(entry: AuditEntry): string {
  const snap = entry.snapshot_depois || entry.snapshot_antes;
  if (!snap) return entry.acao;
  const empresa = snap.empresa || '(sem empresa)';
  const member = snap.member_name || '(sem colaborador)';
  return `${empresa} · ${member}`;
}

export const AuditLogDrawer: React.FC<Props> = ({ open, onClose, comissaoId }) => {
  const { members } = useAppStore();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Filtros
  const [search, setSearch] = useState('');
  const [filterAcao, setFilterAcao] = useState<string>('');
  const [filterMember, setFilterMember] = useState<string>('');
  const [dataDe, setDataDe] = useState('');
  const [dataAte, setDataAte] = useState('');
  const [limit, setLimit] = useState(100);

  const memberById = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);

  // Fetch
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      let q = supabase
        .from('comissoes_registros_audit')
        .select('id, comissao_id, acao, snapshot_antes, snapshot_depois, mudado_por, mudado_em')
        .order('mudado_em', { ascending: false })
        .limit(limit);

      if (comissaoId) q = q.eq('comissao_id', comissaoId);
      if (filterAcao) q = q.eq('acao', filterAcao);
      if (filterMember) q = q.eq('mudado_por', filterMember);
      if (dataDe) q = q.gte('mudado_em', `${dataDe}T00:00:00`);
      if (dataAte) q = q.lt('mudado_em', new Date(new Date(dataAte + 'T00:00:00').getTime() + 24 * 3600 * 1000).toISOString());

      const { data, error } = await q;
      if (error) {
        console.error('audit fetch error', error);
        setEntries([]);
      } else {
        setEntries((data as AuditEntry[]) || []);
      }
      setLoading(false);
    })();
  }, [open, comissaoId, filterAcao, filterMember, dataDe, dataAte, limit]);

  // Search no client (mais leve que ilike no jsonb)
  const filteredEntries = useMemo(() => {
    if (!search.trim()) return entries;
    const s = search.trim().toLowerCase();
    return entries.filter(e => {
      const snap = e.snapshot_depois || e.snapshot_antes;
      if (!snap) return false;
      const hay = `${snap.empresa || ''} ${snap.member_name || ''}`.toLowerCase();
      return hay.includes(s);
    });
  }, [entries, search]);

  const toggleExpand = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div
        className="bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] w-full max-w-2xl h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex items-center gap-2">
            <History size={18} className="text-[var(--color-v4-red)]" />
            <h3 className="text-white font-semibold">
              {comissaoId ? 'Histórico desta comissão' : 'Audit log de comissões'}
            </h3>
            <span className="text-xs text-[var(--color-v4-text-muted)]">
              {loading ? 'carregando…' : `${filteredEntries.length} ${filteredEntries.length === 1 ? 'entrada' : 'entradas'}`}
            </span>
          </div>
          <button onClick={onClose} className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={16} />
          </button>
        </div>

        {/* Filtros — escondidos quando filtra por uma comissao especifica */}
        {!comissaoId && (
          <div className="px-5 py-3 border-b border-[var(--color-v4-border)] space-y-2">
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative flex-1 min-w-[180px]">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar empresa ou colaborador…"
                  className="w-full pl-7 pr-3 py-1.5 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                />
              </div>
              <select
                value={filterAcao}
                onChange={e => setFilterAcao(e.target.value)}
                className="px-2 py-1.5 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
              >
                <option value="">Todas ações</option>
                <option value="INSERT">Criação</option>
                <option value="UPDATE">Edição</option>
                <option value="DELETE">Exclusão</option>
              </select>
              <select
                value={filterMember}
                onChange={e => setFilterMember(e.target.value)}
                className="px-2 py-1.5 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs max-w-[180px]"
              >
                <option value="">Quem mudou: todos</option>
                {members.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-2 items-center text-xs">
              <Filter size={12} className="text-[var(--color-v4-text-muted)]" />
              <span className="text-[10px] text-[var(--color-v4-text-muted)] uppercase">Período:</span>
              <input
                type="date"
                value={dataDe}
                onChange={e => setDataDe(e.target.value)}
                className="px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                placeholder="de"
              />
              <span className="text-[var(--color-v4-text-muted)]">→</span>
              <input
                type="date"
                value={dataAte}
                onChange={e => setDataAte(e.target.value)}
                className="px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
              />
              {(dataDe || dataAte || filterAcao || filterMember || search) && (
                <button
                  onClick={() => { setDataDe(''); setDataAte(''); setFilterAcao(''); setFilterMember(''); setSearch(''); }}
                  className="ml-auto text-[10px] text-[var(--color-v4-text-muted)] hover:text-white"
                >
                  Limpar filtros
                </button>
              )}
            </div>
          </div>
        )}

        {/* Lista */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {loading && (
            <p className="text-[var(--color-v4-text-muted)] text-center py-8 text-xs">Carregando…</p>
          )}
          {!loading && filteredEntries.length === 0 && (
            <p className="text-[var(--color-v4-text-muted)] text-center py-8 text-xs">
              Nenhuma alteração encontrada com esses filtros.
            </p>
          )}
          {!loading && filteredEntries.map(entry => {
            const isExpanded = expanded.has(entry.id);
            const member = entry.mudado_por ? memberById.get(entry.mudado_por) : null;
            const diffs = diffSnapshot(entry.snapshot_antes, entry.snapshot_depois);
            const acaoColor =
              entry.acao === 'INSERT' ? 'bg-green-500/15 text-green-400 border-green-500/30' :
              entry.acao === 'UPDATE' ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' :
              'bg-red-500/15 text-red-400 border-red-500/30';
            const acaoLabel =
              entry.acao === 'INSERT' ? 'Criação' :
              entry.acao === 'UPDATE' ? 'Edição' :
              entry.acao === 'DELETE' ? 'Exclusão' : entry.acao;

            return (
              <div key={entry.id} className="rounded border border-[var(--color-v4-border)] bg-[var(--color-v4-bg)] overflow-hidden">
                <button
                  onClick={() => toggleExpand(entry.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-v4-surface)] text-left"
                >
                  {isExpanded ? <ChevronDown size={12} className="text-[var(--color-v4-text-muted)] shrink-0" /> : <ChevronRight size={12} className="text-[var(--color-v4-text-muted)] shrink-0" />}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${acaoColor}`}>
                    {acaoLabel}
                  </span>
                  <span className="text-xs text-white truncate flex-1">{resumirEntry(entry)}</span>
                  <span className="text-[10px] text-[var(--color-v4-text-muted)] shrink-0">
                    {entry.acao === 'UPDATE' && (
                      <span className="mr-2">{diffs.length} {diffs.length === 1 ? 'campo' : 'campos'}</span>
                    )}
                    {fmtDateTime(entry.mudado_em)}
                  </span>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 border-t border-[var(--color-v4-border)] space-y-1">
                    <div className="text-[10px] text-[var(--color-v4-text-muted)] mb-2">
                      Por: <span className="text-white">{member?.name || (entry.mudado_por ? `(${entry.mudado_por.slice(0, 8)}…)` : 'sistema/trigger')}</span>
                      {entry.comissao_id && (
                        <span className="ml-3">comissão: <code className="text-[10px] text-[var(--color-v4-text-muted)]">{entry.comissao_id.slice(0, 8)}…</code></span>
                      )}
                    </div>
                    {diffs.length === 0 ? (
                      <p className="text-[10px] text-[var(--color-v4-text-muted)] italic">Sem campos relevantes alterados.</p>
                    ) : (
                      <div className="space-y-1">
                        {diffs.map(d => (
                          <div key={d.field} className="grid grid-cols-[120px_1fr] gap-2 text-[11px] items-baseline">
                            <span className="text-[var(--color-v4-text-muted)] truncate">{FIELD_LABELS[d.field] || d.field}:</span>
                            <div className="flex flex-wrap gap-2 items-baseline">
                              {entry.acao !== 'INSERT' && (
                                <span className="line-through text-red-400/70 text-[11px]">{fmtValue(d.field, d.before)}</span>
                              )}
                              {entry.acao !== 'DELETE' && (
                                <>
                                  {entry.acao === 'UPDATE' && <span className="text-[var(--color-v4-text-muted)]">→</span>}
                                  <span className="text-green-400 text-[11px]">{fmtValue(d.field, d.after)}</span>
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Load more */}
          {!loading && filteredEntries.length === limit && (
            <button
              onClick={() => setLimit(l => l + 100)}
              className="w-full py-2 mt-2 rounded border border-[var(--color-v4-border)] text-xs text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]"
            >
              Carregar mais 100
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
