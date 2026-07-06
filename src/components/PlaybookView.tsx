import React from "react";
import { BookOpen, ExternalLink } from "lucide-react";

// Playbook de Pré-Vendas (V4) — material consultável dentro do SalesHub.
// O HTML fica em public/playbook_pre_vendas_v4.html e é renderizado num iframe
// (mantém fontes/players/estilos originais intactos, isolado do app).
const PLAYBOOK_SRC = "/playbook_pre_vendas_v4.html";

export const PlaybookView: React.FC = () => {
  return (
    <div className="flex-1 overflow-hidden flex flex-col p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--color-v4-red-muted)] text-[var(--color-v4-red)] flex items-center justify-center">
            <BookOpen size={18} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Playbook de Pré-Vendas</h1>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Cadências, scripts e regras do time SDR/BDR.</p>
          </div>
        </div>
        <a
          href={PLAYBOOK_SRC}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]"
        >
          Abrir em nova aba <ExternalLink size={14} />
        </a>
      </div>
      <div className="flex-1 overflow-hidden rounded-xl border border-[var(--color-v4-border)] bg-white">
        <iframe
          src={PLAYBOOK_SRC}
          title="Playbook de Pré-Vendas V4"
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
};
