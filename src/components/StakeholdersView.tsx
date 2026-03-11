import React, { useState } from "react";
import { useAppStore } from "../store";
import { Contact, Search, Plus, Edit2, Trash2, X } from "lucide-react";
import toast from "react-hot-toast";
import { Stakeholder, Project } from "../types";

export const StakeholdersView: React.FC = () => {
  const { stakeholders, projects, currentUser, addStakeholder, updateStakeholder, removeStakeholder } = useAppStore();
  const [searchTerm, setSearchTerm] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingStakeholder, setEditingStakeholder] = useState<Stakeholder | null>(null);
  
  // Confirmação de exclusão
  const [stakeholderToDelete, setStakeholderToDelete] = useState<Stakeholder | null>(null);

  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    email: "",
    role: "",
    projectId: "",
  });

  const filteredStakeholders = stakeholders.filter(
    (s) => {
      const p = projects.find(proj => proj.id === s.projectId);
      return s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
             (s.email && s.email.toLowerCase().includes(searchTerm.toLowerCase())) ||
             (p && p.name.toLowerCase().includes(searchTerm.toLowerCase()))
    }
  );

  const openModal = (stakeholder?: Stakeholder) => {
    if (stakeholder) {
      setEditingStakeholder(stakeholder);
      setFormData({
        name: stakeholder.name,
        phone: stakeholder.phone || "",
        email: stakeholder.email || "",
        role: stakeholder.role || "",
        projectId: stakeholder.projectId,
      });
    } else {
      setEditingStakeholder(null);
      setFormData({
        name: "",
        phone: "",
        email: "",
        role: "",
        projectId: projects.length > 0 ? projects[0].id : "",
      });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingStakeholder(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.projectId) {
      toast.error("Nome e Projeto são campos obrigatórios");
      return;
    }

    if (formData.email && !/^\S+@\S+\.\S+$/.test(formData.email)) {
      toast.error("O email inserido não é válido");
      return;
    }
    
    if (formData.phone && !/^\d+$/.test(formData.phone)) {
      toast.error("O telefone deve conter apenas números");
      return;
    }

    if (editingStakeholder) {
      updateStakeholder(editingStakeholder.id, formData);
      toast.success("Stakeholder atualizado com sucesso!");
    } else {
      const newStakeholder: Stakeholder = {
        ...formData,
        id: Math.random().toString(36).substring(7),
      };
      addStakeholder(newStakeholder);
      toast.success("Stakeholder salvo com sucesso!");
    }
    closeModal();
  };

  const confirmDelete = () => {
    if (stakeholderToDelete) {
      removeStakeholder(stakeholderToDelete.id);
      toast.success("Stakeholder removido com sucesso!");
      setStakeholderToDelete(null);
    }
  };

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
            currentUser?.role === "admin" ||
            currentUser?.role === "coord_geral" ||
            currentUser?.role === "coord_equipe") && (
            <button 
              onClick={() => openModal()}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
            >
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
                placeholder="Buscar por nome, email ou projeto..."
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
                          <button 
                            onClick={() => openModal(stakeholder)}
                            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-md transition-colors"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button 
                            onClick={() => setStakeholderToDelete(stakeholder)}
                            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-900/20 rounded-md transition-colors"
                          >
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

      {/* Modal Criar/Editar */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-v4-border)]">
              <h3 className="text-lg font-display font-bold text-white">
                {editingStakeholder ? "Editar Stakeholder" : "Novo Stakeholder"}
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
                  placeholder="Ex: Maria Souza"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Telefone (Apenas dígitos)</label>
                  <input
                    type="text"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                    placeholder="Ex: 5511999999999"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                    placeholder="Ex: maria@empresa.com"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Função</label>
                <input
                  type="text"
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                  placeholder="Ex: CEO, Diretor de Marketing"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Projeto Vinculado *</label>
                <select
                  required
                  value={formData.projectId}
                  onChange={(e) => setFormData({ ...formData, projectId: e.target.value })}
                  className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg text-sm text-white focus:ring-2 focus:ring-[var(--color-v4-red)] transition-all"
                >
                  <option value="" disabled>Selecione um projeto</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
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
      {stakeholderToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-xl w-full max-w-sm overflow-hidden p-6 text-center">
            <div className="mx-auto w-12 h-12 bg-red-500/10 rounded-full flex items-center justify-center mb-4">
              <Trash2 className="text-red-500" size={24} />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">Excluir Stakeholder</h3>
            <p className="text-sm text-slate-400 mb-6">
              Tem certeza que deseja remover <strong>{stakeholderToDelete.name}</strong>?
            </p>
            <div className="flex justify-center gap-2">
              <button
                onClick={() => setStakeholderToDelete(null)}
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
