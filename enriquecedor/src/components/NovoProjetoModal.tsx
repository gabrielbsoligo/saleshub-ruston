import { useState } from 'react';
import { X, FolderPlus, Building2, Globe2 } from 'lucide-react';
import { criarProjeto, PERFIS } from '../lib/projectsStore';
import type { PerfilAuditoria } from '../types';

const PERFIL_ICON: Record<PerfilAuditoria, typeof Building2> = {
  construtoras: Building2,
  geral: Globe2,
};

export function NovoProjetoModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [nome, setNome] = useState('');
  const [perfil, setPerfil] = useState<PerfilAuditoria>('construtoras');
  const criar = () => {
    if (!nome.trim()) return;
    const p = criarProjeto(nome, perfil);
    onCreated(p.id);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-v4-border bg-v4-card p-6 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold text-v4-text">
            <FolderPlus size={20} className="text-v4-red" /> Novo projeto
          </h2>
          <button onClick={onClose} className="text-v4-text-muted hover:text-v4-red">
            <X size={18} />
          </button>
        </div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-v4-text-muted">Nome do projeto</label>
        <input
          autoFocus
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && criar()}
          placeholder="Ex.: Incorporadoras SP — Julho"
          className="mb-4 w-full rounded-lg border border-v4-border bg-v4-surface px-3 py-2.5 text-sm text-v4-text outline-none transition focus:border-v4-red"
        />

        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-v4-text-muted">
          Tipo de auditoria &amp; discurso
        </label>
        <div className="mb-4 space-y-2">
          {(Object.keys(PERFIS) as PerfilAuditoria[]).map((k) => {
            const Icon = PERFIL_ICON[k] ?? Building2;
            const ativo = perfil === k;
            return (
              <button
                key={k}
                onClick={() => setPerfil(k)}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                  ativo ? 'border-v4-red bg-[rgba(230,57,70,0.08)]' : 'border-v4-border hover:border-v4-text-muted'
                }`}
              >
                <div
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    ativo ? 'bg-v4-red text-white' : 'bg-v4-surface text-v4-text-muted'
                  }`}
                >
                  <Icon size={16} />
                </div>
                <div>
                  <p className={`text-sm font-semibold ${ativo ? 'text-v4-red' : 'text-v4-text'}`}>{PERFIS[k].label}</p>
                  <p className="mt-0.5 text-xs text-v4-text-muted">{PERFIS[k].desc}</p>
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-v4-border px-4 py-2 text-sm text-v4-text-muted transition hover:text-v4-text">
            Cancelar
          </button>
          <button
            onClick={criar}
            disabled={!nome.trim()}
            className="rounded-lg bg-v4-red px-4 py-2 text-sm font-semibold text-white transition hover:bg-v4-red-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Criar projeto
          </button>
        </div>
      </div>
    </div>
  );
}
