import React, { useState, useEffect } from "react";
import { useAppStore } from "../store";
import { X, Save, Trash2 } from "lucide-react";
import { PRODUTOS_OT, PRODUTOS_MRR, DEAL_STATUS_LABELS, CANAL_LABELS, TIER_LABELS, type Deal, type DealStatus, type Temperatura, type DealTier } from "../types";
import { DateInput } from "./ui/DateInput";
import { MultiSelect } from "./ui/MultiSelect";
import { ContractUpload } from "./ui/ContractUpload";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";
import { validateGanho } from "../lib/ganhoValidation";

export const DealDrawer: React.FC<{ deal: Deal | null; onClose: () => void }> = ({ deal, onClose }) => {
  const { addDeal, updateDeal, deleteDeal, members } = useAppStore();
  const closers = members.filter(m => m.role === 'closer' || m.role === 'gestor');
  const sdrs = members.filter(m => m.role === 'sdr' || m.role === 'gestor');

  const [tab, setTab] = useState<'geral' | 'produtos' | 'ganho'>('geral');
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const [form, setForm] = useState({
    empresa: '', kommo_id: '', kommo_link: '', closer_id: '', sdr_id: '',
    data_call: '', data_fechamento: '', data_retorno: '',
    status: 'negociacao' as DealStatus, origem: '',
    temperatura: '' as Temperatura | '', bant: 0, motivo_perda: '',
    produtos_ot: [] as string[], produtos_mrr: [] as string[],
    valor_escopo: 0, valor_recorrente: 0,
    data_inicio_escopo: '', data_pgto_escopo: '',
    data_inicio_recorrente: '', data_pgto_recorrente: '',
    link_call_vendas: '', link_transcricao: '', contrato_url: '', contrato_filename: '',
    tier: '' as DealTier | '', observacoes: '',
  });

  useEffect(() => {
    if (deal) {
      setForm({
        empresa: deal.empresa || '', kommo_id: deal.kommo_id || '', kommo_link: deal.kommo_link || '',
        closer_id: deal.closer_id || '', sdr_id: deal.sdr_id || '',
        data_call: deal.data_call || '', data_fechamento: deal.data_fechamento || '',
        data_retorno: deal.data_retorno || '',
        status: deal.status, origem: deal.origem || '',
        temperatura: (deal.temperatura || '') as Temperatura | '', bant: deal.bant || 0,
        motivo_perda: deal.motivo_perda || '',
        produtos_ot: deal.produtos_ot || [], produtos_mrr: deal.produtos_mrr || [],
        valor_escopo: deal.valor_escopo || 0, valor_recorrente: deal.valor_recorrente || 0,
        data_inicio_escopo: deal.data_inicio_escopo || '', data_pgto_escopo: deal.data_pgto_escopo || '',
        data_inicio_recorrente: deal.data_inicio_recorrente || '', data_pgto_recorrente: deal.data_pgto_recorrente || '',
        link_call_vendas: deal.link_call_vendas || '', link_transcricao: deal.link_transcricao || '',
        contrato_url: deal.contrato_url || '', contrato_filename: deal.contrato_filename || '',
        tier: (deal.tier || '') as DealTier | '', observacoes: deal.observacoes || '',
      });
    }
  }, [deal]);

  const handleSave = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
    // Validate ganho
    if (form.status === 'contrato_assinado') {
      const result = validateGanho({ ...form, closer_id: form.closer_id, temperatura: form.temperatura, bant: form.bant });
      if (!result.valid) {
        setMissingFields(result.missing);
        return;
      }
    }

    const payload: any = { ...form, valor_mrr: form.valor_recorrente, valor_ot: form.valor_escopo };
    if (!payload.closer_id) delete payload.closer_id;
    if (!payload.sdr_id) delete payload.sdr_id;
    if (!payload.temperatura) delete payload.temperatura;
    if (!payload.bant) delete payload.bant;
    if (!payload.tier) delete payload.tier;
    Object.keys(payload).forEach(k => { if (payload[k] === '') payload[k] = null; });

    if (deal) { await updateDeal(deal.id, payload); }
    else { await addDeal(payload); }
    onClose();
    } finally { setIsProcessing(false); }
  };

  const handleDelete = async () => {
    if (isProcessing) return;
    if (deal && confirm('Excluir esta negociação?')) {
      setIsProcessing(true);
      try { await deleteDeal(deal.id); onClose(); }
      finally { setIsProcessing(false); }
    }
  };

  const set = (key: string, value: any) => setForm(prev => ({ ...prev, [key]: value }));
  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";
  const tabClass = (t: string) => `px-4 py-2 text-xs font-medium rounded-lg transition-colors ${tab === t ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)] hover:bg-[var(--color-v4-card-hover)]'}`;
  const isGanho = form.status === 'contrato_assinado';

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] overflow-y-auto">
        <div className="sticky top-0 bg-[var(--color-v4-card)] border-b border-[var(--color-v4-border)] px-6 py-4 z-10">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-display font-bold text-white">{deal ? 'Editar Negociação' : 'Nova Negociação'}</h3>
            <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={20} /></button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTab('geral')} className={tabClass('geral')}>Geral</button>
            <button onClick={() => setTab('produtos')} className={tabClass('produtos')}>Produtos</button>
            <button onClick={() => setTab('ganho')} className={tabClass('ganho')}>Fechamento</button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {tab === 'geral' && (<>
            <div><label className={labelClass}>Empresa *</label><input className={inputClass} value={form.empresa} onChange={e => set('empresa', e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelClass}>Closer</label>
                <select className={inputClass} value={form.closer_id} onChange={e => set('closer_id', e.target.value)}>
                  <option value="">Selecionar</option>{closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></div>
              <div><label className={labelClass}>SDR (origem)</label>
                <select className={inputClass} value={form.sdr_id} onChange={e => set('sdr_id', e.target.value)}>
                  <option value="">Selecionar</option>{sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelClass}>Status</label>
                <select className={inputClass} value={form.status} onChange={e => set('status', e.target.value)}>
                  {Object.entries(DEAL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div><label className={labelClass}>Origem</label>
                <select className={inputClass} value={form.origem} onChange={e => set('origem', e.target.value)}>
                  <option value="">Selecionar</option>{Object.entries(CANAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className={labelClass}>Temperatura</label>
                <select className={inputClass} value={form.temperatura} onChange={e => set('temperatura', e.target.value)}>
                  <option value="">—</option><option value="quente">🔥 Quente</option><option value="morno">🌡️ Morno</option><option value="frio">❄️ Frio</option>
                </select></div>
              <div><label className={labelClass}>BANT (1-4)</label>
                <div className="flex gap-1">{[1,2,3,4].map(n => (
                  <button key={n} type="button" onClick={() => set('bant', n)}
                    className={`flex-1 py-2 rounded text-xs font-bold ${form.bant === n ? 'bg-purple-500 text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>{n}</button>
                ))}</div></div>
              <div><label className={labelClass}>Tier</label>
                <select className={inputClass} value={form.tier} onChange={e => set('tier', e.target.value)}>
                  <option value="">—</option>{Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DateInput label="Data Call" value={form.data_call} onChange={v => set('data_call', v)} />
              <DateInput label="Data Fechamento" value={form.data_fechamento} onChange={v => set('data_fechamento', v)} />
            </div>
            <DateInput label="Data Retorno" value={form.data_retorno} onChange={v => set('data_retorno', v)} />
            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelClass}>ID Kommo</label><input className={inputClass} value={form.kommo_id} onChange={e => set('kommo_id', e.target.value)} /></div>
              <div><label className={labelClass}>Link Kommo</label><input className={inputClass} value={form.kommo_link} onChange={e => set('kommo_link', e.target.value)} /></div>
            </div>
            {form.status === 'perdido' && (
              <div><label className={labelClass}>Motivo de Perda</label><input className={inputClass} value={form.motivo_perda} onChange={e => set('motivo_perda', e.target.value)} /></div>
            )}
          </>)}

          {tab === 'produtos' && (<>
            <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
              <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-3">Escopo Fechado (OT)</h4>
              <MultiSelect options={[...PRODUTOS_OT]} selected={form.produtos_ot} onChange={v => set('produtos_ot', v)} placeholder="Selecionar produtos OT..." />
              {form.produtos_ot.length > 0 && (<>
                <div className="mt-3"><label className={labelClass}>Valor Escopo (R$) {isGanho && '*'}</label>
                  <input type="number" className={inputClass} value={form.valor_escopo} onChange={e => set('valor_escopo', Number(e.target.value))} /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <DateInput label={`Início Escopo ${isGanho ? '*' : ''}`} value={form.data_inicio_escopo} onChange={v => set('data_inicio_escopo', v)} />
                  <DateInput label={`1º Pgto Escopo ${isGanho ? '*' : ''}`} value={form.data_pgto_escopo} onChange={v => set('data_pgto_escopo', v)} />
                </div>
              </>)}
            </div>
            <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4">
              <h4 className="text-xs font-bold text-green-400 uppercase tracking-wider mb-3">Recorrente (MRR)</h4>
              <MultiSelect options={[...PRODUTOS_MRR]} selected={form.produtos_mrr} onChange={v => set('produtos_mrr', v)} placeholder="Selecionar produtos MRR..." />
              {form.produtos_mrr.length > 0 && (<>
                <div className="mt-3"><label className={labelClass}>Valor Recorrente (R$/mês) {isGanho && '*'}</label>
                  <input type="number" className={inputClass} value={form.valor_recorrente} onChange={e => set('valor_recorrente', Number(e.target.value))} /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <DateInput label={`Início Recorrente ${isGanho ? '*' : ''}`} value={form.data_inicio_recorrente} onChange={v => set('data_inicio_recorrente', v)} />
                  <DateInput label={`1º Pgto Recorrente ${isGanho ? '*' : ''}`} value={form.data_pgto_recorrente} onChange={v => set('data_pgto_recorrente', v)} />
                </div>
              </>)}
            </div>
          </>)}

          {tab === 'ganho' && (<>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Campos obrigatórios para dar ganho (status = Contrato Assinado).</p>
            <div><label className={labelClass}>Tier {isGanho && '*'}</label>
              <select className={inputClass} value={form.tier} onChange={e => set('tier', e.target.value)}>
                <option value="">Selecionar</option>{Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div><label className={labelClass}>Link Call de Vendas {isGanho && '*'}</label>
              <input className={inputClass} value={form.link_call_vendas} onChange={e => set('link_call_vendas', e.target.value)} placeholder="https://drive.google.com/..." /></div>
            <div><label className={labelClass}>Link Transcrição {isGanho && '*'}</label>
              <input className={inputClass} value={form.link_transcricao} onChange={e => set('link_transcricao', e.target.value)} placeholder="https://docs.google.com/..." /></div>
            {deal ? (
              <ContractUpload
                dealId={deal.id}
                contractUrl={form.contrato_url}
                contractFilename={form.contrato_filename}
                onUploaded={(url, name) => { set('contrato_url', url); set('contrato_filename', name); }}
                onRemoved={() => { set('contrato_url', ''); set('contrato_filename', ''); }}
              />
            ) : (
              <div><label className={labelClass}>Contrato (salve o deal primeiro para anexar)</label>
                <div className="p-3 rounded-lg bg-[var(--color-v4-surface)] text-xs text-[var(--color-v4-text-muted)]">Salve a negociação e depois anexe o contrato</div></div>
            )}
            <div><label className={labelClass}>Observações</label>
              <textarea className={inputClass + " h-20 resize-none"} value={form.observacoes} onChange={e => set('observacoes', e.target.value)} /></div>
          </>)}
        </div>

        <div className="sticky bottom-0 bg-[var(--color-v4-card)] border-t border-[var(--color-v4-border)] px-6 py-4 flex items-center gap-3">
          <button onClick={handleSave} disabled={!form.empresa || isProcessing}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white font-medium text-sm transition-colors">
            <Save size={16} /> {isProcessing ? 'Salvando...' : 'Salvar'}
          </button>
          {deal && (
            <button onClick={handleDelete} className="px-4 py-2.5 rounded-xl border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm"><Trash2 size={16} /></button>
          )}
        </div>
      </div>

      {missingFields && <MissingFieldsPopup missing={missingFields} onClose={() => setMissingFields(null)} />}
    </div>
  );
};
