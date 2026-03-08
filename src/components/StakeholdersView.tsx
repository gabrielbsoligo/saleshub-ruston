import React, { useState } from "react";
import { useAppStore } from "../store";
import { Contact, Search, Plus, Edit2, Trash2 } from "lucide-react";

export const StakeholdersView: React.FC = () => {
  const { stakeholders, projects, currentUser } = useAppStore();
  const [searchTerm, setSearchTerm] = useState("");

  const filteredStakeholders = stakeholders.filter(
    (s) =>
      s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.email && s.email.toLowerCase().includes(searchTerm.toLowerCase())),
  );

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--color-v4-bg)] p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-2xl font-display font-bold text-white">
              Stakeholders
            </h2>
            <p className="text-sm text-[var(--color-v4-text-muted)]">
              Contatos dos clientes.
            </p>
          </div>

          {(currentUser?.role === "owner" ||
            currentUser?.role === "coord_geral" ||
            currentUser?.role === "coord_equipe") && (
            <button className="flex items-center gap-2 px-4 py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors">
              <Plus size={18} />
              Novo Contato
            </button>
          )}
        </div>

        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-[var(--color-v4-border)] flex items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]"
                size={18}
              />
              <input
                type="text"
                placeholder="Buscar por nome ou email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] focus:border-transparent transition-all"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--color-v4-text-muted)]">
              <thead className="text-xs uppercase bg-slate-900/50 border-b border-[var(--color-v4-border)]">
                <tr>
                  <th className="px-6 py-4 font-semibold">Nome</th>
                  <th className="px-6 py-4 font-semibold">Função</th>
                  <th className="px-6 py-4 font-semibold">Email</th>
                  <th className="px-6 py-4 font-semibold">Telefone</th>
                  <th className="px-6 py-4 font-semibold">Projeto</th>
                  <th className="px-6 py-4 font-semibold text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-v4-border)]">
                {filteredStakeholders.map((stakeholder) => {
                  const project = projects.find(
                    (p) => p.id === stakeholder.projectId,
                  );
                  return (
                    <tr
                      key={stakeholder.id}
                      className="hover:bg-slate-800/30 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-white">
                        {stakeholder.name}
                      </td>
                      <td className="px-6 py-4">{stakeholder.role || "—"}</td>
                      <td className="px-6 py-4">{stakeholder.email || "—"}</td>
                      <td className="px-6 py-4 font-mono text-xs">
                        {stakeholder.phone || "—"}
                      </td>
                      <td className="px-6 py-4">
                        {project ? (
                          <span className="px-2.5 py-1 rounded-full bg-slate-800 border border-[var(--color-v4-border)] text-xs text-slate-300">
                            {project.name}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors">
                            <Edit2 size={16} />
                          </button>
                          <button className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-md transition-colors">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {filteredStakeholders.length === 0 && (
              <div className="p-12 text-center">
                <Contact className="mx-auto h-12 w-12 text-slate-600 mb-3" />
                <p className="text-slate-400">Nenhum stakeholder encontrado.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
