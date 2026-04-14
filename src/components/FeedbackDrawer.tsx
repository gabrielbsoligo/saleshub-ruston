import React, { useState, useCallback } from "react";
import { useAppStore } from "../store";
import { X, Send, AlertCircle, ArrowRight, ArrowLeft, Sparkles, Loader2, Calendar } from "lucide-react";
import { PRODUTOS_OT, PRODUTOS_MRR, TIER_LABELS, type Deal, type DealStatus, type Temperatura, type DealTier } from "../types";
import { DateInput } from "./ui/DateInput";
import { MultiSelect } from "./ui/MultiSelect";
import { ContractUpload } from "./ui/ContractUpload";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";
import { validateGanho } from "../lib/ganhoValidation";
import { Plus, Trash2 as Trash2Icon } from "lucide-react";
import { supabase } from "../lib/supabase";
import { fetchMeetingTranscript } from "../lib/googleDrive";
import { analyzeTranscript } from "../lib/callAnalyzer";
import toast from "react-hot-toast";

type AIStatus = 'idle' | 'fetching' | 'paste' | 'analyzing' | 'done' | 'error';

export const FeedbackDrawer: React.FC<{ deal: Deal; onClose: () => void }> = ({ deal, onClose }) => {
  const { updateDeal, members, reunioes, addReuniao, fetchDeals, fetchLeads, fetchReunioes, leads } = useAppStore();
  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);

  // Buscar reuniao associada a este deal (show=true, mais recente)
  const reuniaoAssociada = reunioes
    .filter(r => r.lead_id === deal.lead_id && r.realizada && r.show)
    .sort((a, b) => new Date(b.data_reuniao || 0).getTime() - new Date(a.data_reuniao || 0).getTime())[0] || null;

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recomendacoes, setRecomendacoes] = useState<{ empresa: string; nome_contato: string; telefone: string }[]>([]);

  // AI state
  const [aiStatus, setAiStatus] = useState<AIStatus>('idle');
  const [aiError, setAiError] = useState('');
  const [manualTranscript, setManualTranscript] = useState('');
  const [aiFilledFields, setAiFilledFields] = useState<Set<string>>(new Set());
  const [contractFilledFields, setContractFilledFields] = useState<Set<string>>(new Set());
  const [contractParsing, setContractParsing] = useState(false);

  const [form, setForm] = useState({
    closer_id: deal.closer_id || '',
    temperatura: '' as Temperatura | '',
    bant: 0,
    proximo_passo: '' as DealStatus | '',
    motivo_perda: '',
    data_retorno: '',
    agendar_reuniao: false,
    resumo_call: deal.observacoes || '',
    tier: (deal.tier || '') as DealTier | '',
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
    observacoes: deal.observacoes || '',
  });

  const set = (k: string, v: any) => setForm(p => ({ ...p, [k]: v }));
  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";
  const aiHighlight = (field: string) =>
    contractFilledFields.has(field) ? 'ring-1 ring-green-500/50' :
    aiFilledFields.has(field) ? 'ring-1 ring-purple-500/50' : '';

  const step1Valid = form.closer_id && form.temperatura && form.bant && form.proximo_passo;
  const isGanho = form.proximo_passo === 'contrato_assinado';

  // ==============================
  // AI auto-fill logic
  // ==============================

  const applyAiResult = useCallback((result: any, transcriptUrl?: string, recordingUrl?: string) => {
    const filled = new Set<string>();

    if (result.temperatura) { set('temperatura', result.temperatura); filled.add('temperatura'); }
    if (result.proximo_passo) { set('proximo_passo', result.proximo_passo); filled.add('proximo_passo'); }
    if (result.bant) { set('bant', result.bant); filled.add('bant'); }
    if (result.tier) { set('tier', result.tier); filled.add('tier'); }
    if (result.resumo_executivo) { set('resumo_call', result.resumo_executivo); filled.add('resumo_call'); }
    if (result.valor_escopo > 0) { set('valor_escopo', result.valor_escopo); filled.add('valor_escopo'); }
    if (result.valor_recorrente > 0) { set('valor_recorrente', result.valor_recorrente); filled.add('valor_recorrente'); }
    if (result.produtos_ot?.length) { set('produtos_ot', result.produtos_ot); filled.add('produtos_ot'); }
    if (result.produtos_mrr?.length) { set('produtos_mrr', result.produtos_mrr); filled.add('produtos_mrr'); }
    if (transcriptUrl) { set('link_transcricao', transcriptUrl); filled.add('link_transcricao'); }
    if (recordingUrl) { set('link_call_vendas', recordingUrl); filled.add('link_call_vendas'); }

    // Próxima reunião → data_retorno + agendar
    if (result.proxima_reuniao?.data) {
      const dateStr = result.proxima_reuniao.hora
        ? `${result.proxima_reuniao.data}T${result.proxima_reuniao.hora}:00`
        : result.proxima_reuniao.data;
      set('data_retorno', dateStr);
      set('agendar_reuniao', true);
      filled.add('data_retorno');
    }

    // Indicações → recomendações
    if (result.indicacoes?.length > 0) {
      setRecomendacoes(result.indicacoes.map((ind: any) => ({
        empresa: ind.empresa || '',
        nome_contato: ind.nome || '',
        telefone: ind.telefone || '',
      })));
      filled.add('recomendacoes');
    }

    setAiFilledFields(filled);
  }, []);

  const handleAiClick = async () => {
    setAiError('');

    // Step 1: try to fetch transcript from Drive
    if (reuniaoAssociada) {
      setAiStatus('fetching');
      try {
        const result = await fetchMeetingTranscript(reuniaoAssociada.id);
        if (result.status === 'found' && result.transcript_text) {
          // Got transcript, now analyze
          setAiStatus('analyzing');
          const meetingDate = reuniaoAssociada.data_reuniao?.split('T')[0] || new Date().toISOString().split('T')[0];
          const analysis = await analyzeTranscript(result.transcript_text, meetingDate);
          applyAiResult(analysis, result.transcript_url, result.recording_url);
          setAiStatus('done');
          toast.success('Campos preenchidos pela IA!', { icon: '✨', duration: 3000 });
          return;
        }
      } catch (e: any) {
        // If it's a reauth error, show it but still allow manual paste
        if (e.message?.includes('reconectar')) {
          setAiError(e.message);
        }
      }
    }

    // No transcript found or no reunião — show paste textarea
    setAiStatus('paste');
  };

  const handleManualAnalyze = async () => {
    if (manualTranscript.trim().length < 50) {
      toast.error('Cole a transcrição completa da reunião');
      return;
    }
    setAiStatus('analyzing');
    try {
      const meetingDate = reuniaoAssociada?.data_reuniao?.split('T')[0] || new Date().toISOString().split('T')[0];
      const analysis = await analyzeTranscript(manualTranscript, meetingDate);
      applyAiResult(analysis);
      setAiStatus('done');
      toast.success('Campos preenchidos pela IA!', { icon: '✨', duration: 3000 });
    } catch (e: any) {
      setAiError(e.message || 'Erro na análise');
      setAiStatus('error');
    }
  };

  // ==============================
  // Contract parsing auto-fill
  // ==============================

  const handleContractParsed = useCallback((result: any) => {
    const filled = new Set<string>();

    if (result.produtos_ot?.length) { set('produtos_ot', result.produtos_ot); filled.add('produtos_ot'); }
    if (result.produtos_mrr?.length) { set('produtos_mrr', result.produtos_mrr); filled.add('produtos_mrr'); }
    if (result.valor_escopo > 0) { set('valor_escopo', result.valor_escopo); filled.add('valor_escopo'); }
    if (result.valor_recorrente > 0) { set('valor_recorrente', result.valor_recorrente); filled.add('valor_recorrente'); }
    if (result.data_inicio_escopo) { set('data_inicio_escopo', result.data_inicio_escopo); filled.add('data_inicio_escopo'); }
    if (result.data_pgto_escopo) { set('data_pgto_escopo', result.data_pgto_escopo); filled.add('data_pgto_escopo'); }
    if (result.data_inicio_recorrente) { set('data_inicio_recorrente', result.data_inicio_recorrente); filled.add('data_inicio_recorrente'); }
    if (result.data_pgto_recorrente) { set('data_pgto_recorrente', result.data_pgto_recorrente); filled.add('data_pgto_recorrente'); }
    if (result.tier) { set('tier', result.tier); filled.add('tier'); }

    setContractFilledFields(filled);

    // Auto-navigate to Step 2 to show contract-filled products
    if (filled.has('produtos_ot') || filled.has('produtos_mrr')) {
      setStep(2);
    }
  }, []);

  // ==============================
  // Submit
  // ==============================

  const handleSubmit = async () => {
    if (!step1Valid || isProcessing) return;
    setIsProcessing(true);
    try {
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
        data_retorno: form.data_retorno?.split('T')[0] || undefined,
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
        observacoes: form.resumo_call || form.observacoes || undefined,
        data_fechamento: isGanho ? new Date().toISOString().split('T')[0] : undefined,
      };

      await updateDeal(deal.id, updates);

      // Save recomendacoes as leads
      const validRecs = recomendacoes.filter(r => r.empresa.trim());
      if (validRecs.length > 0) {
        for (const rec of validRecs) {
          const { data: newLead } = await supabase.from('leads').insert({
            empresa: rec.empresa.trim(),
            nome_contato: rec.nome_contato.trim() || null,
            telefone: rec.telefone.trim() || null,
            canal: 'recomendacao',
            status: 'sem_contato',
            sdr_id: deal.sdr_id || null,
          }).select('id').single();

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

      // Agendar reunião de retorno se marcado
      if (form.agendar_reuniao && form.data_retorno) {
        try {
          const dataRetornoISO = form.data_retorno.includes('T')
            ? `${form.data_retorno}:00-03:00`
            : `${form.data_retorno}T10:00:00-03:00`;
          const lead = deal.lead_id ? leads.find(l => l.id === deal.lead_id) : null;
          await addReuniao({
            lead_id: deal.lead_id || undefined,
            closer_id: form.closer_id || deal.closer_id || undefined,
            sdr_id: deal.sdr_id || undefined,
            empresa: deal.empresa,
            nome_contato: deal.nome_contato,
            canal: deal.canal,
            data_agendamento: new Date().toISOString().split('T')[0],
            data_reuniao: dataRetornoISO,
            lead_email: lead?.email || undefined,
          } as any, true);
          toast.success('Reunião de retorno agendada!', { icon: '📅' });
        } catch (e: any) {
          toast.error('Erro ao agendar reunião: ' + e.message);
        }
      }

      // Record automation if AI was used
      if (aiFilledFields.size > 0 && reuniaoAssociada) {
        await supabase.from('post_meeting_automations').upsert({
          reuniao_id: reuniaoAssociada.id,
          deal_id: deal.id,
          status: 'completed',
          actions_taken: {
            deal_updated: true,
            leads_created: validRecs.length,
            meeting_scheduled: form.agendar_reuniao,
            ai_filled_fields: [...aiFilledFields],
          },
          completed_at: new Date().toISOString(),
        }, { onConflict: 'reuniao_id' });
      }

      fetchDeals();
      fetchLeads();
      fetchReunioes();
      onClose();
    } finally {
      setIsProcessing(false);
    }
  };

  const stepLabel = isGanho ? `Etapa ${step}/3` : `Etapa ${step}/2`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-4 flex items-center gap-3 flex-shrink-0">
          <AlertCircle size={20} className="text-amber-400" />
          <div className="flex-1">
            <h3 className="text-sm font-bold text-amber-400">Feedback — {deal.empresa}</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)]">{step === 1 ? 'Qualificação' : step === 2 ? 'Produtos' : 'Fechamento'}</p>
          </div>
          <button
            onClick={handleAiClick}
            disabled={aiStatus === 'fetching' || aiStatus === 'analyzing'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition-colors disabled:opacity-50"
          >
            {aiStatus === 'fetching' || aiStatus === 'analyzing'
              ? <Loader2 size={14} className="animate-spin" />
              : <Sparkles size={14} />}
            {aiStatus === 'fetching' ? 'Buscando...' : aiStatus === 'analyzing' ? 'Analisando...' : 'Preencher com IA'}
          </button>
          <span className="text-[10px] px-2 py-1 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{stepLabel}</span>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-[var(--color-v4-surface)] flex-shrink-0">
          <div className={`h-full bg-amber-400 transition-all ${step === 1 ? 'w-1/3' : step === 2 ? 'w-2/3' : 'w-full'}`} />
        </div>

        {/* AI paste modal overlay */}
        {(aiStatus === 'paste' || aiStatus === 'error') && (
          <div className="absolute inset-0 z-10 bg-black/70 flex items-center justify-center p-6">
            <div className="w-full max-w-md bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-purple-400" />
                  <span className="text-sm font-bold text-white">Preencher com IA</span>
                </div>
                <button onClick={() => setAiStatus('idle')} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={16} /></button>
              </div>

              {aiError && (
                <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <p className="text-xs text-yellow-400">{aiError}</p>
                </div>
              )}

              <div>
                <label className="block text-xs text-[var(--color-v4-text-muted)] mb-2">
                  {reuniaoAssociada ? 'Transcrição não encontrada automaticamente. Cole abaixo:' : 'Cole a transcrição da reunião:'}
                </label>
                <textarea
                  value={manualTranscript}
                  onChange={e => setManualTranscript(e.target.value)}
                  rows={8}
                  placeholder="Cole aqui a transcrição completa da call..."
                  className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-2 text-xs text-white resize-none focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">Google Meet → Registros da reunião → Transcrição</p>
              </div>

              <div className="flex gap-3">
                <button onClick={() => setAiStatus('idle')} className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
                <button onClick={handleManualAnalyze} disabled={manualTranscript.trim().length < 50}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-purple-500 hover:bg-purple-400 disabled:opacity-30 text-white font-bold text-sm">
                  <Sparkles size={14} /> Analisar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* AI loading overlay */}
        {(aiStatus === 'fetching' || aiStatus === 'analyzing') && (
          <div className="absolute inset-0 z-10 bg-black/70 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 size={32} className="text-purple-400 animate-spin" />
              <p className="text-sm text-white">{aiStatus === 'fetching' ? 'Buscando transcrição no Google Drive...' : 'Analisando call com IA...'}</p>
              <p className="text-xs text-[var(--color-v4-text-muted)]">
                {aiStatus === 'fetching' ? 'O Google Meet leva ~30 min para gerar a transcrição' : 'Extraindo dados da call...'}
              </p>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">

          {/* ======== STEP 1: Qualificação ======== */}
          {step === 1 && (<>
            <div><label className={labelClass}>Closer responsável *</label>
              <select className={`${inputClass} ${aiHighlight('closer_id')}`} value={form.closer_id} onChange={e => set('closer_id', e.target.value)}>
                <option value="">Selecionar</option>
                {closers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>

            <div><label className={labelClass}>Temperatura *</label>
              <div className="flex gap-2">
                {(['quente', 'morno', 'frio'] as const).map(t => (
                  <button key={t} type="button" onClick={() => set('temperatura', t)}
                    className={`flex-1 py-3 rounded-lg text-sm font-medium transition-colors ${
                      contractFilledFields.has('temperatura') && form.temperatura === t ? 'ring-1 ring-green-500/50 ' :
                      aiFilledFields.has('temperatura') && form.temperatura === t ? 'ring-1 ring-purple-500/50 ' : ''
                    }${form.temperatura === t
                      ? t === 'quente' ? 'bg-red-500 text-white' : t === 'morno' ? 'bg-yellow-500 text-black' : 'bg-blue-500 text-white'
                      : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:bg-[var(--color-v4-card-hover)]'
                    }`}>
                    {t === 'quente' ? '🔥 Quente' : t === 'morno' ? '🌡️ Morno' : '❄️ Frio'}
                  </button>
                ))}
              </div></div>

            <div><label className={labelClass}>BANT (1-4) *</label>
              <div className="flex gap-2">
                {[1,2,3,4].map(n => (
                  <button key={n} type="button" onClick={() => set('bant', n)}
                    className={`flex-1 py-3 rounded-lg text-lg font-bold transition-colors ${
                      contractFilledFields.has('bant') && form.bant === n ? 'ring-1 ring-green-500/50 ' :
                      aiFilledFields.has('bant') && form.bant === n ? 'ring-1 ring-purple-500/50 ' : ''
                    }${form.bant === n ? 'bg-purple-500 text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>{n}</button>
                ))}
              </div></div>

            <div><label className={labelClass}>Tier</label>
              <select className={`${inputClass} ${aiHighlight('tier')}`} value={form.tier} onChange={e => set('tier', e.target.value)}>
                <option value="">Selecionar</option>
                {Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>

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
                    className={`py-3 px-3 rounded-lg text-xs font-medium border transition-colors ${
                      contractFilledFields.has('proximo_passo') && form.proximo_passo === opt.value ? 'ring-1 ring-green-500/50 ' :
                      aiFilledFields.has('proximo_passo') && form.proximo_passo === opt.value ? 'ring-1 ring-purple-500/50 ' : ''
                    }${form.proximo_passo === opt.value ? opt.color + ' border-current' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] border-transparent'}`}>{opt.label}</button>
                ))}
              </div></div>

            {form.proximo_passo === 'perdido' && (
              <div><label className={labelClass}>Motivo da perda *</label><input className={inputClass} value={form.motivo_perda} onChange={e => set('motivo_perda', e.target.value)} /></div>
            )}

            {(form.proximo_passo === 'follow_longo' || form.proximo_passo === 'negociacao' || form.proximo_passo === 'contrato_na_rua') && (
              <div className={`bg-[var(--color-v4-surface)] rounded-xl p-4 ${aiHighlight('data_retorno')}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-yellow-400" />
                    <span className="text-xs font-bold text-white uppercase">Data de Retorno</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={form.agendar_reuniao} onChange={e => set('agendar_reuniao', e.target.checked)}
                      className="rounded border-[var(--color-v4-border)]" />
                    <span className="text-xs text-[var(--color-v4-text-muted)]">Agendar reunião</span>
                  </label>
                </div>
                <div className="flex gap-3">
                  <input type="date" value={form.data_retorno?.split('T')[0] || ''} onChange={e => {
                    const time = form.data_retorno?.includes('T') ? form.data_retorno.split('T')[1] : '10:00';
                    set('data_retorno', e.target.value ? `${e.target.value}T${time}` : '');
                  }} className={`flex-1 ${inputClass}`} />
                  {form.agendar_reuniao && (
                    <input type="time" value={form.data_retorno?.includes('T') ? form.data_retorno.split('T')[1]?.slice(0, 5) : '10:00'} onChange={e => {
                      const date = form.data_retorno?.split('T')[0] || '';
                      if (date) set('data_retorno', `${date}T${e.target.value}`);
                    }} className={`w-28 ${inputClass}`} />
                  )}
                </div>
              </div>
            )}

            <div>
              <label className={labelClass}>Resumo da Call {aiFilledFields.has('resumo_call') && <span className="text-purple-400 ml-1">✨ IA</span>}</label>
              <textarea
                className={`${inputClass} h-20 resize-none ${aiHighlight('resumo_call')}`}
                value={form.resumo_call}
                onChange={e => set('resumo_call', e.target.value)}
                placeholder="Resumo executivo da reunião..."
              />
            </div>
          </>)}

          {/* ======== STEP 2: Produtos & Recomendações ======== */}
          {step === 2 && (<>
            {/* Recomendações */}
            <div className={`bg-purple-500/5 border border-purple-500/20 rounded-xl p-4 mb-4 ${aiHighlight('recomendacoes')}`}>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-purple-400 uppercase">
                  Recomendações Coletadas {aiFilledFields.has('recomendacoes') && <span className="ml-1">✨</span>}
                </h4>
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

            {/* OT */}
            <div className={`bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 ${aiHighlight('produtos_ot')}`}>
              <h4 className="text-xs font-bold text-blue-400 uppercase mb-3">
                Escopo Fechado (OT) {contractFilledFields.has('produtos_ot') ? <span className="ml-1 text-green-400">📄 Contrato</span> : aiFilledFields.has('produtos_ot') ? <span className="ml-1">✨</span> : null}
              </h4>
              <MultiSelect options={[...PRODUTOS_OT]} selected={form.produtos_ot} onChange={v => set('produtos_ot', v)} placeholder="Produtos OT..." />
              {form.produtos_ot.length > 0 && (<>
                <div className="mt-3"><label className={labelClass}>Valor Escopo (R$) {isGanho && '*'}</label>
                  <input type="number" className={`${inputClass} ${aiHighlight('valor_escopo')}`} value={form.valor_escopo} onChange={e => set('valor_escopo', Number(e.target.value))} /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <DateInput label={`Início Escopo ${isGanho ? '*' : ''}`} value={form.data_inicio_escopo} onChange={v => set('data_inicio_escopo', v)} />
                  <DateInput label={`1º Pgto Escopo ${isGanho ? '*' : ''}`} value={form.data_pgto_escopo} onChange={v => set('data_pgto_escopo', v)} />
                </div>
              </>)}
            </div>

            {/* MRR */}
            <div className={`bg-green-500/5 border border-green-500/20 rounded-xl p-4 ${aiHighlight('produtos_mrr')}`}>
              <h4 className="text-xs font-bold text-green-400 uppercase mb-3">
                Recorrente (MRR) {contractFilledFields.has('produtos_mrr') ? <span className="ml-1 text-green-400">📄 Contrato</span> : aiFilledFields.has('produtos_mrr') ? <span className="ml-1">✨</span> : null}
              </h4>
              <MultiSelect options={[...PRODUTOS_MRR]} selected={form.produtos_mrr} onChange={v => set('produtos_mrr', v)} placeholder="Produtos MRR..." />
              {form.produtos_mrr.length > 0 && (<>
                <div className="mt-3"><label className={labelClass}>Valor Recorrente (R$/mês) {isGanho && '*'}</label>
                  <input type="number" className={`${inputClass} ${aiHighlight('valor_recorrente')}`} value={form.valor_recorrente} onChange={e => set('valor_recorrente', Number(e.target.value))} /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <DateInput label={`Início Recorrente ${isGanho ? '*' : ''}`} value={form.data_inicio_recorrente} onChange={v => set('data_inicio_recorrente', v)} />
                  <DateInput label={`1º Pgto Recorrente ${isGanho ? '*' : ''}`} value={form.data_pgto_recorrente} onChange={v => set('data_pgto_recorrente', v)} />
                </div>
              </>)}
            </div>
          </>)}

          {/* ======== STEP 3: Fechamento ======== */}
          {step === 3 && (<>
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-center">
              <p className="text-sm text-green-400 font-bold">Dados de Fechamento</p>
              <p className="text-xs text-[var(--color-v4-text-muted)]">Obrigatório para confirmar o ganho</p>
            </div>

            <div><label className={labelClass}>Link Call de Vendas *</label>
              <input className={`${inputClass} ${aiHighlight('link_call_vendas')}`} value={form.link_call_vendas} onChange={e => set('link_call_vendas', e.target.value)} placeholder="https://drive.google.com/..." /></div>
            <div><label className={labelClass}>Link Transcrição *</label>
              <input className={`${inputClass} ${aiHighlight('link_transcricao')}`} value={form.link_transcricao} onChange={e => set('link_transcricao', e.target.value)} placeholder="https://docs.google.com/..." /></div>
            <ContractUpload
              dealId={deal.id}
              contractUrl={form.contrato_url}
              contractFilename={form.contrato_filename}
              onUploaded={(url, name) => { set('contrato_url', url); set('contrato_filename', name); }}
              onRemoved={() => { set('contrato_url', ''); set('contrato_filename', ''); }}
              onParsing={setContractParsing}
              onParsed={handleContractParsed}
            />
            {contractParsing && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                <Loader2 size={14} className="text-green-400 animate-spin" />
                <span className="text-xs text-green-400">📄 Extraindo produtos, preços e datas do contrato...</span>
              </div>
            )}
            <div><label className={labelClass}>Observações</label>
              <textarea className={inputClass + " h-20 resize-none"} value={form.observacoes} onChange={e => set('observacoes', e.target.value)} /></div>
          </>)}
        </div>

        {/* Footer */}
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
    </div>
  );
};
