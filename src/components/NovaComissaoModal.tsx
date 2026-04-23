// =============================================================
// NovaComissaoModal — RFC Comissoes v2 (wizard 2 passos)
// =============================================================
// Passo 1: dados do recebimento (categoria, tipo, deal opcional, empresa, data, valor)
// Passo 2: colaboradores (so' aparece pra monetizacao ou sem deal)
//
// Se categoria=aquisicao (inbound/outbound/indicacao/recomendacao) E tem deal:
//   -> cria recebimento e confia no trigger fn_recebimento_criado.
//   Pula passo 2.
// Se categoria=monetizacao (upsell/ee_*) OU sem deal:
//   -> passo 2 pede colaboradores, cria comissoes manualmente vinculadas.
// =============================================================
import React, { useMemo, useState, useEffect } from 'react';
import { X, Save, ArrowLeft, ArrowRight, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';
import type { ComissaoCategoria, ComissaoTipoValor, ComissaoRole } from '../types';

const CATEGORIAS: { value: ComissaoCategoria; label: string; tipoAuto?: ComissaoTipoValor }[] = [
  { value: 'inbound', label: 'Inbound (leadbroker / blackbox)' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'upsell', label: 'Upsell (MRR/OT em base ativa)' },
  { value: 'ee_assessoria', label: 'EE > Assessoria (MRR)', tipoAuto: 'mrr' },
  { value: 'ee_ot', label: 'EE > OT', tipoAuto: 'ot' },
  { value: 'indicacao', label: 'Indicação' },
  { value: 'recomendacao', label: 'Recomendação' },
];

const TIPOS: { value: ComissaoTipoValor; label: string }[] = [
  { value: 'mrr', label: 'MRR (recorrência)' },
  { value: 'ot', label: 'OT (setup/one-time)' },
  { value: 'variavel', label: 'Variável (ISAAS/outros)' },
];

const AQUISICAO_CATEGORIAS: ComissaoCategoria[] = ['inbound', 'outbound', 'indicacao', 'recomendacao'];

function fmt(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

interface ColaboradorLinha {
  id: string; // key local
  role: ComissaoRole;
  member_id: string;
  percentual_override?: string; // vazio usa sugerido
}

export const NovaComissaoModal: React.FC<Props> = ({ open, onClose, onCreated }) => {
  const { comissoes: comissoesConfig, members, deals } = useAppStore();

  const [step, setStep] = useState<1 | 2>(1);
  // Step 1 — recebimento
  const [categoria, setCategoria] = useState<ComissaoCategoria>('upsell');
  const [tipo, setTipo] = useState<ComissaoTipoValor>('mrr');
  const [dealId, setDealId] = useState<string>('');
  const [empresa, setEmpresa] = useState('');
  const [dataPrevista, setDataPrevista] = useState(hoje());
  const [valorContrato, setValorContrato] = useState('');
  const [observacao, setObservacao] = useState('');

  // Step 2 — colaboradores
  const [colaboradores, setColaboradores] = useState<ColaboradorLinha[]>([]);

  const [saving, setSaving] = useState(false);

  // Reset ao abrir
  useEffect(() => {
    if (open) {
      setStep(1);
      setCategoria('upsell');
      setTipo('mrr');
      setDealId('');
      setEmpresa('');
      setDataPrevista(hoje());
      setValorContrato('');
      setObservacao('');
      setColaboradores([]);
    }
  }, [open]);

  // Auto-ajusta tipo quando categoria força (ee_assessoria=mrr, ee_ot=ot)
  useEffect(() => {
    const cat = CATEGORIAS.find(c => c.value === categoria);
    if (cat?.tipoAuto) setTipo(cat.tipoAuto);
  }, [categoria]);

  // Auto-preenche empresa e valor ao escolher deal
  useEffect(() => {
    if (dealId) {
      const d = deals.find(x => x.id === dealId);
      if (d) {
        setEmpresa(d.empresa || '');
        const vb = tipo === 'mrr' ? (d.valor_recorrente || 0) : (d.valor_escopo || 0);
        if (vb && !valorContrato) setValorContrato(String(vb));
      }
    }
  }, [dealId, tipo]);

  const isAquisicao = AQUISICAO_CATEGORIAS.includes(categoria);
  const modoAutomatico = isAquisicao && !!dealId;

  // Regras disponíveis pra (categoria, tipo)
  const regrasDisponiveis = useMemo(() => {
    return comissoesConfig
      .filter(c => c.categoria === categoria && c.tipo_valor === tipo && c.active)
      .sort((a, b) => b.percentual - a.percentual);
  }, [comissoesConfig, categoria, tipo]);

  const valorContratoNum = parseFloat(valorContrato) || 0;

  // Validacao step 1
  const step1Valid =
    !!categoria && !!tipo && !!dataPrevista && valorContratoNum > 0 &&
    (!!dealId || empresa.trim().length > 0);

  const step1ValidationMsg = !step1Valid ? (
    valorContratoNum <= 0 ? 'Informe o valor do contrato (> 0)'
    : (!dealId && !empresa) ? 'Selecione um deal OU informe a empresa'
    : 'Preencha todos os campos'
  ) : null;

  // Preview das comissões no step 2
  const comissoesPreview = useMemo(() => {
    return colaboradores.map(c => {
      const rule = regrasDisponiveis.find(r => r.role === c.role);
      const sugerido = rule?.percentual || 0;
      const pct = c.percentual_override ? parseFloat(c.percentual_override) : sugerido;
      const valor = valorContratoNum * pct;
      const member = members.find(m => m.id === c.member_id);
      return {
        ...c,
        member_name: member?.name || '(selecionar)',
        percentual_efetivo: pct,
        valor_comissao: valor,
      };
    });
  }, [colaboradores, regrasDisponiveis, valorContratoNum, members]);

  const totalComissoes = comissoesPreview.reduce((sum, c) => sum + (c.valor_comissao || 0), 0);

  // Adicionar linha (start com a primeira role disponível)
  const addLinha = () => {
    const roleDefault = regrasDisponiveis[0]?.role || 'account';
    setColaboradores(prev => [
      ...prev,
      { id: crypto.randomUUID(), role: roleDefault as ComissaoRole, member_id: '', percentual_override: '' },
    ]);
  };

  const removeLinha = (id: string) => setColaboradores(prev => prev.filter(x => x.id !== id));
  const updateLinha = (id: string, patch: Partial<ColaboradorLinha>) =>
    setColaboradores(prev => prev.map(x => (x.id === id ? { ...x, ...patch } : x)));

  // Avança para step 2
  const handleNext = () => {
    if (!step1Valid) return toast.error(step1ValidationMsg || 'Dados inválidos');

    if (modoAutomatico) {
      // Pula direto pra submit (trigger vai criar comissoes)
      handleSubmit();
      return;
    }
    // Pré-popula linhas com todas as roles disponíveis sem colaborador
    if (colaboradores.length === 0 && regrasDisponiveis.length > 0) {
      setColaboradores(regrasDisponiveis.map(r => ({
        id: crypto.randomUUID(),
        role: r.role as ComissaoRole,
        member_id: '',
        percentual_override: '',
      })));
    }
    setStep(2);
  };

  const handleSubmit = async () => {
    if (!step1Valid) return toast.error(step1ValidationMsg || 'Dados inválidos');
    if (!modoAutomatico && comissoesPreview.length === 0) {
      return toast.error('Adicione pelo menos um colaborador');
    }
    if (!modoAutomatico) {
      const incompletos = comissoesPreview.filter(c => !c.member_id);
      if (incompletos.length > 0) return toast.error('Preencha colaborador em todas as linhas');
    }

    setSaving(true);
    try {
      // 1. Cria o recebimento
      const recebimentoPayload: any = {
        deal_id: dealId || null,
        tipo,
        numero_parcela: 1, // sempre 1 na criacao; parcelas extras sao adicionadas depois
        data_prevista: dataPrevista,
        valor_contrato: valorContratoNum,
        status: 'aguardando',
        empresa: empresa || null,
        observacao: observacao || null,
      };

      const { data: recebimento, error: rerr } = await supabase
        .from('deal_recebimentos')
        .insert(recebimentoPayload)
        .select()
        .single();

      if (rerr) throw rerr;

      // 2. Se manual, cria as comissoes explicitamente
      if (!modoAutomatico) {
        const rows = comissoesPreview.map(c => {
          const member = members.find(m => m.id === c.member_id);
          return {
            deal_id: dealId || null,
            recebimento_id: recebimento.id,
            numero_parcela: 1,
            member_id: c.member_id,
            member_name: member?.name || '(desconhecido)',
            role_comissao: c.role,
            tipo,
            categoria,
            valor_base: valorContratoNum,
            percentual: c.percentual_efetivo,
            valor_comissao: c.valor_comissao,
            empresa,
            observacao: observacao || null,
            editado_manualmente: true,
            status_comissao: 'aguardando_pgto',
            data_pgto: dataPrevista,
            data_liberacao: (() => {
              const d = new Date(dataPrevista + 'T00:00:00');
              d.setDate(d.getDate() + 30);
              return d.toISOString().slice(0, 10);
            })(),
          };
        });

        const { error: cerr } = await supabase.from('comissoes_registros').insert(rows);
        if (cerr) throw cerr;
      }

      toast.success(
        modoAutomatico
          ? 'Recebimento criado! Comissões serão geradas automaticamente pelo closer/sdr do deal.'
          : `Recebimento + ${comissoesPreview.length} comissão(ões) criado!`
      );
      onCreated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao criar');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const dealsSorted = useMemo(
    () => deals
      .filter(d => d.status === 'contrato_assinado')
      .sort((a, b) => (a.empresa || '').localeCompare(b.empresa || '')),
    [deals]
  );

  const activeMembers = useMemo(
    () => members.filter(m => m.active !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [members]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-bold text-white">Nova Comissão</h3>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={16} />
          </button>
        </div>
        <p className="text-[11px] text-[var(--color-v4-text-muted)] mb-4">
          Passo {step} de {modoAutomatico ? 1 : 2}
          {modoAutomatico && step === 1 && ' · comissões serão geradas automaticamente'}
        </p>

        {/* ===== STEP 1 — Recebimento ===== */}
        {step === 1 && (
          <div className="space-y-3 text-xs">
            <div>
              <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Categoria</label>
              <select
                value={categoria}
                onChange={e => setCategoria(e.target.value as ComissaoCategoria)}
                className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
              >
                {CATEGORIAS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
                Tipo {CATEGORIAS.find(c => c.value === categoria)?.tipoAuto && '(fixado pela categoria)'}
              </label>
              <select
                value={tipo}
                onChange={e => setTipo(e.target.value as ComissaoTipoValor)}
                disabled={!!CATEGORIAS.find(c => c.value === categoria)?.tipoAuto}
                className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs disabled:opacity-50"
              >
                {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
                Deal vinculado (opcional)
              </label>
              <select
                value={dealId}
                onChange={e => setDealId(e.target.value)}
                className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
              >
                <option value="">Sem deal (preenche empresa manualmente)</option>
                {dealsSorted.map(d => <option key={d.id} value={d.id}>{d.empresa}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Empresa</label>
              <input
                type="text"
                value={empresa}
                onChange={e => setEmpresa(e.target.value)}
                placeholder={dealId ? 'Preenchido pelo deal' : 'Digite o nome da empresa'}
                className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Data prevista</label>
                <input
                  type="date"
                  value={dataPrevista}
                  min="2020-01-01" max="2050-12-31"
                  onChange={e => {
                    const v = e.target.value;
                    if (v) {
                      const y = parseInt(v.slice(0, 4), 10);
                      if (!Number.isFinite(y) || y < 2020 || y > 2050) return;
                    }
                    setDataPrevista(v);
                  }}
                  className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Valor contrato (R$)</label>
                <input
                  type="number"
                  step="0.01"
                  value={valorContrato}
                  onChange={e => setValorContrato(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Observação</label>
              <input
                type="text"
                value={observacao}
                onChange={e => setObservacao(e.target.value)}
                placeholder="ex: Parcela 2/5, ISAAS competência 03/2026"
                className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
              />
            </div>

            {/* Card resumo */}
            <div className={`p-3 border rounded text-xs ${modoAutomatico ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-[var(--color-v4-border)] bg-[var(--color-v4-bg)]'}`}>
              {modoAutomatico ? (
                <>
                  <div className="text-emerald-400 font-semibold mb-1">✨ Modo automático</div>
                  <div className="text-[var(--color-v4-text-muted)]">
                    Categoria de aquisição com deal vinculado. Trigger do banco vai gerar as comissões do closer e SDR do deal automaticamente ao criar o recebimento.
                  </div>
                </>
              ) : (
                <>
                  <div className="text-white font-semibold mb-1">Modo manual</div>
                  <div className="text-[var(--color-v4-text-muted)]">
                    {regrasDisponiveis.length} role(s) disponível(is) pra {categoria}/{tipo}. No próximo passo você seleciona os colaboradores.
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2 mt-4">
              <button onClick={onClose}
                className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs">
                Cancelar
              </button>
              <button onClick={handleNext} disabled={!step1Valid || saving}
                className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50">
                {modoAutomatico ? (
                  <>{saving ? 'Criando...' : <><Save size={12} /> Criar recebimento</>}</>
                ) : (
                  <>Próximo <ArrowRight size={12} /></>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ===== STEP 2 — Colaboradores ===== */}
        {step === 2 && (
          <div className="text-xs">
            <div className="mb-3 p-3 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded flex justify-between items-center">
              <div>
                <div className="text-white font-semibold">{empresa}</div>
                <div className="text-[10px] text-[var(--color-v4-text-muted)]">
                  {categoria} · {tipo} · {fmt(valorContratoNum)} · {dataPrevista}
                </div>
              </div>
              <button onClick={() => setStep(1)}
                className="text-[10px] text-[var(--color-v4-text-muted)] hover:text-white flex items-center gap-1">
                <ArrowLeft size={10} /> editar
              </button>
            </div>

            <div className="mb-2 flex items-center justify-between">
              <div className="text-white font-semibold">Colaboradores ({colaboradores.length})</div>
              <button onClick={addLinha}
                className="px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-[10px] flex items-center gap-1">
                <Plus size={10} /> Adicionar
              </button>
            </div>

            <div className="space-y-2">
              {colaboradores.map((c) => {
                const preview = comissoesPreview.find(p => p.id === c.id);
                const rule = regrasDisponiveis.find(r => r.role === c.role);
                const sugerido = rule?.percentual || 0;
                return (
                  <div key={c.id} className="grid grid-cols-12 gap-2 items-center bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded p-2">
                    <select
                      value={c.role}
                      onChange={e => updateLinha(c.id, { role: e.target.value as ComissaoRole })}
                      className="col-span-3 px-2 py-1.5 rounded bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white text-[11px]"
                    >
                      {regrasDisponiveis.map(r => (
                        <option key={r.role} value={r.role}>{r.role}</option>
                      ))}
                    </select>
                    <select
                      value={c.member_id}
                      onChange={e => updateLinha(c.id, { member_id: e.target.value })}
                      className="col-span-5 px-2 py-1.5 rounded bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white text-[11px]"
                    >
                      <option value="">Selecione…</option>
                      {activeMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <input
                      type="number"
                      step="0.001"
                      value={c.percentual_override}
                      placeholder={String(sugerido)}
                      onChange={e => updateLinha(c.id, { percentual_override: e.target.value })}
                      className="col-span-2 px-2 py-1.5 rounded bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white text-[11px] text-center"
                      title={`Sugerido: ${(sugerido * 100).toFixed(1)}%`}
                    />
                    <div className="col-span-1 text-right text-[10px] text-white font-semibold">
                      {preview ? fmt(preview.valor_comissao) : '—'}
                    </div>
                    <button onClick={() => removeLinha(c.id)}
                      className="col-span-1 text-red-400 hover:text-red-300 justify-self-center">
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
              {colaboradores.length === 0 && (
                <div className="text-center text-[var(--color-v4-text-muted)] py-4">
                  Nenhum colaborador adicionado. Clique em "Adicionar" acima.
                </div>
              )}
            </div>

            <div className="grid grid-cols-12 gap-1 mt-2 text-[9px] text-[var(--color-v4-text-muted)] uppercase px-2">
              <div className="col-span-3">Role</div>
              <div className="col-span-5">Colaborador</div>
              <div className="col-span-2 text-center">% (vazio = sugerido)</div>
              <div className="col-span-1 text-right">Valor</div>
              <div className="col-span-1"></div>
            </div>

            <div className="mt-4 p-3 bg-[var(--color-v4-card-hover)] rounded text-xs flex justify-between">
              <span className="text-[var(--color-v4-text-muted)]">Total comissões</span>
              <span className="text-white font-bold">{fmt(totalComissoes)}</span>
            </div>

            <div className="flex gap-2 mt-4">
              <button onClick={() => setStep(1)}
                className="px-4 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs flex items-center gap-1">
                <ArrowLeft size={12} /> Voltar
              </button>
              <button onClick={handleSubmit} disabled={saving || colaboradores.length === 0}
                className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50">
                <Save size={12} /> {saving ? 'Salvando...' : `Criar ${colaboradores.length > 0 ? colaboradores.length + ' ' : ''}comissão(ões)`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
