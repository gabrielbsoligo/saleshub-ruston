import React, { useState, useEffect } from "react";
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
  Plus,
  Trash2,
  Loader2,
  XCircle,
  CircleDashed,
  Edit2
} from "lucide-react";
import { cn } from "./Layout";
import toast from "react-hot-toast";
import { supabase } from "../lib/supabase";
import { 
  notifyWhatsApp, 
  createGChatSpace, 
  createWppGroup, 
  createDriveFolders, 
  createEkyteWorkspace, 
  sendWelcomeSequence 
} from "../lib/webhooks";

const PRODUCT_OPTIONS = [
  { id: "ee", label: "Estruturação Estratégica (EE)" },
  { id: "byline", label: "Byline" },
];

export const ProjectDrawer: React.FC<{
  project: Project | null;
  onClose: () => void;
}> = ({ project: initialProject, onClose }) => {
  const {
    projects,
    members,
    updateProject,
    moveProject,
    addLog,
    currentUser,
    addProjectMember,
    removeProjectMember,
    projectMembers,
  } = useAppStore();

  const project = initialProject ? projects.find(p => p.id === initialProject.id) || initialProject : null;

  const [isEditingClient, setIsEditingClient] = useState(false);
  const [isEditingCoordinator, setIsEditingCoordinator] = useState(false);
  const [isEditingTeam, setIsEditingTeam] = useState(false);
  const [editedProject, setEditedProject] = useState<Project | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [nextStage, setNextStage] = useState<Stage | null>(null);
  
  // Link states
  const [newLink, setNewLink] = useState("");

  // Async Workspace creation states
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);

  // Team Selection State
  const [teamSelection, setTeamSelection] = useState({
    gestor_projetos: "",
    designer: "",
    gestor_trafego: "",
    copywriter: "",
  });

  useEffect(() => {
    if (project) {
      setEditedProject(project);
      
      const currentTeam = projectMembers.filter((pm) => pm.projectId === project.id);
      setTeamSelection({
        gestor_projetos: currentTeam.find((pm) => pm.roleInProject === "gestor_projetos")?.memberId || "",
        designer: currentTeam.find((pm) => pm.roleInProject === "designer")?.memberId || "",
        gestor_trafego: currentTeam.find((pm) => pm.roleInProject === "gestor_trafego")?.memberId || "",
        copywriter: currentTeam.find((pm) => pm.roleInProject === "copywriter")?.memberId || "",
      });

      setIsCreatingWorkspace(false);
    }
  }, [project, projectMembers]);

  const canEditAnyStage = ["owner", "admin", "coord_geral"].includes(currentUser?.role || "");

  if (!project || !editedProject) return null;

  const handleSaveProjectInfo = () => {
    updateProject(project.id, {
      clientName: editedProject.clientName,
      clientPhone: editedProject.clientPhone,
      meetingLinks: editedProject.meetingLinks,
      produtosEscopo: editedProject.produtosEscopo,
      valorEscopo: editedProject.valorEscopo,
      dataInicioEscopo: editedProject.dataInicioEscopo,
      dataPgtoEscopo: editedProject.dataPgtoEscopo,
      produtosRecorrente: editedProject.produtosRecorrente,
      valorRecorrente: editedProject.valorRecorrente,
      dataInicioRecorrente: editedProject.dataInicioRecorrente,
      dataPgtoRecorrente: editedProject.dataPgtoRecorrente,
      linkCallVendas: editedProject.linkCallVendas,
      linkTranscricao: editedProject.linkTranscricao,
      observacoes: editedProject.observacoes,
      contractUrl: editedProject.contractUrl,
    });
    setIsEditingClient(false);
    toast.success("Informações do projeto atualizadas!");
  };

  const handleAddLink = () => {
    if (!newLink) return;
    const currentLinks = editedProject.meetingLinks || [];
    setEditedProject({
      ...editedProject,
      meetingLinks: [...currentLinks, newLink],
    });
    setNewLink("");
  };

  const handleRemoveLink = (index: number) => {
    const currentLinks = editedProject.meetingLinks || [];
    setEditedProject({
      ...editedProject,
      meetingLinks: currentLinks.filter((_, i) => i !== index),
    });
  };

  const getMemberName = (id: string | null | undefined) => {
    if (!id) return "— não atribuído";
    const member = members.find(m => m.id === id);
    return member ? member.name : "— não atribuído";
  };

  const getAssignedTeamObject = () => {
    const currentTeam = projectMembers.filter(pm => pm.projectId === project.id);
    return {
      gestor_projetos: currentTeam.find((pm) => pm.roleInProject === "gestor_projetos")?.memberId || null,
      designer: currentTeam.find((pm) => pm.roleInProject === "designer")?.memberId || null,
      gestor_trafego: currentTeam.find((pm) => pm.roleInProject === "gestor_trafego")?.memberId || null,
      copywriter: currentTeam.find((pm) => pm.roleInProject === "copywriter")?.memberId || null,
    };
  };

  const confirmAdvance = (stage: Stage) => {
    setNextStage(stage);
    setShowConfirmModal(true);
  };

  const handleAdvance = async () => {
    if (nextStage) {
      if (project.stage === "atribuir_coordenador") {
        const isWebhookEnabled = !!import.meta.env.VITE_N8N_WEBHOOK_URL;
        if (isWebhookEnabled && editedProject.assignedCoordinatorId) {
          const coordinator = members.find(m => m.id === editedProject.assignedCoordinatorId);
          if (coordinator && coordinator.phone) {
            const productsList = editedProject.product?.map(p => p === 'ee' ? 'EE' : 'Byline') || [];
            const message = `🎯 Novo Projeto: ${project.clientName}\n📦 Produto: ${productsList.join(' + ')}\n💰 Valor: R$ ${project.contractValue || 0}\n👤 Você foi atribuído como coordenador.\n📋 Acesse o painel para montar a equipe.`;
            try {
              await notifyWhatsApp(coordinator.phone, message);
            } catch (err) {
              console.error('Falha ao notificar via WhatsApp:', err);
            }
          }
        }
      }

      if (project.stage === "atribuir_equipe") {
        const currentTeam = projectMembers.filter((pm) => pm.projectId === project.id);
        currentTeam.forEach((pm) => removeProjectMember(pm.id));

        const roles: { [key: string]: string } = {
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
        toast.success("Equipe salva com sucesso!");
      }
      moveProject(project.id, nextStage);
      setShowConfirmModal(false);
      onClose();
    }
  };

  const handleSendWelcome = async () => {
    const isWebhookEnabled = !!import.meta.env.VITE_N8N_WEBHOOK_URL;

    if (isWebhookEnabled) {
      try {
        if (!project.wppGroupId) {
          toast.error('Grupo do WhatsApp não foi criado ainda');
          return;
        }

        await sendWelcomeSequence(
          project.id,
          project.wppGroupId,
          project.gdriveFolderLink || ''
        );

        await supabase.from('project').update({ welcome_sent: true }).eq('id', project.id);
      } catch (err) {
        console.error('Falha ao enviar boas-vindas:', err);
        toast.error("Erro ao notificar webhook de boas-vindas. O avanço será registrado de qualquer modo.");
      }
    }

    updateProject(project.id, { welcomeSent: true });
    addLog({
      id: Math.random().toString(36).substring(7),
      projectId: project.id,
      action: "welcome_sent",
      performedBy: currentUser?.id,
      createdAt: new Date().toISOString(),
    });
    toast.success("Boas-Vindas marcadas como enviadas.");
    confirmAdvance("kickoff");
  };

  // Workspace Creation Logic
  const handleCreateWorkspace = async () => {
    setIsCreatingWorkspace(true);
    
    // Initialize starting state as 'creating'
    updateProject(project.id, {
      workspaceStatus: {
        gchat: 'creating',
        whatsapp: 'creating',
        gdrive: 'creating',
        ekyte: 'creating'
      }
    });

    const isWebhookEnabled = !!import.meta.env.VITE_N8N_WEBHOOK_URL;

    if (isWebhookEnabled) {
      try {
        await supabase.from('project').update({
          workspace_status: { gchat: 'creating', whatsapp: 'creating', gdrive: 'creating', ekyte: 'creating' }
        }).eq('id', project.id);

        const { data: team } = await supabase
          .from('project_member')
          .select('role_in_project, member:member_id(email, phone)')
          .eq('project_id', project.id);

        const teamEmails = team?.map(t => (t.member as any)?.email).filter(Boolean) || [];
        const teamPhones = team?.map(t => (t.member as any)?.phone).filter(Boolean) || [];

        const fixedEmails = ['tiago.bardini@v4company.com', 'patrick.rosavianna@v4company.com', 'gabriel.sartori@v4company.com'];
        
        // Fetch correct phones for fixed members
        const { data: fixedMembersData } = await supabase
          .from('member')
          .select('phone')
          .in('email', fixedEmails);
        
        const fetchedFixedPhones = fixedMembersData?.map(m => m.phone).filter(Boolean) || [];

        // Apenas Tiago como fixo
        const fixedPhones = ['554796769946'];
        const fixedAdminPhones = ['554796769946'];
        
        // Buscar Coordenador para fone e email extra, se necessário
        let coordEmail = '';
        let coordPhone = '';
        if (project.assignedCoordinatorId) {
          const { data: coord } = await supabase
            .from('member')
            .select('email, phone')
            .eq('id', project.assignedCoordinatorId)
            .single();
          coordEmail = coord?.email || '';
          coordPhone = coord?.phone || '';
        }

        const allEmails = [...new Set([...fixedEmails, coordEmail, ...teamEmails])].filter(Boolean);

        const { data: stakeholders } = await supabase
          .from('stakeholder')
          .select('phone')
          .order('created_at', { ascending: true })
          .eq('project_id', project.id);
        const stakeholderPhones = stakeholders?.map(s => s.phone).filter(Boolean) || [];

        const clientPhone = project.clientPhone || '';

        const allPhones = [...new Set([
          ...fixedPhones,
          coordPhone,
          ...teamPhones,
          clientPhone,
          ...stakeholderPhones
        ])].filter(Boolean);

        // Regra para Admins: 
        // Telefones fixos (Tiago)
        // Coordenador (coordPhone)
        const adminPhones = [...new Set([
          ...fixedAdminPhones,
          coordPhone
        ])].filter(Boolean);

        createGChatSpace(project.id, project.clientName, allEmails).catch(err => {
          console.error('GChat falhou:', err);
          supabase.from('project').update({ workspace_status: { ...(project.workspaceStatus || {}), gchat: 'error' } }).eq('id', project.id);
        });

        createWppGroup(project.id, project.clientName, allPhones, adminPhones).catch(err => {
          console.error('WhatsApp falhou:', err);
          supabase.from('project').update({ workspace_status: { ...(project.workspaceStatus || {}), whatsapp: 'error' } }).eq('id', project.id);
        });

        createDriveFolders(project.id, project.clientName, coordEmail).catch(err => {
          console.error('Drive falhou:', err);
          supabase.from('project').update({ workspace_status: { ...(project.workspaceStatus || {}), gdrive: 'error' } }).eq('id', project.id);
        });

        createEkyteWorkspace(project.id, project.clientName, allEmails).catch(err => {
          console.error('Ekyte falhou:', err);
          supabase.from('project').update({ workspace_status: { ...(project.workspaceStatus || {}), ekyte: 'error' } }).eq('id', project.id);
        });

      } catch (err) {
        console.error("Erro geral criar workspace:", err);
      }
      setIsCreatingWorkspace(false);
    } else {
      const timers = [
        { key: 'gchat', delay: 2000, updates: { gchatSpaceId: "spaces/mock123" } },
        { key: 'whatsapp', delay: 4000, updates: { wppGroupId: "mock@g.us" } },
        { key: 'gdrive', delay: 6000, updates: { gdriveFolderId: "folder123", gdriveFolderLink: "https://drive.google.com/drive" } },
        { key: 'ekyte', delay: 8000, updates: { ekyteId: "ekyte_mock123" } }
      ];

      let completed = 0;

      timers.forEach(({ key, delay, updates }) => {
        setTimeout(() => {
          updateProject(project.id, {
            ...updates,
            workspaceStatus: {
              // we rely on the specific partial update keeping other status safe due to our merge logic in store
              [key]: 'created'
            } as any
          });
          
          completed++;
          if (completed === 4) {
            setIsCreatingWorkspace(false);
            toast.success("Todos os ambientes foram criados com sucesso!");
          }
        }, delay);
      });
    }
  };

  // Mock a retry
  const handleRetryEnv = (envKey: 'gchat' | 'whatsapp' | 'gdrive' | 'ekyte') => {
    updateProject(project.id, { workspaceStatus: { [envKey]: 'creating' } as any });
    setTimeout(() => {
      let extraUpdates = {};
      if (envKey === 'gchat') extraUpdates = { gchatSpaceId: 'spaces/mock_retry' };
      if (envKey === 'whatsapp') extraUpdates = { wppGroupId: 'mock_retry@g.us' };
      if (envKey === 'gdrive') extraUpdates = { gdriveFolderId: 'folder_retry', gdriveFolderLink: 'https://drive.google.com' };
      if (envKey === 'ekyte') extraUpdates = { ekyteId: 'ekyte_retry' };

      updateProject(project.id, {
        ...extraUpdates,
        workspaceStatus: { [envKey]: 'created' } as any
      });
    }, 2000);
  };

  // Check stage conditions
  const isPastAguardandoComercial = project.stage !== "aguardando_comercial";
  const isPastCoordenador = !["aguardando_comercial", "atribuir_coordenador"].includes(project.stage);
  const isPastEquipe = !["aguardando_comercial", "atribuir_coordenador", "atribuir_equipe"].includes(project.stage);
  
  const assignedTeam = getAssignedTeamObject();

  const allEnvsCreated = () => {
    const s = project.workspaceStatus;
    if (!s) return false;
    return s.gchat === 'created' && s.whatsapp === 'created' && s.gdrive === 'created' && s.ekyte === 'created';
  };

  const renderEnvStatusIcon = (status?: string) => {
    switch(status) {
      case 'created': return <CheckCircle2 size={16} className="text-[var(--color-v4-success)]" />;
      case 'creating': return <Loader2 size={16} className="text-blue-400 animate-spin" />;
      case 'error': return <XCircle size={16} className="text-[var(--color-v4-error)]" />;
      default: return <CircleDashed size={16} className="text-[var(--color-v4-text-disabled)]" />;
    }
  };

  const renderEnvRow = (
    label: string, 
    key: 'gchat' | 'whatsapp' | 'gdrive' | 'ekyte', 
    link?: string, 
    linkText: string = "Acessar ↗"
  ) => {
    const status = project.workspaceStatus?.[key] || 'pending';
    
    return (
      <div className="flex items-center justify-between text-sm py-1.5 border-b border-[var(--color-v4-border-strong)] last:border-0 last:pb-0">
        <div className="flex items-center gap-2">
          {renderEnvStatusIcon(status)}
          <span className={status === 'pending' ? 'text-[var(--color-v4-text-disabled)]' : 'text-white'}>
            {label} 
            {status === 'creating' && <span className="ml-2 text-xs text-blue-400 italic">Criando...</span>}
          </span>
        </div>
        <div className="flex items-center justify-end">
          {status === 'created' && link && (
            <a href={link} target="_blank" rel="noreferrer" className="text-xs font-medium text-[var(--color-v4-red)] hover:text-white transition-colors bg-[var(--color-v4-surface)] px-2 py-1 rounded">
              {linkText}
            </a>
          )}
          {status === 'error' && (
            <button onClick={() => handleRetryEnv(key)} className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors bg-[var(--color-v4-surface)] px-2 py-1 rounded">
              Tentar novamente
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderStageActions = () => {
    switch (project.stage) {
      case "aguardando_comercial":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
             <button
              onClick={() => {
                if(isEditingClient) handleSaveProjectInfo();
                confirmAdvance("atribuir_coordenador");
              }}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
            >
              Ciente - Confirmar e Avançar
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
                onChange={(e) => {
                  const val = e.target.value;
                  setEditedProject({
                    ...editedProject,
                    assignedCoordinatorId: val,
                  });
                  updateProject(project.id, { assignedCoordinatorId: val });
                }}
                className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2.5 text-white focus:ring-2 focus:ring-[var(--color-v4-red)]"
              >
                <option value="">Selecione...</option>
                {members
                  .filter((m) => m.role === "coord_equipe" && m.isActive)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </div>
            <button
              onClick={() => confirmAdvance("atribuir_equipe")}
              disabled={!editedProject.assignedCoordinatorId}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white rounded-xl font-medium transition-colors"
            >
              Atribuir Coordenador e Avançar
            </button>
          </div>
        );
      case "atribuir_equipe":
        const isTeamValid = teamSelection.gestor_projetos !== "";
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
        const canAdvance = allEnvsCreated();
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)] space-y-3">
             <button
              onClick={handleCreateWorkspace}
              disabled={isCreatingWorkspace || canAdvance}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              {isCreatingWorkspace ? (
                <><Loader2 size={18} className="animate-spin" /> Criando ambientes...</>
              ) : canAdvance ? (
                <><CheckCircle2 size={18} /> Ambientes Criados</>
              ) : (
                <><Building2 size={18} /> Criar Ambientes (Automático)</>
              )}
            </button>
            <button
              onClick={() => confirmAdvance("boas_vindas")}
              disabled={!canAdvance}
              className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-colors flex items-center justify-center gap-2"
            >
              Avançar Etapa
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
                : "Avançar — Boas-Vindas Enviadas"}
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
              Avançar — Kickoff Realizado
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
              Concluir Planejamento — Handover Realizado
            </button>
          </div>
        );
      case "ongoing":
        return (
          <div className="p-4 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)]">
            <div className="w-full py-3 bg-[var(--color-v4-surface)] text-[var(--color-v4-text-disabled)] rounded-xl font-medium text-center flex items-center justify-center gap-2">
              <CheckCircle2 size={18} />
              Onboarding Concluído
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
          
          {/* Seção 1: Dados do Cliente */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} /> Dados do Cliente
              </h3>
              {(!isPastAguardandoComercial || canEditAnyStage) && (
                <button
                  onClick={() => setIsEditingClient(!isEditingClient)}
                  className="text-xs text-[var(--color-v4-red)] hover:underline flex items-center gap-1"
                >
                  {isEditingClient ? "Cancelar Edição" : <><Edit2 size={12} /> Editar Todos</>}
                </button>
              )}
            </div>

            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              {isEditingClient && (!isPastAguardandoComercial || canEditAnyStage) ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Empresa</label>
                    <input type="text" value={editedProject.clientName} onChange={(e) => setEditedProject({ ...editedProject, clientName: e.target.value })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Telefone / WhatsApp</label>
                    <input type="text" value={editedProject.clientPhone || ""} onChange={(e) => setEditedProject({ ...editedProject, clientPhone: e.target.value })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Empresa</p>
                      <p className="text-sm font-medium text-white">{project.clientName}</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Telefone</p>
                      <p className="text-sm font-medium text-white">{project.clientPhone || "—"}</p>
                    </div>
                    {project.soldBy && (
                      <div className="col-span-2 pt-2">
                        <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Vendedor</p>
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-[var(--color-v4-red)]/20 border border-[var(--color-v4-red)]/30 flex items-center justify-center text-xs font-bold text-[var(--color-v4-red)] uppercase">
                            {project.soldBy.name?.charAt(0) || "U"}
                          </div>
                          <p className="text-xs font-medium text-slate-300">{project.soldBy.name}</p>
                        </div>
                      </div>
                    )}
                  </div>
                  {project.kommoLink && (
                    <div className="pt-3 border-t border-[var(--color-v4-border-strong)]">
                      <a href={project.kommoLink} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline flex items-center gap-1"><LinkIcon size={12} /> Ver no Kommo</a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Seção 2: Escopo Fechado */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} /> Escopo Fechado
              </h3>
            </div>
            
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              {isEditingClient && (!isPastAguardandoComercial || canEditAnyStage) ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Produtos (Escopo)</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                       {(editedProject.produtosEscopo || []).map(pId => {
                         const lbl = pId === 'ee' ? 'EE' : pId === 'byline' ? 'Byline' : pId;
                         return (
                           <span key={pId} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[var(--color-v4-danger)]/20 text-[var(--color-v4-red)] border border-[var(--color-v4-red)]/30 text-xs font-medium">
                             {lbl}
                             <button type="button" onClick={() => setEditedProject({ ...editedProject, produtosEscopo: (editedProject.produtosEscopo || []).filter(p => p !== pId) })} className="hover:text-white"><X size={12} /></button>
                           </span>
                         )
                       })}
                    </div>
                    <select
                      value=""
                      onChange={(e) => { 
                        if(e.target.value) {
                           const opts = editedProject.produtosEscopo || [];
                           if(!opts.includes(e.target.value)) setEditedProject({ ...editedProject, produtosEscopo: [...opts, e.target.value] });
                        }
                      }}
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-[var(--color-v4-text-muted)] focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    >
                      <option value="">+ Adicionar produto</option>
                      {PRODUCT_OPTIONS.filter(o => !(editedProject.produtosEscopo || []).includes(o.id)).map(opt => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Valor do Escopo (R$)</label>
                    <input type="number" value={editedProject.valorEscopo || ""} onChange={(e) => setEditedProject({ ...editedProject, valorEscopo: Number(e.target.value) })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                     <div>
                        <label className="block text-xs text-slate-400 mb-1">Data Início</label>
                        <input type="date" value={editedProject.dataInicioEscopo ? editedProject.dataInicioEscopo.split('T')[0] : ""} onChange={(e) => setEditedProject({ ...editedProject, dataInicioEscopo: e.target.value ? new Date(e.target.value).toISOString() : null })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                     </div>
                     <div>
                        <label className="block text-xs text-slate-400 mb-1">Data 1º Pgto</label>
                        <input type="date" value={editedProject.dataPgtoEscopo ? editedProject.dataPgtoEscopo.split('T')[0] : ""} onChange={(e) => setEditedProject({ ...editedProject, dataPgtoEscopo: e.target.value ? new Date(e.target.value).toISOString() : null })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                     </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Produto(s)</p>
                      {project.produtosEscopo && project.produtosEscopo.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {project.produtosEscopo.map(p => (
                             <span key={p} className="px-2 py-0.5 rounded bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[10px] font-semibold tracking-wider text-slate-300">
                               {p === 'ee' ? 'EE' : p === 'byline' ? 'Byline' : p}
                             </span>
                          ))}
                        </div>
                      ) : <p className="text-sm font-medium text-slate-500">—</p>}
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Valor</p>
                      <p className="text-sm font-medium text-white font-mono">
                        R$ {project.valorEscopo?.toLocaleString("pt-BR", { minimumFractionDigits: 2, }) || "0,00"}
                      </p>
                    </div>
                    <div>
                       <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Início / Pgto</p>
                       <p className="text-sm font-medium text-white">
                         {project.dataInicioEscopo ? new Date(project.dataInicioEscopo).toLocaleDateString('pt-BR') : '—'} / {project.dataPgtoEscopo ? new Date(project.dataPgtoEscopo).toLocaleDateString('pt-BR') : '—'}
                       </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Seção 3: Recorrente */}
          {((isEditingClient && (!isPastAguardandoComercial || canEditAnyStage)) || (project.produtosRecorrente?.length || project.valorRecorrente || project.dataInicioRecorrente || project.dataPgtoRecorrente)) ? (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} /> Recorrente
              </h3>
            </div>
            
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              {isEditingClient && (!isPastAguardandoComercial || canEditAnyStage) ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Produtos (Recorrente)</label>
                    <div className="flex flex-wrap gap-2 mb-2">
                       {(editedProject.produtosRecorrente || []).map(pId => {
                         const lbl = pId === 'ee' ? 'EE' : pId === 'byline' ? 'Byline' : pId;
                         return (
                           <span key={pId} className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[var(--color-v4-danger)]/20 text-[var(--color-v4-red)] border border-[var(--color-v4-red)]/30 text-xs font-medium">
                             {lbl}
                             <button type="button" onClick={() => setEditedProject({ ...editedProject, produtosRecorrente: (editedProject.produtosRecorrente || []).filter(p => p !== pId) })} className="hover:text-white"><X size={12} /></button>
                           </span>
                         )
                       })}
                    </div>
                    <select
                      value=""
                      onChange={(e) => { 
                        if(e.target.value) {
                           const opts = editedProject.produtosRecorrente || [];
                           if(!opts.includes(e.target.value)) setEditedProject({ ...editedProject, produtosRecorrente: [...opts, e.target.value] });
                        }
                      }}
                      className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-[var(--color-v4-text-muted)] focus:ring-1 focus:ring-[var(--color-v4-red)]"
                    >
                      <option value="">+ Adicionar produto</option>
                      {PRODUCT_OPTIONS.filter(o => !(editedProject.produtosRecorrente || []).includes(o.id)).map(opt => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Valor Recorrente (R$)</label>
                    <input type="number" value={editedProject.valorRecorrente || ""} onChange={(e) => setEditedProject({ ...editedProject, valorRecorrente: Number(e.target.value) })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                     <div>
                        <label className="block text-xs text-slate-400 mb-1">Data Início</label>
                        <input type="date" value={editedProject.dataInicioRecorrente ? editedProject.dataInicioRecorrente.split('T')[0] : ""} onChange={(e) => setEditedProject({ ...editedProject, dataInicioRecorrente: e.target.value ? new Date(e.target.value).toISOString() : null })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                     </div>
                     <div>
                        <label className="block text-xs text-slate-400 mb-1">Data 1º Pgto</label>
                        <input type="date" value={editedProject.dataPgtoRecorrente ? editedProject.dataPgtoRecorrente.split('T')[0] : ""} onChange={(e) => setEditedProject({ ...editedProject, dataPgtoRecorrente: e.target.value ? new Date(e.target.value).toISOString() : null })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                     </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="col-span-2">
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Produto(s)</p>
                      {project.produtosRecorrente && project.produtosRecorrente.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {project.produtosRecorrente.map(p => (
                             <span key={p} className="px-2 py-0.5 rounded bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[10px] font-semibold tracking-wider text-slate-300">
                               {p === 'ee' ? 'EE' : p === 'byline' ? 'Byline' : p}
                             </span>
                          ))}
                        </div>
                      ) : <p className="text-sm font-medium text-slate-500">—</p>}
                    </div>
                    <div>
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Valor</p>
                      <p className="text-sm font-medium text-white font-mono">
                        R$ {project.valorRecorrente?.toLocaleString("pt-BR", { minimumFractionDigits: 2, }) || "0,00"}
                      </p>
                    </div>
                    <div>
                       <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Início / Pgto</p>
                       <p className="text-sm font-medium text-white">
                         {project.dataInicioRecorrente ? new Date(project.dataInicioRecorrente).toLocaleDateString('pt-BR') : '—'} / {project.dataPgtoRecorrente ? new Date(project.dataPgtoRecorrente).toLocaleDateString('pt-BR') : '—'}
                       </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
          ) : null}

          {/* Seção 4: Informações */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} /> Informações
              </h3>
            </div>
            
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              {isEditingClient && (!isPastAguardandoComercial || canEditAnyStage) ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Link Call de Vendas</label>
                    <input type="text" value={editedProject.linkCallVendas || ""} onChange={(e) => setEditedProject({ ...editedProject, linkCallVendas: e.target.value })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Link Transcrição</label>
                    <input type="text" value={editedProject.linkTranscricao || ""} onChange={(e) => setEditedProject({ ...editedProject, linkTranscricao: e.target.value })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Observações</label>
                    <textarea rows={3} value={editedProject.observacoes || ""} onChange={(e) => setEditedProject({ ...editedProject, observacoes: e.target.value })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)] resize-none" />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2">
                    {project.linkCallVendas ? (
                       <a href={project.linkCallVendas} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:underline flex items-center gap-1 w-fit"><LinkIcon size={14} /> Abrir Call</a>
                    ) : <p className="text-sm font-medium text-slate-500">Call não informada</p>}
                    
                    {project.linkTranscricao ? (
                       <a href={project.linkTranscricao} target="_blank" rel="noreferrer" className="text-sm text-blue-400 hover:underline flex items-center gap-1 w-fit"><LinkIcon size={14} /> Abrir Transcrição</a>
                    ) : <p className="text-sm font-medium text-slate-500">Transcrição não informada</p>}
                  </div>
                  {project.observacoes && (
                    <div className="pt-3 border-t border-[var(--color-v4-border-strong)]">
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-1">Observações</p>
                      <p className="text-sm text-white items-center whitespace-pre-wrap">{project.observacoes}</p>
                    </div>
                  )}
                  {(project.meetingLinks && project.meetingLinks.length > 0) && (
                    <div className="pt-3 border-t border-[var(--color-v4-border-strong)]">
                      <p className="text-xs text-[var(--color-v4-text-muted)] mb-2">Links Antigos/Legacy</p>
                      <ul className="space-y-1">
                        {project.meetingLinks.map((link, idx) => (
                          <li key={idx}><a href={link} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline flex items-center gap-1 truncate"><LinkIcon size={12} className="shrink-0" /> {link}</a></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Seção 5: Contrato */}
          <section>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} /> Contrato
              </h3>
            </div>
            
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              {isEditingClient && (!isPastAguardandoComercial || canEditAnyStage) ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">URL do Contrato PDF</label>
                    <input type="text" placeholder="https://..." value={editedProject.contractUrl || ""} onChange={(e) => setEditedProject({ ...editedProject, contractUrl: e.target.value })} className="w-full p-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-md text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]" />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-col gap-2">
                    {project.contractUrl ? (
                       <a href={project.contractUrl} target="_blank" rel="noreferrer" className="text-sm bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white py-1.5 px-3 rounded flex items-center justify-center gap-1 w-fit"><LinkIcon size={14} /> Visualizar PDF do Contrato</a>
                    ) : <p className="text-sm font-medium text-slate-500">Nenhum contrato anexado</p>}
                  </div>
                </div>
              )}
            </div>
          </section>
          
          {/* Botão Global de Salvar, exibido se estiver em modo edição */}
          {isEditingClient && (!isPastAguardandoComercial || canEditAnyStage) && (
             <div className="sticky bottom-4 z-10 flex flex-col items-center">
                 <button onClick={handleSaveProjectInfo} className="w-full py-3 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] transition-colors text-white rounded shadow-lg text-sm font-bold mt-2 flex justify-center items-center gap-2">
                    <CheckCircle2 size={18} /> Salvar Todas as Alterações
                 </button>
             </div>
          )}

          {/* Coordenador Designado */}
          {isPastCoordenador && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                  <Users size={16} /> Coordenador do Projeto
                </h3>
                {canEditAnyStage && (
                  <button
                    onClick={() => setIsEditingCoordinator(!isEditingCoordinator)}
                    className="text-xs text-[var(--color-v4-red)] hover:underline flex items-center gap-1"
                  >
                    {isEditingCoordinator ? "Cancelar" : <><Edit2 size={12} /> Alterar</>}
                  </button>
                )}
              </div>
              <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4">
                {isEditingCoordinator ? (
                  <div className="space-y-4">
                    <div>
                      <select
                        value={editedProject.assignedCoordinatorId || ""}
                        onChange={(e) => {
                          setEditedProject({ ...editedProject, assignedCoordinatorId: e.target.value });
                        }}
                        className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2.5 text-white focus:ring-2 focus:ring-[var(--color-v4-red)]"
                      >
                        <option value="">Selecione...</option>
                        {members.filter((m) => m.role === "coord_equipe" && m.isActive).map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={() => {
                        updateProject(project.id, { assignedCoordinatorId: editedProject.assignedCoordinatorId });
                        setIsEditingCoordinator(false);
                        toast.success("Coordenador alterado!");
                      }}
                      className="w-full py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      Salvar Coordenador
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-white text-xs font-bold">
                      {getMemberName(project.assignedCoordinatorId).charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">{getMemberName(project.assignedCoordinatorId)}</p>
                      <p className="text-xs text-slate-400">Coordenador de Equipe</p>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Equipe - Seleção ou Visualização */}
          {(project.stage === "atribuir_equipe") && (
            <section>
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
                <Users size={16} /> Montar Equipe
              </h3>
              <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4 space-y-4">
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Gestor de Projetos <span className="text-[var(--color-v4-red)]">*</span></label>
                  <select value={teamSelection.gestor_projetos} onChange={(e) => setTeamSelection({ ...teamSelection, gestor_projetos: e.target.value })} className={cn("w-full bg-[var(--color-v4-bg)] border rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]", !teamSelection.gestor_projetos ? "border-[var(--color-v4-red)]" : "border-[var(--color-v4-border)]")}>
                    <option value="">Selecione...</option>
                    {members.filter((m) => m.role === "gestor_projetos" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Designer</label>
                  <select value={teamSelection.designer} onChange={(e) => setTeamSelection({ ...teamSelection, designer: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                    <option value="">Selecione...</option>
                    {members.filter((m) => m.role === "designer" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Gestor de Tráfego</label>
                  <select value={teamSelection.gestor_trafego} onChange={(e) => setTeamSelection({ ...teamSelection, gestor_trafego: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                    <option value="">Selecione...</option>
                    {members.filter((m) => m.role === "gestor_trafego" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Copywriter</label>
                  <select value={teamSelection.copywriter} onChange={(e) => setTeamSelection({ ...teamSelection, copywriter: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                    <option value="">Selecione...</option>
                    {members.filter((m) => m.role === "copywriter" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                  </select>
                </div>
              </div>
            </section>
          )}

          {isPastEquipe && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2">
                  <Users size={16} /> Equipe Designada
                </h3>
                {canEditAnyStage && (
                  <button
                    onClick={() => setIsEditingTeam(!isEditingTeam)}
                    className="text-xs text-[var(--color-v4-red)] hover:underline flex items-center gap-1"
                  >
                    {isEditingTeam ? "Cancelar" : <><Edit2 size={12} /> Alterar</>}
                  </button>
                )}
              </div>
              <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4 space-y-3">
                {isEditingTeam ? (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Gestor de Projetos</label>
                      <select value={teamSelection.gestor_projetos} onChange={(e) => setTeamSelection({ ...teamSelection, gestor_projetos: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                        <option value="">Selecione...</option>
                        {members.filter((m) => m.role === "gestor_projetos" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Designer</label>
                      <select value={teamSelection.designer} onChange={(e) => setTeamSelection({ ...teamSelection, designer: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                        <option value="">Selecione...</option>
                        {members.filter((m) => m.role === "designer" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Gestor de Tráfego</label>
                      <select value={teamSelection.gestor_trafego} onChange={(e) => setTeamSelection({ ...teamSelection, gestor_trafego: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                        <option value="">Selecione...</option>
                        {members.filter((m) => m.role === "gestor_trafego" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Copywriter</label>
                      <select value={teamSelection.copywriter} onChange={(e) => setTeamSelection({ ...teamSelection, copywriter: e.target.value })} className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-2 text-sm text-white focus:ring-1 focus:ring-[var(--color-v4-red)]">
                        <option value="">Selecione...</option>
                        {members.filter((m) => m.role === "copywriter" && m.isActive).map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                      </select>
                    </div>
                    <button
                      onClick={() => {
                        const currentTeam = projectMembers.filter((pm) => pm.projectId === project.id);
                        currentTeam.forEach((pm) => removeProjectMember(pm.id));
                
                        const roles: { [key: string]: string } = {
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
                        setIsEditingTeam(false);
                        toast.success("Equipe alterada com sucesso!");
                      }}
                      className="w-full py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-lg text-xs font-medium transition-colors"
                    >
                      Salvar Equipe
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-between items-center border-b border-[var(--color-v4-border-strong)] pb-2 last:border-0 last:pb-0">
                      <span className="text-xs text-slate-400">Gestor de Projetos:</span>
                      <span className="text-sm text-white font-medium text-right">{getMemberName(assignedTeam.gestor_projetos)}</span>
                    </div>
                    <div className="flex justify-between items-center border-b border-[var(--color-v4-border-strong)] pb-2 last:border-0 last:pb-0">
                      <span className="text-xs text-slate-400">Designer:</span>
                      <span className={cn("text-sm text-right", assignedTeam.designer ? "text-white font-medium" : "text-slate-500 italic")}>{getMemberName(assignedTeam.designer)}</span>
                    </div>
                    <div className="flex justify-between items-center border-b border-[var(--color-v4-border-strong)] pb-2 last:border-0 last:pb-0">
                      <span className="text-xs text-slate-400">Gestor de Tráfego:</span>
                      <span className={cn("text-sm text-right", assignedTeam.gestor_trafego ? "text-white font-medium" : "text-slate-500 italic")}>{getMemberName(assignedTeam.gestor_trafego)}</span>
                    </div>
                    <div className="flex justify-between items-center border-b border-[var(--color-v4-border-strong)] pb-2 last:border-0 last:pb-0">
                      <span className="text-xs text-slate-400">Copywriter:</span>
                      <span className={cn("text-sm text-right", assignedTeam.copywriter ? "text-white font-medium" : "text-slate-500 italic")}>{getMemberName(assignedTeam.copywriter)}</span>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Ambientes Cultivados */}
          {["criar_workspace", "boas_vindas", "kickoff", "planejamento", "ongoing"].includes(project.stage) && (
            <section>
              <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider flex items-center gap-2 mb-4">
                <Building2 size={16} /> Ambientes
              </h3>
              <div className="bg-[var(--color-v4-card)] rounded-xl border border-[var(--color-v4-border)] p-4 space-y-1">
                {renderEnvRow("Google Chat", "gchat", project.gchatLink, "Abrir")}
                {renderEnvRow("WhatsApp Group", "whatsapp", project.wppGroupLink, "Abrir")}
                {renderEnvRow("Google Drive", "gdrive", project.gdriveFolderLink, "Abrir")}
                {renderEnvRow("Ekyte Workspace", "ekyte", project.ekyteLink, "Abrir")}
              </div>
            </section>
          )}
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
