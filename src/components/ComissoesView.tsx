import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { ROLE_LABELS } from "../types";
import { DollarSign, ChevronDown, ChevronRight, RefreshCw, Edit2, Save, X, Check, Search, Users, Building2 } from "lucide-react";
import toast from "react-hot-toast";

function fmt(v: number) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v); }

function getCategoria(origem?: string): 'inbound' | 'outbound' {
  if (!origem) return 'inbound';
  return ['blackbox', 'leadbroker'].includes(origem) ? 'inbound' : 'outbound';
}

type StatusComissao = 'aguardando_pgto' | 'liberada' | 'paga';

const STATUS_LABELS: Record<StatusComissao, string> = {
  aguardando_pgto: 'Aguardando Pgto',
  liberada: 'Liberada',
  paga: 'Paga',
};

const STATUS_COLORS: Record<StatusComissao, string> = {
  aguardando_pgto: 'bg-yellow-500/20 text-yellow-400',
  liberada: 'bg-blue-500/20 text-blue-400',
  paga: 'bg-green-500/20 text-green-400',
};

interface ComissaoRegistro {
  id: string;
  deal_id?: string;
  member_id?: string;
  member_name: string;
  role_comissao: string;
  tipo: 'mrr' | 'ot';
  categoria: string;
  valor_base: number;
  percentual: number;
  valor_comissao: number;
  data_pgto?: string;
  data_liberacao?: string;
  empresa: string;
  origem?: string;
  observacao?: string;
  editado_manualmente: boolean;
  status_comissao: StatusComissao;
  data_pgto_real?: string;
  valor_recebido?: number;
  data_pgto_vendedor?: string;
  confirmado_por?: string;
}

type ViewTab = 'funcionario' | 'cliente';

export const ComissoesView: React.FC = () => {
  const { deals, members, comissoes: comissoesConfig, currentUser } = useAppStore();
  const isGestor = currentUser?.role === 'gestor';
  const isFinanceiro = currentUser?.role === 'financeiro';
  const canEdit = isGestor;
  const canConfirm = isGestor || isFinanceiro;
  const canViewAll = isGestor || isFinanceiro;
  const [viewTab, setViewTab] = useState<ViewTab>(isFinanceiro ? 'cliente' : 'funcionario');
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [registros, setRegistros] = useState<ComissaoRegistro[]>([]);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ComissaoRegistro>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  // Client view filters
  const [searchEmpresa, setSearchEmpresa] = useState('');
  const [filterStatus, setFilterStatus] = useState<StatusComissao | ''>('');
  const [filterVendedor, setFilterVendedor] = useState('');

  // Confirm payment modal — per line
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmForm, setConfirmForm] = useState({ data_pgto_real: '', valor_recebido: '' });
  // Pay vendor modal
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payForm, setPayForm] = useState({ data_pgto_vendedor: '' });

  const now = new Date();

  // Fetch registros
  const fetchRegistros = useCallback(async () => {
    const [year, month] = selectedMonth.split('-').map(Number);
    const start = `${selectedMonth}-01`;
    const end = new Date(year, month, 0).toISOString().split('T')[0];

    let query = supabase.from('comissoes_registros').select('*').order('empresa');

    if (viewTab === 'cliente') {
      // Client view: filter by data_pgto (contract payment date) within month
      query = query.gte('data_pgto', start).lte('data_pgto', end);
      if (filterStatus) query = query.eq('status_comissao', filterStatus);
    } else {
      // Employee view: filter by data_liberacao within month
      query = query.gte('data_liberacao', start).lte('data_liberacao', end);
    }

    const { data } = await query;
    if (data) setRegistros(data);
  }, [selectedMonth, viewTab, filterStatus]);

  useEffect(() => { fetchRegistros(); }, [fetchRegistros]);

  // Generate comissoes from deals
  const generateComissoes = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const dealsGanhos = deals.filter(d => d.status === 'contrato_assinado');
      const newRegistros: any[] = [];

      for (const deal of dealsGanhos) {
        const categoria = getCategoria(deal.origem);

        if (deal.closer_id) {
          const closer = members.find(m => m.id === deal.closer_id);
          const mrrVal = deal.valor_recorrente || deal.valor_mrr || 0;
          const otVal = deal.valor_escopo || deal.valor_ot || 0;

          if (mrrVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'closer' && c.tipo_origem === categoria && c.tipo_valor === 'mrr');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_recorrente || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.closer_id, member_name: closer?.name || '?',
              role_comissao: 'closer', tipo: 'mrr', categoria, valor_base: mrrVal,
              percentual: pct, valor_comissao: mrrVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem, status_comissao: 'aguardando_pgto',
            });
          }
          if (otVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'closer' && c.tipo_origem === categoria && c.tipo_valor === 'ot');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_escopo || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.closer_id, member_name: closer?.name || '?',
              role_comissao: 'closer', tipo: 'ot', categoria, valor_base: otVal,
              percentual: pct, valor_comissao: otVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem, status_comissao: 'aguardando_pgto',
            });
          }
        }

        if (deal.sdr_id) {
          const sdr = members.find(m => m.id === deal.sdr_id);
          const mrrVal = deal.valor_recorrente || deal.valor_mrr || 0;
          const otVal = deal.valor_escopo || deal.valor_ot || 0;

          if (mrrVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'sdr' && c.tipo_origem === categoria && c.tipo_valor === 'mrr');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_recorrente || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.sdr_id, member_name: sdr?.name || '?',
              role_comissao: 'sdr', tipo: 'mrr', categoria, valor_base: mrrVal,
              percentual: pct, valor_comissao: mrrVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem, status_comissao: 'aguardando_pgto',
            });
          }
          if (otVal > 0) {
            const rule = comissoesConfig.find(c => c.role === 'sdr' && c.tipo_origem === categoria && c.tipo_valor === 'ot');
            const pct = rule?.percentual || 0;
            const dataPgto = deal.data_pgto_escopo || deal.data_primeiro_pagamento || null;
            const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
            newRegistros.push({
              deal_id: deal.id, member_id: deal.sdr_id, member_name: sdr?.name || '?',
              role_comissao: 'sdr', tipo: 'ot', categoria, valor_base: otVal,
              percentual: pct, valor_comissao: otVal * pct, data_pgto: dataPgto, data_liberacao: dataLib,
              empresa: deal.empresa, origem: deal.origem, status_comissao: 'aguardando_pgto',
            });
          }
        }
      }

      await supabase.from('comissoes_registros').delete().eq('editado_manualmente', false);
      if (newRegistros.length > 0) {
        await supabase.from('comissoes_registros').insert(newRegistros);
      }

      toast.success(`${newRegistros.length} registros de comissão gerados!`);
      fetchRegistros();
    } finally { setIsProcessing(false); }
  };

  // Confirm client payment — links all lines from same deal_id + tipo
  // If deal_id exists, confirms all comissões for that contract+tipo at once
  // If manual (no deal_id), confirms only that single line
  const handleConfirmPgto = async () => {
    if (!confirmingId) return;
    const reg = registros.find(r => r.id === confirmingId);
    if (!reg) return;

    const dataReal = confirmForm.data_pgto_real;
    const valorRecebido = Number(confirmForm.valor_recebido) || 0;

    if (!dataReal) { toast.error('Informe a data de pagamento real'); return; }
    if (valorRecebido <= 0) { toast.error('Informe o valor recebido'); return; }

    const dataLib = new Date(new Date(dataReal).getTime() + 30 * 86400000).toISOString().split('T')[0];

    // Find linked lines: same deal_id + same tipo (from same contract)
    const linkedLines = reg.deal_id
      ? registros.filter(r => r.deal_id === reg.deal_id && r.tipo === reg.tipo && r.status_comissao === 'aguardando_pgto')
      : [reg];

    let totalComissaoNova = 0;
    for (const line of linkedLines) {
      const novaComissao = valorRecebido * line.percentual;
      totalComissaoNova += novaComissao;

      await supabase.from('comissoes_registros').update({
        status_comissao: 'liberada',
        data_pgto_real: dataReal,
        valor_recebido: valorRecebido,
        valor_base: valorRecebido,
        valor_comissao: novaComissao,
        data_liberacao: dataLib,
        confirmado_por: currentUser?.id,
      }).eq('id', line.id);
    }

    const linkedMsg = linkedLines.length > 1 ? ` (${linkedLines.length} comissões do mesmo contrato)` : '';
    toast.success(`${reg.tipo.toUpperCase()} de ${reg.empresa} confirmado!${linkedMsg} Total: ${fmt(totalComissaoNova)}`);
    setConfirmingId(null);
    setConfirmForm({ data_pgto_real: '', valor_recebido: '' });
    fetchRegistros();
  };

  // Confirm vendor payment
  const handlePayVendor = async () => {
    if (!payingId) return;
    if (!payForm.data_pgto_vendedor) { toast.error('Informe a data de pagamento'); return; }

    const { error } = await supabase.from('comissoes_registros').update({
      status_comissao: 'paga',
      data_pgto_vendedor: payForm.data_pgto_vendedor,
      confirmado_por: currentUser?.id,
    }).eq('id', payingId);

    if (error) { toast.error(error.message); return; }
    toast.success('Pagamento ao vendedor registrado!');
    setPayingId(null);
    setPayForm({ data_pgto_vendedor: '' });
    fetchRegistros();
  };

  // Edit a registro (gestor only)
  const startEdit = (reg: ComissaoRegistro) => {
    setEditingId(reg.id);
    setEditForm({ ...reg });
  };

  const saveEdit = async () => {
    if (!editingId || !editForm) return;
    const { error } = await supabase.from('comissoes_registros').update({
      empresa: editForm.empresa,
      member_name: editForm.member_name,
      role_comissao: editForm.role_comissao,
      valor_base: editForm.valor_base,
      percentual: editForm.percentual,
      valor_comissao: editForm.valor_comissao,
      data_pgto: editForm.data_pgto || null,
      data_liberacao: editForm.data_liberacao || null,
      observacao: editForm.observacao || null,
      editado_manualmente: true,
    }).eq('id', editingId);
    if (error) { toast.error(error.message); return; }
    toast.success('Registro atualizado!');
    setEditingId(null);
    fetchRegistros();
  };

  const deleteRegistro = async (id: string) => {
    if (!confirm('Excluir este registro de comissão?')) return;
    await supabase.from('comissoes_registros').delete().eq('id', id);
    fetchRegistros();
  };

  const addManual = async () => {
    const { error } = await supabase.from('comissoes_registros').insert({
      member_name: '(editar nome)', role_comissao: 'sdr', tipo: 'ot', categoria: 'outbound',
      valor_base: 0, percentual: 0, valor_comissao: 0, empresa: '(editar)',
      editado_manualmente: true, data_liberacao: `${selectedMonth}-15`,
      status_comissao: 'aguardando_pgto',
    });
    if (error) { toast.error(error.message); return; }
    fetchRegistros();
  };

  // Group by member (funcionario view)
  const grouped = useMemo(() => {
    const map: Record<string, { name: string; lines: ComissaoRegistro[]; total: number; liberado: number; pago: number }> = {};
    for (const reg of registros) {
      const key = reg.member_name || 'Sem nome';
      if (!map[key]) map[key] = { name: key, lines: [], total: 0, liberado: 0, pago: 0 };
      map[key].lines.push(reg);
      map[key].total += reg.valor_comissao;
      if (reg.status_comissao === 'liberada') map[key].liberado += reg.valor_comissao;
      if (reg.status_comissao === 'paga') map[key].pago += reg.valor_comissao;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [registros]);

  // Filtered for client view
  const filteredClient = useMemo(() => {
    return registros.filter(r => {
      if (searchEmpresa && !r.empresa.toLowerCase().includes(searchEmpresa.toLowerCase())) return false;
      if (filterStatus && r.status_comissao !== filterStatus) return false;
      if (filterVendedor && r.member_name !== filterVendedor) return false;
      return true;
    }).sort((a, b) => a.empresa.localeCompare(b.empresa) || a.member_name.localeCompare(b.member_name));
  }, [registros, searchEmpresa, filterStatus, filterVendedor]);

  const vendedoresUnicos = useMemo(() => {
    const names = new Set(registros.map(r => r.member_name));
    return Array.from(names).sort();
  }, [registros]);

  // Summary
  const totalGeral = registros.reduce((a, r) => a + r.valor_comissao, 0);
  const aguardandoGeral = registros.filter(r => r.status_comissao === 'aguardando_pgto').reduce((a, r) => a + r.valor_comissao, 0);
  const liberadoGeral = registros.filter(r => r.status_comissao === 'liberada').reduce((a, r) => a + r.valor_comissao, 0);
  const pagoGeral = registros.filter(r => r.status_comissao === 'paga').reduce((a, r) => a + r.valor_comissao, 0);

  const inputClass = "px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Comissões</h2>
        <div className="flex items-center gap-3">
          <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
            className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm" />
          {canEdit && (
            <button onClick={addManual}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs">
              + Manual
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-[var(--color-v4-surface)] rounded-lg p-0.5 w-fit">
        <button onClick={() => setViewTab('funcionario')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${viewTab === 'funcionario' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)] hover:text-white'}`}>
          <Users size={14} /> Por Funcionário
        </button>
        <button onClick={() => setViewTab('cliente')}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${viewTab === 'cliente' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)] hover:text-white'}`}>
          <Building2 size={14} /> Por Cliente
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
          <span className="text-xs text-[var(--color-v4-text-muted)]">Total Comissões</span>
          <p className="text-xl font-bold text-white mt-1">{fmt(totalGeral)}</p>
          <p className="text-[10px] text-[var(--color-v4-text-muted)]">{registros.length} registros</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-xl p-4">
          <span className="text-xs text-yellow-400">Aguardando Pgto</span>
          <p className="text-xl font-bold text-yellow-400 mt-1">{fmt(aguardandoGeral)}</p>
          <p className="text-[10px] text-yellow-400/60">{registros.filter(r => r.status_comissao === 'aguardando_pgto').length} registros</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-blue-500/30 rounded-xl p-4">
          <span className="text-xs text-blue-400">Liberada</span>
          <p className="text-xl font-bold text-blue-400 mt-1">{fmt(liberadoGeral)}</p>
          <p className="text-[10px] text-blue-400/60">{registros.filter(r => r.status_comissao === 'liberada').length} registros</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-green-500/30 rounded-xl p-4">
          <span className="text-xs text-green-400">Paga</span>
          <p className="text-xl font-bold text-green-400 mt-1">{fmt(pagoGeral)}</p>
          <p className="text-[10px] text-green-400/60">{registros.filter(r => r.status_comissao === 'paga').length} registros</p>
        </div>
      </div>

      {/* ==================== VIEW POR FUNCIONÁRIO ==================== */}
      {viewTab === 'funcionario' && (
        <>
          {/* Tabela de regras */}
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-6">
            <h3 className="text-xs font-semibold text-[var(--color-v4-text-muted)] uppercase tracking-wider mb-3">Tabela de Comissões</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">Inbound (BB + LB)</p>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  <span></span><span className="text-center text-[var(--color-v4-text-muted)]">Closer</span><span className="text-center text-[var(--color-v4-text-muted)]">SDR</span>
                  <span className="text-white">MRR</span><span className="text-center text-white">10%</span><span className="text-center text-white">5%</span>
                  <span className="text-white">OT</span><span className="text-center text-white">5%</span><span className="text-center text-white">2%</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">Outbound + Recom. + Indicação</p>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  <span></span><span className="text-center text-[var(--color-v4-text-muted)]">Closer</span><span className="text-center text-[var(--color-v4-text-muted)]">SDR</span>
                  <span className="text-white">MRR</span><span className="text-center text-white">30%</span><span className="text-center text-white">10%</span>
                  <span className="text-white">OT</span><span className="text-center text-white">15%</span><span className="text-center text-white">5%</span>
                </div>
              </div>
            </div>
            <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-3">Fluxo: Aguardando Pgto → Liberada (cliente pagou + 30d) → Paga (vendedor recebeu)</p>
            <div className="border-t border-[var(--color-v4-border)] mt-4 pt-3">
              <h4 className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">Monetização</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">EE {'>'} Assessoria</p>
                  <div className="grid grid-cols-4 gap-1 text-xs">
                    <span></span><span className="text-center text-[var(--color-v4-text-muted)]">Account</span><span className="text-center text-[var(--color-v4-text-muted)]">GT</span><span className="text-center text-[var(--color-v4-text-muted)]">Designer</span>
                    <span className="text-white">MRR</span><span className="text-center text-white">20%</span><span className="text-center text-white">5%</span><span className="text-center text-white">5%</span>
                    <span className="text-white">OT</span><span className="text-center text-white">10%</span><span className="text-center text-white">2.5%</span><span className="text-center text-white">2.5%</span>
                  </div>
                </div>
                <div>
                  <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-2">Upsell</p>
                  <div className="grid grid-cols-3 gap-1 text-xs">
                    <span></span><span className="text-center text-[var(--color-v4-text-muted)]">Levantou</span><span className="text-center text-[var(--color-v4-text-muted)]">Fechou</span>
                    <span className="text-white">MRR</span><span className="text-center text-white">10%</span><span className="text-center text-white">20%</span>
                    <span className="text-white">OT</span><span className="text-center text-white">5%</span><span className="text-center text-white">10%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Por membro */}
          {grouped.length > 0 ? (
            <div className="space-y-3">
              {grouped.map(({ name, lines, total, liberado, pago }) => {
                const isExpanded = expandedMember === name;
                const aguardando = total - liberado - pago;
                return (
                  <div key={name} className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden">
                    <button onClick={() => setExpandedMember(isExpanded ? null : name)}
                      className="w-full flex items-center justify-between px-5 py-4 hover:bg-[var(--color-v4-card-hover)] transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-xs">
                          {name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-white">{name}</span>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <span className="text-sm font-bold text-white">{fmt(total)}</span>
                          <div className="flex gap-2 text-[10px]">
                            {pago > 0 && <span className="text-green-400">{fmt(pago)} paga</span>}
                            {liberado > 0 && <span className="text-blue-400">{fmt(liberado)} lib.</span>}
                            {aguardando > 0 && <span className="text-yellow-400">{fmt(aguardando)} pend.</span>}
                          </div>
                        </div>
                        <span className="text-xs text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)] px-2 py-0.5 rounded">{lines.length}</span>
                        {isExpanded ? <ChevronDown size={14} className="text-[var(--color-v4-text-muted)]" /> : <ChevronRight size={14} className="text-[var(--color-v4-text-muted)]" />}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-[var(--color-v4-border)] overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)]">
                              <th className="px-3 py-2 text-left">Empresa</th>
                              <th className="px-3 py-2">Role</th>
                              <th className="px-3 py-2">Tipo</th>
                              <th className="px-3 py-2">Cat.</th>
                              <th className="px-3 py-2">Valor</th>
                              <th className="px-3 py-2">%</th>
                              <th className="px-3 py-2">Comissão</th>
                              <th className="px-3 py-2">Status</th>
                              {(canEdit || canConfirm) && <th className="px-3 py-2">Ações</th>}
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map(line => {
                              const isEditing = editingId === line.id;

                              if (isEditing) {
                                return (
                                  <tr key={line.id} className="border-t border-[var(--color-v4-border)] bg-[var(--color-v4-surface)]">
                                    <td className="px-3 py-2">
                                      <input className={inputClass + " w-24 mb-1"} value={editForm.empresa || ''} onChange={e => setEditForm(p => ({ ...p, empresa: e.target.value }))} />
                                      <input className={inputClass + " w-24"} value={editForm.member_name || ''} onChange={e => setEditForm(p => ({ ...p, member_name: e.target.value }))} />
                                    </td>
                                    <td className="px-3 py-2"><input className={inputClass + " w-16"} value={editForm.role_comissao || ''} onChange={e => setEditForm(p => ({ ...p, role_comissao: e.target.value }))} /></td>
                                    <td className="px-3 py-2"><select className={inputClass} value={editForm.tipo} onChange={e => setEditForm(p => ({ ...p, tipo: e.target.value as any }))}><option value="mrr">MRR</option><option value="ot">OT</option></select></td>
                                    <td className="px-3 py-2"><select className={inputClass} value={editForm.categoria} onChange={e => setEditForm(p => ({ ...p, categoria: e.target.value }))}><option value="inbound">Inbound</option><option value="outbound">Outbound</option><option value="upsell_mrr">Upsell MRR</option><option value="upsell_ot">Upsell OT</option><option value="ee_assessoria">EE Assessoria</option><option value="ee_ot">EE OT</option></select></td>
                                    <td className="px-3 py-2"><input type="number" className={inputClass + " w-20"} value={editForm.valor_base} onChange={e => { const v = Number(e.target.value); setEditForm(p => ({ ...p, valor_base: v, valor_comissao: v * (p.percentual || 0) })); }} /></td>
                                    <td className="px-3 py-2"><input type="number" step="0.01" className={inputClass + " w-14"} value={editForm.percentual} onChange={e => { const pct = Number(e.target.value); setEditForm(p => ({ ...p, percentual: pct, valor_comissao: (p.valor_base || 0) * pct })); }} /></td>
                                    <td className="px-3 py-2"><input type="number" className={inputClass + " w-20"} value={editForm.valor_comissao} onChange={e => setEditForm(p => ({ ...p, valor_comissao: Number(e.target.value) }))} /></td>
                                    <td className="px-3 py-2"></td>
                                    <td className="px-3 py-2 flex gap-1">
                                      <button onClick={saveEdit} className="text-green-400 hover:text-green-300"><Save size={12} /></button>
                                      <button onClick={() => setEditingId(null)} className="text-[var(--color-v4-text-muted)]"><X size={12} /></button>
                                    </td>
                                  </tr>
                                );
                              }

                              return (
                                <tr key={line.id} className={`border-t border-[var(--color-v4-border)] ${line.editado_manualmente ? 'bg-yellow-500/5' : ''}`}>
                                  <td className="px-3 py-2 text-white">{line.empresa} {line.origem === 'monetizacao' && <span className="text-[8px] text-purple-400 ml-1">monet.</span>}</td>
                                  <td className="px-3 py-2 text-center text-[var(--color-v4-text-muted)]">{line.role_comissao}</td>
                                  <td className="px-3 py-2 text-center"><span className={`px-1.5 py-0.5 rounded ${line.tipo === 'mrr' ? 'bg-green-500/15 text-green-400' : 'bg-blue-500/15 text-blue-400'}`}>{line.tipo.toUpperCase()}</span></td>
                                  <td className="px-3 py-2 text-center text-[var(--color-v4-text-muted)]">{{inbound:'Inbound',outbound:'Outbound',upsell_mrr:'Upsell',upsell_ot:'Upsell',ee_assessoria:'EE Assess.',ee_ot:'EE OT'}[line.categoria] || line.categoria}</td>
                                  <td className="px-3 py-2 text-center text-white">{fmt(line.valor_base)}</td>
                                  <td className="px-3 py-2 text-center text-white">{(line.percentual * 100).toFixed(0)}%</td>
                                  <td className="px-3 py-2 text-center font-bold text-white">{fmt(line.valor_comissao)}</td>
                                  <td className="px-3 py-2 text-center">
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[line.status_comissao]}`}>
                                      {STATUS_LABELS[line.status_comissao]}
                                    </span>
                                  </td>
                                  {(canEdit || canConfirm) && (
                                    <td className="px-3 py-2">
                                      <div className="flex gap-1">
                                        {canEdit && <button onClick={() => startEdit(line)} className="text-[var(--color-v4-text-muted)] hover:text-white"><Edit2 size={12} /></button>}
                                        {canEdit && <button onClick={() => deleteRegistro(line.id)} className="text-[var(--color-v4-text-muted)] hover:text-red-400"><X size={12} /></button>}
                                        {canConfirm && line.status_comissao === 'aguardando_pgto' && (
                                          <button onClick={() => { setConfirmingId(line.id); setConfirmForm({ data_pgto_real: '', valor_recebido: String(line.valor_base) }); }}
                                            className="text-yellow-400 hover:text-yellow-300 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 hover:bg-yellow-500/20">
                                            Confirmar Pgto
                                          </button>
                                        )}
                                        {canConfirm && line.status_comissao === 'liberada' && (
                                          <button onClick={() => { setPayingId(line.id); setPayForm({ data_pgto_vendedor: '' }); }}
                                            className="text-green-400 hover:text-green-300 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 hover:bg-green-500/20">
                                            Pagar Vendedor
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhum registro de comissão para este período</p>
              <p className="text-xs text-[var(--color-v4-text-muted)] mt-2">Comissões são geradas automaticamente quando um deal é dado como ganho.</p>
            </div>
          )}
        </>
      )}

      {/* ==================== VIEW POR CLIENTE ==================== */}
      {viewTab === 'cliente' && (
        <>
          {/* Filters */}
          <div className="flex flex-wrap gap-3 mb-4 items-center">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
              <input type="text" placeholder="Buscar empresa..." value={searchEmpresa} onChange={e => setSearchEmpresa(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]" />
            </div>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}
              className={`px-3 py-2 rounded-lg border text-sm transition-colors ${filterStatus ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
              <option value="">Todos os Status</option>
              <option value="aguardando_pgto">⏳ Aguardando Pgto</option>
              <option value="liberada">🔓 Liberada</option>
              <option value="paga">✅ Paga</option>
            </select>
            <select value={filterVendedor} onChange={e => setFilterVendedor(e.target.value)}
              className={`px-3 py-2 rounded-lg border text-sm transition-colors ${filterVendedor ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]' : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'}`}>
              <option value="">Todos Vendedores</option>
              {vendedoresUnicos.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
            {(searchEmpresa || filterStatus || filterVendedor) && (
              <button onClick={() => { setSearchEmpresa(''); setFilterStatus(''); setFilterVendedor(''); }}
                className="px-2.5 py-2 rounded-lg text-xs text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]">
                Limpar filtros
              </button>
            )}
          </div>

          {/* Client table */}
          <div className="overflow-auto rounded-xl border border-[var(--color-v4-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-v4-card)] sticky top-0">
                <tr className="text-left text-[var(--color-v4-text-muted)]">
                  <th className="px-4 py-3 font-medium">Empresa</th>
                  <th className="px-4 py-3 font-medium">Vendedor</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium text-center">Tipo</th>
                  <th className="px-4 py-3 font-medium text-right">Valor Base</th>
                  <th className="px-4 py-3 font-medium text-center">%</th>
                  <th className="px-4 py-3 font-medium text-right">Comissão</th>
                  <th className="px-4 py-3 font-medium text-center">Pgto Contrato</th>
                  <th className="px-4 py-3 font-medium text-center">Pgto Real</th>
                  <th className="px-4 py-3 font-medium text-center">Liberação</th>
                  <th className="px-4 py-3 font-medium text-center">Status</th>
                  {canConfirm && <th className="px-4 py-3 font-medium text-center">Ações</th>}
                </tr>
              </thead>
              <tbody>
                {filteredClient.map((line, idx) => {
                  // Show empresa name only on first row of group
                  const showEmpresa = idx === 0 || filteredClient[idx - 1].empresa !== line.empresa;
                  const empresaGroup = filteredClient.filter(r => r.empresa === line.empresa);
                  const isFirstRow = showEmpresa;

                  return (
                    <tr key={line.id} className={`border-t border-[var(--color-v4-border)] hover:bg-[var(--color-v4-card-hover)] transition-colors ${isFirstRow ? 'border-t-2 border-t-[var(--color-v4-border)]' : ''}`}>
                      <td className="px-4 py-3">
                        {showEmpresa ? <span className="text-white font-medium">{line.empresa}</span> : <span className="text-[var(--color-v4-text-muted)]/30">↳</span>}
                      </td>
                      <td className="px-4 py-3 text-white">{line.member_name}</td>
                      <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{line.role_comissao}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-1.5 py-0.5 rounded ${line.tipo === 'mrr' ? 'bg-green-500/15 text-green-400' : 'bg-blue-500/15 text-blue-400'}`}>{line.tipo.toUpperCase()}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-white">{fmt(line.valor_base)}</td>
                      <td className="px-4 py-3 text-center text-white">{(line.percentual * 100).toFixed(0)}%</td>
                      <td className="px-4 py-3 text-right font-bold text-white">{fmt(line.valor_comissao)}</td>
                      <td className="px-4 py-3 text-center text-[var(--color-v4-text-muted)]">{line.data_pgto ? new Date(line.data_pgto + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}</td>
                      <td className="px-4 py-3 text-center">
                        {line.data_pgto_real ? (
                          <span className="text-green-400">{new Date(line.data_pgto_real + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                        ) : (
                          <span className="text-[var(--color-v4-text-muted)]">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-[var(--color-v4-text-muted)]">{line.data_liberacao ? new Date(line.data_liberacao + 'T12:00:00').toLocaleDateString('pt-BR') : '—'}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${STATUS_COLORS[line.status_comissao]}`}>
                          {STATUS_LABELS[line.status_comissao]}
                        </span>
                      </td>
                      {canConfirm && (
                        <td className="px-4 py-3 text-center">
                          {line.status_comissao === 'aguardando_pgto' && (
                            <button onClick={() => { setConfirmingId(line.id); setConfirmForm({ data_pgto_real: '', valor_recebido: String(line.valor_base) }); }}
                              className="text-[10px] px-2 py-1 rounded font-medium bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25 whitespace-nowrap">
                              💰 Confirmar Pgto
                            </button>
                          )}
                          {line.status_comissao === 'liberada' && (
                            <button onClick={() => { setPayingId(line.id); setPayForm({ data_pgto_vendedor: '' }); }}
                              className="text-[10px] px-2 py-1 rounded font-medium bg-green-500/15 text-green-400 hover:bg-green-500/25 whitespace-nowrap">
                              ✅ Pagar Vendedor
                            </button>
                          )}
                          {line.status_comissao === 'paga' && line.data_pgto_vendedor && (
                            <span className="text-[10px] text-green-400/60">
                              Pago {new Date(line.data_pgto_vendedor + 'T12:00:00').toLocaleDateString('pt-BR')}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {filteredClient.length === 0 && (
                  <tr><td colSpan={12} className="px-4 py-12 text-center text-[var(--color-v4-text-muted)]">Nenhum registro encontrado</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ==================== MODAL: Confirmar Pagamento Cliente ==================== */}
      {confirmingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmingId(null)} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-1">💰 Confirmar Pagamento do Cliente</h3>
            {(() => {
              const reg = registros.find(r => r.id === confirmingId);
              if (!reg) return null;
              const linkedLines = reg.deal_id
                ? registros.filter(r => r.deal_id === reg.deal_id && r.tipo === reg.tipo && r.status_comissao === 'aguardando_pgto')
                : [reg];
              return (
                <>
                  <p className="text-xs text-[var(--color-v4-text-muted)] mb-2">
                    {reg.empresa} — {reg.tipo.toUpperCase()} — Valor contrato: {fmt(reg.valor_base)}
                  </p>
                  {linkedLines.length > 1 && (
                    <div className="text-[10px] text-blue-400 bg-blue-500/10 rounded-lg px-3 py-2 mb-3">
                      🔗 Vai liberar {linkedLines.length} comissões do mesmo contrato: {linkedLines.map(l => `${l.member_name} (${l.role_comissao})`).join(', ')}
                    </div>
                  )}
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Data real de pagamento</label>
                      <input type="date" value={confirmForm.data_pgto_real} onChange={e => setConfirmForm(p => ({ ...p, data_pgto_real: e.target.value }))}
                        className={inputClass + " w-full !py-2 !text-sm"} />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Valor recebido do cliente (R$)</label>
                      <input type="number" step="0.01" value={confirmForm.valor_recebido} onChange={e => setConfirmForm(p => ({ ...p, valor_recebido: e.target.value }))}
                        className={inputClass + " w-full !py-2 !text-sm"} />
                      {Number(confirmForm.valor_recebido) !== reg.valor_base && Number(confirmForm.valor_recebido) > 0 && (
                        <p className="text-[10px] text-orange-400 mt-1">
                          ⚠️ Valor diferente do contrato ({fmt(reg.valor_base)}). Comissão será recalculada: {fmt(Number(confirmForm.valor_recebido) * reg.percentual)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-3 mt-5">
                    <button onClick={() => setConfirmingId(null)}
                      className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
                    <button onClick={handleConfirmPgto}
                      className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-sm">Confirmar</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ==================== MODAL: Pagar Vendedor ==================== */}
      {payingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPayingId(null)} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-green-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-green-400 mb-1">✅ Registrar Pagamento ao Vendedor</h3>
            {(() => {
              const reg = registros.find(r => r.id === payingId);
              if (!reg) return null;
              return (
                <>
                  <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">
                    {reg.empresa} — {reg.member_name} ({reg.role_comissao}) — {reg.tipo.toUpperCase()} — {fmt(reg.valor_comissao)}
                  </p>
                  <div>
                    <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Data de pagamento ao vendedor</label>
                    <input type="date" value={payForm.data_pgto_vendedor} onChange={e => setPayForm({ data_pgto_vendedor: e.target.value })}
                      className={inputClass + " w-full !py-2 !text-sm"} />
                  </div>
                  <div className="flex gap-3 mt-5">
                    <button onClick={() => setPayingId(null)}
                      className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
                    <button onClick={handlePayVendor}
                      className="flex-1 py-2.5 rounded-xl bg-green-500 hover:bg-green-400 text-black font-bold text-sm">Confirmar Pagamento</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};
