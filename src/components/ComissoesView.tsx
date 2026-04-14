import React, { useState, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { ChevronDown, ChevronRight, Edit2, Save, X, Search, Users, Building2, UserCog } from "lucide-react";
import toast from "react-hot-toast";
import { addDays, currentYearMonth } from "../lib/datemath";
import { useComissoes, ViewMode } from "../hooks/comissoes/useComissoes";
import {
  COMISSAO_COLUMNS,
  STANDARD_COLUMN_KEYS,
  DATE_FIELD_LABELS,
  DateField,
  pctDisplay,
} from "../hooks/comissoes/columns";
import {
  ComissaoRegistro,
  StatusComissao,
  STATUS_LABELS,
  STATUS_COLORS,
} from "../hooks/comissoes/types";
import { MultiSelectFilter } from "./ui/MultiSelect";

function fmt(v: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 }).format(v);
}

function getCategoria(origem?: string): "inbound" | "outbound" {
  if (!origem) return "inbound";
  return ["blackbox", "leadbroker"].includes(origem) ? "inbound" : "outbound";
}

const VIEW_TABS: { id: ViewMode; label: string; icon: React.ReactNode }[] = [
  { id: "cliente", label: "Por Cliente", icon: <Building2 size={14} /> },
  { id: "time", label: "Por Time", icon: <Users size={14} /> },
  { id: "sdr", label: "Por SDR", icon: <UserCog size={14} /> },
];

const DATE_FIELDS: DateField[] = ["data_pgto", "data_liberacao", "data_pgto_real", "data_pgto_vendedor"];

const DEFAULT_DATE_FIELD_BY_VIEW: Record<ViewMode, DateField> = {
  cliente: "data_pgto",
  time: "data_liberacao",
  sdr: "data_liberacao",
};

export const ComissoesView: React.FC = () => {
  const { deals, members, comissoes: comissoesConfig, currentUser } = useAppStore();
  const isGestor = currentUser?.role === "gestor";
  const isFinanceiro = currentUser?.role === "financeiro";
  const canEdit = isGestor;
  const canConfirm = isGestor || isFinanceiro;

  const [view, setView] = useState<ViewMode>(isFinanceiro ? "cliente" : "time");
  const [dateField, setDateField] = useState<DateField>(DEFAULT_DATE_FIELD_BY_VIEW[isFinanceiro ? "cliente" : "time"]);
  const [yearMonth, setYearMonth] = useState(currentYearMonth);

  const [searchEmpresa, setSearchEmpresa] = useState("");
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [filterVendedor, setFilterVendedor] = useState<string[]>([]);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ComissaoRegistro>>({});
  const [isProcessing, setIsProcessing] = useState(false);

  // Modal state — snapshot the row to avoid race with refetch
  const [confirmingReg, setConfirmingReg] = useState<ComissaoRegistro | null>(null);
  const [confirmForm, setConfirmForm] = useState({ data_pgto_real: "", valor_recebido: "" });
  const [payingReg, setPayingReg] = useState<ComissaoRegistro | null>(null);
  const [payForm, setPayForm] = useState({ data_pgto_vendedor: "" });

  const filters = useMemo(() => ({
    status: filterStatus,
    empresa: searchEmpresa,
    vendedor: filterVendedor,
  }), [filterStatus, searchEmpresa, filterVendedor]);

  const { rows, groups, totals, vendedoresUnicos, isLoading, refetch } = useComissoes({
    view,
    dateField,
    yearMonth,
    filters,
  });

  const handleViewChange = (next: ViewMode) => {
    setView(next);
    setDateField(DEFAULT_DATE_FIELD_BY_VIEW[next]);
    setExpandedKey(null);
  };

  const inputClass =
    "px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  // Generate comissoes from deals — uses addDays to centralize +30d math
  const generateComissoes = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const dealsGanhos = deals.filter((d) => d.status === "contrato_assinado");
      const newRegistros: any[] = [];

      const buildRow = (
        deal: any,
        memberId: string,
        memberName: string,
        roleComissao: "closer" | "sdr",
        tipo: "mrr" | "ot",
        valorBase: number,
        categoria: "inbound" | "outbound",
        dataPgto: string | null,
      ) => {
        const rule = comissoesConfig.find(
          (c) => c.role === roleComissao && c.tipo_origem === categoria && c.tipo_valor === tipo,
        );
        const pct = rule?.percentual || 0;
        return {
          deal_id: deal.id,
          member_id: memberId,
          member_name: memberName,
          role_comissao: roleComissao,
          tipo,
          categoria,
          valor_base: valorBase,
          percentual: pct,
          valor_comissao: valorBase * pct,
          data_pgto: dataPgto,
          data_liberacao: addDays(dataPgto, 30),
          empresa: deal.empresa,
          origem: deal.origem,
          status_comissao: "aguardando_pgto" as StatusComissao,
        };
      };

      for (const deal of dealsGanhos) {
        const categoria = getCategoria(deal.origem);
        const mrrVal = deal.valor_recorrente || deal.valor_mrr || 0;
        const otVal = deal.valor_escopo || deal.valor_ot || 0;
        const dataMrr = deal.data_pgto_recorrente || deal.data_primeiro_pagamento || null;
        const dataOt = deal.data_pgto_escopo || deal.data_primeiro_pagamento || null;

        for (const role of ["closer", "sdr"] as const) {
          const memberId = role === "closer" ? deal.closer_id : deal.sdr_id;
          if (!memberId) continue;
          const member = members.find((m) => m.id === memberId);
          if (mrrVal > 0)
            newRegistros.push(buildRow(deal, memberId, member?.name || "?", role, "mrr", mrrVal, categoria, dataMrr));
          if (otVal > 0)
            newRegistros.push(buildRow(deal, memberId, member?.name || "?", role, "ot", otVal, categoria, dataOt));
        }
      }

      await supabase.from("comissoes_registros").delete().eq("editado_manualmente", false);
      if (newRegistros.length > 0) {
        await supabase.from("comissoes_registros").insert(newRegistros);
      }
      toast.success(`${newRegistros.length} registros de comissão gerados!`);
      refetch();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmPgto = async () => {
    if (!confirmingReg) return;
    const dataReal = confirmForm.data_pgto_real;
    const valorRecebido = Number(confirmForm.valor_recebido) || 0;
    if (!dataReal) return toast.error("Informe a data de pagamento real");
    if (valorRecebido <= 0) return toast.error("Informe o valor recebido");

    const dataLib = addDays(dataReal, 30);
    const reg = confirmingReg;
    const linkedLines = reg.deal_id
      ? rows.filter((r) => r.deal_id === reg.deal_id && r.tipo === reg.tipo && r.status_comissao === "aguardando_pgto")
      : [reg];

    let totalNova = 0;
    for (const line of linkedLines) {
      const novaComissao = valorRecebido * line.percentual;
      totalNova += novaComissao;
      await supabase.from("comissoes_registros").update({
        status_comissao: "liberada",
        data_pgto_real: dataReal,
        valor_recebido: valorRecebido,
        valor_base: valorRecebido,
        valor_comissao: novaComissao,
        data_liberacao: dataLib,
        confirmado_por: currentUser?.id,
      }).eq("id", line.id);
    }

    const linkedMsg = linkedLines.length > 1 ? ` (${linkedLines.length} comissões do mesmo contrato)` : "";
    toast.success(`${reg.tipo.toUpperCase()} de ${reg.empresa} confirmado!${linkedMsg} Total: ${fmt(totalNova)}`);
    setConfirmingReg(null);
    setConfirmForm({ data_pgto_real: "", valor_recebido: "" });
    refetch();
  };

  const handlePayVendor = async () => {
    if (!payingReg) return;
    if (!payForm.data_pgto_vendedor) return toast.error("Informe a data de pagamento");
    const { error } = await supabase.from("comissoes_registros").update({
      status_comissao: "paga",
      data_pgto_vendedor: payForm.data_pgto_vendedor,
      confirmado_por: currentUser?.id,
    }).eq("id", payingReg.id);
    if (error) return toast.error(error.message);
    toast.success("Pagamento ao vendedor registrado!");
    setPayingReg(null);
    setPayForm({ data_pgto_vendedor: "" });
    refetch();
  };

  const startEdit = (reg: ComissaoRegistro) => {
    setEditingId(reg.id);
    setEditForm({ ...reg });
  };

  const saveEdit = async () => {
    if (!editingId || !editForm) return;
    const { error } = await supabase.from("comissoes_registros").update({
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
    }).eq("id", editingId);
    if (error) return toast.error(error.message);
    toast.success("Registro atualizado!");
    setEditingId(null);
    refetch();
  };

  const deleteRegistro = async (id: string) => {
    if (!confirm("Excluir este registro de comissão?")) return;
    await supabase.from("comissoes_registros").delete().eq("id", id);
    refetch();
  };

  const addManual = async () => {
    const { error } = await supabase.from("comissoes_registros").insert({
      member_name: "(editar nome)",
      role_comissao: "sdr",
      tipo: "ot",
      categoria: "outbound",
      valor_base: 0,
      percentual: 0,
      valor_comissao: 0,
      empresa: "(editar)",
      editado_manualmente: true,
      data_liberacao: `${yearMonth}-15`,
      status_comissao: "aguardando_pgto",
    });
    if (error) return toast.error(error.message);
    refetch();
  };

  // Build the columns to actually render — uses STANDARD_COLUMN_KEYS, with the
  // "data_dyn" header label replaced by the active dateField label.
  const columnsToRender = useMemo(() => {
    return STANDARD_COLUMN_KEYS
      .map((k) => COMISSAO_COLUMNS.find((c) => c.key === k))
      .filter((c): c is (typeof COMISSAO_COLUMNS)[number] => !!c)
      .map((c) => (c.key === "data_dyn" ? { ...c, header: DATE_FIELD_LABELS[dateField] } : c));
  }, [dateField]);

  const renderRow = useCallback(
    (line: ComissaoRegistro) => {
      if (editingId === line.id) {
        return (
          <tr key={line.id} className="border-t border-[var(--color-v4-border)] bg-[var(--color-v4-surface)]">
            <td className="px-3 py-2">
              <input className={inputClass + " w-32 mb-1"} value={editForm.empresa || ""}
                onChange={(e) => setEditForm((p) => ({ ...p, empresa: e.target.value }))} />
            </td>
            <td className="px-3 py-2">
              <input className={inputClass + " w-28"} value={editForm.member_name || ""}
                onChange={(e) => setEditForm((p) => ({ ...p, member_name: e.target.value }))} />
            </td>
            <td className="px-3 py-2">
              <input className={inputClass + " w-16"} value={editForm.role_comissao || ""}
                onChange={(e) => setEditForm((p) => ({ ...p, role_comissao: e.target.value }))} />
            </td>
            <td className="px-3 py-2">
              <select className={inputClass} value={editForm.tipo}
                onChange={(e) => setEditForm((p) => ({ ...p, tipo: e.target.value as any }))}>
                <option value="mrr">MRR</option><option value="ot">OT</option><option value="variavel">Variável</option>
              </select>
            </td>
            <td className="px-3 py-2">
              <select className={inputClass} value={editForm.categoria}
                onChange={(e) => setEditForm((p) => ({ ...p, categoria: e.target.value }))}>
                <option value="inbound">Inbound</option><option value="outbound">Outbound</option>
                <option value="upsell_mrr">Upsell MRR</option><option value="upsell_ot">Upsell OT</option>
                <option value="ee_assessoria">EE Assessoria</option><option value="ee_ot">EE OT</option>
              </select>
            </td>
            <td className="px-3 py-2">
              <input type="number" className={inputClass + " w-20"} value={editForm.valor_base ?? 0}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setEditForm((p) => ({ ...p, valor_base: v, valor_comissao: v * (p.percentual || 0) }));
                }} />
            </td>
            <td className="px-3 py-2">
              <input type="number" step="0.01" className={inputClass + " w-14"} value={editForm.percentual ?? 0}
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  setEditForm((p) => ({ ...p, percentual: pct, valor_comissao: (p.valor_base || 0) * pct }));
                }} />
            </td>
            <td className="px-3 py-2">
              <input type="number" className={inputClass + " w-20"} value={editForm.valor_comissao ?? 0}
                onChange={(e) => setEditForm((p) => ({ ...p, valor_comissao: Number(e.target.value) }))} />
            </td>
            <td className="px-3 py-2"></td>
            <td className="px-3 py-2"></td>
            <td className="px-3 py-2 flex gap-1">
              <button onClick={saveEdit} className="text-green-400 hover:text-green-300"><Save size={12} /></button>
              <button onClick={() => setEditingId(null)} className="text-[var(--color-v4-text-muted)]"><X size={12} /></button>
            </td>
          </tr>
        );
      }

      return (
        <tr key={line.id}
          className={`border-t border-[var(--color-v4-border)] ${line.editado_manualmente ? "bg-yellow-500/5" : ""}`}>
          {columnsToRender.map((col) => (
            <td key={col.key} className={`px-3 py-2 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}>
              {col.render(line, { dateField })}
            </td>
          ))}
          {(canEdit || canConfirm) && (
            <td className="px-3 py-2">
              <div className="flex gap-1 flex-wrap">
                {canEdit && (
                  <button onClick={() => startEdit(line)} className="text-[var(--color-v4-text-muted)] hover:text-white">
                    <Edit2 size={12} />
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => deleteRegistro(line.id)} className="text-[var(--color-v4-text-muted)] hover:text-red-400">
                    <X size={12} />
                  </button>
                )}
                {canConfirm && line.status_comissao === "aguardando_pgto" && (
                  <button
                    onClick={() => {
                      setConfirmingReg(line);
                      setConfirmForm({ data_pgto_real: "", valor_recebido: String(line.valor_base) });
                    }}
                    className="text-yellow-400 hover:text-yellow-300 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 hover:bg-yellow-500/20"
                  >
                    Confirmar Pgto
                  </button>
                )}
                {canConfirm && line.status_comissao === "liberada" && (
                  <button
                    onClick={() => {
                      setPayingReg(line);
                      setPayForm({ data_pgto_vendedor: "" });
                    }}
                    className="text-green-400 hover:text-green-300 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 hover:bg-green-500/20"
                  >
                    Pagar Vendedor
                  </button>
                )}
                {line.status_comissao === "paga" && line.data_pgto_vendedor && (
                  <span className="text-[10px] text-green-400/60">Pago</span>
                )}
              </div>
            </td>
          )}
        </tr>
      );
    },
    [columnsToRender, dateField, editingId, editForm, canEdit, canConfirm],
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h2 className="text-2xl font-display font-bold text-white">Comissões</h2>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="month"
            value={yearMonth}
            onChange={(e) => setYearMonth(e.target.value)}
            className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm"
          />
          <select
            value={dateField}
            onChange={(e) => setDateField(e.target.value as DateField)}
            className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm"
            title="Campo de data usado no filtro do mês"
          >
            {DATE_FIELDS.map((f) => (
              <option key={f} value={f}>Filtrar por: {DATE_FIELD_LABELS[f]}</option>
            ))}
          </select>
          {canEdit && (
            <>
              <button
                onClick={generateComissoes}
                disabled={isProcessing}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] text-white text-xs disabled:opacity-50"
              >
                {isProcessing ? "Gerando..." : "Gerar do funil"}
              </button>
              <button onClick={addManual}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs">
                + Manual
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-[var(--color-v4-surface)] rounded-lg p-0.5 w-fit">
        {VIEW_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => handleViewChange(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              view === t.id ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)] hover:text-white"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input
            type="text"
            placeholder="Buscar empresa..."
            value={searchEmpresa}
            onChange={(e) => setSearchEmpresa(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]"
          />
        </div>
        <MultiSelectFilter
          options={[
            { value: "aguardando_pgto", label: "Aguardando Pgto" },
            { value: "liberada", label: "Liberada" },
            { value: "paga", label: "Paga" },
          ]}
          selected={filterStatus}
          onChange={setFilterStatus}
          placeholder="Status"
        />
        <MultiSelectFilter
          options={vendedoresUnicos.map((v) => ({ value: v, label: v }))}
          selected={filterVendedor}
          onChange={setFilterVendedor}
          placeholder="Vendedor"
        />
        {(searchEmpresa || filterStatus.length > 0 || filterVendedor.length > 0) && (
          <button
            onClick={() => { setSearchEmpresa(""); setFilterStatus([]); setFilterVendedor([]); }}
            className="px-2.5 py-2 rounded-lg text-xs text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]"
          >
            Limpar filtros
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Total Comissões" value={totals.total} count={totals.count} />
        <SummaryCard label="Aguardando Pgto" value={totals.aguardando}
          count={rows.filter((r) => r.status_comissao === "aguardando_pgto").length}
          tone="yellow" />
        <SummaryCard label="Liberada" value={totals.liberado}
          count={rows.filter((r) => r.status_comissao === "liberada").length} tone="blue" />
        <SummaryCard label="Paga" value={totals.pago}
          count={rows.filter((r) => r.status_comissao === "paga").length} tone="green" />
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="text-center py-12 text-sm text-[var(--color-v4-text-muted)]">Carregando…</div>
      ) : groups.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhum registro de comissão para este período</p>
          <p className="text-xs text-[var(--color-v4-text-muted)] mt-2">
            Filtro atual: <span className="text-white">{DATE_FIELD_LABELS[dateField]}</span> em{" "}
            <span className="text-white">{yearMonth}</span>
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(({ key, items, aggs }) => {
            const isExpanded = expandedKey === key;
            return (
              <div key={key} className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpandedKey(isExpanded ? null : key)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-[var(--color-v4-card-hover)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
                      {(key || "—").split(" ").map((n) => n[0] || "").join("").slice(0, 2).toUpperCase() || "—"}
                    </div>
                    <span className="text-sm font-medium text-white truncate">{key}</span>
                  </div>
                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="text-right">
                      <span className="text-sm font-bold text-white">{fmt(aggs.total)}</span>
                      <div className="flex gap-2 text-[10px] justify-end">
                        {aggs.pago > 0 && <span className="text-green-400">{fmt(aggs.pago)} paga</span>}
                        {aggs.liberado > 0 && <span className="text-blue-400">{fmt(aggs.liberado)} lib.</span>}
                        {aggs.aguardando > 0 && <span className="text-yellow-400">{fmt(aggs.aguardando)} pend.</span>}
                      </div>
                    </div>
                    <span className="text-xs text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)] px-2 py-0.5 rounded">
                      {items.length}
                    </span>
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                </button>
                {isExpanded && (
                  <div className="border-t border-[var(--color-v4-border)] overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)]">
                          {columnsToRender.map((col) => (
                            <th key={col.key}
                              className={`px-3 py-2 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}>
                              {col.header}
                            </th>
                          ))}
                          {(canEdit || canConfirm) && <th className="px-3 py-2">Ações</th>}
                        </tr>
                      </thead>
                      <tbody>{items.map(renderRow)}</tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL: Confirmar Pagamento Cliente */}
      {confirmingReg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmingReg(null)} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-1">💰 Confirmar Pagamento do Cliente</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-2">
              {confirmingReg.empresa} — {confirmingReg.tipo.toUpperCase()} — Valor contrato: {fmt(confirmingReg.valor_base)}
            </p>
            {(() => {
              const linkedLines = confirmingReg.deal_id
                ? rows.filter((r) => r.deal_id === confirmingReg.deal_id && r.tipo === confirmingReg.tipo && r.status_comissao === "aguardando_pgto")
                : [confirmingReg];
              return linkedLines.length > 1 ? (
                <div className="text-[10px] text-blue-400 bg-blue-500/10 rounded-lg px-3 py-2 mb-3">
                  🔗 Vai liberar {linkedLines.length} comissões do mesmo contrato:{" "}
                  {linkedLines.map((l) => `${l.member_name} (${l.role_comissao})`).join(", ")}
                </div>
              ) : null;
            })()}
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Data real de pagamento</label>
                <input type="date" value={confirmForm.data_pgto_real}
                  onChange={(e) => setConfirmForm((p) => ({ ...p, data_pgto_real: e.target.value }))}
                  className={inputClass + " w-full !py-2 !text-sm"} />
              </div>
              <div>
                <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Valor recebido do cliente (R$)</label>
                <input type="number" step="0.01" value={confirmForm.valor_recebido}
                  onChange={(e) => setConfirmForm((p) => ({ ...p, valor_recebido: e.target.value }))}
                  className={inputClass + " w-full !py-2 !text-sm"} />
                {Number(confirmForm.valor_recebido) !== confirmingReg.valor_base && Number(confirmForm.valor_recebido) > 0 && (
                  <p className="text-[10px] text-orange-400 mt-1">
                    ⚠️ Valor diferente do contrato ({fmt(confirmingReg.valor_base)}). Comissão será recalculada:{" "}
                    {fmt(Number(confirmForm.valor_recebido) * confirmingReg.percentual)} ({pctDisplay(confirmingReg.percentual)})
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setConfirmingReg(null)}
                className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">
                Cancelar
              </button>
              <button onClick={handleConfirmPgto}
                className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-sm">
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Pagar Vendedor */}
      {payingReg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPayingReg(null)} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-green-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-green-400 mb-1">✅ Registrar Pagamento ao Vendedor</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">
              {payingReg.empresa} — {payingReg.member_name} ({payingReg.role_comissao}) —{" "}
              {payingReg.tipo.toUpperCase()} — {fmt(payingReg.valor_comissao)}
            </p>
            <div>
              <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Data de pagamento ao vendedor</label>
              <input type="date" value={payForm.data_pgto_vendedor}
                onChange={(e) => setPayForm({ data_pgto_vendedor: e.target.value })}
                className={inputClass + " w-full !py-2 !text-sm"} />
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setPayingReg(null)}
                className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">
                Cancelar
              </button>
              <button onClick={handlePayVendor}
                className="flex-1 py-2.5 rounded-xl bg-green-500 hover:bg-green-400 text-black font-bold text-sm">
                Confirmar Pagamento
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const SummaryCard: React.FC<{ label: string; value: number; count: number; tone?: "yellow" | "blue" | "green" }> = ({ label, value, count, tone }) => {
  const toneClass =
    tone === "yellow" ? "border-yellow-500/30 text-yellow-400"
    : tone === "blue" ? "border-blue-500/30 text-blue-400"
    : tone === "green" ? "border-green-500/30 text-green-400"
    : "border-[var(--color-v4-border)] text-white";
  return (
    <div className={`bg-[var(--color-v4-card)] border ${toneClass} rounded-xl p-4`}>
      <span className={`text-xs ${tone ? "" : "text-[var(--color-v4-text-muted)]"}`}>{label}</span>
      <p className={`text-xl font-bold mt-1 ${tone ? "" : "text-white"}`}>{fmt(value)}</p>
      <p className={`text-[10px] ${tone ? "opacity-60" : "text-[var(--color-v4-text-muted)]"}`}>{count} registros</p>
    </div>
  );
};
