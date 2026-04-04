import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { ROLE_LABELS } from "../types";
import { DollarSign, ChevronDown, ChevronRight, RefreshCw, Edit2, Save, X } from "lucide-react";
import toast from "react-hot-toast";

function fmt(v: number) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v); }

function getCategoria(origem?: string): 'inbound' | 'outbound' {
  if (!origem) return 'inbound';
  return ['blackbox', 'leadbroker'].includes(origem) ? 'inbound' : 'outbound';
}

interface ComissaoRegistro {
  id: string;
  deal_id?: string;
  member_id?: string;
  member_name: string;
  role_comissao: string;
  tipo: 'mrr' | 'ot';
  categoria: string;
  valor_base: number;
  percentual: number;
  valor_comissao: number;
  data_pgto?: string;
  data_liberacao?: string;
  empresa: string;
  origem?: string;
  observacao?: string;
  editado_manualmente: boolean;
}

export const ComissoesView: React.FC = () => {
  const { deals, members, comissoes: comissoesConfig, currentUser } = useAppStore();
  const isGestor = currentUser?.role === 'gestor';
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [registros, setRegistros] = useState<ComissaoRegistro[]>([]);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ComissaoRegistro>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  const now = new Date();

  // Fetch registros
  const fetchRegistros = useCallback(async () => {
    const [year, month] = selectedMonth.split('-').map(Number);
    const start = `${selectedMonth}-01`;
    const end = new Date(year, month, 0).toISOString().split('T')[0];

    const { data } = await supabase.from('comissoes_registros').select('*')
      .gte('data_liberacao', start).lte('data_liberacao', end)
      .order('empresa');
    if (data) setRegistros(data);
  }, [selectedMonth]);

  useEffect(() => { fetchRegistros(); }, [fetchRegistros]);

  // Generate comissoes from deals
  const generateComissoes = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const dealsGanhos = deals.filter(d => d.status === 'contrato_assinado');
      const newRegistros: any[] = [];

      for (const deal of dealsGanhos) {
        const categoria = getCategoria(deal.origem);

        // Closer comissoes
        if (deal.closer_id) {
          const closer = members.find(m => m.id === deal.closer_id);
          const mrrVal = deal.valor_recorrente || deal.valor_mrr || 0;
          const otVal = deal.valor_escopo || deal.valor_ot || 0;

          if (mrrVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'closer' && c.tipo_origem === categoria && c.tipo_valor === 'mrr');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_recorrente || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.closer_id, member_name: closer?.name || '?',
              role_comissao: 'closer', tipo: 'mrr', categoria, valor_base: mrrVal,
              percentual: pct, valor_comissao: mrrVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem,
            });
          }
          if (otVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'closer' && c.tipo_origem === categoria && c.tipo_valor === 'ot');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_escopo || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.closer_id, member_name: closer?.name || '?',
              role_comissao: 'closer', tipo: 'ot', categoria, valor_base: otVal,
              percentual: pct, valor_comissao: otVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem,
            });
          }
        }

        // SDR comissoes
        if (deal.sdr_id) {
          const sdr = members.find(m => m.id === deal.sdr_id);
          const mrrVal = deal.valor_recorrente || deal.valor_mrr || 0;
          const otVal = deal.valor_escopo || deal.valor_ot || 0;

          if (mrrVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'sdr' && c.tipo_origem === categoria && c.tipo_valor === 'mrr');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_recorrente || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.sdr_id, member_name: sdr?.name || '?',
              role_comissao: 'sdr', tipo: 'mrr', categoria, valor_base: mrrVal,
              percentual: pct, valor_comissao: mrrVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem,
            });
          }
          if (otVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'sdr' && c.tipo_origem === categoria && c.tipo_valor === 'ot');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_escopo || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.sdr_id, member_name: sdr?.name || '?',
              role_comissao: 'sdr', tipo: 'ot', categoria, valor_base: otVal,
              percentual: pct, valor_comissao: otVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem,
            });
          }
        }
      }

      // Delete non-manually-edited registros and re-insert
      await supabase.from('comissoes_registros').delete().eq('editado_manualmente', false);
      if (newRegistros.length > 0) {
        await supabase.from('comissoes_registros').insert(newRegistros);
      }

      toast.success(`${newRegistros.length} registros de comissão gerados!`);
      fetchRegistros();
    } finally { setIsProcessing(false); }
  };

  // Edit a registro
  const startEdit = (reg: ComissaoRegistro) => {
    setEditingId(reg.id);
    setEditForm({ ...reg });
  };

  const saveEdit = async () => {
    if (!editingId || !editForm) return;
    const { error } = await supabase.from('comissoes_registros').update({
      empresa: editForm.empresa,
      member_name: editForm.member_name,
      role_comissao: editForm.role_comissao,
      valor_base: editForm.valor_base,
      percentual: editForm.percentual,
      valor_comissao: editForm.valor_comissao,
      data_pgto: editForm.data_pgto || null,
      data_liberacao: editForm.data_liberacao || null,
      observacao: editForm.observacao || null,
      editado_manualmente: true,
    }).eq('id', editingId);
    if (error) { toast.error(error.message); return; }
    toast.success('Registro atualizado!');
    setEditingId(null);
    fetchRegistros();
  };

  const deleteRegistro = async (id: string) => {
    if (!confirm('Excluir este registro de comissão?')) return;
    await supabase.from('comissoes_registros').delete().eq('id', id);
    fetchRegistros();
  };

  // Add manual registro
  const addManual = async () => {
    const { error } = await supabase.from('comissoes_registros').insert({
      member_name: '(editar nome)', role_comissao: 'sdr', tipo: 'ot', categoria: 'outbound',
      valor_base: 0, percentual: 0, valor_comissao: 0, empresa: '(editar)',
      editado_manualmente: true, data_liberacao: `${selectedMonth}-15`,
    });
    if (error) { toast.error(error.message); return; }
    fetchRegistros();
  };

  // Group by member
  const grouped = useMemo(() => {
    const map: Record<string, { name: string; lines: ComissaoRegistro[]; total: number; liberado: number }> = {};
    for (const reg of registros) {
      const key = reg.member_name || 'Sem nome';
      if (!map[key]) map[key] = { name: key, lines: [], total: 0, liberado: 0 };
      map[key].lines.push(reg);
      map[key].total += reg.valor_comissao;
      if (reg.data_liberacao && new Date(reg.data_liberacao) <= now) map[key].liberado += reg.valor_comissao;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [registros]);

  const totalGeral = registros.reduce((a, r) => a + r.valor_comissao, 0);
  const liberadoGeral = registros.filter(r => r.data_liberacao && new Date(r.data_liberacao) <= now).reduce((a, r) => a + r.valor_comissao, 0);

  const inputClass = "px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Comissões</h2>
        <div className="flex items-center gap-3">
          <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
            className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm" />
          {isGestor && (
            <button onClick={addManual}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs">
              + Manual
            </button>
          )}
        </div>
      </div>

      {/* Totais */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
          <span className="text-xs text-[var(--color-v4-text-muted)]">Total Comissões</span>
          <p className="text-xl font-bold text-white mt-1">{fmt(totalGeral)}</p>
          <p className="text-[10px] text-[var(--color-v4-text-muted)]">{registros.length} registros</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-green-500/30 rounded-xl p-4">
          <span className="text-xs text-green-400">Liberado</span>
          <p className="text-xl font-bold text-green-400 mt-1">{fmt(liberadoGeral)}</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-xl p-4">
          <span className="text-xs text-yellow-400">Pendente</span>
          <p className="text-xl font-bold text-yellow-400 mt-1">{fmt(totalGeral - liberadoGeral)}</p>
        </div>
      </div>

      {/* Tabela de regras */}
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-6">
        <h3 className="text-xs font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-3">Tabela de Comissões</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">Inbound (BB + LB)</p>
            <div className="grid grid-cols-3 gap-1 text-xs">
              <span></span><span className="text-center text-[var(--color-v4-text-muted)]">Closer</span><span className="text-center text-[var(--color-v4-text-muted)]">SDR</span>
              <span className="text-white">MRR</span><span className="text-center text-white">10%</span><span className="text-center text-white">5%</span>
              <span className="text-white">OT</span><span className="text-center text-white">5%</span><span className="text-center text-white">2%</span>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">Outbound + Recom. + Indicação</p>
            <div className="grid grid-cols-3 gap-1 text-xs">
              <span></span><span className="text-center text-[var(--color-v4-text-muted)]">Closer</span><span className="text-center text-[var(--color-v4-text-muted)]">SDR</span>
              <span className="text-white">MRR</span><span className="text-center text-white">30%</span><span className="text-center text-white">10%</span>
              <span className="text-white">OT</span><span className="text-center text-white">15%</span><span className="text-center text-white">5%</span>
            </div>
          </div>
        </div>
        <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-3">Liberação: 30 dias após 1º pagamento. Registros editáveis pelo gestor.</p>
      </div>

      {/* Por membro */}
      {grouped.length > 0 ? (
        <div className="space-y-3">
          {grouped.map(({ name, lines, total, liberado }) => {
            const isExpanded = expandedMember === name;
            const pendente = total - liberado;
            return (
              <div key={name} className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden">
                <button onClick={() => setExpandedMember(isExpanded ? null : name)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-[var(--color-v4-card-hover)] transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-xs">
                      {name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <span className="text-sm font-medium text-white">{name}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <span className="text-sm font-bold text-white">{fmt(total)}</span>
                      <div className="flex gap-2 text-[10px]">
                        <span className="text-green-400">{fmt(liberado)} lib.</span>
                        {pendente > 0 && <span className="text-yellow-400">{fmt(pendente)} pend.</span>}
                      </div>
                    </div>
                    <span className="text-xs text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)] px-2 py-0.5 rounded">{lines.length}</span>
                    {isExpanded ? <ChevronDown size={14} className="text-[var(--color-v4-text-muted)]" /> : <ChevronRight size={14} className="text-[var(--color-v4-text-muted)]" />}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-[var(--color-v4-border)] overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)]">
                          <th className="px-3 py-2 text-left">Empresa</th>
                          <th className="px-3 py-2">Role</th>
                          <th className="px-3 py-2">Tipo</th>
                          <th className="px-3 py-2">Cat.</th>
                          <th className="px-3 py-2">Valor</th>
                          <th className="px-3 py-2">%</th>
                          <th className="px-3 py-2">Comissão</th>
                          <th className="px-3 py-2">1º Pgto</th>
                          <th className="px-3 py-2">Liberação</th>
                          <th className="px-3 py-2">Status</th>
                          {isGestor && <th className="px-3 py-2">Ações</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map(line => {
                          const isEditing = editingId === line.id;
                          const liberada = line.data_liberacao && new Date(line.data_liberacao) <= now;

                          if (isEditing) {
                            return (
                              <tr key={line.id} className="border-t border-[var(--color-v4-border)] bg-[var(--color-v4-surface)]">
                                <td className="px-3 py-2">
                                  <input className={inputClass + " w-24 mb-1"} value={editForm.empresa || ''} onChange={e => setEditForm(p => ({ ...p, empresa: e.target.value }))} placeholder="Empresa" />
                                  <input className={inputClass + " w-24"} value={editForm.member_name || ''} onChange={e => setEditForm(p => ({ ...p, member_name: e.target.value }))} placeholder="Nome pessoa" />
                                </td>
                                <td className="px-3 py-2"><input className={inputClass + " w-16"} value={editForm.role_comissao || ''} onChange={e => setEditForm(p => ({ ...p, role_comissao: e.target.value }))} /></td>
                                <td className="px-3 py-2"><select className={inputClass} value={editForm.tipo} onChange={e => setEditForm(p => ({ ...p, tipo: e.target.value as any }))}><option value="mrr">MRR</option><option value="ot">OT</option></select></td>
                                <td className="px-3 py-2"><select className={inputClass} value={editForm.categoria} onChange={e => setEditForm(p => ({ ...p, categoria: e.target.value }))}><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select></td>
                                <td className="px-3 py-2"><input type="number" className={inputClass + " w-20"} value={editForm.valor_base} onChange={e => { const v = Number(e.target.value); setEditForm(p => ({ ...p, valor_base: v, valor_comissao: v * (p.percentual || 0) })); }} /></td>
                                <td className="px-3 py-2"><input type="number" step="0.01" className={inputClass + " w-14"} value={editForm.percentual} onChange={e => { const pct = Number(e.target.value); setEditForm(p => ({ ...p, percentual: pct, valor_comissao: (p.valor_base || 0) * pct })); }} /></td>
                                <td className="px-3 py-2"><input type="number" className={inputClass + " w-20"} value={editForm.valor_comissao} onChange={e => setEditForm(p => ({ ...p, valor_comissao: Number(e.target.value) }))} /></td>
                                <td className="px-3 py-2"><input type="date" className={inputClass + " w-28"} value={editForm.data_pgto || ''} onChange={e => { const d = e.target.value; const lib = d ? new Date(new Date(d).getTime() + 30 * 86400000).toISOString().split('T')[0] : ''; setEditForm(p => ({ ...p, data_pgto: d, data_liberacao: lib })); }} /></td>
                                <td className="px-3 py-2"><input type="date" className={inputClass + " w-28"} value={editForm.data_liberacao || ''} onChange={e => setEditForm(p => ({ ...p, data_liberacao: e.target.value }))} /></td>
                                <td className="px-3 py-2"></td>
                                <td className="px-3 py-2 flex gap-1">
                                  <button onClick={saveEdit} className="text-green-400 hover:text-green-300"><Save size={12} /></button>
                                  <button onClick={() => setEditingId(null)} className="text-[var(--color-v4-text-muted)]"><X size={12} /></button>
                                </td>
                              </tr>
                            );
                          }

                          return (
                            <tr key={line.id} className={`border-t border-[var(--color-v4-border)] ${line.editado_manualmente ? 'bg-yellow-500/5' : ''}`}>
                              <td className="px-3 py-2 text-white">{line.empresa} {line.editado_manualmente && <span className="text-[8px] text-yellow-400">editado</span>}</td>
                              <td className="px-3 py-2 text-center text-[var(--color-v4-text-muted)]">{line.role_comissao}</td>
                              <td className="px-3 py-2 text-center"><span className={`px-1.5 py-0.5 rounded ${line.tipo === 'mrr' ? 'bg-green-500/15 text-green-400' : 'bg-blue-500/15 text-blue-400'}`}>{line.tipo.toUpperCase()}</span></td>
                              <td className="px-3 py-2 text-center text-[var(--color-v4-text-muted)]">{line.categoria}</td>
                              <td className="px-3 py-2 text-center text-white">{fmt(line.valor_base)}</td>
                              <td className="px-3 py-2 text-center text-white">{(line.percentual * 100).toFixed(0)}%</td>
                              <td className="px-3 py-2 text-center font-bold text-white">{fmt(line.valor_comissao)}</td>
                              <td className="px-3 py-2 text-center text-[var(--color-v4-text-muted)]">{line.data_pgto ? new Date(line.data_pgto + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}</td>
                              <td className="px-3 py-2 text-center text-[var(--color-v4-text-muted)]">{line.data_liberacao ? new Date(line.data_liberacao + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}</td>
                              <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded text-[10px] font-medium ${liberada ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>{liberada ? 'Liberado' : 'Pendente'}</span></td>
                              {isGestor && (
                                <td className="px-3 py-2 flex gap-1">
                                  <button onClick={() => startEdit(line)} className="text-[var(--color-v4-text-muted)] hover:text-white"><Edit2 size={12} /></button>
                                  <button onClick={() => deleteRegistro(line.id)} className="text-[var(--color-v4-text-muted)] hover:text-red-400"><X size={12} /></button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-12">
          <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhum registro de comissão para este período</p>
          <p className="text-xs text-[var(--color-v4-text-muted)] mt-2">Comissões são geradas automaticamente quando um deal é dado como ganho.</p>
        </div>
      )}
    </div>
  );
};
