import React, { useState } from "react";
import { useAppStore } from "../store";
import { FolderKanban, Search, Filter, Plus } from "lucide-react";
import { cn } from "./Layout";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CreateProjectDrawer } from "./CreateProjectDrawer";

export const ProjectsView: React.FC<{ onProjectClick: (p: any) => void }> = ({
  onProjectClick,
}) => {
  const { projects, members, currentUser } = useAppStore();
  const [searchTerm, setSearchTerm] = useState("");
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.clientName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.soldBy?.name || "").toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <>
      <div className="flex-1 h-full overflow-y-auto bg-[var(--color-v4-bg)] p-6">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h2 className="text-2xl font-display font-bold text-white">
                Projetos
              </h2>
              <p className="text-sm text-[var(--color-v4-text-muted)]">
                Lista completa de clientes em onboarding.
              </p>
            </div>
            {(currentUser?.role === "owner" || currentUser?.role === "admin" || currentUser?.role === "coord_geral") && (
              <button
                onClick={() => setIsCreatingProject(true)}
                className="px-4 py-2 border border-[var(--color-v4-border)] hover:bg-[var(--color-v4-surface)] text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                <Plus size={16} />
                Novo Projeto
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
                placeholder="Buscar projeto ou cliente..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] focus:border-transparent transition-all"
              />
            </div>
            <button className="flex items-center gap-2 px-3 py-2 bg-slate-800 border border-[var(--color-v4-border)] hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Filter size={16} />
              Filtros
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--color-v4-text-muted)]">
              <thead className="text-xs uppercase bg-slate-900/50 border-b border-[var(--color-v4-border)]">
                <tr>
                  <th className="px-6 py-4 font-semibold">Projeto</th>
                  <th className="px-6 py-4 font-semibold">Cliente</th>
                  <th className="px-6 py-4 font-semibold">Produto</th>
                  <th className="px-6 py-4 font-semibold">Valor</th>
                  <th className="px-6 py-4 font-semibold">Vendedor</th>
                  <th className="px-6 py-4 font-semibold">Estágio</th>
                  <th className="px-6 py-4 font-semibold">Coordenador</th>
                  <th className="px-6 py-4 font-semibold">Início</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-v4-border)]">
                {filteredProjects.map((project) => {
                  const coord = members.find(
                    (m) => m.id === project.assignedCoordinatorId,
                  );
                  return (
                    <tr
                      key={project.id}
                      onClick={() => onProjectClick(project)}
                      className="hover:bg-slate-800/30 transition-colors cursor-pointer"
                    >
                      <td className="px-6 py-4 font-medium text-white">
                        {project.name}
                      </td>
                      <td className="px-6 py-4">{project.clientName}</td>
                      <td className="px-6 py-4">
                        {([...(project.produtosEscopo || []), ...(project.produtosRecorrente || [])]).length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {[...(project.produtosEscopo || []), ...(project.produtosRecorrente || [])].map((p, i) => (
                              <span key={i} className="px-2 py-0.5 rounded bg-slate-800 border border-[var(--color-v4-border)] text-[10px] font-semibold tracking-wider text-slate-300">
                                {p === 'ee' ? 'EE' : p === 'byline' ? 'Byline' : p}
                              </span>
                            ))}
                          </div>
                        ) : "—"}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs">
                        R${" "}
                        {((project.valorEscopo || 0) + (project.valorRecorrente || 0)).toLocaleString("pt-BR", {
                          minimumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-6 py-4">
                        {project.soldBy ? (
                          <div className="flex items-center gap-2">
                            <div className="w-5 h-5 rounded-full bg-[var(--color-v4-red)]/20 border border-[var(--color-v4-red)]/30 flex items-center justify-center text-[10px] font-bold text-[var(--color-v4-red)] uppercase">
                              {project.soldBy.name?.charAt(0) || "U"}
                            </div>
                            <span className="text-xs font-medium text-slate-300">{project.soldBy.name}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className="px-2.5 py-1 rounded-full bg-slate-800 border border-[var(--color-v4-border)] text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                          {project.stage.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {coord ? (
                          <div className="flex items-center gap-2">
                            <img
                              src={coord.avatarUrl}
                              alt={coord.name}
                              className="w-6 h-6 rounded-full bg-slate-800"
                            />
                            <span className="text-xs">{coord.name}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-xs">
                        {project.projectStartDate
                          ? format(
                              new Date(project.projectStartDate),
                              "dd/MM/yyyy",
                              { locale: ptBR },
                            )
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {filteredProjects.length === 0 && (
              <div className="p-12 text-center">
                <FolderKanban className="mx-auto h-12 w-12 text-slate-600 mb-3" />
                <p className="text-slate-400">Nenhum projeto encontrado.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    
    {isCreatingProject && (
      <CreateProjectDrawer onClose={() => setIsCreatingProject(false)} />
    )}
  </>
  );
};
