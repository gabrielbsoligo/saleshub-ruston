// =============================================================
// NovaComissaoModal — RFC Comissoes v2
// =============================================================
// Modal com seletor em cascata (categoria -> tipo -> role) que
// busca percentual em comissoes_config. Utilizado para comissoes
// de monetizacao (ee_assessoria, ee_ot, upsell) e correcoes
// manuais pela gestao/financeiro.
// =============================================================
import React, { useMemo, useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';
import type { ComissaoCategoria, ComissaoTipoValor, ComissaoRole } from '../types';

const CATEGORIAS: { value: ComissaoCategoria; label: string }[] = [
  { value: 'inbound', label: 'Inbound (leadbroker / blackbox)' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'upsell', label: 'Upsell (MRR/OT em base ativa)' },
  { value: 'ee_assessoria', label: 'EE > Assessoria (MRR)' },
  { value: 'ee_ot', label: 'EE > OT' },
  { value: 'indicacao', label: 'Indicação' },
  { value: 'recomendacao', label: 'Recomendação' },
];

const TIPOS: { value: ComissaoTipoValor; label: string }[] = [
  { value: 'mrr', label: 'MRR (recorrência)' },
  { value: 'ot', label: 'OT (setup/one-time)' },
  { value: 'variavel', label: 'Variável (ISAAS/outros)' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export const NovaComissaoModal: React.FC<Props> = ({ open, onClose, onCreated }) => {
  const { comissoes: comissoesConfig, members, deals } = useAppStore();

  const [categoria, setCategoria] = useState<ComissaoCategoria>('ee_assessoria');
  const [tipo, setTipo] = useState<ComissaoTipoValor>('mrr');
  const [role, setRole] = useState<ComissaoRole>('account');
  const [memberId, setMemberId] = useState<string>('');
  const [dealId, setDealId] = useState<string>('');
  const [empresa, setEmpresa] = useState('');
  const [valorBase, setValorBase] = useState('');
  const [percentualManual, setPercentualManual] = useState('');
  const [observacao, setObservacao] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset quando abre
  useEffect(() => {
    if (open) {
      setCategoria('ee_assessoria');
      setTipo('mrr');
      setRole('account');
      setMemberId('');
      setDealId('');
      setEmpresa('');
      setValorBase('');
      setPercentualManual('');
      setObservacao('');
    }
  }, [open]);

  // Roles disponíveis para a categoria+tipo selecionados
  const rolesDisponiveis = useMemo(() => {
    const regras = comissoesConfig.filter(c => c.categoria === categoria && c.tipo_valor === tipo && c.active);
    return regras.map(r => r.role);
  }, [comissoesConfig, categoria, tipo]);

  // Se categoria/tipo muda, garante que role está na lista disponível
  useEffect(() => {
    if (rolesDisponiveis.length > 0 && !rolesDisponiveis.includes(role)) {
      setRole(rolesDisponiveis[0]);
    }
  }, [rolesDisponiveis, role]);

  // Percentual sugerido do config
  const percentualSugerido = useMemo(() => {
    const rule = comissoesConfig.find(
      c => c.role === role && c.categoria === categoria && c.tipo_valor === tipo && c.active
    );
    return rule?.percentual ?? 0;
  }, [comissoesConfig, role, categoria, tipo]);

  const percentualEfetivo = percentualManual ? parseFloat(percentualManual) : percentualSugerido;
  const valorBaseNum = parseFloat(valorBase) || 0;
  const valorComissao = valorBaseNum * percentualEfetivo;

  // Se escolher deal, preenche empresa automaticamente
  useEffect(() => {
    if (dealId) {
      const d = deals.find(x => x.id === dealId);
      if (d) {
        setEmpresa(d.empresa || '');
        if (!valorBase) {
          const vb = tipo === 'mrr' ? (d.valor_recorrente || 0) : (d.valor_escopo || 0);
          if (vb) setValorBase(String(vb));
        }
      }
    }
  }, [dealId, deals, tipo]);

  const handleSave = async () => {
    if (!memberId) return toast.error('Selecione o colaborador');
    if (!empresa) return toast.error('Informe a empresa');
    if (valorBaseNum <= 0) return toast.error('Valor base deve ser > 0');
    if (percentualEfetivo <= 0) return toast.error('Percentual deve ser > 0');

    setSaving(true);
    try {
      const member = members.find(m => m.id === memberId);
      const payload: any = {
        deal_id: dealId || null,
        member_id: memberId,
        member_name: member?.name || '(desconhecido)',
        role_comissao: role,
        tipo,
        categoria,
        valor_base: valorBaseNum,
        percentual: percentualEfetivo,
        valor_comissao: valorComissao,
        empresa,
        observacao: observacao || null,
        editado_manualmente: true,
        status_comissao: 'aguardando_pgto',
      };

      const { error } = await supabase.from('comissoes_registros').insert(payload);
      if (error) throw error;
      toast.success('Comissão criada!');
      onCreated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao criar');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-white">Nova Comissão</h3>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 text-xs">
          {/* Categoria */}
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

          {/* Tipo valor */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Tipo</label>
            <select
              value={tipo}
              onChange={e => setTipo(e.target.value as ComissaoTipoValor)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            >
              {TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          {/* Role */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
              Role ({rolesDisponiveis.length} disponível(is) pra essa combinação)
            </label>
            <select
              value={role}
              onChange={e => setRole(e.target.value as ComissaoRole)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            >
              {rolesDisponiveis.length === 0 ? (
                <option value="">Sem regra configurada</option>
              ) : (
                rolesDisponiveis.map(r => <option key={r} value={r}>{r}</option>)
              )}
            </select>
          </div>

          {/* Colaborador */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Colaborador</label>
            <select
              value={memberId}
              onChange={e => setMemberId(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            >
              <option value="">Selecione</option>
              {members
                .filter(m => m.active !== false)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(m => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
            </select>
          </div>

          {/* Deal (opcional) */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
              Deal vinculado (opcional)
            </label>
            <select
              value={dealId}
              onChange={e => setDealId(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            >
              <option value="">Sem deal (manual puro)</option>
              {deals
                .filter(d => d.status === 'contrato_assinado')
                .sort((a, b) => (a.empresa || '').localeCompare(b.empresa || ''))
                .map(d => <option key={d.id} value={d.id}>{d.empresa}</option>)}
            </select>
          </div>

          {/* Empresa */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Empresa</label>
            <input
              type="text"
              value={empresa}
              onChange={e => setEmpresa(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            />
          </div>

          {/* Valor base */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Valor Base (R$)</label>
            <input
              type="number"
              step="0.01"
              value={valorBase}
              onChange={e => setValorBase(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            />
          </div>

          {/* Percentual */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">
              Percentual (decimal, ex 0.2 = 20%). Sugerido: {(percentualSugerido * 100).toFixed(1)}%
            </label>
            <input
              type="number"
              step="0.001"
              value={percentualManual}
              placeholder={String(percentualSugerido)}
              onChange={e => setPercentualManual(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            />
          </div>

          {/* Observacao */}
          <div>
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Observação</label>
            <input
              type="text"
              value={observacao}
              onChange={e => setObservacao(e.target.value)}
              placeholder="ex: Upsell OT - fechou 10%, ISAAS - competencia 03/2026"
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            />
          </div>

          {/* Preview */}
          <div className="p-3 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-xs">
            <div className="text-[var(--color-v4-text-muted)]">Comissão calculada:</div>
            <div className="text-lg font-bold text-white">{fmt(valorComissao)}</div>
            <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">
              {fmt(valorBaseNum)} × {(percentualEfetivo * 100).toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose}
            className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs">
            Cancelar
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50">
            <Save size={12} /> {saving ? 'Salvando...' : 'Criar comissão'}
          </button>
        </div>
      </div>
    </div>
  );
};
