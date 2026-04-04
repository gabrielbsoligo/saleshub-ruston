import React, { useState } from "react";
import { X, Calendar, Check, Plus, Video } from "lucide-react";
import { DateInput } from "./ui/DateInput";
import type { Lead } from "../types";
import { CANAL_LABELS } from "../types";
import { useAppStore } from "../store";

interface Props {
  lead: Lead;
  onConfirm: (dataReuniaoISO: string, closerId: string, participantesExtras?: string[], leadEmail?: string) => void;
  onClose: () => void;
}

export const AgendarReuniaoModal: React.FC<Props> = ({ lead, onConfirm, onClose }) => {
  const { members } = useAppStore();
  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [closerId, setCloserId] = useState('');
  const [leadEmail, setLeadEmail] = useState((lead as any).email || '');
  const [extraEmails, setExtraEmails] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";

  const selectedCloser = members.find(m => m.id === closerId);
  const calendarConnected = selectedCloser?.google_calendar_connected;

  const handleConfirm = () => {
    if (!date || !time || !closerId || isProcessing) return;
    setIsProcessing(true);
    const iso = new Date(`${date}T${time}`).toISOString();
    const extras = extraEmails.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes('@'));
    onConfirm(iso, closerId, extras.length > 0 ? extras : undefined, leadEmail || undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-5 py-4 flex items-center gap-3">
          <Calendar size={18} className="text-yellow-400" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-yellow-400">Agendar Reunião</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)]">{lead.empresa}</p>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-[var(--color-v4-surface)] rounded-lg p-3">
            <p className="text-sm text-white font-medium">{lead.empresa}</p>
            <p className="text-xs text-[var(--color-v4-text-muted)]">
              {lead.nome_contato || 'Sem contato'} · {CANAL_LABELS[lead.canal]} · SDR: {lead.sdr?.name?.split(' ')[0] || '—'}
            </p>
          </div>

          <div>
            <label className={labelClass}>Closer que vai atender *</label>
            <select className={inputClass} value={closerId} onChange={e => setCloserId(e.target.value)}>
              <option value="">Selecionar closer</option>
              {closers.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.google_calendar_connected ? '📅' : ''}
                </option>
              ))}
            </select>
            {closerId && !calendarConnected && (
              <p className="text-[10px] text-yellow-400 mt-1">⚠️ Closer não conectou Google Calendar. Evento não será criado automaticamente.</p>
            )}
            {closerId && calendarConnected && (
              <p className="text-[10px] text-green-400 mt-1">✅ Google Calendar conectado - evento será criado com Google Meet</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <DateInput label="Data *" value={date} onChange={setDate} type="date" />
            <div>
              <label className={labelClass}>Horário *</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className={inputClass} />
            </div>
          </div>

          <div>
            <label className={labelClass}>Email do Lead (para convite)</label>
            <input type="email" className={inputClass} value={leadEmail} onChange={e => setLeadEmail(e.target.value)} placeholder="email@empresa.com" />
          </div>

          <div>
            <label className={labelClass}>Participantes extras (emails separados por vírgula)</label>
            <input className={inputClass} value={extraEmails} onChange={e => setExtraEmails(e.target.value)} placeholder="pessoa1@email.com, pessoa2@email.com" />
          </div>
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-v4-border)] flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
          <button onClick={handleConfirm} disabled={!date || !time || !closerId || isProcessing}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 disabled:opacity-30 text-black font-bold text-sm">
            {calendarConnected && <Video size={14} />}
            <Check size={14} /> {isProcessing ? 'Agendando...' : 'Agendar'}
          </button>
        </div>
      </div>
    </div>
  );
};
