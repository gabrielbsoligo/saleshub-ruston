import React, { useState } from "react";
import { useAppStore } from "../store";
import { CANAL_LABELS } from "../types";
import { Plus, Check, X as XIcon, Calendar, Search, User } from "lucide-react";
import { DateInput } from "./ui/DateInput";
import { ConfirmarReuniaoModal } from "./ConfirmarReuniaoModal";
import type { Reuniao } from "../types";

export const ReunioesView: React.FC = () => {
  const { reunioes, leads, addReuniao, updateReuniao, members } = useAppStore();
  const sdrs = members.filter(m => m.role === 'sdr' || m.role === 'gestor');
  const closers = members.filter(m => m.role === 'closer' || m.role === 'gestor');
  const [showForm, setShowForm] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState('');
  const [leadSearch, setLeadSearch] = useState('');
  const [confirmar, setConfirmar] = useState<Reuniao | null>(null);
  const [form, setForm] = useState({ empresa: '', nome_contato: '', canal: '', sdr_id: '', closer_id: '', kommo_id: '', data_agendamento: '', data_reuniao_date: '', data_reuniao_time: '', lead_id: '' });

  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));
  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  const leadsDisponiveis = leads.filter(l =>
    ['sem_contato', 'em_follow', 'reuniao_marcada'].includes(l.status) &&
    (leadSearch ? l.empresa.toLowerCase().includes(leadSearch.toLowerCase()) : true)
  );

  const selectLead = (leadId: string) => {
    const lead = leads.find(l => l.id === leadId);
    if (lead) {
      setForm({ empresa: lead.empresa, nome_contato: lead.nome_contato || '', canal: lead.canal,
        sdr_id: lead.sdr_id || '', closer_id: '', kommo_id: lead.kommo_id || '',
        data_agendamento: new Date().toISOString().split('T')[0], data_reuniao_date: '', data_reuniao_time: '', lead_id: lead.id });
      setSelectedLeadId(lead.id);
    }
  };

  const [showReplace, setShowReplace] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const doAddReuniao = async (replace: boolean) => {
    if (!form.empresa || !form.data_reuniao_date || !form.data_reuniao_time || !form.closer_id || isProcessing) return;
    setIsProcessing(true);
    const dataReuniaoISO = new Date(`${form.data_reuniao_date}T${form.data_reuniao_time}`).toISOString();
    try {
      const { data_reuniao_date, data_reuniao_time, ...rest } = form;
      await addReuniao({
        ...rest, data_reuniao: dataReuniaoISO,
        sdr_id: form.sdr_id || undefined, closer_id: form.closer_id || undefined, lead_id: form.lead_id || undefined,
      } as any, replace);
      setForm({ empresa: '', nome_contato: '', canal: '', sdr_id: '', closer_id: '', kommo_id: '', data_agendamento: '', data_reuniao_date: '', data_reuniao_time: '', lead_id: '' });
      setSelectedLeadId('');
      setShowForm(false);
      setShowReplace(false);
    } catch (e: any) {
      if (e.message === 'REUNIAO_ATIVA_EXISTENTE') {
        setShowReplace(true);
      }
    } finally { setIsProcessing(false); }
  };

  const handleAdd = () => doAddReuniao(false);

  const handleConfirm = async (show: boolean, closerConfirmadoId: string) => {
    if (!confirmar) return;
    await updateReuniao(confirmar.id, { realizada: true, show, closer_confirmado_id: closerConfirmadoId });
    setConfirmar(null);
  };

  const hoje = new Date().toISOString().split('T')[0];
  const futuras = reunioes.filter(r => !r.realizada);
  const passadas = reunioes.filter(r => r.realizada);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Reuniões</h2>
        <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white font-medium text-sm">
          <Plus size={16} /> Agendar Reunião
        </button>
      </div>

      {showForm && (
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-white mb-3">Selecione o Lead (preenche automaticamente)</h3>
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
            <input className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm" placeholder="Buscar lead..." value={leadSearch} onChange={e => setLeadSearch(e.target.value)} />
          </div>
          {leadSearch && !selectedLeadId && (
            <div className="max-h-40 overflow-y-auto mb-3 border border-[var(--color-v4-border)] rounded-lg">
              {leadsDisponiveis.slice(0, 10).map(l => (
                <button key={l.id} onClick={() => { selectLead(l.id); setLeadSearch(''); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-v4-card-hover)] text-white border-b border-[var(--color-v4-border)] last:border-0">
                  <span className="font-medium">{l.empresa}</span>
                  <span className="text-[var(--color-v4-text-muted)] ml-2">{l.nome_contato} · {CANAL_LABELS[l.canal]}</span>
                </button>
              ))}
            </div>
          )}
          {selectedLeadId && (
            <div className="bg-[var(--color-v4-surface)] rounded-lg p-3 mb-3 flex items-center justify-between">
              <div><span className="text-sm text-white font-medium">{form.empresa}</span>
                <span className="text-xs text-[var(--color-v4-text-muted)] ml-2">{form.nome_contato}</span></div>
              <button onClick={() => { setSelectedLeadId(''); setForm(p => ({ ...p, empresa: '', nome_contato: '', canal: '', sdr_id: '', kommo_id: '', lead_id: '' })); }}
                className="text-xs text-red-400">Trocar</button>
            </div>
          )}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
            <input className={inputClass} placeholder="Empresa *" value={form.empresa} onChange={e => set('empresa', e.target.value)} />
            <input className={inputClass} placeholder="Contato" value={form.nome_contato} onChange={e => set('nome_contato', e.target.value)} />
            <select className={inputClass} value={form.sdr_id} onChange={e => set('sdr_id', e.target.value)}>
              <option value="">SDR</option>{sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className={inputClass} value={form.closer_id} onChange={e => set('closer_id', e.target.value)}>
              <option value="">Closer *</option>{closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="flex gap-2">
              <DateInput type="date" value={form.data_reuniao_date} onChange={v => set('data_reuniao_date', v)} />
              <input type="time" className={inputClass} value={form.data_reuniao_time} onChange={e => set('data_reuniao_time', e.target.value)} />
            </div>
          </div>
          <button onClick={handleAdd} disabled={!form.empresa || !form.data_reuniao_date || !form.data_reuniao_time || !form.closer_id || isProcessing}
            className="px-6 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm font-medium">
            {isProcessing ? 'Agendando...' : 'Agendar'}
          </button>
        </div>
      )}

      <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-3">Próximas ({futuras.length})</h3>
      <div className="space-y-2 mb-8">
        {futuras.map(r => (
          <div key={r.id} className="flex items-center justify-between bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-lg px-4 py-3">
            <div className="flex items-center gap-3">
              <Calendar size={16} className="text-yellow-400" />
              <div>
                <span className="text-sm text-white font-medium">{r.empresa}</span>
                {r.nome_contato && <span className="text-xs text-[var(--color-v4-text-muted)] ml-2">({r.nome_contato})</span>}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--color-v4-text-muted)]">{r.sdr?.name?.split(' ')[0]}</span>
              {r.closer && <span className="text-xs text-blue-400 flex items-center gap-1"><User size={10} />{r.closer.name.split(' ')[0]}</span>}
              <span className="text-xs text-white">{r.data_reuniao ? new Date(r.data_reuniao).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
              <button onClick={() => setConfirmar(r)}
                className="px-3 py-1.5 rounded text-xs font-medium bg-green-500/20 text-green-400 hover:bg-green-500/30">
                Confirmar
              </button>
            </div>
          </div>
        ))}
        {futuras.length === 0 && <p className="text-sm text-[var(--color-v4-text-muted)] py-4">Nenhuma reunião agendada</p>}
      </div>

      <h3 className="text-sm font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-3">Realizadas ({passadas.length})</h3>
      <div className="space-y-2">
        {passadas.slice(0, 50).map(r => (
          <div key={r.id} className="flex items-center justify-between bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-lg px-4 py-3 opacity-70">
            <div className="flex items-center gap-3">
              {r.show ? <Check size={16} className="text-green-400" /> : <XIcon size={16} className="text-red-400" />}
              <span className="text-sm text-white">{r.empresa}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--color-v4-text-muted)]">{r.sdr?.name?.split(' ')[0]}</span>
              {r.closer && <span className="text-xs text-blue-400">{r.closer.name.split(' ')[0]}</span>}
              <span className="text-xs text-[var(--color-v4-text-muted)]">{r.data_reuniao ? new Date(r.data_reuniao).toLocaleDateString('pt-BR') : '—'}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${r.show ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                {r.show ? 'Show → Deal criado' : 'No-show'}
              </span>
            </div>
          </div>
        ))}
      </div>

      {confirmar && <ConfirmarReuniaoModal reuniao={confirmar} onConfirm={handleConfirm} onClose={() => setConfirmar(null)} />}

      {showReplace && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowReplace(false)} />
          <div className="relative w-full max-w-sm bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-2">Reunião já existente</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">Este lead já tem uma reunião ativa. Deseja substituir pela nova?</p>
            <div className="flex gap-3">
              <button onClick={() => setShowReplace(false)} className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
              <button onClick={() => doAddReuniao(true)} className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-sm">Substituir</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
