import React from "react";
import { Repeat } from "lucide-react";
import { useAppStore } from "../store";

// Card do rodízio de closers (próximo a receber em destaque).
// Usado nas telas Reuniões e Agendas.
export const RoletaPanel: React.FC = () => {
  const { roleta } = useAppStore();
  if (roleta.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Repeat size={14} className="text-[var(--color-v4-red)]" />
        <span className="text-xs font-semibold text-white">Rodízio de Closers</span>
        <span className="text-[11px] text-[var(--color-v4-text-muted)]">— próximo a receber em destaque</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {roleta.map((r, i) => (
          <span key={r.member_id}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
              i === 0
                ? "bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-white"
                : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)]"
            }`}>
            {i === 0 && <span className="text-[9px] font-bold uppercase text-[var(--color-v4-red)]">próximo</span>}
            <span className={i === 0 ? "text-white font-medium" : ""}>{r.name}</span>
            <span className="text-[10px] opacity-70">{r.total}</span>
          </span>
        ))}
      </div>
    </div>
  );
};
