import React, { useEffect, useState, useCallback } from "react";
import { Repeat, ChevronLeft, ChevronRight, History } from "lucide-react";
import { supabase } from "../lib/supabase";
import type { RoletaSdrLead, RoletaSdrCiclo } from "../types";

// ABA — Histórico de ciclos da Roleta SDR (auditoria de meses passados).
// Navega por mês (get_roleta_sdr_ciclos), e por mês mostra balanço por SDR +
// lista nominal dos leads (get_roleta_sdr_leads na janela do mês). Escopo SDR/inbound.
// Read-only. Paginação = 1 mês por vez (o log pode crescer).
export const RoletaHistoricoView: React.FC = () => {
  const [ciclos, setCiclos] = useState<RoletaSdrCiclo[]>([]);
  const [idx, setIdx] = useState(0);
  const [leads, setLeads] = useState<RoletaSdrLead[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("get_roleta_sdr_ciclos", { p_escopo: "inbound" });
      setCiclos((data || []) as RoletaSdrCiclo[]);
    })();
  }, []);

  const loadMonth = useCallback(async (c: RoletaSdrCiclo) => {
    setLoading(true);
    const start = new Date(c.mes + "T00:00:00");
    const end = new Date(start); end.setMonth(end.getMonth() + 1);
    const { data } = await supabase.rpc("get_roleta_sdr_leads", {
      p_escopo: "inbound",
      p_desde: start.toISOString(),
      p_ate: end.toISOString(),
    });
    setLeads((data || []) as RoletaSdrLead[]);
    setLoading(false);
  }, []);

  useEffect(() => { if (ciclos[idx]) loadMonth(ciclos[idx]); }, [ciclos, idx, loadMonth]);

  const cur = ciclos[idx];
  const monthLabel = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const fmtTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  // balanço por SDR (só 'roleta' conta; 'manual' aparece separado)
  const byMember = new Map<string, { name: string; roleta: RoletaSdrLead[]; manual: RoletaSdrLead[] }>();
  for (const l of leads) {
    const e = byMember.get(l.member_id) || { name: l.member_name, roleta: [], manual: [] };
    (l.tipo_atribuicao === "manual" ? e.manual : e.roleta).push(l);
    byMember.set(l.member_id, e);
  }
  const members = [...byMember.entries()].sort((a, b) => b[1].roleta.length - a[1].roleta.length);

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-6">
      <div className="flex items-center gap-2 mb-4">
        <History size={20} className="text-[var(--color-v4-red)]" />
        <h2 className="text-2xl font-display font-bold text-white">Histórico da Roleta SDR</h2>
        <span className="text-[var(--color-v4-text-muted)] text-sm">— ciclos por mês (inbound)</span>
      </div>

      {ciclos.length === 0 ? (
        <div className="text-sm text-[var(--color-v4-text-muted)]">Nenhum ciclo registrado ainda.</div>
      ) : (
        <>
          {/* navegador de ciclos */}
          <div className="flex items-center gap-3 mb-4">
            <button disabled={idx >= ciclos.length - 1} onClick={() => setIdx(i => Math.min(i + 1, ciclos.length - 1))}
              className="p-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white disabled:opacity-30 hover:border-[var(--color-v4-red)]">
              <ChevronLeft size={16} />
            </button>
            <div className="flex items-center gap-2">
              <Repeat size={14} className="text-[var(--color-v4-red)]" />
              <span className="text-sm font-semibold text-white capitalize">{cur && monthLabel(cur.mes)}</span>
              {cur?.is_atual && <span className="text-[9px] font-bold uppercase text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded">ciclo atual</span>}
              <span className="text-[11px] text-[var(--color-v4-text-muted)]">
                · {cur?.total_roleta} roleta{cur && cur.total_manual > 0 ? ` · ${cur.total_manual} manual` : ""}
              </span>
            </div>
            <button disabled={idx <= 0} onClick={() => setIdx(i => Math.max(i - 1, 0))}
              className="p-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white disabled:opacity-30 hover:border-[var(--color-v4-red)]">
              <ChevronRight size={16} />
            </button>
            <span className="text-[11px] text-[var(--color-v4-text-muted)] ml-2">{idx + 1}/{ciclos.length}</span>
          </div>

          {/* balanço + leads nominais por SDR */}
          {loading ? (
            <div className="text-sm text-[var(--color-v4-text-muted)]">carregando…</div>
          ) : members.length === 0 ? (
            <div className="text-sm text-[var(--color-v4-text-muted)]">Nenhuma atribuição neste mês.</div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {members.map(([mid, e]) => (
                  <div key={mid} className="rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-white">{e.name}</span>
                      <span className="text-xs text-[var(--color-v4-text-muted)]">
                        <span className="text-emerald-400 font-semibold">{e.roleta.length}</span> roleta
                        {e.manual.length > 0 && <> · <span className="text-amber-400">{e.manual.length}</span> manual</>}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {[...e.roleta, ...e.manual].map(l => (
                        <div key={l.log_id} className="text-[12px] text-[var(--color-v4-text-muted)] truncate py-0.5 border-b border-[var(--color-v4-border)]/40 last:border-0">
                          <span className="text-white">{l.empresa || l.nome_contato || "(sem nome)"}</span>
                          {" "}
                          <span className={`text-[9px] uppercase ${l.tipo_atribuicao === "manual" ? "text-amber-400" : "text-emerald-400"}`}>{l.tipo_atribuicao}</span>
                          <span className="opacity-60"> · {fmtTime(l.created_at)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
