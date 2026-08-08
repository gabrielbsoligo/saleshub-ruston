import { useState } from 'react';
import { X, FolderPlus } from 'lucide-react';
import { criarProjeto } from '../lib/projectsStore';

export function NovoProjetoModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [nome, setNome] = useState('');
  const criar = () => {
    if (!nome.trim()) return;
    const p = criarProjeto(nome);
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
