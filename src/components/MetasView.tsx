import React, { useState } from "react";
import { useAppStore } from "../store";
import { ROLE_LABELS } from "../types";
import { Save, DollarSign } from "lucide-react";

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

export const MetasView: React.FC = () => {
  const { members, metas, saveMeta, deals, comissoes } = useAppStore();
  const [selectedMes, setSelectedMes] = useState(new Date().toISOString().slice(0, 7));

  const mesDate = `${selectedMes}-01`;
  const mesStart = new Date(mesDate);
  const mesEnd = new Date(mesStart.getFullYear(), mesStart.getMonth() + 1, 0);

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  // Meta vs Realizado
  const memberStats = members.filter(m => m.active).map(member => {
    const meta = metas.find(m => m.member_id === member.id && m.mes === mesDate);
    const memberDeals = deals.filter(d => {
      const closer = d.closer_id === member.id;
      const sdr = d.sdr_id === member.id;
      const ganho = d.status === 'contrato_assinado';
      const noMes = d.data_fechamento && new Date(d.data_fechamento) >= mesStart && new Date(d.data_fechamento) <= mesEnd;
      return (closer || sdr) && ganho && noMes;
    });

    const realizadoMrr = memberDeals.reduce((a, d) => a + (d.valor_mrr || 0), 0);
    const realizadoOt = memberDeals.reduce((a, d) => a + (d.valor_ot || 0), 0);

    // Comissão
    const comissaoMrr = comissoes.find(c => c.role === member.role && c.tipo_valor === 'mrr');
    const comissaoOt = comissoes.find(c => c.role === member.role && c.tipo_valor === 'ot');
    const valorComissao = (realizadoMrr * (comissaoMrr?.percentual || 0)) + (realizadoOt * (comissaoOt?.percentual || 0));

    return { member, meta, realizadoMrr, realizadoOt, deals: memberDeals.length, valorComissao };
  });

  const [editingMeta, setEditingMeta] = useState<{ memberId: string; metaMrr: number; metaOt: number; metaReunioes: number; metaLeads: number } | null>(null);

  const handleSaveMeta = async () => {
    if (!editingMeta) return;
    await saveMeta({
      member_id: editingMeta.memberId,
      mes: mesDate,
      meta_mrr: editingMeta.metaMrr,
      meta_ot: editingMeta.metaOt,
      meta_reunioes: editingMeta.metaReunioes,
      meta_leads: editingMeta.metaLeads,
    });
    setEditingMeta(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Metas & Comissões</h2>
        <input type="month" className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm" value={selectedMes} onChange={e => setSelectedMes(e.target.value)} />
      </div>

      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)]">
              <th className="px-4 py-3">Membro</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Meta MRR</th>
              <th className="px-4 py-3">Realiz. MRR</th>
              <th className="px-4 py-3">Meta OT</th>
              <th className="px-4 py-3">Realiz. OT</th>
              <th className="px-4 py-3">Deals</th>
              <th className="px-4 py-3">Comissão</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {memberStats.map(({ member, meta, realizadoMrr, realizadoOt, deals: dealCount, valorComissao }) => {
              const isEditing = editingMeta?.memberId === member.id;
              const pctMrr = meta?.meta_mrr ? (realizadoMrr / meta.meta_mrr * 100) : 0;

              return (
                <tr key={member.id} className="border-t border-[var(--color-v4-border)]">
                  <td className="px-4 py-3 text-white font-medium">{member.name.split(' ')[0]}</td>
                  <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{ROLE_LABELS[member.role]}</td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input type="number" className={inputClass} value={editingMeta.metaMrr} onChange={e => setEditingMeta(p => p ? { ...p, metaMrr: Number(e.target.value) } : p)} />
                    ) : (
                      <span className="text-[var(--color-v4-text-muted)]">{meta?.meta_mrr ? formatCurrency(meta.meta_mrr) : '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={realizadoMrr > 0 ? 'text-green-400' : 'text-[var(--color-v4-text-muted)]'}>{formatCurrency(realizadoMrr)}</span>
                    {pctMrr > 0 && <span className={`ml-1 text-xs ${pctMrr >= 100 ? 'text-green-400' : 'text-yellow-400'}`}>({pctMrr.toFixed(0)}%)</span>}
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input type="number" className={inputClass} value={editingMeta.metaOt} onChange={e => setEditingMeta(p => p ? { ...p, metaOt: Number(e.target.value) } : p)} />
                    ) : (
                      <span className="text-[var(--color-v4-text-muted)]">{meta?.meta_ot ? formatCurrency(meta.meta_ot) : '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={realizadoOt > 0 ? 'text-blue-400' : 'text-[var(--color-v4-text-muted)]'}>{formatCurrency(realizadoOt)}</span>
                  </td>
                  <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{dealCount}</td>
                  <td className="px-4 py-3">
                    <span className="text-yellow-400 flex items-center gap-1"><DollarSign size={12} />{formatCurrency(valorComissao)}</span>
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <button onClick={handleSaveMeta} className="text-green-400 hover:text-green-300"><Save size={14} /></button>
                    ) : (
                      <button onClick={() => setEditingMeta({ memberId: member.id, metaMrr: meta?.meta_mrr || 0, metaOt: meta?.meta_ot || 0, metaReunioes: meta?.meta_reunioes || 0, metaLeads: meta?.meta_leads || 0 })}
                        className="text-[var(--color-v4-text-muted)] hover:text-white text-xs">Editar</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Tabela de comissões */}
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Tabela de Comissões</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {comissoes.map(c => (
            <div key={c.id} className="bg-[var(--color-v4-surface)] rounded-lg p-3">
              <div className="text-xs text-[var(--color-v4-text-muted)] uppercase">{c.role} · {c.tipo_origem} · {c.tipo_valor}</div>
              <div className="text-lg font-bold text-white">{(c.percentual * 100).toFixed(0)}%</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
