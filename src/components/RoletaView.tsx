import React, { useState } from "react";
import { Repeat } from "lucide-react";
import { RoletaBoard } from "./RoletaBoard";
import { RoletaHistoricoView } from "./RoletaHistoricoView";

// Tela unificada "Roleta" (menu). Abas em cima pra alternar entre SDR e Closer (uma de cada vez).
// Só leitura + o que já existia: painel SDR (RoletaPanelSdr) + histórico SDR; painel Closer novo.
export const RoletaView: React.FC = () => {
  const [tab, setTab] = useState<"sdr" | "closer">("sdr");

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 mb-4">
        <Repeat size={20} className="text-[var(--color-v4-red)]" />
        <h1 className="text-lg font-semibold text-white">Roleta</h1>
      </div>

      {/* ABAS */}
      <div className="inline-flex rounded-lg border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-1 mb-4">
        {([["sdr", "SDR"], ["closer", "Closer"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === id ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)] hover:text-white"
            }`}>{label}</button>
        ))}
      </div>

      {tab === "sdr" ? (
        <div className="space-y-4">
          <RoletaBoard tipo="sdr" />
          <RoletaHistoricoView />
        </div>
      ) : (
        <RoletaBoard tipo="closer" />
      )}
    </div>
  );
};
