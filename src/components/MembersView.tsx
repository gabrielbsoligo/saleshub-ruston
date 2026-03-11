import React, { useState } from "react";
import { useAppStore } from "../store";
import { Users, Search, Plus, Edit2, Trash2, X } from "lucide-react";
import { cn } from "./Layout";
import { Member, Role } from "../types";
import toast from "react-hot-toast";

const ROLES: { value: Role; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "coord_geral", label: "Coordenador Geral" },
  { value: "coord_equipe", label: "Coordenador de Equipe" },
  { value: "comercial", label: "Comercial" },
  { value: "copywriter", label: "Copywriter" },
  { value: "designer", label: "Designer" },
  { value: "gestor_trafego", label: "Gestor de Tráfego" },
  { value: "gestor_projetos", label: "Gestor de Projetos" },
  { value: "membro", label: "Membro" },
];

export const MembersView: React.FC = () => {
  const { members, currentUser, addMember, updateMember, removeMember, projectMembers } = useAppStore();
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  
  // Confirmação de exclusão
  const [memberToDelete, setMemberToDelete] = useState<Member | null>(null);
  const [deleteWarning, setDeleteWarning] = useState("");

  const [formData, setFormData] = useState({
    name: "",
    nickname: "",
    email: "",
    phone: "",
    role: "membro" as Role,
    isActive: true,
  });

  const filteredMembers = members.filter(
    (m) =>
      m.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.role.replace("_", " ").toLowerCase().includes(searchTerm.toLowerCase())
  );

  const openModal = (member?: Member) => {
    if (member) {
      setEditingMember(member);
      setFormData({
        name: member.name,
        nickname: member.nickname || "",
        email: member.email,
        phone: member.phone,
        role: member.role,
        isActive: member.isActive,
      });
    } else {
      setEditingMember(null);
      setFormData({
        name: "",
        nickname: "",
        email: "",
        phone: "",
        role: "membro",
        isActive: true,
      });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingMember(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.email || !formData.phone || !formData.role) {
      toast.error("Preencha todos os campos obrigatórios");
      return;
    }

    // Basic email validation
    if (!formData.email.endsWith("@v4company.com")) {
      toast.error("O email deve ser um domínio @v4company.com");
      return;
    }

    if (!/^\d+$/.test(formData.phone)) {
      toast.error("O telefone deve conter apenas números");
      return;
    }

    if (editingMember) {
      updateMember(editingMember.id, formData);
      toast.success("Colaborador atualizado com sucesso!");
    } else {
      const newMember: Member = {
        ...formData,
        id: Math.random().toString(36).substring(7),
        avatarUrl: `https://api.dicebear.com/7.x/avataaars/svg?seed=${formData.nickname || formData.name}`,
      };
      addMember(newMember);
      toast.success("Colaborador salvo com sucesso!");
    }
    closeModal();
  };

  const toggleStatus = (m: Member) => {
    updateMember(m.id, { isActive: !m.isActive });
    toast.success(`Colaborador ${!m.isActive ? 'ativado' : 'inativado'} com sucesso.`);
  }

  const handleDeletePrompt = (m: Member) => {
    const allocatedCount = projectMembers.filter(pm => pm.memberId === m.id).length;
    if (allocatedCount > 0) {
      setDeleteWarning(`Este colaborador está alocado em ${allocatedCount} projeto(s). Remover mesmo assim?`);
    } else {
      setDeleteWarning("");
    }
    setMemberToDelete(m);
  };

  const confirmDelete = () => {
    if (memberToDelete) {
      removeMember(memberToDelete.id);
      toast.success("Colaborador removido com sucesso!");
      setMemberToDelete(null);
    }
  };


  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--color-v4-bg)] p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-2xl font-display font-bold text-white">
              Colaboradores
            </h2>
            <p className="text-sm text-[var(--color-v4-text-muted)]">
              Gerencie o time da assessoria.
            </p>
          </div>

          {(currentUser?.role === "owner" ||
            currentUser?.role === "admin" ||
            currentUser?.role === "coord_geral") && (
            <button 
              onClick={() => openModal()}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
            >
              <Plus size={18} />
              Novo Colaborador
            </button>
          )}
        </div>

        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-[var(--color-v4-border)] flex items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" size={18} />
              <input
                type="text"
                placeholder="Buscar por nome, email ou cargo..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] focus:border-transparent transition-all"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--color-v4-text-muted)] whitespace-nowrap">
              <thead className="text-xs uppercase bg-slate-900/50 border-b border-[var(--color-v4-border)]">
                <tr>
                  <th className="px-6 py-4 font-semibold">Colaborador</th>
                  <th className="px-6 py-4 font-semibold">Cargo</th>
                  <th className="px-6 py-4 font-semibold">Telefone</th>
                  <th className="px-6 py-4 font-semibold">Status</th>
                  <th className="px-6 py-4 font-semibold text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-v4-border)]">
                {filteredMembers.map((member) => (
                  <tr
                    key={member.id}
                    className={cn(
                      "transition-colors hover:bg-slate-800/30",
                      !member.isActive && "opacity-50 grayscale"
                    )}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <img src={member.avatarUrl} alt={member.name} className="w-8 h-8 rounded-full bg-slate-800" />
                        <div>
                          <p className="font-medium text-white">
                            {member.name} {member.nickname && <span className="text-slate-400 font-normal">({member.nickname})</span>}
                          </p>
                          <p className="text-xs">{member.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-2.5 py-1 rounded-full bg-slate-800 border border-[var(--color-v4-border)] text-xs font-medium text-slate-300">
                        {ROLES.find(r => r.value === member.role)?.label || member.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs">
                      {member.phone}
                    </td>
                    <td className="px-6 py-4">
                      <button 
                        onClick={() => toggleStatus(member)}
                        className="flex items-center gap-1.5 hover:bg-slate-800 p-1.5 rounded-md transition-colors"
                        title="Clique para alterar status"
                      >
                        <div className={cn("w-2 h-2 rounded-full", member.isActive ? "bg-emerald-500" : "bg-slate-500")} />
                        <span className="text-xs">{member.isActive ? "Ativo" : "Inativo"}</span>
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {(currentUser?.role === "owner" || currentUser?.role === "admin" || currentUser?.role === "coord_geral") && (
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => openModal(member)} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors">
                            <Edit2 size={16} />
                          </button>
                          <button onClick={() => handleDeletePrompt(member)} className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-md transition-colors">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {filteredMembers.length === 0 && (
              <div className="p-12 text-center">
                <Users className="mx-auto h-12 w-12 text-slate-600 mb-3" />
                <p className="text-slate-400">Nenhum colaborador encontrado.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal Criar/Editar */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-v4-border)]">
              <h3 className="text-lg font-display font-bold text-white">
                {editingMember ? "Editar Colaborador" : "Novo Colaborador"}
              </h3>
              <button
                onClick={closeModal}
                className="text-slate-400 hover:text-white p-1 rounded-md transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Nome Completo *</label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                  placeholder="Ex: João Silva"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Apelido</label>
                <input
                  type="text"
                  value={formData.nickname}
                  onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                  placeholder="Ex: Joãozinho"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Email (@v4company.com) *</label>
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                  placeholder="Ex: joao@v4company.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Telefone (Apenas dígitos) *</label>
                  <input
                    type="text"
                    required
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                    placeholder="Ex: 5511999999999"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Cargo *</label>
                  <select
                    value={formData.role}
                    onChange={(e) => setFormData({ ...formData, role: e.target.value as Role })}
                    className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                  >
                    {ROLES.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              
              <div className="pt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-medium transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl text-sm font-medium transition-colors"
                >
                  Salvar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Confirmação Delete */}
      {memberToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-xl w-full max-w-sm overflow-hidden p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
              <Trash2 className="text-red-500" size={24} />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Excluir Colaborador</h3>
            <p className="text-sm text-slate-400 mb-2">
              Tem certeza que deseja remover <strong>{memberToDelete.name}</strong>?
            </p>
            {deleteWarning && (
              <p className="text-sm text-red-400 bg-red-500/10 p-2 rounded-lg mb-4">
                {deleteWarning}
              </p>
            )}
            <div className="flex justify-center gap-2 mt-6">
              <button
                onClick={() => setMemberToDelete(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-medium transition-colors w-full"
              >
                Cancelar
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-medium transition-colors w-full"
              >
                Sim, Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
