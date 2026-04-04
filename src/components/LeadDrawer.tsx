import React, { useState, useEffect } from "react";
import { useAppStore } from "../store";
import { X, Save, Trash2 } from "lucide-react";
import { CANAL_LABELS, ALL_PRODUTOS, type Lead, type LeadCanal } from "../types";
import { DateInput } from "./ui/DateInput";
import toast from "react-hot-toast";

// Status que o usuario pode selecionar manualmente
const EDITABLE_STATUSES = [
  { value: 'sem_contato', label: 'Sem Contato' },
  { value: 'em_follow', label: 'Em Follow' },
  { value: 'reuniao_marcada', label: 'Reunião Marcada' },
  { value: 'reuniao_realizada', label: 'Reunião Realizada' },
  { value: 'noshow', label: 'No Show' },
  { value: 'perdido', label: 'Perdido' },
  { value: 'estorno', label: 'Estorno' },
];

export const LeadDrawer: React.FC<{ lead: Lead | null; onClose: () => void }> = ({ lead, onClose }) => {
  const { addLead, updateLead, deleteLead, members } = useAppStore();
  // Filtrar apenas membros ativos
  const sdrs = members.filter(m => (m.role === 'sdr' || m.role === 'gestor') && m.active);

  const [form, setForm] = useState({
    empresa: '', nome_contato: '', telefone: '', email: '', cnpj: '', faturamento: '',
    canal: 'blackbox' as LeadCanal, fonte: '', produto: '', sdr_id: '',
    kommo_id: '', kommo_link: '', mktlab_link: '', status: 'sem_contato',
    data_cadastro: '', valor_lead: 0,
  });

  useEffect(() => {
    if (lead) {
      setForm({
        empresa: lead.empresa || '', nome_contato: lead.nome_contato || '',
        telefone: lead.telefone || '', email: lead.email || '', cnpj: lead.cnpj || '',
        faturamento: lead.faturamento || '', canal: lead.canal,
        fonte: lead.fonte || '', produto: lead.produto || '',
        sdr_id: lead.sdr_id || '', kommo_id: lead.kommo_id || '',
        kommo_link: lead.kommo_link || '', mktlab_link: lead.mktlab_link || '', status: lead.status,
        data_cadastro: lead.data_cadastro || '', valor_lead: lead.valor_lead || 0,
      });
    }
  }, [lead]);

  const [isProcessing, setIsProcessing] = useState(false);

  const handleSave = async () => {
    if (isProcessing || !form.empresa) return;
    setIsProcessing(true);
    try {
      // Limpar campos vazios - converter "" pra null pra evitar erros de tipo no Supabase
      const payload: any = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === '' || v === null || v === undefined) {
          payload[k] = null;
        } else if (v === 0 && k === 'valor_lead') {
          payload[k] = null;
        } else {
          payload[k] = v;
        }
      }
      // empresa e canal sao obrigatorios, nao podem ser null
      payload.empresa = form.empresa;
      payload.canal = form.canal;
      payload.status = form.status || 'sem_contato';
      if (!payload.sdr_id) delete payload.sdr_id;

      if (lead) { await updateLead(lead.id, payload); }
      else { await addLead(payload); }
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao salvar lead');
    } finally { setIsProcessing(false); }
  };

  const handleDelete = async () => {
    if (isProcessing) return;
    if (lead && confirm('Excluir este lead?')) {
      setIsProcessing(true);
      try { await deleteLead(lead.id); onClose(); }
      finally { setIsProcessing(false); }
    }
  };

  const set = (key: string, value: any) => setForm(prev => ({ ...prev, [key]: value }));
  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] overflow-y-auto">
        <div className="sticky top-0 bg-[var(--color-v4-card)] border-b border-[var(--color-v4-border)] px-6 py-4 flex items-center justify-between z-10">
          <h3 className="text-lg font-display font-bold text-white">{lead ? 'Editar Lead' : 'Novo Lead'}</h3>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={20} /></button>
        </div>

        <div className="p-6 space-y-4">
          <div><label className={labelClass}>Empresa *</label><input className={inputClass} value={form.empresa} onChange={e => set('empresa', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Contato</label><input className={inputClass} value={form.nome_contato} onChange={e => set('nome_contato', e.target.value)} /></div>
            <div><label className={labelClass}>Telefone</label><input className={inputClass} value={form.telefone} onChange={e => set('telefone', e.target.value)} /></div>
          </div>
          <div><label className={labelClass}>Email</label><input type="email" className={inputClass} value={form.email || ''} onChange={e => set('email', e.target.value)} placeholder="email@empresa.com" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>CNPJ</label><input className={inputClass} value={form.cnpj} onChange={e => set('cnpj', e.target.value)} /></div>
            <div><label className={labelClass}>Faturamento</label>
              <select className={inputClass} value={form.faturamento} onChange={e => set('faturamento', e.target.value)}>
                <option value="">Selecionar</option>
                <option>Até 50 mil</option>
                <option>De 51 mil à 70 mil</option>
                <option>De 71 mil à 100 mil</option>
                <option>De 101 mil à 200 mil</option>
                <option>De 201 mil à 400 mil</option>
                <option>De 401 mil à 1 milhão</option>
                <option>De 1 a 4 milhões</option>
                <option>De 4 a 16 milhões</option>
                <option>De 16 a 40 milhões</option>
                <option>Acima de 40 milhões</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Canal *</label>
              <select className={inputClass} value={form.canal} onChange={e => set('canal', e.target.value)}>
                {Object.entries(CANAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div><label className={labelClass}>Fonte</label>
              <select className={inputClass} value={form.fonte} onChange={e => set('fonte', e.target.value)}>
                <option value="">Selecionar</option>
                <option value="GOOGLE">Google</option>
                <option value="FACEBOOK">Facebook</option>
                <option value="ORGANICO">Orgânico</option>
                <option value="OUTRO">Outro</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>Produto</label>
              <select className={inputClass} value={form.produto} onChange={e => set('produto', e.target.value)}>
                <option value="">Selecionar</option>
                {ALL_PRODUTOS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div><label className={labelClass}>SDR</label>
              <select className={inputClass} value={form.sdr_id} onChange={e => set('sdr_id', e.target.value)}>
                <option value="">Selecionar</option>
                {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div><label className={labelClass}>Status</label>
            <select className={inputClass} value={form.status} onChange={e => set('status', e.target.value)}>
              {EDITABLE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>ID Kommo</label><input className={inputClass} value={form.kommo_id} onChange={e => set('kommo_id', e.target.value)} /></div>
            <DateInput label="Data Cadastro" value={form.data_cadastro} onChange={v => set('data_cadastro', v)} />
          </div>
          <div>
            <label className={labelClass}>Link Kommo</label>
            <div className="flex gap-2">
              <input className={inputClass + " flex-1"} value={form.kommo_link} onChange={e => set('kommo_link', e.target.value)} />
              {form.kommo_link && (
                <a href={form.kommo_link} target="_blank" rel="noopener"
                  className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white text-sm flex items-center">
                  Abrir ↗
                </a>
              )}
            </div>
          </div>
          <div>
            <label className={labelClass}>Link MKTLAB</label>
            <div className="flex gap-2">
              <input className={inputClass + " flex-1"} value={form.mktlab_link} onChange={e => set('mktlab_link', e.target.value)} placeholder="Preenchido automaticamente pela extensão" />
              {form.mktlab_link && (
                <a href={form.mktlab_link} target="_blank" rel="noopener"
                  className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white text-sm flex items-center">
                  Abrir ↗
                </a>
              )}
            </div>
          </div>
          {form.canal === 'leadbroker' && (
            <div><label className={labelClass}>Valor do Lead (R$)</label><input type="number" className={inputClass} value={form.valor_lead} onChange={e => set('valor_lead', Number(e.target.value))} /></div>
          )}
        </div>

        <div className="sticky bottom-0 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)] px-6 py-4 flex items-center gap-3">
          <button onClick={handleSave} disabled={!form.empresa || isProcessing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white font-medium text-sm transition-colors">
            <Save size={16} /> {isProcessing ? 'Salvando...' : 'Salvar'}
          </button>
          {lead && (
            <button onClick={handleDelete} className="px-4 py-2.5 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm transition-colors">
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
