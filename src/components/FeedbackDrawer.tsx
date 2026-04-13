import React, { useState } from "react";
import { useAppStore } from "../store";
import { X, Send, AlertCircle, ArrowRight, ArrowLeft, Sparkles } from "lucide-react";
import { PRODUTOS_OT, PRODUTOS_MRR, TIER_LABELS, type Deal, type DealStatus, type Temperatura, type DealTier } from "../types";
import { DateInput } from "./ui/DateInput";
import { MultiSelect } from "./ui/MultiSelect";
import { ContractUpload } from "./ui/ContractUpload";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";
import { validateGanho } from "../lib/ganhoValidation";
import { Plus, Trash2 as Trash2Icon } from "lucide-react";
import { supabase } from "../lib/supabase";
import { PostMeetingReviewModal } from "./PostMeetingReviewModal";
import toast from "react-hot-toast";

export const FeedbackDrawer: React.FC<{ deal: Deal; onClose: () => void }> = ({ deal, onClose }) => {
  const { updateDeal, members, reunioes } = useAppStore();
  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const [showPostMeeting, setShowPostMeeting] = useState(false);

  // Buscar reuniao associada a este deal (show=true, de fato a MAIS recente).
  // .find retornava a primeira do array; a ordem de reunioes não garante recência.
  const reuniaoAssociada = reunioes
    .filter(r => r.lead_id === deal.lead_id && r.realizada && r.show)
    .sort((a, b) => new Date(b.data_reuniao || 0).getTime() - new Date(a.data_reuniao || 0).getTime())[0] || null;

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recomendacoes, setRecomendacoes] = useState<{ empresa: string; nome_contato: string; telefone: string }[]>([]);
  const [form, setForm] = useState({
    closer_id: deal.closer_id || '',
    temperatura: '' as Temperatura | '',
    bant: 0,
    proximo_passo: '' as DealStatus | '',
    motivo_perda: '',
    data_retorno: '',
    produtos_ot: deal.produtos_ot || [] as string[],
    produtos_mrr: deal.produtos_mrr || [] as string[],
    valor_escopo: deal.valor_escopo || 0,
    valor_recorrente: deal.valor_recorrente || 0,
    data_inicio_escopo: deal.data_inicio_escopo || '',
    data_pgto_escopo: deal.data_pgto_escopo || '',
    data_inicio_recorrente: deal.data_inicio_recorrente || '',
    data_pgto_recorrente: deal.data_pgto_recorrente || '',
    link_call_vendas: deal.link_call_vendas || '',
    link_transcricao: deal.link_transcricao || '',
    contrato_url: deal.contrato_url || '',
    contrato_filename: deal.contrato_filename || '',
    tier: (deal.tier || '') as DealTier | '',
    observacoes: deal.observacoes || '',
  });

  const set = (k: string, v: any) => setForm(p => ({ ...p, [k]: v }));
  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";

  const step1Valid = form.closer_id && form.temperatura && form.bant && form.proximo_passo;
  const isGanho = form.proximo_passo === 'contrato_assinado';

  const handleSubmit = async () => {
    if (!step1Valid || isProcessing) return;
    setIsProcessing(true);
    try {

    // Validate ganho fields
    if (isGanho) {
      const result = validateGanho({ ...form, closer_id: form.closer_id, temperatura: form.temperatura, bant: form.bant });
      if (!result.valid) {
        setMissingFields(result.missing);
        return;
      }
    }

    const updates: Partial<Deal> = {
      closer_id: form.closer_id,
      temperatura: form.temperatura as Temperatura,
      bant: form.bant,
      status: form.proximo_passo as DealStatus,
      motivo_perda: form.proximo_passo === 'perdido' ? form.motivo_perda : undefined,
      data_retorno: form.data_retorno || undefined,
      produtos_ot: form.produtos_ot,
      produtos_mrr: form.produtos_mrr,
      valor_escopo: form.valor_escopo,
      valor_recorrente: form.valor_recorrente,
      valor_ot: form.valor_escopo,
      valor_mrr: form.valor_recorrente,
      data_inicio_escopo: form.data_inicio_escopo || undefined,
      data_pgto_escopo: form.data_pgto_escopo || undefined,
      data_inicio_recorrente: form.data_inicio_recorrente || undefined,
      data_pgto_recorrente: form.data_pgto_recorrente || undefined,
      link_call_vendas: form.link_call_vendas || undefined,
      link_transcricao: form.link_transcricao || undefined,
      contrato_url: form.contrato_url || undefined,
      contrato_filename: form.contrato_filename || undefined,
      tier: form.tier as DealTier || undefined,
      observacoes: form.observacoes || undefined,
      data_fechamento: isGanho ? new Date().toISOString().split('T')[0] : undefined,
    };

    await updateDeal(deal.id, updates);

    // Save recomendacoes and create leads
    const validRecs = recomendacoes.filter(r => r.empresa.trim());
    if (validRecs.length > 0) {
      for (const rec of validRecs) {
        // Create lead from recommendation
        const { data: newLead } = await supabase.from('leads').insert({
          empresa: rec.empresa.trim(),
          nome_contato: rec.nome_contato.trim() || null,
          telefone: rec.telefone.trim() || null,
          canal: 'recomendacao',
          status: 'sem_contato',
          sdr_id: deal.sdr_id || null,
        }).select('id').single();

        // Save recomendacao record
        await supabase.from('recomendacoes').insert({
          deal_id: deal.id,
          closer_id: form.closer_id || deal.closer_id,
          sdr_id: deal.sdr_id || null,
          empresa: rec.empresa.trim(),
          nome_contato: rec.nome_contato.trim() || null,
          telefone: rec.telefone.trim() || null,
          lead_criado_id: newLead?.id || null,
        });
      }
      toast.success(`${validRecs.length} recomendação(ões) salva(s) como lead!`, { icon: '🎯' });
    }

    onClose();
    } finally { setIsProcessing(false); }
  };

  const stepLabel = isGanho ? `Etapa ${step}/3` : `Etapa ${step}/2`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-4 flex items-center gap-3 flex-shrink-0">
          <AlertCircle size={20} className="text-amber-400" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-amber-400">Feedback - {deal.empresa}</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)]">{step === 1 ? 'Qualificação' : step === 2 ? 'Produtos' : 'Fechamento'}</p>
          </div>
          {reuniaoAssociada && (
            <button onClick={() => setShowPostMeeting(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors">
              <Sparkles size={14} />
              Preencher com IA
            </button>
          )}
          <span className="text-[10px] px-2 py-1 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{stepLabel}</span>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>

        <div className="h-1 bg-[var(--color-v4-surface)] flex-shrink-0">
          <div className={`h-full bg-amber-400 transition-all ${step === 1 ? 'w-1/3' : step === 2 ? 'w-2/3' : 'w-full'}`} />
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {step === 1 && (<>
            <div><label className={labelClass}>Closer responsável *</label>
              <select className={inputClass} value={form.closer_id} onChange={e => set('closer_id', e.target.value)}>
                <option value="">Selecionar</option>
                {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>

            <div><label className={labelClass}>Temperatura *</label>
              <div className="flex gap-2">
                {(['quente', 'morno', 'frio'] as const).map(t => (
                  <button key={t} type="button" onClick={() => set('temperatura', t)}
                    className={`flex-1 py-3 rounded-lg text-sm font-medium transition-colors ${form.temperatura === t ? t === 'quente' ? 'bg-red-500 text-white' : t === 'morno' ? 'bg-yellow-500 text-black' : 'bg-blue-500 text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:bg-[var(--color-v4-card-hover)]'}`}>
                    {t === 'quente' ? '🔥 Quente' : t === 'morno' ? '🌡️ Morno' : '❄️ Frio'}
                  </button>
                ))}
              </div></div>

            <div><label className={labelClass}>BANT (1-4) *</label>
              <div className="flex gap-2">
                {[1,2,3,4].map(n => (
                  <button key={n} type="button" onClick={() => set('bant', n)}
                    className={`flex-1 py-3 rounded-lg text-lg font-bold transition-colors ${form.bant === n ? 'bg-purple-500 text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>{n}</button>
                ))}
              </div></div>

            <div><label className={labelClass}>Próximo passo *</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'negociacao', label: '📋 Em Negociação', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
                  { value: 'contrato_na_rua', label: '📝 Contrato na Rua', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
                  { value: 'contrato_assinado', label: '✅ Fechou!', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
                  { value: 'follow_longo', label: '⏳ Follow Longo', color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
                  { value: 'perdido', label: '❌ Perdido', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
                ].map(opt => (
                  <button key={opt.value} type="button" onClick={() => set('proximo_passo', opt.value)}
                    className={`py-3 px-3 rounded-lg text-xs font-medium border transition-colors ${form.proximo_passo === opt.value ? opt.color + ' border-current' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] border-transparent'}`}>{opt.label}</button>
                ))}
              </div></div>

            {form.proximo_passo === 'perdido' && (
              <div><label className={labelClass}>Motivo da perda *</label><input className={inputClass} value={form.motivo_perda} onChange={e => set('motivo_perda', e.target.value)} /></div>
            )}
            {(form.proximo_passo === 'follow_longo' || form.proximo_passo === 'negociacao') && (
              <DateInput label="Data de retorno" value={form.data_retorno} onChange={v => set('data_retorno', v)} />
            )}
          </>)}

          {step === 2 && (<>
            {/* Recomendacoes */}
            <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-purple-400 uppercase">Recomendações Coletadas</h4>
                <button type="button" onClick={() => setRecomendacoes(prev => [...prev, { empresa: '', nome_contato: '', telefone: '' }])}
                  className="flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300">
                  <Plus size={12} /> Adicionar
                </button>
              </div>
              {recomendacoes.length === 0 && <p className="text-xs text-[var(--color-v4-text-muted)]">Nenhuma recomendação coletada nesta reunião</p>}
              {recomendacoes.map((rec, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input className={inputClass + " flex-1"} placeholder="Empresa *" value={rec.empresa}
                    onChange={e => setRecomendacoes(prev => prev.map((r, j) => j === i ? { ...r, empresa: e.target.value } : r))} />
                  <input className={inputClass + " flex-1"} placeholder="Contato" value={rec.nome_contato}
                    onChange={e => setRecomendacoes(prev => prev.map((r, j) => j === i ? { ...r, nome_contato: e.target.value } : r))} />
                  <input className={inputClass + " flex-1"} placeholder="Telefone" value={rec.telefone}
                    onChange={e => setRecomendacoes(prev => prev.map((r, j) => j === i ? { ...r, telefone: e.target.value } : r))} />
                  <button type="button" onClick={() => setRecomendacoes(prev => prev.filter((_, j) => j !== i))}
                    className="p-2 text-red-400 hover:text-red-300"><Trash2Icon size={14} /></button>
                </div>
              ))}
            </div>

            <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
              <h4 className="text-xs font-bold text-blue-400 uppercase mb-3">Escopo Fechado (OT)</h4>
              <MultiSelect options={[...PRODUTOS_OT]} selected={form.produtos_ot} onChange={v => set('produtos_ot', v)} placeholder="Produtos OT..." />
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
              <h4 className="text-xs font-bold text-green-400 uppercase mb-3">Recorrente (MRR)</h4>
              <MultiSelect options={[...PRODUTOS_MRR]} selected={form.produtos_mrr} onChange={v => set('produtos_mrr', v)} placeholder="Produtos MRR..." />
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

          {step === 3 && (<>
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-center">
              <p className="text-sm text-green-400 font-bold">Dados de Fechamento</p>
              <p className="text-xs text-[var(--color-v4-text-muted)]">Obrigatório para confirmar o ganho</p>
            </div>

            <div><label className={labelClass}>Tier *</label>
              <select className={inputClass} value={form.tier} onChange={e => set('tier', e.target.value)}>
                <option value="">Selecionar</option>
                {Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div><label className={labelClass}>Link Call de Vendas *</label>
              <input className={inputClass} value={form.link_call_vendas} onChange={e => set('link_call_vendas', e.target.value)} placeholder="https://drive.google.com/..." /></div>
            <div><label className={labelClass}>Link Transcrição *</label>
              <input className={inputClass} value={form.link_transcricao} onChange={e => set('link_transcricao', e.target.value)} placeholder="https://docs.google.com/..." /></div>
            <ContractUpload
              dealId={deal.id}
              contractUrl={form.contrato_url}
              contractFilename={form.contrato_filename}
              onUploaded={(url, name) => { set('contrato_url', url); set('contrato_filename', name); }}
              onRemoved={() => { set('contrato_url', ''); set('contrato_filename', ''); }}
            />
            <div><label className={labelClass}>Observações</label>
              <textarea className={inputClass + " h-20 resize-none"} value={form.observacoes} onChange={e => set('observacoes', e.target.value)} /></div>
          </>)}
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-v4-border)] flex-shrink-0">
          {step === 1 && (
            <button onClick={() => setStep(2)} disabled={!step1Valid}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-30 text-black font-bold text-sm">
              Próximo: Produtos <ArrowRight size={14} />

            </button>
          )}
          {step === 2 && !isGanho && (
            <div className="flex gap-3">
              <button onClick={() => setStep(1)} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm"><ArrowLeft size={14} /> Voltar</button>
              <button onClick={handleSubmit} disabled={isProcessing} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-30 text-black font-bold text-sm"><Send size={14} /> {isProcessing ? 'Enviando...' : 'Enviar Feedback'}</button>
            </div>
          )}
          {step === 2 && isGanho && (
            <div className="flex gap-3">
              <button onClick={() => setStep(1)} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm"><ArrowLeft size={14} /> Voltar</button>
              <button onClick={() => setStep(3)} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-green-500 hover:bg-green-400 text-black font-bold text-sm">Próximo: Fechamento <ArrowRight size={14} /></button>
            </div>
          )}
          {step === 3 && (
            <div className="flex gap-3">
              <button onClick={() => setStep(2)} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm"><ArrowLeft size={14} /> Voltar</button>
              <button onClick={handleSubmit} disabled={isProcessing} className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-green-500 hover:bg-green-400 disabled:opacity-30 text-black font-bold text-sm"><Send size={14} /> {isProcessing ? 'Processando...' : 'Confirmar Ganho'}</button>
            </div>
          )}
          {step === 1 && !step1Valid && <p className="text-[10px] text-[var(--color-v4-text-muted)] text-center mt-2">Preencha closer, temperatura, BANT e próximo passo</p>}
        </div>
      </div>

      {missingFields && <MissingFieldsPopup missing={missingFields} onClose={() => setMissingFields(null)} />}
      {showPostMeeting && reuniaoAssociada && (
        <PostMeetingReviewModal
          reuniao={reuniaoAssociada}
          onClose={() => { setShowPostMeeting(false); onClose(); }}
        />
      )}
    </div>
  );
};
