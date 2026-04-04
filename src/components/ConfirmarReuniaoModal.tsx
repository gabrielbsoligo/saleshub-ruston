import React, { useState } from "react";
import { X, Check, XCircle, Calendar, User } from "lucide-react";
import type { Reuniao } from "../types";
import { useAppStore } from "../store";

interface Props {
  reuniao: Reuniao;
  onConfirm: (show: boolean, closerConfirmadoId: string) => void;
  onClose: () => void;
}

export const ConfirmarReuniaoModal: React.FC<Props> = ({ reuniao, onConfirm, onClose }) => {
  const { members } = useAppStore();
  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const [closerConfirmadoId, setCloserConfirmadoId] = useState(reuniao.closer_id || '');
  const [isProcessing, setIsProcessing] = useState(false);

  const handleConfirm = async (show: boolean) => {
    if (isProcessing || !closerConfirmadoId) return;
    setIsProcessing(true);
    onConfirm(show, closerConfirmadoId);
  };

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  const dataReuniao = reuniao.data_reuniao ? new Date(reuniao.data_reuniao) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="bg-green-500/10 border-b border-green-500/20 px-5 py-4 flex items-center gap-3">
          <Calendar size={18} className="text-green-400" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-green-400">Confirmar Reunião</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)]">{reuniao.empresa}</p>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-[var(--color-v4-surface)] rounded-lg p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--color-v4-text-muted)]">Empresa</span>
              <span className="text-sm text-white font-medium">{reuniao.empresa}</span>
            </div>
            {reuniao.nome_contato && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-v4-text-muted)]">Contato</span>
                <span className="text-sm text-white">{reuniao.nome_contato}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--color-v4-text-muted)]">Data</span>
              <span className="text-sm text-white">{dataReuniao ? dataReuniao.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--color-v4-text-muted)]">SDR</span>
              <span className="text-sm text-white">{reuniao.sdr?.name || '—'}</span>
            </div>
            {reuniao.closer && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--color-v4-text-muted)]">Closer agendado</span>
                <span className="text-sm text-white">{reuniao.closer.name}</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">
              <User size={12} className="inline mr-1" />
              Closer que executou a reunião *
            </label>
            <select className={inputClass} value={closerConfirmadoId} onChange={e => setCloserConfirmadoId(e.target.value)}>
              <option value="">Selecionar closer</option>
              {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {reuniao.closer_id && closerConfirmadoId && reuniao.closer_id !== closerConfirmadoId && (
              <p className="text-[10px] text-yellow-400 mt-1">⚠️ Closer diferente do agendado</p>
            )}
          </div>

          <p className="text-xs text-[var(--color-v4-text-muted)] text-center">A reunião aconteceu?</p>
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-v4-border)] flex gap-3">
          <button onClick={onClose} className="py-2.5 px-4 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
          <button onClick={() => handleConfirm(false)} disabled={!closerConfirmadoId || isProcessing}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 disabled:opacity-30 text-red-400 font-medium text-sm">
            <XCircle size={14} /> {isProcessing ? '...' : 'No-show'}
          </button>
          <button onClick={() => handleConfirm(true)} disabled={!closerConfirmadoId || isProcessing}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-green-500 hover:bg-green-400 disabled:opacity-30 text-black font-bold text-sm">
            <Check size={14} /> {isProcessing ? '...' : 'Realizada'}
          </button>
        </div>
      </div>
    </div>
  );
};
