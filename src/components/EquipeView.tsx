import React, { useState } from "react";
import { useAppStore } from "../store";
import { ROLE_LABELS, type TeamRole, type TeamMember } from "../types";
import { Plus, Search, Phone, Mail, Calendar } from "lucide-react";
import { MemberDrawer } from "./MemberDrawer";

export const EquipeView: React.FC = () => {
  const { members, addMember, currentUser } = useAppStore();
  const isGestor = currentUser?.role === "gestor";

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "sdr" as TeamRole, ramal_4com: "" });
  const [search, setSearch] = useState("");
  const [showInativos, setShowInativos] = useState(false);
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);

  const handleAdd = async () => {
    if (!form.name || !form.email) return;
    await addMember({
      name: form.name,
      email: form.email,
      role: form.role,
      ramal_4com: form.ramal_4com.trim() || undefined,
    });
    setForm({ name: "", email: "", role: "sdr", ramal_4com: "" });
    setShowForm(false);
  };

  const inputClass =
    "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  const filtered = members.filter((m) => {
    if (!showInativos && !m.active) return false;
    if (showInativos && m.active) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        m.name.toLowerCase().includes(s) ||
        m.email.toLowerCase().includes(s) ||
        (m.ramal_4com || "").includes(s)
      );
    }
    return true;
  });

  const ativos = members.filter((m) => m.active).length;
  const inativos = members.filter((m) => !m.active).length;
  const semRamal = members.filter((m) => m.active && !m.ramal_4com).length;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h2 className="text-2xl font-display font-bold text-white">
          Equipe <span className="text-[var(--color-v4-text-muted)] text-lg font-normal">({ativos} ativos)</span>
        </h2>
        {isGestor && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm"
          >
            <Plus size={16} /> Novo Membro
          </button>
        )}
      </div>

      {/* Filtros + alertas */}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <div className="relative flex-1 min-w-[220px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input
            type="text"
            placeholder="Buscar nome / email / ramal…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]"
          />
        </div>
        <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
          <button
            onClick={() => setShowInativos(false)}
            className={`px-3 py-1.5 rounded text-xs ${!showInativos ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)]"}`}
          >
            Ativos ({ativos})
          </button>
          <button
            onClick={() => setShowInativos(true)}
            className={`px-3 py-1.5 rounded text-xs ${showInativos ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)]"}`}
          >
            Inativos ({inativos})
          </button>
        </div>
        {semRamal > 0 && !showInativos && (
          <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 px-3 py-1.5 rounded-lg">
            ⚠ {semRamal} ativo(s) sem ramal — ligações não atribuídas
          </div>
        )}
      </div>

      {/* Form de novo membro */}
      {showForm && isGestor && (
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-6">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
            <input
              className={inputClass}
              placeholder="Nome *"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
            <input
              className={inputClass}
              placeholder="Email *"
              type="email"
              value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
            />
            <select
              className={inputClass}
              value={form.role}
              onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as TeamRole }))}
            >
              <option value="sdr">SDR</option>
              <option value="closer">Closer</option>
              <option value="gestor">Gestor</option>
              <option value="financeiro">Financeiro</option>
            </select>
            <input
              className={inputClass}
              placeholder="Ramal 4com"
              value={form.ramal_4com}
              onChange={(e) => setForm((p) => ({ ...p, ramal_4com: e.target.value }))}
            />
            <button
              onClick={handleAdd}
              disabled={!form.name || !form.email}
              className="px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm"
            >
              Adicionar
            </button>
          </div>
        </div>
      )}

      {/* Cards de membros */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((member) => {
          const semRamal = !member.ramal_4com;
          return (
            <button
              key={member.id}
              onClick={() => setSelectedMember(member)}
              className={`text-left bg-[var(--color-v4-card)] border rounded-xl p-4 transition-colors ${
                member.active
                  ? "border-[var(--color-v4-border)] hover:border-[var(--color-v4-border-strong)]"
                  : "border-[var(--color-v4-border)] opacity-60"
              }`}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
                  {member.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{member.name}</p>
                  <p className="text-xs text-[var(--color-v4-text-muted)] truncate">{member.email}</p>
                </div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded ${
                    member.role === "gestor"
                      ? "bg-purple-500/20 text-purple-400"
                      : member.role === "closer"
                      ? "bg-blue-500/20 text-blue-400"
                      : member.role === "financeiro"
                      ? "bg-orange-500/20 text-orange-400"
                      : "bg-green-500/20 text-green-400"
                  }`}
                >
                  {ROLE_LABELS[member.role]}
                </span>
              </div>

              <div className="flex flex-wrap gap-2 text-[10px]">
                <span
                  className={`flex items-center gap-1 px-2 py-1 rounded ${
                    member.ramal_4com
                      ? "bg-[var(--color-v4-bg)] text-[var(--color-v4-text-muted)]"
                      : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                  }`}
                >
                  <Phone size={10} />
                  {member.ramal_4com || "sem ramal"}
                </span>
                {member.google_calendar_connected && (
                  <span className="flex items-center gap-1 px-2 py-1 rounded bg-green-500/10 text-green-400">
                    <Calendar size={10} /> Calendar
                  </span>
                )}
                {member.kommo_user_id && (
                  <span className="flex items-center gap-1 px-2 py-1 rounded bg-purple-500/10 text-purple-400">
                    <Mail size={10} /> Kommo {member.kommo_user_id}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <p className="text-center py-12 text-sm text-[var(--color-v4-text-muted)]">
          Nenhum membro encontrado
        </p>
      )}

      {/* Drawer de edição */}
      <MemberDrawer member={selectedMember} onClose={() => setSelectedMember(null)} />
    </div>
  );
};
