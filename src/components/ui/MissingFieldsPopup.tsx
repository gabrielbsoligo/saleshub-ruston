import React from "react";
import { AlertTriangle, X } from "lucide-react";

interface Props {
  missing: string[];
  onClose: () => void;
}

export const MissingFieldsPopup: React.FC<Props> = ({ missing, onClose }) => {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-[var(--color-v4-card)] border border-red-500/30 rounded-2xl shadow-2xl overflow-hidden">
        <div className="bg-red-500/10 border-b border-red-500/20 px-5 py-4 flex items-center gap-3">
          <AlertTriangle size={20} className="text-red-400" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-red-400">Campos Obrigatórios</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Preencha para dar ganho</p>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5">
          <ul className="space-y-2">
            {missing.map((field, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-white">
                <span className="w-5 h-5 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center text-[10px] font-bold flex-shrink-0">{i + 1}</span>
                {field}
              </li>
            ))}
          </ul>
        </div>
        <div className="px-5 py-4 border-t border-[var(--color-v4-border)]">
          <button onClick={onClose} className="w-full py-2.5 rounded-xl bg-[var(--color-v4-surface)] hover:bg-[var(--color-v4-card-hover)] text-white text-sm font-medium">
            Entendi, vou preencher
          </button>
        </div>
      </div>
    </div>
  );
};
