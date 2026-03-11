import React, { useState } from "react";
import { useAppStore } from "../store";
import { Building2, Save } from "lucide-react";

export const CompanyView: React.FC = () => {
  const { company, updateCompany, currentUser } = useAppStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editedCompany, setEditedCompany] = useState(company);

  const handleSave = () => {
    updateCompany(editedCompany);
    setIsEditing(false);
  };

  const isOwner = currentUser?.role === "owner" || currentUser?.role === "admin";

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--color-v4-bg)] p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h2 className="text-2xl font-display font-bold text-white">
              Empresa
            </h2>
            <p className="text-sm text-[var(--color-v4-text-muted)]">
              Configurações da assessoria V4.
            </p>
          </div>

          {isOwner && (
            <button
              onClick={() => (isEditing ? handleSave() : setIsEditing(true))}
              className="flex items-center gap-2 px-4 py-2 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white rounded-xl font-medium transition-colors"
            >
              {isEditing ? (
                <>
                  <Save size={18} /> Salvar Alterações
                </>
              ) : (
                <>
                  <Building2 size={18} /> Editar Dados
                </>
              )}
            </button>
          )}
        </div>

        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl p-6 shadow-sm">
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2">
                Nome da Assessoria
              </label>
              <input
                type="text"
                value={editedCompany.name}
                onChange={(e) =>
                  setEditedCompany({ ...editedCompany, name: e.target.value })
                }
                disabled={!isEditing}
                className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-3 text-white focus:ring-2 focus:ring-[var(--color-v4-red)] disabled:opacity-70 disabled:bg-slate-900/50"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2">
                CNPJ
              </label>
              <input
                type="text"
                value={editedCompany.cnpj || ""}
                onChange={(e) =>
                  setEditedCompany({ ...editedCompany, cnpj: e.target.value })
                }
                disabled={!isEditing}
                className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-3 text-white focus:ring-2 focus:ring-[var(--color-v4-red)] disabled:opacity-70 disabled:bg-slate-900/50 font-mono"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2">
                Endereço
              </label>
              <input
                type="text"
                value={editedCompany.address || ""}
                onChange={(e) =>
                  setEditedCompany({
                    ...editedCompany,
                    address: e.target.value,
                  })
                }
                disabled={!isEditing}
                className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-3 text-white focus:ring-2 focus:ring-[var(--color-v4-red)] disabled:opacity-70 disabled:bg-slate-900/50"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2">
                Telefone Principal
              </label>
              <input
                type="text"
                value={editedCompany.phone || ""}
                onChange={(e) =>
                  setEditedCompany({ ...editedCompany, phone: e.target.value })
                }
                disabled={!isEditing}
                className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-3 text-white focus:ring-2 focus:ring-[var(--color-v4-red)] disabled:opacity-70 disabled:bg-slate-900/50 font-mono"
              />
            </div>
          </div>
        </div>

        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl p-6 shadow-sm opacity-50">
          <h3 className="text-lg font-display font-bold text-white mb-4">
            Integrações (Em breve)
          </h3>
          <p className="text-sm text-[var(--color-v4-text-muted)] mb-4">
            Configurações de webhooks n8n e tokens de API ficarão aqui.
          </p>
          <div className="space-y-4">
            <div className="p-4 bg-slate-900/50 border border-[var(--color-v4-border)] rounded-lg flex items-center justify-between">
              <span className="text-sm font-medium text-white">
                n8n Webhook URL Base
              </span>
              <span className="text-xs text-slate-500 font-mono">
                https://n8n.v4company.com/...
              </span>
            </div>
            <div className="p-4 bg-slate-900/50 border border-[var(--color-v4-border)] rounded-lg flex items-center justify-between">
              <span className="text-sm font-medium text-white">
                Supabase Service Role Key
              </span>
              <span className="text-xs text-slate-500 font-mono">
                ••••••••••••••••
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
