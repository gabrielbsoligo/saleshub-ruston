import React, { useState } from "react";
import { useAppStore } from "../store";
import { ROLE_LABELS } from "../types";
import { Save } from "lucide-react";

export const PerformanceView: React.FC = () => {
  const { members, performanceSdr, savePerformanceSdr, performanceCloser, savePerformanceCloser } = useAppStore();
  const [tab, setTab] = useState<'sdr' | 'closer'>('sdr');
  const [selectedMember, setSelectedMember] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedMes, setSelectedMes] = useState(new Date().toISOString().slice(0, 7));

  const sdrs = members.filter(m => m.role === 'sdr');
  const closers = members.filter(m => m.role === 'closer');

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  // SDR form
  const [sdrForm, setSdrForm] = useState({
    ligacoes: 0, ligacoes_atendidas: 0, conversas_whatsapp: 0,
    reunioes_agendadas: 0, reunioes_realizadas: 0, no_shows: 0, indicacoes_coletadas: 0,
  });

  const handleSaveSdr = async () => {
    if (!selectedMember) return;
    await savePerformanceSdr({ member_id: selectedMember, data: selectedDate, ...sdrForm });
  };

  // Closer form
  const [closerForm, setCloserForm] = useState({
    canal: 'inbound' as string, shows: 0, no_shows: 0, vendas: 0,
  });

  const handleSaveCloser = async () => {
    if (!selectedMember) return;
    await savePerformanceCloser({ member_id: selectedMember, mes: `${selectedMes}-01`, ...closerForm });
  };

  // Resumo SDR
  const sdrSummary = sdrs.map(s => {
    const perfs = performanceSdr.filter(p => p.member_id === s.id);
    return {
      name: s.name.split(' ')[0],
      ligacoes: perfs.reduce((a, p) => a + (p.ligacoes || 0), 0),
      reunioes: perfs.reduce((a, p) => a + (p.reunioes_agendadas || 0), 0),
      realizadas: perfs.reduce((a, p) => a + (p.reunioes_realizadas || 0), 0),
      noShows: perfs.reduce((a, p) => a + (p.no_shows || 0), 0),
      dias: perfs.length,
    };
  });

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-2xl font-display font-bold text-white mb-6">Performance</h2>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('sdr')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'sdr' ? 'bg-[var(--color-v4-red)] text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>
          Pré-venda (SDR)
        </button>
        <button onClick={() => setTab('closer')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'closer' ? 'bg-[var(--color-v4-red)] text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>
          Closer
        </button>
      </div>

      {tab === 'sdr' && (
        <>
          {/* Resumo */}
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 mb-6">
            <h3 className="text-sm font-semibold text-white mb-3">Resumo SDR (todos os registros)</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[var(--color-v4-text-muted)]">
                  <th className="pb-2">SDR</th><th className="pb-2">Ligações</th><th className="pb-2">Reuniões Ag.</th><th className="pb-2">Realizadas</th><th className="pb-2">No-shows</th><th className="pb-2">Dias</th>
                </tr></thead>
                <tbody>
                  {sdrSummary.map(s => (
                    <tr key={s.name} className="border-t border-[var(--color-v4-border)]">
                      <td className="py-2 text-white">{s.name}</td>
                      <td className="py-2 text-[var(--color-v4-text-muted)]">{s.ligacoes}</td>
                      <td className="py-2 text-[var(--color-v4-text-muted)]">{s.reunioes}</td>
                      <td className="py-2 text-green-400">{s.realizadas}</td>
                      <td className="py-2 text-red-400">{s.noShows}</td>
                      <td className="py-2 text-[var(--color-v4-text-muted)]">{s.dias}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Input */}
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Registrar Performance SDR</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <select className={inputClass} value={selectedMember} onChange={e => setSelectedMember(e.target.value)}>
                <option value="">Selecionar SDR</option>
                {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input type="date" className={inputClass} value={selectedDate} onChange={e => setSelectedDate(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              {[
                ['ligacoes', 'Ligações'], ['ligacoes_atendidas', 'Atendidas'], ['conversas_whatsapp', 'WhatsApp'],
                ['reunioes_agendadas', 'Reuniões Ag.'], ['reunioes_realizadas', 'Realizadas'], ['no_shows', 'No-shows'], ['indicacoes_coletadas', 'Indicações'],
              ].map(([key, label]) => (
                <div key={key}>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">{label}</label>
                  <input type="number" className={inputClass} value={(sdrForm as any)[key]} onChange={e => setSdrForm(p => ({ ...p, [key]: Number(e.target.value) }))} />
                </div>
              ))}
            </div>
            <button onClick={handleSaveSdr} disabled={!selectedMember} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm">
              <Save size={14} /> Salvar
            </button>
          </div>
        </>
      )}

      {tab === 'closer' && (
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-3">Registrar Performance Closer</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <select className={inputClass} value={selectedMember} onChange={e => setSelectedMember(e.target.value)}>
              <option value="">Selecionar Closer</option>
              {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="month" className={inputClass} value={selectedMes} onChange={e => setSelectedMes(e.target.value)} />
            <select className={inputClass} value={closerForm.canal} onChange={e => setCloserForm(p => ({ ...p, canal: e.target.value }))}>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
              <option value="indicacao">Indicação</option>
              <option value="recomendacao">Recomendação</option>
              <option value="outros">Outros</option>
            </select>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Shows</label>
              <input type="number" className={inputClass} value={closerForm.shows} onChange={e => setCloserForm(p => ({ ...p, shows: Number(e.target.value) }))} /></div>
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">No-shows</label>
              <input type="number" className={inputClass} value={closerForm.no_shows} onChange={e => setCloserForm(p => ({ ...p, no_shows: Number(e.target.value) }))} /></div>
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Vendas</label>
              <input type="number" className={inputClass} value={closerForm.vendas} onChange={e => setCloserForm(p => ({ ...p, vendas: Number(e.target.value) }))} /></div>
          </div>
          <button onClick={handleSaveCloser} disabled={!selectedMember} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm">
            <Save size={14} /> Salvar
          </button>
        </div>
      )}
    </div>
  );
};
