import React, { useState, useMemo } from "react";
import { useAppStore } from "../store";
import { Stage, Project } from "../types";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Clock,
  MoreVertical,
  CheckCircle2,
  AlertCircle,
  Link as LinkIcon,
} from "lucide-react";
import { cn } from "./Layout";

const STAGES: { id: Stage; title: string; role: string }[] = [
  {
    id: "aguardando_comercial",
    title: "Aguardando Comercial",
    role: "comercial",
  },
  {
    id: "atribuir_coordenador",
    title: "Atribuir Coordenador",
    role: "coord_geral",
  },
  { id: "atribuir_equipe", title: "Atribuir Equipe", role: "coord_equipe" },
  { id: "criar_workspace", title: "Criar Workspace", role: "coord_equipe" },
  { id: "boas_vindas", title: "Boas-vindas", role: "coord_equipe" },
  { id: "kickoff", title: "Kickoff", role: "—" },
  { id: "planejamento", title: "Planejamento", role: "—" },
  { id: "ongoing", title: "Ongoing", role: "—" },
];

const getTimeStatus = (updatedAt: string) => {
  const diffHours =
    (new Date().getTime() - new Date(updatedAt).getTime()) / (1000 * 60 * 60);
  if (diffHours < 24) return "green";
  if (diffHours < 48) return "yellow";
  return "red";
};

const ProjectCard: React.FC<{
  project: Project;
  index: number;
  onClick: () => void;
}> = ({ project, index, onClick }) => {
  const { members } = useAppStore();
  const coordinator = members.find(
    (m) => m.id === project.assignedCoordinatorId,
  );
  const timeStatus = getTimeStatus(project.updatedAt);

  return (
    <div
      onClick={onClick}
      className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] p-4 rounded-xl shadow-sm mb-3 cursor-pointer transition-all hover:border-[var(--color-v4-text-muted)]"
    >
      <div className="flex justify-between items-start mb-2">
        <h3 className="font-medium text-white text-sm leading-tight line-clamp-2">
          {project.name}
        </h3>
        <div
          className={cn(
            "w-2 h-2 rounded-full mt-1 flex-shrink-0",
            timeStatus === "green"
              ? "bg-[var(--color-v4-success)]"
              : timeStatus === "yellow"
                ? "bg-[var(--color-v4-warning)]"
                : "bg-[var(--color-v4-error)]",
          )}
        />
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        {project.product?.map(p => (
          <span key={p} className="px-1.5 py-0.5 rounded bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[9px] font-semibold tracking-wider text-[var(--color-v4-text-muted)]">
            {p === 'ee' ? 'EE' : 'Byline'}
          </span>
        ))}
      </div>

      <div className="text-xs text-[var(--color-v4-text-muted)] mb-3 space-y-1">
        <p className="truncate">{project.clientName}</p>
        <p className="font-mono text-[10px] bg-[var(--color-v4-surface)] px-1.5 py-0.5 rounded inline-block">
          R${" "}
          {project.contractValue?.toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
          })}
        </p>
      </div>

      <div className="flex items-center justify-between mt-auto pt-3 border-t border-[var(--color-v4-border)]">
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-v4-text-muted)]">
          <Clock size={12} />
          <span className="truncate max-w-[80px]">
            {formatDistanceToNow(new Date(project.updatedAt), {
              locale: ptBR,
              addSuffix: true,
            })}
          </span>
        </div>

        {coordinator ? (
          <img
            src={coordinator.avatarUrl}
            alt={coordinator.name}
            title={coordinator.name}
            className="w-6 h-6 rounded-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)]"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-[var(--color-v4-surface)] border border-dashed border-[var(--color-v4-border)] flex items-center justify-center text-[10px] text-[var(--color-v4-text-disabled)]">
            ?
          </div>
        )}
      </div>
    </div>
  );
};

export const KanbanBoard: React.FC<{
  onProjectClick: (p: Project) => void;
}> = ({ onProjectClick }) => {
  const { projects, currentUser } = useAppStore();

  const filteredProjects = useMemo(() => {
    if (!currentUser) return [];
    if (currentUser.role === "owner" || currentUser.role === "admin" || currentUser.role === "coord_geral")
      return projects;
    if (currentUser.role === "comercial")
      return projects.filter(
        (p) =>
          p.stage === "aguardando_comercial" &&
          p.soldById === currentUser.id,
      );
    if (currentUser.role === "coord_equipe")
      return projects.filter(
        (p) =>
          p.assignedCoordinatorId === currentUser.id ||
          p.stage === "atribuir_equipe",
      );
    return [];
  }, [projects, currentUser]);

  return (
    <div className="flex-1 h-full overflow-x-auto overflow-y-hidden bg-[var(--color-v4-bg)] p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-display font-bold text-white">
          Jornada do Cliente
        </h2>
        <p className="text-sm text-[var(--color-v4-text-muted)]">
          Clique nos cards para visualizar e avançar as etapas.
        </p>
      </div>

      <div className="flex h-[calc(100%-80px)] gap-6 pb-4">
        {STAGES.map((stage) => {
          const stageProjects = filteredProjects.filter(
            (p) => p.stage === stage.id,
          );

          return (
            <div key={stage.id} className="flex flex-col w-80 flex-shrink-0">
              <div className="flex items-center justify-between mb-3 px-1">
                <h3 className="font-medium text-sm text-[var(--color-v4-text-muted)] uppercase tracking-wider">
                  {stage.title}
                </h3>
                <span className="bg-[var(--color-v4-card)] text-xs text-[var(--color-v4-text-muted)] px-2 py-0.5 rounded-full border border-[var(--color-v4-border)]">
                  {stageProjects.length}
                </span>
              </div>

              <div
                className="flex-1 bg-black/20 rounded-2xl p-3 border border-dashed transition-colors overflow-y-auto border-[var(--color-v4-border)]"
              >
                {stageProjects.map((project, index) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    index={index}
                    onClick={() => onProjectClick(project)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
