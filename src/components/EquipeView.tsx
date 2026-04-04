import React, { useState } from "react";
import { useAppStore } from "../store";
import { ROLE_LABELS, type TeamRole } from "../types";
import { Plus, Save, X, UserCheck, UserX } from "lucide-react";

export const EquipeView: React.FC = () => {
  const { members, addMember, updateMember } = useAppStore();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'sdr' as TeamRole });

  const handleAdd = async () => {
    if (!form.name || !form.email) return;
    await addMember(form);
    setForm({ name: '', email: '', role: 'sdr' });
    setShowForm(false);
  };

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  const ativos = members.filter(m => m.active);
  const inativos = members.filter(m => !m.active);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Equipe ({ativos.length} ativos)</h2>
        <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm">
          <Plus size={16} /> Novo Membro
        </button>
      </div>

      {showForm && (
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-6">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <input className={inputClass} placeholder="Nome *" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            <input className={inputClass} placeholder="Email *" type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
            <select className={inputClass} value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value as TeamRole }))}>
              <option value="sdr">SDR</option>
              <option value="closer">Closer</option>
              <option value="gestor">Gestor</option>
            </select>
            <button onClick={handleAdd} disabled={!form.name || !form.email} className="px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm">Adicionar</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {ativos.map(member => (
          <div key={member.id} className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-sm">
                {member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-white">{member.name}</p>
                <p className="text-xs text-[var(--color-v4-text-muted)]">{member.email}</p>
              </div>
              <span className={`text-xs px-2 py-1 rounded ${
                member.role === 'gestor' ? 'bg-purple-500/20 text-purple-400' :
                member.role === 'closer' ? 'bg-blue-500/20 text-blue-400' :
                'bg-green-500/20 text-green-400'
              }`}>
                {ROLE_LABELS[member.role]}
              </span>
            </div>
            <button
              onClick={() => updateMember(member.id, { active: false })}
              className="flex items-center gap-1 text-xs text-[var(--color-v4-text-muted)] hover:text-red-400 transition-colors"
            >
              <UserX size={12} /> Desativar
            </button>
          </div>
        ))}
      </div>

      {inativos.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mt-8 mb-3">Inativos ({inativos.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {inativos.map(member => (
              <div key={member.id} className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 opacity-50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[var(--color-v4-surface)] flex items-center justify-center text-[var(--color-v4-text-muted)] font-bold text-sm">
                    {member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-[var(--color-v4-text-muted)]">{member.name}</p>
                    <p className="text-xs text-[var(--color-v4-text-disabled)]">{ROLE_LABELS[member.role]}</p>
                  </div>
                  <button onClick={() => updateMember(member.id, { active: true })} className="text-xs text-green-400 hover:text-green-300 flex items-center gap-1">
                    <UserCheck size={12} /> Reativar
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
