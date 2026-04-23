// =============================================================
// ComissoesView v3 — tabela linear estilo Pipeline
// =============================================================
// - 1 linha = 1 comissao
// - Colunas configuraveis via modal (localStorage)
// - Sort clicando no header
// - Filtros numa linha so' (mes + campo data + status + vendedor + busca)
// - Barra compacta de totais reativa (4 chips)
// - Agrupar por: nenhum / cliente / colaborador (opcional)
// - Acoes inline: Confirmar Pgto, Pagar Vendedor, Editar (abre drawer), Apagar
// - Modal Nova Comissao (wizard) + Nova Parcela
// =============================================================
import React, { useState, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { ChevronUp, ChevronDown, Search, Edit2 } from "lucide-react";
import toast from "react-hot-toast";
import { useComissoes } from "../hooks/comissoes/useComissoes";
import { ComissaoRegistro, StatusComissao } from "../hooks/comissoes/types";
import { MultiSelectFilter } from "./ui/MultiSelect";
import {
  useComissoesColumns,
  ColumnsSettingsModal,
  ColumnsSettingsButton,
  sortByColumn,
  ALL_COMISSOES_COLUMNS,
} from "./ComissoesTableColumns";
import { NovaComissaoModal } from "./NovaComissaoModal";
import { NovaParcelaModal } from "./NovaParcelaModal";
import { ComissaoDrawer } from "./ComissaoDrawer";
import { cn } from "./Layout";

type DateField = "data_pgto" | "data_liberacao" | "data_pgto_real" | "data_pgto_vendedor";
type GroupBy = "none" | "cliente" | "colaborador";

const DATE_FIELD_LABELS: Record<DateField, string> = {
  data_pgto: "Pgto Contrato",
  data_liberacao: "Liberação",
  data_pgto_real: "Pgto Real",
  data_pgto_vendedor: "Pgto Vendedor",
};

function fmt(v: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2 }).format(v);
}

export const ComissoesView: React.FC = () => {
  const { currentUser } = useAppStore();
  const isGestor = currentUser?.role === "gestor";
  const isFinanceiro = currentUser?.role === "financeiro";
  const canEdit = isGestor || isFinanceiro;
  const canConfirm = isGestor || isFinanceiro;

  const [dateField, setDateField] = useState<DateField>("data_liberacao");
  // Default vazio = mostra TODAS as comissoes. Ao selecionar um mes, filtra.
  const [yearMonth, setYearMonth] = useState<string>("");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

  const [searchEmpresa, setSearchEmpresa] = useState("");
  const [filterStatus, setFilterStatus] = useState<string[]>([]);
  const [filterVendedor, setFilterVendedor] = useState<string[]>([]);

  const [sortField, setSortField] = useState<string>("comissao");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [confirmingReg, setConfirmingReg] = useState<ComissaoRegistro | null>(null);
  const [confirmForm, setConfirmForm] = useState({ data_pgto_real: "", valor_recebido: "" });
  const [payingReg, setPayingReg] = useState<ComissaoRegistro | null>(null);
  const [payForm, setPayForm] = useState({ data_pgto_vendedor: "" });
  const [drawerReg, setDrawerReg] = useState<ComissaoRegistro | null>(null);

  const [showNovaComissao, setShowNovaComissao] = useState(false);
  const [showNovaParcela, setShowNovaParcela] = useState(false);
  const [showColumnsModal, setShowColumnsModal] = useState(false);

  const { config: columnsConfig, visibleColumns, setConfig: setColumnsConfig, resetDefaults } = useComissoesColumns();

  // view='time' porque useComissoes precisa de algum view; filtro groupBy na UI
  const { rows: rowsRaw, totals, vendedoresUnicos, isLoading, refetch } = useComissoes({
    view: "time",
    dateField,
    yearMonth,
    filters: {
      status: filterStatus,
      empresa: searchEmpresa,
      vendedor: filterVendedor,
    },
  });

  const sortedRows = useMemo(() => {
    const col = ALL_COMISSOES_COLUMNS.find((c) => c.id === sortField);
    if (!col?.sortValue) return rowsRaw;
    return sortByColumn(rowsRaw, col.sortValue, sortDir);
  }, [rowsRaw, sortField, sortDir]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const SortIcon: React.FC<{ field: string }> = ({ field }) => {
    if (sortField !== field) return <ChevronDown size={11} className="text-[var(--color-v4-text-muted)]/30" />;
    return sortDir === "asc"
      ? <ChevronUp size={11} className="text-[var(--color-v4-red)]" />
      : <ChevronDown size={11} className="text-[var(--color-v4-red)]" />;
  };

  // Agrupamento opcional
  const groups = useMemo(() => {
    if (groupBy === "none") return null;
    const keyFn =
      groupBy === "cliente"
        ? (r: ComissaoRegistro) => r.empresa || "—"
        : (r: ComissaoRegistro) => r.member_name || "Sem nome";
    const map = new Map<string, ComissaoRegistro[]>();
    for (const r of sortedRows) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return Array.from(map.entries())
      .map(([key, items]) => ({
        key,
        items,
        total: items.reduce((s, r) => s + (r.valor_comissao || 0), 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [sortedRows, groupBy]);

  // Confirm pagamento (botao inline)
  const handleConfirmPgto = async () => {
    if (!confirmingReg) return;
    const dataReal = confirmForm.data_pgto_real;
    const valorRecebido = Number(confirmForm.valor_recebido) || 0;
    if (!dataReal) return toast.error("Informe a data de pagamento real");
    if (valorRecebido <= 0) return toast.error("Informe o valor recebido");
    const dataLib = (() => {
      const d = new Date(dataReal + "T00:00:00");
      d.setDate(d.getDate() + 30);
      return d.toISOString().slice(0, 10);
    })();
    const reg = confirmingReg;
    const linkedLines = reg.deal_id
      ? rowsRaw.filter((r) => r.deal_id === reg.deal_id && r.tipo === reg.tipo && r.status_comissao === "aguardando_pgto")
      : [reg];

    let totalNova = 0;
    for (const line of linkedLines) {
      const novaComissao = valorRecebido * line.percentual;
      totalNova += novaComissao;
      await supabase
        .from("comissoes_registros")
        .update({
          status_comissao: "liberada",
          data_pgto_real: dataReal,
          valor_recebido: valorRecebido,
          valor_base: valorRecebido,
          valor_comissao: novaComissao,
          data_liberacao: dataLib,
          confirmado_por: currentUser?.id,
          editado_manualmente: true,
        })
        .eq("id", line.id);
    }

    toast.success(`${reg.tipo.toUpperCase()} de ${reg.empresa} confirmado! ${linkedLines.length > 1 ? `(${linkedLines.length} linhas)` : ""} Total: ${fmt(totalNova)}`);
    setConfirmingReg(null);
    setConfirmForm({ data_pgto_real: "", valor_recebido: "" });
    refetch();
  };

  // Marca como pago ao vendedor
  const handlePayVendor = async () => {
    if (!payingReg) return;
    if (!payForm.data_pgto_vendedor) return toast.error("Informe a data de pagamento");
    const { error } = await supabase
      .from("comissoes_registros")
      .update({
        status_comissao: "paga",
        data_pgto_vendedor: payForm.data_pgto_vendedor,
        confirmado_por: currentUser?.id,
        editado_manualmente: true,
      })
      .eq("id", payingReg.id);
    if (error) return toast.error(error.message);
    toast.success("Pagamento ao vendedor registrado!");
    setPayingReg(null);
    setPayForm({ data_pgto_vendedor: "" });
    refetch();
  };

  const activeFilterCount = [
    filterStatus.length > 0,
    filterVendedor.length > 0,
    !!searchEmpresa,
    !!yearMonth,
  ].filter(Boolean).length;

  const renderRow = useCallback(
    (line: ComissaoRegistro) => (
      <tr key={line.id}
          onClick={() => setDrawerReg(line)}
          className="border-t border-[var(--color-v4-border)] hover:bg-[var(--color-v4-card-hover)] cursor-pointer transition-colors">
        {visibleColumns.map((col) => (
          <td key={col.id} className={cn("px-3 py-2.5 text-xs",
            col.align === "right" && "text-right",
            col.align === "center" && "text-center")}>
            {col.render(line)}
          </td>
        ))}
        {(canEdit || canConfirm) && (
          <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex gap-1 justify-end items-center">
              {canConfirm && line.status_comissao === "aguardando_pgto" && (
                <button
                  onClick={() => {
                    setConfirmingReg(line);
                    setConfirmForm({ data_pgto_real: "", valor_recebido: String(line.valor_base) });
                  }}
                  className="text-yellow-400 hover:text-yellow-300 text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 hover:bg-yellow-500/20 whitespace-nowrap">
                  Confirmar Pgto
                </button>
              )}
              {canConfirm && line.status_comissao === "liberada" && (
                <button
                  onClick={() => {
                    setPayingReg(line);
                    setPayForm({ data_pgto_vendedor: "" });
                  }}
                  className="text-green-400 hover:text-green-300 text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 hover:bg-green-500/20 whitespace-nowrap">
                  Pagar Vendedor
                </button>
              )}
              {canEdit && (
                <button onClick={() => setDrawerReg(line)}
                        className="text-[var(--color-v4-text-muted)] hover:text-white p-1">
                  <Edit2 size={11} />
                </button>
              )}
            </div>
          </td>
        )}
      </tr>
    ),
    [visibleColumns, canEdit, canConfirm],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h2 className="text-2xl font-display font-bold text-white">
          Comissões
          <span className="text-[var(--color-v4-text-muted)] text-lg font-normal ml-2">
            ({sortedRows.length})
          </span>
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {canEdit && (
            <>
              <button onClick={() => setShowNovaParcela(true)}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] text-white text-xs">
                + Parcela
              </button>
              <button onClick={() => setShowNovaComissao(true)}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs">
                + Nova Comissão
              </button>
            </>
          )}
        </div>
      </div>

      {/* Linha unica de filtros */}
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
          <input type="text" placeholder="Buscar empresa…" value={searchEmpresa}
                 onChange={(e) => setSearchEmpresa(e.target.value)}
                 className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]" />
        </div>

        <input type="month" value={yearMonth}
               onChange={(e) => setYearMonth(e.target.value)}
               placeholder="todos os meses"
               className={cn(
                 "px-3 py-1.5 rounded-lg border text-xs",
                 yearMonth
                   ? "bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-white"
                   : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)]"
               )} />

        {yearMonth && (
          <select value={dateField}
                  onChange={(e) => setDateField(e.target.value as DateField)}
                  className="px-3 py-1.5 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs"
                  title="Campo de data usado pelo filtro do mês">
            {(Object.keys(DATE_FIELD_LABELS) as DateField[]).map((f) => (
              <option key={f} value={f}>por {DATE_FIELD_LABELS[f]}</option>
            ))}
          </select>
        )}

        <MultiSelectFilter
          options={[
            { value: "aguardando_pgto", label: "Aguardando" },
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

        <select value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as GroupBy)}
                className="px-3 py-1.5 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs"
                title="Agrupar linhas">
          <option value="none">Sem agrupamento</option>
          <option value="cliente">Agrupar por cliente</option>
          <option value="colaborador">Agrupar por colaborador</option>
        </select>

        {activeFilterCount > 0 && (
          <button onClick={() => { setSearchEmpresa(""); setFilterStatus([]); setFilterVendedor([]); setYearMonth(""); }}
                  className="px-2.5 py-1.5 rounded-lg text-[10px] text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]">
            Limpar filtros ({activeFilterCount})
          </button>
        )}

        <div className="ml-auto">
          <ColumnsSettingsButton onClick={() => setShowColumnsModal(true)} />
        </div>
      </div>

      {/* Barra compacta de totais */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Chip label="Total" value={totals.total} count={totals.count} />
        <Chip label="Aguardando" value={totals.aguardando} count={rowsRaw.filter(r => r.status_comissao === "aguardando_pgto").length} tone="yellow" />
        <Chip label="Liberada" value={totals.liberado} count={rowsRaw.filter(r => r.status_comissao === "liberada").length} tone="blue" />
        <Chip label="Paga" value={totals.pago} count={rowsRaw.filter(r => r.status_comissao === "paga").length} tone="green" />
      </div>

      {/* Tabela */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto rounded-xl border border-[var(--color-v4-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--color-v4-card)] sticky top-0 z-10">
              <tr className="text-left text-[var(--color-v4-text-muted)]">
                {visibleColumns.map((col) => {
                  const isSortable = !!col.sortValue;
                  return (
                    <th key={col.id}
                        onClick={isSortable ? () => handleSort(col.id) : undefined}
                        className={cn("px-3 py-2.5 font-medium",
                          col.align === "right" && "text-right",
                          col.align === "center" && "text-center",
                          isSortable && "cursor-pointer hover:text-white select-none")}>
                      <span className={cn("flex items-center gap-1",
                        col.align === "right" && "justify-end",
                        col.align === "center" && "justify-center")}>
                        {col.label}
                        {isSortable && <SortIcon field={col.id} />}
                      </span>
                    </th>
                  );
                })}
                {(canEdit || canConfirm) && <th className="px-3 py-2.5 font-medium text-right">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={visibleColumns.length + 1} className="px-4 py-12 text-center text-[var(--color-v4-text-muted)]">
                  Carregando…
                </td></tr>
              ) : sortedRows.length === 0 ? (
                <tr><td colSpan={visibleColumns.length + 1} className="px-4 py-12 text-center text-[var(--color-v4-text-muted)]">
                  Nenhum registro encontrado
                  {yearMonth && <> para <strong className="text-white">{DATE_FIELD_LABELS[dateField]}</strong> em <strong className="text-white">{yearMonth}</strong></>}
                </td></tr>
              ) : groups ? (
                groups.map((g) => (
                  <React.Fragment key={g.key}>
                    <tr className="bg-[var(--color-v4-card)] border-t-2 border-[var(--color-v4-red)]/40">
                      <td colSpan={visibleColumns.length + (canEdit || canConfirm ? 1 : 0)} className="px-3 py-2">
                        <div className="flex items-center justify-between">
                          <span className="text-white font-semibold">{g.key}</span>
                          <span className="text-xs">
                            <span className="text-[var(--color-v4-text-muted)]">{g.items.length} comissão(ões) · </span>
                            <span className="text-white font-bold">{fmt(g.total)}</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {g.items.map(renderRow)}
                  </React.Fragment>
                ))
              ) : (
                sortedRows.slice(0, 300).map(renderRow)
              )}
            </tbody>
          </table>
        </div>
        {sortedRows.length > 300 && groupBy === "none" && (
          <p className="text-[10px] text-[var(--color-v4-text-muted)] text-center mt-2">
            Mostrando 300 de {sortedRows.length}. Use filtros/sort pra refinar.
          </p>
        )}
      </div>

      {/* MODAL: Confirmar Pgto */}
      {confirmingReg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setConfirmingReg(null)} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-1">💰 Confirmar Pagamento</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">
              {confirmingReg.empresa} — {confirmingReg.tipo.toUpperCase()} — Valor contrato: {fmt(confirmingReg.valor_base)}
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Data real de pagamento</label>
                <input type="date" value={confirmForm.data_pgto_real}
                       min="2020-01-01" max="2050-12-31"
                       onChange={(e) => {
                         const v = e.target.value;
                         if (v) { const y = parseInt(v.slice(0, 4), 10); if (!Number.isFinite(y) || y < 2020 || y > 2050) return; }
                         setConfirmForm((p) => ({ ...p, data_pgto_real: v }));
                       }}
                       className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Valor recebido do cliente (R$)</label>
                <input type="number" step="0.01" value={confirmForm.valor_recebido}
                       onChange={(e) => setConfirmForm((p) => ({ ...p, valor_recebido: e.target.value }))}
                       className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm" />
                {Number(confirmForm.valor_recebido) !== confirmingReg.valor_base && Number(confirmForm.valor_recebido) > 0 && (
                  <p className="text-[10px] text-orange-400 mt-1">
                    ⚠️ Valor diferente do contrato ({fmt(confirmingReg.valor_base)}). Comissão será recalculada:{" "}
                    {fmt(Number(confirmForm.valor_recebido) * confirmingReg.percentual)}
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
              {payingReg.empresa} — {payingReg.member_name} ({payingReg.role_comissao}) — {payingReg.tipo.toUpperCase()} — {fmt(payingReg.valor_comissao)}
            </p>
            <div>
              <label className="text-[10px] text-[var(--color-v4-text-muted)] uppercase mb-1 block">Data de pagamento ao vendedor</label>
              <input type="date" value={payForm.data_pgto_vendedor}
                     min="2020-01-01" max="2050-12-31"
                     onChange={(e) => {
                       const v = e.target.value;
                       if (v) { const y = parseInt(v.slice(0, 4), 10); if (!Number.isFinite(y) || y < 2020 || y > 2050) return; }
                       setPayForm({ data_pgto_vendedor: v });
                     }}
                     className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm" />
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

      {/* Columns settings modal */}
      <ColumnsSettingsModal
        open={showColumnsModal}
        onClose={() => setShowColumnsModal(false)}
        config={columnsConfig}
        onChange={setColumnsConfig}
        onReset={resetDefaults}
      />

      {/* Nova Comissao */}
      <NovaComissaoModal
        open={showNovaComissao}
        onClose={() => setShowNovaComissao(false)}
        onCreated={refetch}
      />

      {/* Nova Parcela */}
      <NovaParcelaModal
        open={showNovaParcela}
        onClose={() => setShowNovaParcela(false)}
        onCreated={refetch}
      />

      {/* Drawer edit */}
      <ComissaoDrawer
        comissao={drawerReg}
        onClose={() => setDrawerReg(null)}
        onSaved={refetch}
        onDeleted={refetch}
        canEdit={canEdit}
      />
    </div>
  );
};

// ---------- Chip compacto de totais ----------
const Chip: React.FC<{ label: string; value: number; count: number; tone?: "yellow" | "blue" | "green" }> = ({ label, value, count, tone }) => {
  const toneClass =
    tone === "yellow" ? "border-yellow-500/30 text-yellow-400" :
    tone === "blue" ? "border-blue-500/30 text-blue-400" :
    tone === "green" ? "border-green-500/30 text-green-400" :
    "border-[var(--color-v4-border)] text-white";
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--color-v4-card)] border ${toneClass}`}>
      <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">{label}</span>
      <span className={`text-sm font-bold ${tone ? "" : "text-white"}`}>{fmt(value)}</span>
      <span className="text-[10px] text-[var(--color-v4-text-muted)]">({count})</span>
    </div>
  );
};
