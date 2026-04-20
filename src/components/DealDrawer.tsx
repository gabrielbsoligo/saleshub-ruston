import React, { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../store";
import { X, Save, Trash2, Loader2, Plus, Trash2 as Trash2Icon, Calendar } from "lucide-react";
import { PRODUTOS_OT, PRODUTOS_MRR, CANAL_LABELS, TIER_LABELS, type Deal, type DealStatus, type Temperatura, type DealTier } from "../types";
import { DateInput } from "./ui/DateInput";
import { MultiSelect } from "./ui/MultiSelect";
import { ContractUpload } from "./ui/ContractUpload";
import { MissingFieldsPopup } from "./ui/MissingFieldsPopup";
import { validateGanho } from "../lib/ganhoValidation";
import { supabase } from "../lib/supabase";
import { useRecomendacoesDraft } from "../hooks/useRecomendacoesDraft";
import toast from "react-hot-toast";

export const DealDrawer: React.FC<{ deal: Deal | null; onClose: () => void }> = ({ deal, onClose }) => {
  const { addDeal, updateDeal, deleteDeal, members, addReuniao, leads, fetchDeals, fetchLeads } = useAppStore();
  const closers = members.filter(m => (m.role === 'closer' || m.role === 'gestor') && m.active);
  const sdrs = members.filter(m => (m.role === 'sdr' || m.role === 'gestor') && m.active);

  const [tab, setTab] = useState<'geral' | 'produtos' | 'recomendacoes' | 'ganho'>('geral');
  const [missingFields, setMissingFields] = useState<string[] | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [contractParsing, setContractParsing] = useState(false);
  const [contractFilledFields, setContractFilledFields] = useState<Set<string>>(new Set());
  // Recomendacoes — hook unificado (mesma logica pro FeedbackDrawer)
  const {
    existing: recomendacoesExistentes,
    drafts: recomendacoes,
    addDraft: addRecomendacao,
    updateDraft: updateRecomendacao,
    removeDraft: removeRecomendacao,
    saveDrafts: saveRecomendacoes,
  } = useRecomendacoesDraft(deal?.id);

  const [form, setForm] = useState({
    empresa: '', kommo_id: '', kommo_link: '', closer_id: '', sdr_id: '',
    data_call: '', data_fechamento: '', data_retorno: '',
    agendar_reuniao: false,
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
        agendar_reuniao: false,
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
        const result = validateGanho({ ...form, closer_id: form.closer_id, temperatura: form.temperatura, bant: form.bant, kommo_id: form.kommo_id });
        if (!result.valid) {
          setMissingFields(result.missing);
          return;
        }
      }

      const payload: any = { ...form, valor_mrr: form.valor_recorrente, valor_ot: form.valor_escopo };
      delete payload.agendar_reuniao;
      if (!payload.closer_id) delete payload.closer_id;
      if (!payload.sdr_id) delete payload.sdr_id;
      if (!payload.temperatura) delete payload.temperatura;
      if (!payload.bant) delete payload.bant;
      if (!payload.tier) delete payload.tier;
      Object.keys(payload).forEach(k => { if (payload[k] === '') payload[k] = null; });

      if (deal) { await updateDeal(deal.id, payload); }
      else { await addDeal(payload); }

      // Save recomendacoes as leads (via hook unificado)
      if (deal) {
        const coletorId = form.closer_id || deal.closer_id || null;
        const coletorName = coletorId ? members.find(m => m.id === coletorId)?.name || null : null;
        const leadOrigem = deal.lead_id ? leads.find(l => l.id === deal.lead_id) || null : null;
        const saved = await saveRecomendacoes({
          dealId: deal.id,
          dealEmpresa: deal.empresa,
          dealSdrId: deal.sdr_id || null,
          closerId: coletorId,
          closerName: coletorName,
          leadOrigem,
        });
        if (saved > 0) {
          toast.success(`${saved} recomendação(ões) salva(s) como lead!`, { icon: '🎯' });
          fetchLeads();
        }
      }

      // Agendar reuniao de retorno
      if (deal && form.agendar_reuniao && form.data_retorno) {
        try {
          const dataRetornoISO = `${form.data_retorno}T10:00:00-03:00`;
          const lead = deal.lead_id ? leads.find(l => l.id === deal.lead_id) : null;
          await addReuniao({
            tipo: 'retorno',
            deal_id: deal.id,
            lead_id: deal.lead_id || undefined,
            closer_id: form.closer_id || deal.closer_id || undefined,
            sdr_id: deal.sdr_id || undefined,
            empresa: deal.empresa,
            nome_contato: deal.nome_contato,
            canal: deal.canal,
            data_agendamento: new Date().toISOString().split('T')[0],
            data_reuniao: dataRetornoISO,
            lead_email: lead?.email || undefined,
          } as any);
          toast.success('Reuniao de retorno agendada!', { icon: '\uD83D\uDCC5' });
        } catch (e: any) {
          toast.error('Erro ao agendar reuniao: ' + e.message);
        }
      }

      fetchDeals();
      onClose();
    } finally { setIsProcessing(false); }
  };

  const handleDelete = async () => {
    if (isProcessing) return;
    if (deal && confirm('Excluir esta negociacao?')) {
      setIsProcessing(true);
      try { await deleteDeal(deal.id); onClose(); }
      finally { setIsProcessing(false); }
    }
  };

  const set = (key: string, value: any) => setForm(prev => ({ ...prev, [key]: value }));
  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1";
  const tabClass = (t: string) => `px-3 py-2 text-xs font-medium rounded-lg transition-colors ${tab === t ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)] hover:bg-[var(--color-v4-card-hover)]'}`;
  const isGanho = form.status === 'contrato_assinado';
  const contractHighlight = (field: string) => contractFilledFields.has(field) ? 'ring-1 ring-green-500/50' : '';

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
    if (filled.has('produtos_ot') || filled.has('produtos_mrr')) {
      setTab('produtos');
    }
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] overflow-y-auto">
        <div className="sticky top-0 bg-[var(--color-v4-card)] border-b border-[var(--color-v4-border)] px-6 py-4 z-10">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-display font-bold text-white">{deal ? 'Editar Negociacao' : 'Nova Negociacao'}</h3>
            <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={20} /></button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTab('geral')} className={tabClass('geral')}>Geral</button>
            <button onClick={() => setTab('produtos')} className={tabClass('produtos')}>Produtos</button>
            <button onClick={() => setTab('recomendacoes')} className={tabClass('recomendacoes')}>
              Recomendações {(recomendacoes.length + recomendacoesExistentes.length) > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400 text-[10px]">{recomendacoes.length + recomendacoesExistentes.length}</span>}
            </button>
            <button onClick={() => setTab('ganho')} className={tabClass('ganho')}>Fechamento</button>
          </div>
        </div>

        <div className="p-6 space-y-4">

          {/* ======== TAB: GERAL ======== */}
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

            {/* Proximo Passo - grid visual */}
            <div>
              <label className={labelClass}>Proximo Passo</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'negociacao', label: '\uD83D\uDCCB Em Negociacao', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
                  { value: 'contrato_na_rua', label: '\uD83D\uDCDD Contrato na Rua', color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
                  { value: 'contrato_assinado', label: '\u2705 Fechou!', color: 'bg-green-500/20 text-green-400 border-green-500/30' },
                  { value: 'follow_longo', label: '\u23F3 Follow Longo', color: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
                  { value: 'perdido', label: '\u274C Perdido', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
                ].map(opt => (
                  <button key={opt.value} type="button" onClick={() => set('status', opt.value)}
                    className={`py-2.5 px-3 rounded-lg text-xs font-medium border transition-colors ${
                      form.status === opt.value ? opt.color + ' border-current' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] border-transparent'
                    }`}>{opt.label}</button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelClass}>Origem</label>
                <select className={inputClass} value={form.origem} onChange={e => set('origem', e.target.value)}>
                  <option value="">Selecionar</option>{Object.entries(CANAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div><label className={labelClass}>Temperatura</label>
                <select className={inputClass} value={form.temperatura} onChange={e => set('temperatura', e.target.value)}>
                  <option value="">--</option><option value="quente">{'\uD83D\uDD25'} Quente</option><option value="morno">{'\uD83C\uDF21\uFE0F'} Morno</option><option value="frio">{'\u2744\uFE0F'} Frio</option>
                </select></div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div><label className={labelClass}>BANT (1-4)</label>
                <div className="flex gap-1">{[1,2,3,4].map(n => (
                  <button key={n} type="button" onClick={() => set('bant', n)}
                    className={`flex-1 py-2 rounded text-xs font-bold ${form.bant === n ? 'bg-purple-500 text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>{n}</button>
                ))}</div></div>
              <div><label className={labelClass}>Tier</label>
                <select className={inputClass} value={form.tier} onChange={e => set('tier', e.target.value)}>
                  <option value="">--</option>{Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <DateInput label="Data Call" value={form.data_call} onChange={v => set('data_call', v)} />
            </div>

            {form.status === 'perdido' && (
              <div><label className={labelClass}>Motivo de Perda</label><input className={inputClass} value={form.motivo_perda} onChange={e => set('motivo_perda', e.target.value)} /></div>
            )}

            {/* Data Retorno + Agendar Reuniao */}
            {(form.status === 'follow_longo' || form.status === 'negociacao' || form.status === 'contrato_na_rua') && (
              <div className="bg-[var(--color-v4-surface)] rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-yellow-400" />
                    <span className="text-xs font-bold text-white uppercase">Data de Retorno</span>
                  </div>
                  {deal && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={form.agendar_reuniao} onChange={e => set('agendar_reuniao', e.target.checked)}
                        className="rounded border-[var(--color-v4-border)]" />
                      <span className="text-xs text-[var(--color-v4-text-muted)]">Agendar reuniao</span>
                    </label>
                  )}
                </div>
                <input type="date" value={form.data_retorno || ''} onChange={e => set('data_retorno', e.target.value)} className={inputClass} />
              </div>
            )}

            {/* Resumo da Call */}
            <div>
              <label className={labelClass}>Resumo da Call</label>
              <textarea
                className={inputClass + " h-20 resize-none"}
                value={form.observacoes}
                onChange={e => set('observacoes', e.target.value)}
                placeholder="Resumo executivo da reuniao..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div><label className={labelClass}>ID Kommo</label><input className={inputClass} value={form.kommo_id} onChange={e => set('kommo_id', e.target.value)} /></div>
              <div><label className={labelClass}>Link Kommo</label><input className={inputClass} value={form.kommo_link} onChange={e => set('kommo_link', e.target.value)} /></div>
            </div>
          </>)}

          {/* ======== TAB: PRODUTOS ======== */}
          {tab === 'produtos' && (<>
            <div className={`bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 ${contractHighlight('produtos_ot')}`}>
              <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-3">
                Escopo Fechado (OT) {contractFilledFields.has('produtos_ot') && <span className="ml-1 text-green-400">{'\uD83D\uDCC4'} Contrato</span>}
              </h4>
              <MultiSelect options={[...PRODUTOS_OT]} selected={form.produtos_ot} onChange={v => set('produtos_ot', v)} placeholder="Selecionar produtos OT..." />
              {form.produtos_ot.length > 0 && (<>
                <div className="mt-3"><label className={labelClass}>Valor Escopo (R$) {isGanho && '*'}</label>
                  <input type="number" className={`${inputClass} ${contractHighlight('valor_escopo')}`} value={form.valor_escopo} onChange={e => set('valor_escopo', Number(e.target.value))} /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <DateInput label={`Inicio Escopo ${isGanho ? '*' : ''}`} value={form.data_inicio_escopo} onChange={v => set('data_inicio_escopo', v)} />
                  <DateInput label={`1o Pgto Escopo ${isGanho ? '*' : ''}`} value={form.data_pgto_escopo} onChange={v => set('data_pgto_escopo', v)} />
                </div>
              </>)}
            </div>
            <div className={`bg-green-500/5 border border-green-500/20 rounded-xl p-4 ${contractHighlight('produtos_mrr')}`}>
              <h4 className="text-xs font-bold text-green-400 uppercase tracking-wider mb-3">
                Recorrente (MRR) {contractFilledFields.has('produtos_mrr') && <span className="ml-1 text-green-400">{'\uD83D\uDCC4'} Contrato</span>}
              </h4>
              <MultiSelect options={[...PRODUTOS_MRR]} selected={form.produtos_mrr} onChange={v => set('produtos_mrr', v)} placeholder="Selecionar produtos MRR..." />
              {form.produtos_mrr.length > 0 && (<>
                <div className="mt-3"><label className={labelClass}>Valor Recorrente (R$/mes) {isGanho && '*'}</label>
                  <input type="number" className={`${inputClass} ${contractHighlight('valor_recorrente')}`} value={form.valor_recorrente} onChange={e => set('valor_recorrente', Number(e.target.value))} /></div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <DateInput label={`Inicio Recorrente ${isGanho ? '*' : ''}`} value={form.data_inicio_recorrente} onChange={v => set('data_inicio_recorrente', v)} />
                  <DateInput label={`1o Pgto Recorrente ${isGanho ? '*' : ''}`} value={form.data_pgto_recorrente} onChange={v => set('data_pgto_recorrente', v)} />
                </div>
              </>)}
            </div>
          </>)}

          {/* ======== TAB: RECOMENDACOES ======== */}
          {tab === 'recomendacoes' && (<>
            {/* Recomendacoes JA salvas (le do lead via JOIN — source of truth) */}
            {recomendacoesExistentes.length > 0 && (
              <div className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-3">
                <h4 className="text-xs font-bold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-3">
                  Já salvas ({recomendacoesExistentes.length})
                </h4>
                <div className="space-y-2">
                  {recomendacoesExistentes.map(rec => (
                    <div key={rec.id} className="flex items-center gap-3 text-sm px-3 py-2 rounded-lg bg-[var(--color-v4-card)]">
                      <span className="text-white font-medium flex-1">{rec.lead.empresa}</span>
                      {rec.lead.nome_contato && <span className="text-[var(--color-v4-text-muted)] text-xs">{rec.lead.nome_contato}</span>}
                      {rec.lead.telefone && <span className="text-[var(--color-v4-text-muted)] text-xs">{rec.lead.telefone}</span>}
                      {rec.lead.kommo_link && (
                        <a href={rec.lead.kommo_link} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}
                           className="text-[10px] text-blue-400 hover:underline">Kommo</a>
                      )}
                      <span className="text-[10px] text-[var(--color-v4-text-muted)]">
                        {new Date(rec.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Drafts (editáveis — serão criadas ao salvar) */}
            <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-4">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider">Novas Recomendações</h4>
                  <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">Serão criadas como leads ao salvar a negociação.</p>
                </div>
                <button type="button" onClick={addRecomendacao}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30">
                  <Plus size={12} /> Adicionar
                </button>
              </div>

              {recomendacoes.length === 0 && (
                <div className="text-center py-8">
                  <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhuma recomendação a adicionar</p>
                  <button type="button" onClick={addRecomendacao}
                    className="mt-3 flex items-center gap-1 mx-auto px-4 py-2 rounded-lg text-xs font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30">
                    <Plus size={12} /> Adicionar primeira
                  </button>
                </div>
              )}

              {recomendacoes.map((rec, i) => (
                <div key={i} className="flex gap-2 mb-3">
                  <div className="flex-1 space-y-2">
                    <input className={inputClass} placeholder="Empresa *" value={rec.empresa}
                      onChange={e => updateRecomendacao(i, { empresa: e.target.value })} />
                    <div className="flex gap-2">
                      <input className={inputClass + " flex-1"} placeholder="Contato" value={rec.nome_contato}
                        onChange={e => updateRecomendacao(i, { nome_contato: e.target.value })} />
                      <input className={inputClass + " flex-1"} placeholder="Telefone" value={rec.telefone}
                        onChange={e => updateRecomendacao(i, { telefone: e.target.value })} />
                    </div>
                  </div>
                  <button type="button" onClick={() => removeRecomendacao(i)}
                    className="p-2 text-red-400 hover:text-red-300 self-start mt-1"><Trash2Icon size={14} /></button>
                </div>
              ))}
            </div>

            {!deal && (
              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <p className="text-xs text-yellow-400">Salve a negociação primeiro para poder adicionar recomendações.</p>
              </div>
            )}
          </>)}

          {/* ======== TAB: FECHAMENTO ======== */}
          {tab === 'ganho' && (<>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Campos obrigatorios para dar ganho (status = Contrato Assinado).</p>
            <div><label className={labelClass}>Tier {isGanho && '*'}</label>
              <select className={inputClass} value={form.tier} onChange={e => set('tier', e.target.value)}>
                <option value="">Selecionar</option>{Object.entries(TIER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div><label className={labelClass}>Link Call de Vendas {isGanho && '*'}</label>
              <input className={inputClass} value={form.link_call_vendas} onChange={e => set('link_call_vendas', e.target.value)} placeholder="https://drive.google.com/..." /></div>
            <div><label className={labelClass}>Link Transcricao {isGanho && '*'}</label>
              <input className={inputClass} value={form.link_transcricao} onChange={e => set('link_transcricao', e.target.value)} placeholder="https://docs.google.com/..." /></div>
            {deal ? (
              <ContractUpload
                dealId={deal.id}
                contractUrl={form.contrato_url}
                contractFilename={form.contrato_filename}
                onUploaded={(url, name) => { set('contrato_url', url); set('contrato_filename', name); }}
                onRemoved={() => { set('contrato_url', ''); set('contrato_filename', ''); }}
                onParsing={setContractParsing}
                onParsed={handleContractParsed}
              />
            ) : (
              <div><label className={labelClass}>Contrato (salve o deal primeiro para anexar)</label>
                <div className="p-3 rounded-lg bg-[var(--color-v4-surface)] text-xs text-[var(--color-v4-text-muted)]">Salve a negociacao e depois anexe o contrato</div></div>
            )}
            {contractParsing && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                <Loader2 size={14} className="text-green-400 animate-spin" />
                <span className="text-xs text-green-400">{'\uD83D\uDCC4'} Extraindo produtos, precos e datas do contrato...</span>
              </div>
            )}
            <DateInput label="Data Fechamento" value={form.data_fechamento} onChange={v => set('data_fechamento', v)} />
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
