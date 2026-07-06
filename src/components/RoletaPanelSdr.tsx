import React, { useEffect, useState, useCallback } from "react";
import { Repeat, ChevronDown, ChevronRight, PauseCircle } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { RoletaStatusRow, RoletaSdrLead } from "../types";

// Cabeçalho do rodízio de SDRs (inbound), espelho do "Rodízio de Closers"
// (RoletaPanel): próximo-a-receber em destaque + contadores. Expande p/ a lista
// nominal dos leads que cada SDR pegou no ciclo atual (desde reset_ts).
// 100% read-only: só chama get_roleta_status_sdr / get_roleta_sdr_leads.
export const RoletaPanelSdr: React.FC = () => {
  const [rows, setRows] = useState<RoletaStatusRow[]>([]);
  const [ativa, setAtiva] = useState<boolean>(true);
  const [expanded, setExpanded] = useState(false);
  const [leads, setLeads] = useState<RoletaSdrLead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);

  const load = useCallback(async () => {
    const [{ data: status }, { data: cfg }] = await Promise.all([
      supabase.rpc("get_roleta_status_sdr", { p_escopo: "inbound" }),
      supabase.from("integracao_config").select("value").eq("key", "roleta_inbound_ativa").maybeSingle(),
    ]);
    setRows((status || []) as RoletaStatusRow[]);
    setAtiva(cfg?.value === "true");
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && leads.length === 0) {
      setLoadingLeads(true);
      const { data } = await supabase.rpc("get_roleta_sdr_leads", { p_escopo: "inbound", p_desde: null, p_ate: null });
      setLeads((data || []) as RoletaSdrLead[]);
      setLoadingLeads(false);
    }
  };

  if (rows.length === 0) return null;

  const leadsByMember = (mid: string) => leads.filter(l => l.member_id === mid);
  const fmtTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="mb-4 rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Repeat size={14} className="text-[var(--color-v4-red)]" />
        <span className="text-xs font-semibold text-white">Rodízio de SDRs</span>
        <span className="text-[11px] text-[var(--color-v4-text-muted)]">— inbound · próximo a receber em destaque</span>
        {!ativa && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 ml-1">
            <PauseCircle size={11} /> rodízio pausado
          </span>
        )}
        <button onClick={toggleExpand}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-v4-text-muted)] hover:text-white">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? "ocultar leads do ciclo" : "ver leads do ciclo"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {rows.map((r, i) => (
          <span key={r.member_id}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
              i === 0 && ativa
                ? "bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-white"
                : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)]"
            }`}>
            {i === 0 && ativa && <span className="text-[9px] font-bold uppercase text-[var(--color-v4-red)]">próximo</span>}
            <span className={i === 0 && ativa ? "text-white font-medium" : ""}>{r.name}</span>
            <span className="text-[10px] opacity-70" title={`base ${r.base_count} + ciclo ${r.recebidas}`}>{r.total}</span>
          </span>
        ))}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-[var(--color-v4-border)] pt-3">
          {loadingLeads ? (
            <div className="text-[11px] text-[var(--color-v4-text-muted)]">carregando…</div>
          ) : leads.length === 0 ? (
            <div className="text-[11px] text-[var(--color-v4-text-muted)]">Nenhum lead atribuído neste ciclo.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {rows.map(r => {
                const ls = leadsByMember(r.member_id);
                return (
                  <div key={r.member_id} className="min-w-0">
                    <div className="text-[11px] font-semibold text-white mb-1">{r.name}
                      <span className="text-[var(--color-v4-text-muted)] font-normal"> · {ls.length} no ciclo</span>
                    </div>
                    {ls.length === 0 ? (
                      <div className="text-[10px] text-[var(--color-v4-text-muted)]">—</div>
                    ) : ls.map(l => (
                      <div key={l.log_id} className="text-[11px] text-[var(--color-v4-text-muted)] truncate py-0.5">
                        <span className="text-white">{l.empresa || l.nome_contato || "(sem nome)"}</span>
                        {" "}
                        <span className={`text-[9px] uppercase ${l.tipo_atribuicao === "manual" ? "text-amber-400" : "text-emerald-400"}`}>
                          {l.tipo_atribuicao}
                        </span>
                        <span className="opacity-60"> · {fmtTime(l.created_at)}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">
            Contador = base + atribuições do ciclo. Só <span className="text-emerald-400">roleta</span> conta no balanço; <span className="text-amber-400">manual</span> aparece mas não conta.
          </div>
        </div>
      )}
    </div>
  );
};
