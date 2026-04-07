import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store';
import { X as XIcon, Sparkles, Loader2, Check, AlertTriangle, Calendar, Users, FileText, ThermometerSun, DollarSign, Package, Target, Building2 } from 'lucide-react';
import { fetchMeetingTranscript } from '../lib/googleDrive';
import { analyzeTranscript } from '../lib/callAnalyzer';
import { supabase } from '../lib/supabase';
import type { Reuniao, CallAnalysisResult, Deal } from '../types';
import { TEMPERATURA_LABELS, TIER_LABELS } from '../types';
import toast from 'react-hot-toast';

type Step = 'fetching' | 'not_found' | 'analyzing' | 'review' | 'applying' | 'done' | 'error';

interface Props {
  reuniao: Reuniao;
  onClose: () => void;
}

export const PostMeetingReviewModal: React.FC<Props> = ({ reuniao, onClose }) => {
  const { deals, updateDeal, addLead, fetchDeals, fetchLeads, fetchReunioes, members } = useAppStore();
  const [step, setStep] = useState<Step>('fetching');
  const [error, setError] = useState('');
  const [analysis, setAnalysis] = useState<CallAnalysisResult | null>(null);
  const [transcriptUrl, setTranscriptUrl] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');

  // Campos editaveis pelo closer
  const [temperatura, setTemperatura] = useState<string>('');
  const [valorOt, setValorOt] = useState(0);
  const [valorMrr, setValorMrr] = useState(0);
  const [produtosOt, setProdutosOt] = useState<string[]>([]);
  const [produtosMrr, setProdutosMrr] = useState<string[]>([]);
  const [bant, setBant] = useState(1);
  const [tier, setTier] = useState('');
  const [resumo, setResumo] = useState('');
  const [indicacoes, setIndicacoes] = useState<Array<{ nome: string; empresa: string; telefone?: string }>>([]);
  const [proximaData, setProximaData] = useState('');
  const [proximaHora, setProximaHora] = useState('');
  const [agendarReuniao, setAgendarReuniao] = useState(false);

  // Campos de controle
  const [isApplying, setIsApplying] = useState(false);

  // Buscar deal associado
  const deal = deals.find(d => d.lead_id === reuniao.lead_id) || null;

  // Step 1: Buscar transcricao
  useEffect(() => {
    let cancelled = false;

    async function fetchTranscript() {
      try {
        const result = await fetchMeetingTranscript(reuniao.id);

        if (cancelled) return;

        if (result.status === 'not_found' || !result.transcript_text) {
          setStep('not_found');
          return;
        }

        if (result.needs_reauth) {
          setError('Google Drive nao autorizado. Peca ao organizador reconectar na tela de Equipe.');
          setStep('error');
          return;
        }

        setTranscriptUrl(result.transcript_url || '');
        setRecordingUrl(result.recording_url || '');

        // Step 2: Analisar com Gemini
        setStep('analyzing');
        const analysisResult = await analyzeTranscript(result.transcript_text);

        if (cancelled) return;

        setAnalysis(analysisResult);
        setTemperatura(analysisResult.temperatura);
        setValorOt(analysisResult.valor_escopo);
        setValorMrr(analysisResult.valor_recorrente);
        setProdutosOt(analysisResult.produtos_ot);
        setProdutosMrr(analysisResult.produtos_mrr);
        setBant(analysisResult.bant);
        setTier(analysisResult.tier);
        setResumo(analysisResult.resumo_executivo);
        setIndicacoes(analysisResult.indicacoes);
        if (analysisResult.proxima_reuniao) {
          setProximaData(analysisResult.proxima_reuniao.data);
          setProximaHora(analysisResult.proxima_reuniao.hora);
          setAgendarReuniao(true);
        }
        setStep('review');
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message || 'Erro desconhecido');
          setStep('error');
        }
      }
    }

    fetchTranscript();
    return () => { cancelled = true; };
  }, [reuniao.id]);

  // Aplicar tudo apos confirmacao
  const handleConfirm = async () => {
    setIsApplying(true);
    setStep('applying');

    try {
      // 1. Atualizar deal
      if (deal) {
        const updates: Partial<Deal> = {
          temperatura: temperatura as any,
          valor_escopo: valorOt,
          valor_ot: valorOt,
          valor_recorrente: valorMrr,
          valor_mrr: valorMrr,
          produtos_ot: produtosOt,
          produtos_mrr: produtosMrr,
          bant,
          tier: tier as any,
          observacoes: resumo,
          status: 'negociacao', // Mover para negociacao apos feedback da IA confirmado
        };
        if (recordingUrl) updates.link_call_vendas = recordingUrl;
        if (transcriptUrl) updates.link_transcricao = transcriptUrl;

        await updateDeal(deal.id, updates);
      }

      // 2. Criar leads de indicacao
      for (const ind of indicacoes) {
        if (!ind.nome || !ind.empresa) continue;
        // Encontrar SDR Lary
        const lary = members.find(m => m.name.toLowerCase().includes('lary') && m.role === 'sdr');
        await addLead({
          empresa: ind.empresa,
          nome_contato: ind.nome,
          telefone: ind.telefone || undefined,
          canal: 'recomendacao',
          status: 'sem_contato',
          sdr_id: lary?.id || undefined,
          data_cadastro: new Date().toISOString().split('T')[0],
          mes_referencia: new Date().toISOString().slice(0, 7),
        });
      }

      // 3. Agendar proxima reuniao (se confirmado)
      if (agendarReuniao && proximaData && proximaHora) {
        const dataReuniaoISO = `${proximaData}T${proximaHora}:00-03:00`;
        const { error: reuniaoErr } = await supabase.from('reunioes').insert({
          lead_id: reuniao.lead_id || undefined,
          closer_id: reuniao.closer_confirmado_id || reuniao.closer_id || undefined,
          sdr_id: reuniao.sdr_id || undefined,
          empresa: reuniao.empresa,
          nome_contato: reuniao.nome_contato,
          canal: reuniao.canal,
          data_agendamento: new Date().toISOString().split('T')[0],
          data_reuniao: dataReuniaoISO,
          realizada: false,
        }).select('*').single();

        if (reuniaoErr) {
          console.error('Erro ao agendar reuniao:', reuniaoErr);
          toast.error('Deal atualizado, mas erro ao agendar reuniao: ' + reuniaoErr.message);
        } else {
          // Atualizar lead para reuniao_marcada
          if (reuniao.lead_id) {
            await supabase.from('leads').update({ status: 'reuniao_marcada' }).eq('id', reuniao.lead_id);
          }
          toast.success('Proxima reuniao agendada!', { icon: '📅' });
        }
      }

      // 4. Registrar automacao
      await supabase.from('post_meeting_automations').upsert({
        reuniao_id: reuniao.id,
        deal_id: deal?.id,
        status: 'completed',
        ai_result: analysis as any,
        actions_taken: {
          deal_updated: !!deal,
          leads_created: indicacoes.length,
          meeting_scheduled: agendarReuniao,
        },
        completed_at: new Date().toISOString(),
      }, { onConflict: 'reuniao_id' });

      // Refresh dados
      fetchDeals();
      fetchLeads();
      fetchReunioes();

      setStep('done');
      toast.success('Feedback aplicado com sucesso!', { icon: '🤖', duration: 4000 });

      setTimeout(() => onClose(), 2000);
    } catch (e: any) {
      setError(e.message);
      setStep('error');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={step === 'review' ? undefined : onClose} />
      <div className="relative w-full max-w-2xl max-h-[90vh] bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--color-v4-border)] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sparkles size={18} className="text-purple-400" />
            <div>
              <h3 className="text-sm font-bold text-white">Pos-Reuniao IA</h3>
              <p className="text-xs text-[var(--color-v4-text-muted)]">{reuniao.empresa}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white">
            <XIcon size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* FETCHING */}
          {step === 'fetching' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 size={32} className="text-purple-400 animate-spin" />
              <p className="text-sm text-white">Buscando transcricao no Google Drive...</p>
              <p className="text-xs text-[var(--color-v4-text-muted)]">O Google Meet leva ~30 min para gerar a transcricao</p>
            </div>
          )}

          {/* NOT FOUND */}
          {step === 'not_found' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <AlertTriangle size={32} className="text-yellow-400" />
              <p className="text-sm text-white font-medium">Transcricao ainda nao disponivel</p>
              <p className="text-xs text-[var(--color-v4-text-muted)] text-center max-w-md">
                O Google Meet leva aproximadamente 30 minutos para gerar a transcricao apos a reuniao.
                Tente novamente mais tarde.
              </p>
              <button onClick={onClose} className="mt-4 px-6 py-2 rounded-xl bg-[var(--color-v4-surface)] text-white text-sm hover:bg-[var(--color-v4-card-hover)]">
                Fechar
              </button>
            </div>
          )}

          {/* ANALYZING */}
          {step === 'analyzing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 size={32} className="text-purple-400 animate-spin" />
              <p className="text-sm text-white">Analisando call com IA...</p>
              <p className="text-xs text-[var(--color-v4-text-muted)]">Extraindo temperatura, valores, produtos, indicacoes...</p>
            </div>
          )}

          {/* REVIEW - Closer confirma os dados */}
          {step === 'review' && analysis && (
            <div className="space-y-5">
              <p className="text-xs text-purple-400 font-medium uppercase tracking-wider">Revise e confirme os dados extraidos pela IA</p>

              {/* Resumo */}
              <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <FileText size={14} className="text-blue-400" />
                  <span className="text-xs font-bold text-white uppercase">Resumo da Call</span>
                </div>
                <textarea
                  value={resumo}
                  onChange={e => setResumo(e.target.value)}
                  rows={3}
                  className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-2 text-xs text-white resize-none"
                />
              </div>

              {/* Temperatura + BANT + Tier */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <ThermometerSun size={14} className="text-orange-400" />
                    <span className="text-xs font-bold text-white uppercase">Temperatura</span>
                  </div>
                  <div className="flex gap-1">
                    {(['quente', 'morno', 'frio'] as const).map(t => (
                      <button key={t} onClick={() => setTemperatura(t)}
                        className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                          temperatura === t
                            ? t === 'quente' ? 'bg-red-500/30 text-red-400 ring-1 ring-red-500/50'
                            : t === 'morno' ? 'bg-yellow-500/30 text-yellow-400 ring-1 ring-yellow-500/50'
                            : 'bg-blue-500/30 text-blue-400 ring-1 ring-blue-500/50'
                            : 'bg-[var(--color-v4-bg)] text-[var(--color-v4-text-muted)] hover:text-white'
                        }`}>
                        {TEMPERATURA_LABELS[t]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Target size={14} className="text-green-400" />
                    <span className="text-xs font-bold text-white uppercase">BANT</span>
                  </div>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map(b => (
                      <button key={b} onClick={() => setBant(b)}
                        className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                          bant === b ? 'bg-green-500/30 text-green-400 ring-1 ring-green-500/50' : 'bg-[var(--color-v4-bg)] text-[var(--color-v4-text-muted)] hover:text-white'
                        }`}>
                        {b}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 size={14} className="text-purple-400" />
                    <span className="text-xs font-bold text-white uppercase">Tier</span>
                  </div>
                  <select value={tier} onChange={e => setTier(e.target.value)}
                    className="w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-2 py-1.5 text-xs text-white">
                    {Object.entries(TIER_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Valores */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <DollarSign size={14} className="text-emerald-400" />
                    <span className="text-xs font-bold text-white uppercase">Valor OT (one-time)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--color-v4-text-muted)]">R$</span>
                    <input type="number" value={valorOt} onChange={e => setValorOt(Number(e.target.value))}
                      className="flex-1 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-1.5 text-sm text-white" />
                  </div>
                </div>
                <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <DollarSign size={14} className="text-blue-400" />
                    <span className="text-xs font-bold text-white uppercase">Valor MRR (mensal)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--color-v4-text-muted)]">R$</span>
                    <input type="number" value={valorMrr} onChange={e => setValorMrr(Number(e.target.value))}
                      className="flex-1 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-1.5 text-sm text-white" />
                  </div>
                </div>
              </div>

              {/* Produtos */}
              <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Package size={14} className="text-cyan-400" />
                  <span className="text-xs font-bold text-white uppercase">Produtos</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[...produtosOt, ...produtosMrr].map((p, i) => (
                    <span key={i} className="px-2 py-1 rounded-full text-[10px] font-medium bg-cyan-500/20 text-cyan-400">
                      {p}
                    </span>
                  ))}
                  {produtosOt.length === 0 && produtosMrr.length === 0 && (
                    <span className="text-xs text-[var(--color-v4-text-muted)]">Nenhum produto identificado</span>
                  )}
                </div>
              </div>

              {/* Indicacoes */}
              {indicacoes.length > 0 && (
                <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Users size={14} className="text-amber-400" />
                    <span className="text-xs font-bold text-white uppercase">Indicacoes ({indicacoes.length})</span>
                  </div>
                  <div className="space-y-2">
                    {indicacoes.map((ind, i) => (
                      <div key={i} className="flex items-center gap-3 bg-[var(--color-v4-bg)] rounded-lg px-3 py-2">
                        <div className="flex-1">
                          <input value={ind.nome} onChange={e => {
                            const updated = [...indicacoes];
                            updated[i] = { ...updated[i], nome: e.target.value };
                            setIndicacoes(updated);
                          }} className="bg-transparent text-xs text-white w-full outline-none" placeholder="Nome" />
                        </div>
                        <div className="flex-1">
                          <input value={ind.empresa} onChange={e => {
                            const updated = [...indicacoes];
                            updated[i] = { ...updated[i], empresa: e.target.value };
                            setIndicacoes(updated);
                          }} className="bg-transparent text-xs text-[var(--color-v4-text-muted)] w-full outline-none" placeholder="Empresa" />
                        </div>
                        <div className="w-32">
                          <input value={ind.telefone || ''} onChange={e => {
                            const updated = [...indicacoes];
                            updated[i] = { ...updated[i], telefone: e.target.value };
                            setIndicacoes(updated);
                          }} className="bg-transparent text-xs text-[var(--color-v4-text-muted)] w-full outline-none" placeholder="Telefone" />
                        </div>
                        <button onClick={() => setIndicacoes(indicacoes.filter((_, j) => j !== i))}
                          className="text-red-400 hover:text-red-300">
                          <XIcon size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Proxima Reuniao */}
              <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-yellow-400" />
                    <span className="text-xs font-bold text-white uppercase">Proxima Reuniao</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={agendarReuniao} onChange={e => setAgendarReuniao(e.target.checked)}
                      className="rounded border-[var(--color-v4-border)]" />
                    <span className="text-xs text-[var(--color-v4-text-muted)]">Agendar</span>
                  </label>
                </div>
                {agendarReuniao && (
                  <div className="flex gap-3">
                    <input type="date" value={proximaData} onChange={e => setProximaData(e.target.value)}
                      className="flex-1 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-1.5 text-xs text-white" />
                    <input type="time" value={proximaHora} onChange={e => setProximaHora(e.target.value)}
                      className="w-28 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-1.5 text-xs text-white" />
                  </div>
                )}
                {!agendarReuniao && (
                  <p className="text-xs text-[var(--color-v4-text-muted)]">Nenhuma reuniao sera agendada</p>
                )}
              </div>
            </div>
          )}

          {/* APPLYING */}
          {step === 'applying' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 size={32} className="text-green-400 animate-spin" />
              <p className="text-sm text-white">Aplicando feedback...</p>
            </div>
          )}

          {/* DONE */}
          {step === 'done' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Check size={32} className="text-green-400" />
              <p className="text-sm text-white font-medium">Feedback aplicado com sucesso!</p>
              <p className="text-xs text-[var(--color-v4-text-muted)]">Deal movido para Negociacao</p>
            </div>
          )}

          {/* ERROR */}
          {step === 'error' && (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <AlertTriangle size={32} className="text-red-400" />
              <p className="text-sm text-white font-medium">Erro na automacao</p>
              <p className="text-xs text-red-400 text-center max-w-md">{error}</p>
              <button onClick={onClose} className="mt-4 px-6 py-2 rounded-xl bg-[var(--color-v4-surface)] text-white text-sm">
                Fechar
              </button>
            </div>
          )}
        </div>

        {/* Footer - botao de confirmar */}
        {step === 'review' && (
          <div className="px-6 py-4 border-t border-[var(--color-v4-border)] flex items-center justify-between">
            <button onClick={onClose} className="px-5 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm hover:text-white">
              Cancelar
            </button>
            <button onClick={handleConfirm} disabled={isApplying}
              className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black font-bold text-sm">
              <Check size={16} />
              Confirmar e Aplicar
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
