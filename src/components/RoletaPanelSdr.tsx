import React, { useEffect, useState, useCallback } from "react";
import { Repeat, ChevronDown, ChevronRight, PauseCircle, Power } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAppStore } from "../store";
import type { RoletaStatusRow, RoletaSdrBalancoLead, RoletaOrigem, RoletaSinal } from "../types";

const KOMMO_BASE = "https://financeirorustonengenhariacombr.kommo.com";
const ORIGEM_LABEL: Record<RoletaOrigem, string> = { roleta: "roleta", manual: "manual", pre_roleta: "pré-roleta" };
const ORIGEM_COLOR: Record<RoletaOrigem, string> = {
  roleta: "text-emerald-400", manual: "text-amber-400", pre_roleta: "text-sky-400",
};
const SINAL_LABEL: Record<RoletaSinal, string> = { log: "log", reuniao: "reunião", kommo_atual: "dono atual", sem_sdr: "—" };

// Cabeçalho do rodízio de SDRs (inbound), espelho do "Rodízio de Closers".
// Contador AUDITÁVEL: total do pill = nº de leads REAIS do ciclo (mês) atribuídos ao SDR
// (get_roleta_sdr_balanco, lead-level), listáveis nominalmente. CONTA TUDO: roleta+manual+pré-roleta.
// Ordem / "próximo" / ativo continuam vindo de get_roleta_status_sdr (distribuição INTACTA).
export const RoletaPanelSdr: React.FC = () => {
  const { currentUser } = useAppStore();
  const isGestor = currentUser?.role === "gestor";
  const [roster, setRoster] = useState<RoletaStatusRow[]>([]);
  const [balanco, setBalanco] = useState<RoletaSdrBalancoLead[]>([]);
  const [ativa, setAtiva] = useState<boolean>(true);
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: status }, { data: bal }, { data: cfg }] = await Promise.all([
      supabase.rpc("get_roleta_status_sdr", { p_escopo: "inbound", p_incluir_inativos: true }),
      supabase.rpc("get_roleta_sdr_balanco", { p_escopo: "inbound", p_desde: null, p_ate: null }),
      supabase.from("integracao_config").select("value").eq("key", "roleta_inbound_ativa").maybeSingle(),
    ]);
    setRoster((status || []) as RoletaStatusRow[]);
    setBalanco((bal || []) as RoletaSdrBalancoLead[]);
    setAtiva(cfg?.value === "true");
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleAtivo = async (memberId: string, novoAtivo: boolean) => {
    setToggling(memberId);
    const { error } = await supabase.rpc("roleta_sdr_set_ativo", { p_member_id: memberId, p_escopo: "inbound", p_ativo: novoAtivo });
    if (error) console.error("roleta_sdr_set_ativo:", error.message);
    await load();
    setToggling(null);
  };

  if (roster.length === 0) return null;

  const leadsOf = (mid: string) => balanco.filter(l => l.member_id === mid);
  const semSdr = balanco.filter(l => !l.member_id);
  const proximoIdx = roster.findIndex(r => r.ativo !== false);
  const fmtTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="mb-4 rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Repeat size={14} className="text-[var(--color-v4-red)]" />
        <span className="text-xs font-semibold text-white">Rodízio de SDRs</span>
        <span className="text-[11px] text-[var(--color-v4-text-muted)]">— inbound · leads do mês por SDR</span>
        {!ativa && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-400 ml-1">
            <PauseCircle size={11} /> rodízio pausado
          </span>
        )}
        <button onClick={() => setExpanded(e => !e)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-v4-text-muted)] hover:text-white">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? "ocultar leads do ciclo" : "ver leads do ciclo"}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {roster.map((r, i) => {
          const off = r.ativo === false;
          const isProximo = i === proximoIdx && ativa && !off;
          const n = leadsOf(r.member_id).length;   // total AUDITÁVEL = nº de leads listados
          return (
            <span key={r.member_id}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
                off
                  ? "bg-transparent border-dashed border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] opacity-50"
                  : isProximo
                    ? "bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-white"
                    : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)]"
              }`}>
              {isProximo && <span className="text-[9px] font-bold uppercase text-[var(--color-v4-red)]">próximo</span>}
              <span className={isProximo ? "text-white font-medium" : ""}>{r.name}</span>
              <span className="text-[10px] opacity-70">{n}</span>
              {off && <span className="text-[9px] font-bold uppercase text-amber-400/80">off</span>}
              {isGestor && (
                <button
                  disabled={toggling === r.member_id}
                  onClick={() => toggleAtivo(r.member_id, off)}
                  title={off ? "Fora do rodízio (clique para incluir)" : "No rodízio (clique para tirar)"}
                  className={`ml-0.5 -mr-1 p-0.5 rounded-full hover:bg-white/10 disabled:opacity-40 ${off ? "text-amber-400" : "text-emerald-400"}`}>
                  <Power size={11} />
                </button>
              )}
            </span>
          );
        })}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-[var(--color-v4-border)] pt-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {roster.map(r => {
              const ls = leadsOf(r.member_id);
              return (
                <div key={r.member_id} className="min-w-0">
                  <div className="text-[11px] font-semibold text-white mb-1">{r.name}
                    <span className="text-[var(--color-v4-text-muted)] font-normal"> · {ls.length} no ciclo</span>
                    {r.ativo === false && <span className="text-amber-400/80 font-normal"> · off</span>}
                  </div>
                  {ls.length === 0 ? (
                    <div className="text-[10px] text-[var(--color-v4-text-muted)]">—</div>
                  ) : ls.map(l => {
                    const nome = l.empresa || l.nome_contato || "(sem nome)";
                    return (
                      <div key={l.lead_id} className="text-[11px] text-[var(--color-v4-text-muted)] truncate py-0.5">
                        {l.kommo_id
                          ? <a href={`${KOMMO_BASE}/leads/detail/${l.kommo_id}`} target="_blank" rel="noreferrer" className="text-white hover:text-[var(--color-v4-red)] no-underline">{nome}</a>
                          : <span className="text-white">{nome}</span>}
                        {" "}
                        <span className={`text-[9px] uppercase ${ORIGEM_COLOR[l.origem]}`}>{ORIGEM_LABEL[l.origem]}</span>
                        {l.no_closer && <span className="text-[9px] uppercase text-purple-400"> → closer</span>}
                        <span className="opacity-50" title={`resolvido por: ${SINAL_LABEL[l.sinal]}`}> · {SINAL_LABEL[l.sinal]}</span>
                        <span className="opacity-60"> · {fmtTime(l.created_at)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {semSdr.length > 0 && (
            <div className="mt-3 border-t border-dashed border-[var(--color-v4-border)] pt-2">
              <div className="text-[11px] font-semibold text-amber-400/90 mb-1">SEM SDR do roster · {semSdr.length}
                <span className="text-[var(--color-v4-text-muted)] font-normal"> (só passou por closer/não-SDR — revisar)</span>
              </div>
              {semSdr.map(l => {
                const nome = l.empresa || l.nome_contato || "(sem nome)";
                return (
                  <div key={l.lead_id} className="text-[11px] text-[var(--color-v4-text-muted)] truncate py-0.5">
                    {l.kommo_id
                      ? <a href={`${KOMMO_BASE}/leads/detail/${l.kommo_id}`} target="_blank" rel="noreferrer" className="text-white hover:text-[var(--color-v4-red)] no-underline">{nome}</a>
                      : <span className="text-white">{nome}</span>}
                    {" "}<span className={`text-[9px] uppercase ${ORIGEM_COLOR[l.origem]}`}>{ORIGEM_LABEL[l.origem]}</span>
                    <span className="opacity-60"> · {fmtTime(l.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">
            Conta todos os leads inbound do ciclo (<span className="text-emerald-400">roleta</span> / <span className="text-amber-400">manual</span> / <span className="text-sky-400">pré-roleta</span>), atribuídos ao <span className="text-white">SDR que passou</span> (log &gt; reunião &gt; dono atual). <span className="text-purple-400">→ closer</span> = já está no closer, conta pro SDR. Total do pill = nº de leads listados.
          </div>
        </div>
      )}
    </div>
  );
};
