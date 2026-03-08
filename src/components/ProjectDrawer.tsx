import React, { useState } from "react";
import { useAppStore } from "../store";
import { Project, Member, Stage } from "../types";
import {
  X,
  Save,
  Send,
  CheckCircle2,
  AlertCircle,
  Link as LinkIcon,
  Users,
  Calendar,
  DollarSign,
  Building2,
  Phone,
  Mail,
} from "lucide-react";
import { cn } from "./Layout";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export const ProjectDrawer: React.FC<{
  project: Project | null;
  onClose: () => void;
}> = ({ project, onClose }) => {
  const {
    members,
    updateProject,
    moveProject,
    addLog,
    currentUser,
    addProjectMember,
    removeProjectMember,
    projectMembers,
  } = useAppStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editedProject, setEditedProject] = useState<Project | null>(project);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [nextStage, setNextStage] = useState<Stage | null>(null);

  // Team Selection State
  const [teamSelection, setTeamSelection] = useState(() => {
    const currentTeam = projectMembers.filter(
      (pm) => pm.projectId === project?.id,
    );
    return {
      account:
        currentTeam.find((pm) => pm.roleInProject === "account")?.memberId ||
        "",
      gestor_projetos:
        currentTeam.find((pm) => pm.roleInProject === "gestor_projetos")
          ?.memberId || "",
      designer:
        currentTeam.find((pm) => pm.roleInProject === "designer")?.memberId ||
        "",
      gestor_trafego:
        currentTeam.find((pm) => pm.roleInProject === "gestor_trafego")
          ?.memberId || "",
      copywriter:
        currentTeam.find((pm) => pm.roleInProject === "copywriter")?.memberId ||
        "",
    };
  });

  if (!project || !editedProject) return null;

  const handleSave = () => {
    updateProject(project.id, editedProject);
    setIsEditing(false);
  };

  const confirmAdvance = (stage: Stage) => {
    setNextStage(stage);
    setShowConfirmModal(true);
  };

  const handleAdvance = () => {
    if (nextStage) {
      if (project.stage === "atribuir_equipe") {
        // Remove old team members for this project
        const currentTeam = projectMembers.filter(
          (pm) => pm.projectId === project.id,
        );
        currentTeam.forEach((pm) => removeProjectMember(pm.id));

        // Save new team selection
        const roles: { [key: string]: string } = {
          account: teamSelection.account,
          gestor_projetos: teamSelection.gestor_projetos,
          designer: teamSelection.designer,
          gestor_trafego: teamSelection.gestor_trafego,
          copywriter: teamSelection.copywriter,
        };

        Object.entries(roles).forEach(([role, memberId]) => {
          if (memberId) {
            addProjectMember({
              id: Math.random().toString(36).substring(7),
              projectId: project.id,
              memberId,
              roleInProject: role as any,
            });
          }
        });
      }
      moveProject(project.id, nextStage);
      setShowConfirmModal(false);
      onClose();
    }
  };

  const handleSendWelcome = () => {
    updateProject(project.id, { welcomeSent: true });
    addLog({
      id: Math.random().toString(36).substring(7),
      projectId: project.id,
      action: "welcome_sent",
      performedBy: currentUser?.id,
      createdAt: new Date().toISOString(),
    });
    confirmAdvance("kickoff");
  };

  const renderStageActions = () => {
    switch (project.stage) {
      case "aguardando_comercial":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <button
              onClick={() => confirmAdvance("atribuir_coordenador")}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
            >
              Confirmar e Avançar
            </button>
          </div>
        );
      case "atribuir_coordenador":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)] space-y-4">
            <div>
              <label className="block text-sm text-[var(--color-v4-text-muted)] mb-2">
                Coordenador de Equipe
              </label>
              <select
                value={editedProject.assignedCoordinatorId || ""}
                onChange={(e) =>
                  setEditedProject({
                    ...editedProject,
                    assignedCoordinatorId: e.target.value,
                  })
                }
                className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2.5 text-white focus:ring-2 focus:ring-[var(--color-v4-red)]"
              >
                <option value="">Selecione...</option>
                {members
                  .filter((m) => m.role === "coord_equipe")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </div>
            <button
              onClick={() => {
                handleSave();
                confirmAdvance("atribuir_equipe");
              }}
              disabled={!editedProject.assignedCoordinatorId}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white rounded-xl font-medium transition-colors"
            >
              Salvar e Avançar
            </button>
          </div>
        );
      case "atribuir_equipe":
        const isTeamValid =
          teamSelection.account !== "" && teamSelection.gestor_projetos !== "";

        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <button
              onClick={() => confirmAdvance("criar_workspace")}
              disabled={!isTeamValid}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-colors"
            >
              Equipe Definida — Avançar
            </button>
          </div>
        );
      case "criar_workspace":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)] space-y-3">
            <button
              onClick={() => {
                // Mock webhook calls
                setTimeout(() => {
                  updateProject(project.id, {
                    gchatSpaceId: "spaces/mock123",
                    wppGroupId: "mock@g.us",
                    gdriveFolderId: "folder_mock",
                    gdriveFolderLink: "https://drive.google.com/mock",
                    ekyteId: "ekyte_mock",
                  });
                  confirmAdvance("boas_vindas");
                }, 1500);
              }}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Building2 size={18} />
              Criar Ambientes (Automático)
            </button>
          </div>
        );
      case "boas_vindas":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <button
              onClick={handleSendWelcome}
              disabled={project.welcomeSent}
              className="w-full py-3 bg-[var(--color-v4-success)] hover:bg-emerald-700 disabled:bg-[var(--color-v4-surface)] disabled:text-[var(--color-v4-text-disabled)] text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              {project.welcomeSent ? (
                <CheckCircle2 size={18} />
              ) : (
                <Send size={18} />
              )}
              {project.welcomeSent
                ? "Boas-vindas enviadas ✓"
                : "Enviar Boas-Vindas"}
            </button>
          </div>
        );
      case "kickoff":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <button
              onClick={() => confirmAdvance("planejamento")}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
            >
              Iniciar Planejamento
            </button>
          </div>
        );
      case "planejamento":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <button
              onClick={() => confirmAdvance("ongoing")}
              className="w-full py-3 bg-[var(--color-v4-success)] hover:bg-emerald-700 text-white rounded-xl font-medium transition-colors"
            >
              Concluir Planejamento
            </button>
          </div>
        );
      case "ongoing":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <div className="w-full py-3 bg-[var(--color-v4-surface)] text-[var(--color-v4-text-disabled)] rounded-xl font-medium text-center flex items-center justify-center gap-2">
              <CheckCircle2 size={18} />
              Projeto em Andamento
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
        onClick={onClose}
      />
      <div className="fixed inset-y-0 right-0 w-full max-w-md bg-[var(--color-v4-bg)] border-l border-[var(--color-v4-border)] shadow-2xl z-50 flex flex-col transform transition-transform duration-300 ease-in-out">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-[var(--color-v4-border)] bg-[var(--color-v4-card)]">
          <div>
            <h2 className="text-xl font-display font-bold text-white mb-1">
              {project.name}
            </h2>
            <div className="flex items-center gap-2 text-sm text-[var(--color-v4-text-muted)]">
              <span className="px-2 py-0.5 rounded bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] uppercase text-[10px] font-semibold tracking-wider">
                {project.stage.replace("_", " ")}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-[var(--color-v4-surface)] rounded-full text-[var(--color-v4-text-muted)] hover:text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Client Info */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} /> Dados do Cliente
              </h3>
              {currentUser?.role === "owner" ||
              currentUser?.role === "comercial" ||
              currentUser?.role === "coord_geral" ? (
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className="text-xs text-[var(--color-v4-red)] hover:underline"
                >
                  {isEditing ? "Cancelar" : "Editar"}
                </button>
              ) : null}
            </div>

            <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4 space-y-4">
              {isEditing ? (
                <>
                  <div>
                    <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                      Nome do Cliente
                    </label>
                    <input
                      type="text"
                      value={editedProject.clientName}
                      onChange={(e) =>
                        setEditedProject({
                          ...editedProject,
                          clientName: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border-strong)] rounded p-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                      Telefone
                    </label>
                    <input
                      type="text"
                      value={editedProject.clientPhone || ""}
                      onChange={(e) =>
                        setEditedProject({
                          ...editedProject,
                          clientPhone: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border-strong)] rounded p-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                      Produto
                    </label>
                    <input
                      type="text"
                      value={editedProject.product || ""}
                      onChange={(e) =>
                        setEditedProject({
                          ...editedProject,
                          product: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border-strong)] rounded p-2 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                      Valor (R$)
                    </label>
                    <input
                      type="number"
                      value={editedProject.contractValue || 0}
                      onChange={(e) =>
                        setEditedProject({
                          ...editedProject,
                          contractValue: Number(e.target.value),
                        })
                      }
                      className="w-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border-strong)] rounded p-2 text-sm text-white"
                    />
                  </div>
                  <button
                    onClick={handleSave}
                    className="w-full py-2 bg-[var(--color-v4-red)] text-white rounded text-sm font-medium"
                  >
                    Salvar Alterações
                  </button>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Empresa</p>
                      <p className="text-sm font-medium text-white">
                        {project.clientName}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Telefone</p>
                      <p className="text-sm font-medium text-white">
                        {project.clientPhone || "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Produto</p>
                      <p className="text-sm font-medium text-white">
                        {project.product || "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Valor</p>
                      <p className="text-sm font-medium text-white font-mono">
                        R${" "}
                        {project.contractValue?.toLocaleString("pt-BR", {
                          minimumFractionDigits: 2,
                        }) || "0,00"}
                      </p>
                    </div>
                  </div>
                  {project.kommoLink && (
                    <div className="pt-3 border-t border-[var(--color-v4-border-strong)]">
                      <a
                        href={project.kommoLink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                      >
                        <LinkIcon size={12} /> Ver no Kommo
                      </a>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Equipe (Only show if stage is atribuir_equipe or later) */}
          {["atribuir_equipe", "criar_workspace", "boas_vindas", "kickoff", "planejamento", "ongoing"].includes(project.stage) && (
            <section>
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
                <Users size={16} /> Atribuir Equipe
              </h3>
              <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4 space-y-4">
                {/* Account Manager (Obrigatório) */}
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                    Account Manager <span className="text-[var(--color-v4-red)]">*</span>
                  </label>
                  <select
                    value={teamSelection.account}
                    onChange={(e) =>
                      setTeamSelection({ ...teamSelection, account: e.target.value })
                    }
                    className={cn(
                      "w-full bg-[var(--color-v4-bg)] border rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]",
                      !teamSelection.account ? "border-[var(--color-v4-red)]" : "border-[var(--color-v4-border)]"
                    )}
                  >
                    <option value="">Selecione...</option>
                    {members
                      .filter((m) => m.role === "account" && m.isActive)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </div>

                {/* Gestor de Projetos (Obrigatório) */}
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                    Gestor de Projetos <span className="text-[var(--color-v4-red)]">*</span>
                  </label>
                  <select
                    value={teamSelection.gestor_projetos}
                    onChange={(e) =>
                      setTeamSelection({ ...teamSelection, gestor_projetos: e.target.value })
                    }
                    className={cn(
                      "w-full bg-[var(--color-v4-bg)] border rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]",
                      !teamSelection.gestor_projetos ? "border-[var(--color-v4-red)]" : "border-[var(--color-v4-border)]"
                    )}
                  >
                    <option value="">Selecione...</option>
                    {members
                      .filter((m) => m.role === "gestor_projetos" && m.isActive)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </div>

                {/* Designer (Opcional) */}
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                    Designer
                  </label>
                  <select
                    value={teamSelection.designer}
                    onChange={(e) =>
                      setTeamSelection({ ...teamSelection, designer: e.target.value })
                    }
                    className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  >
                    <option value="">Selecione...</option>
                    {members
                      .filter((m) => m.role === "designer" && m.isActive)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </div>

                {/* Gestor de Tráfego (Opcional) */}
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                    Gestor de Tráfego
                  </label>
                  <select
                    value={teamSelection.gestor_trafego}
                    onChange={(e) =>
                      setTeamSelection({ ...teamSelection, gestor_trafego: e.target.value })
                    }
                    className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  >
                    <option value="">Selecione...</option>
                    {members
                      .filter((m) => m.role === "gestor_trafego" && m.isActive)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </div>

                {/* Copywriter (Opcional) */}
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">
                    Copywriter
                  </label>
                  <select
                    value={teamSelection.copywriter}
                    onChange={(e) =>
                      setTeamSelection({ ...teamSelection, copywriter: e.target.value })
                    }
                    className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]"
                  >
                    <option value="">Selecione...</option>
                    {members
                      .filter((m) => m.role === "copywriter" && m.isActive)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            </section>
          )}

          {/* Ambientes */}
          <section>
            <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
              <LinkIcon size={16} /> Ambientes
            </h3>
            <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4 space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--color-v4-text-muted)]">Google Chat</span>
                {project.gchatSpaceId ? (
                  <span className="text-[var(--color-v4-success)] flex items-center gap-1">
                    <CheckCircle2 size={14} /> Criado
                  </span>
                ) : (
                  <span className="text-[var(--color-v4-text-disabled)]">Pendente</span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--color-v4-text-muted)]">WhatsApp Group</span>
                {project.wppGroupId ? (
                  <span className="text-[var(--color-v4-success)] flex items-center gap-1">
                    <CheckCircle2 size={14} /> Criado
                  </span>
                ) : (
                  <span className="text-[var(--color-v4-text-disabled)]">Pendente</span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--color-v4-text-muted)]">Google Drive</span>
                {project.gdriveFolderLink ? (
                  <a
                    href={project.gdriveFolderLink}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:underline flex items-center gap-1"
                  >
                    Acessar <LinkIcon size={12} />
                  </a>
                ) : (
                  <span className="text-[var(--color-v4-text-disabled)]">Pendente</span>
                )}
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-[var(--color-v4-text-muted)]">Ekyte Workspace</span>
                {project.ekyteId ? (
                  <span className="text-[var(--color-v4-success)] flex items-center gap-1">
                    <CheckCircle2 size={14} /> Criado
                  </span>
                ) : (
                  <span className="text-[var(--color-v4-text-disabled)]">Pendente</span>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Footer Actions */}
        {renderStageActions()}
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-display font-bold text-white mb-2">
              Confirmar Avanço
            </h3>
            <p className="text-[var(--color-v4-text-muted)] text-sm mb-6">
              Tem certeza que deseja avançar para a etapa{" "}
              <span className="font-semibold text-white">
                {nextStage?.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())}
              </span>
              ?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-2.5 bg-[var(--color-v4-surface)] hover:bg-[var(--color-v4-border)] text-white rounded-xl font-medium transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleAdvance}
                className="flex-1 py-2.5 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
