import React, { useEffect, useState, useCallback } from "react";
import { Repeat, ChevronDown, ChevronRight, PauseCircle, Power, CheckCircle2, XCircle, CircleDot } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAppStore } from "../store";
import { CANAL_LABELS, type RoletaStatusRow } from "../types";
import { RoletaPanelSdr } from "./RoletaPanelSdr";

const KOMMO_BASE = "https://financeirorustonengenhariacombr.kommo.com";

// Painel unificado do rodízio, parametrizado por tipo.
//  - tipo="sdr"    -> reusa o painel SDR existente (intacto, distribuição inalterada).
//  - tipo="closer" -> painel do rodízio de closers: balanço por REALIZADA (recebidas líquidas
//    de get_roleta_status já excluem no-show), próximo da fila, toggle ativo/OFF, e o LOG DO
//    CICLO expansível (roleta_closer_log: atribuida/no_show/compareceu). SÓ LEITURA + toggle
//    (roleta_set_ativo, que já existe). NÃO toca a lógica de balanço.
export const RoletaBoard: React.FC<{ tipo: "sdr" | "closer" }> = ({ tipo }) => {
  if (tipo === "sdr") return <RoletaPanelSdr />;
  return <RoletaBoardCloser />;
};

type CloserRow = { member_id: string; name: string; ativo: boolean; ordem: number;
                   recebidas: number; total: number; por_canal: Record<string, number>; canais: string[] | null };
type LogRow = { reuniao_id: string | null; closer_id: string | null;
                evento: string; ciclo_ts: string | null; created_at: string; canal?: string | null };
const rotuloCanal = (c: string | null | undefined) => (c && (CANAL_LABELS as Record<string, string>)[c]) || c || "—";

const RoletaBoardCloser: React.FC = () => {
  const { currentUser, roletaCapacidade } = useAppStore();
  const isGestor = currentUser?.role === "gestor";
  const comCanal = roletaCapacidade.modo !== "legado";
  const semPonto = roletaCapacidade.canaisSemPonto;
  const [rows, setRows] = useState<CloserRow[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [empresas, setEmpresas] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Schema novo (migration_156) ou legado: as colunas canais/canal só existem no novo. O store
    // já decidiu o modo em fetchRoleta (roletaCapacidade); aqui só segue a mesma decisão.
    let status: RoletaStatusRow[] | null = null;
    if (comCanal) {
      const r = await supabase.rpc("get_roleta_status_canal");
      if (r.error) { console.error("get_roleta_status_canal:", r.error.message); return; } // mantém a tela anterior
      status = r.data as RoletaStatusRow[];
    } else {
      const r = await supabase.rpc("get_roleta_status");
      status = (r.data || []) as RoletaStatusRow[];
    }
    const [{ data: closers }, { data: cfg }] = await Promise.all([
      supabase.from("roleta_closers").select(comCanal ? "member_id, ativo, ordem, canais, team_members(name)" : "member_id, ativo, ordem, team_members(name)"),
      supabase.from("roleta_config").select("reset_ts").eq("id", true).maybeSingle(),
    ]);
    const st = (status || []) as RoletaStatusRow[];
    const stById = new Map(st.map(s => [s.member_id, s]));
    // roster completo: ativos (com contagem) + OFF (do roleta_closers), ordenado como a fila
    const merged: CloserRow[] = (closers || []).map((c: any) => {
      const s = stById.get(c.member_id);
      return {
        member_id: c.member_id,
        name: s?.name || c.team_members?.name || "(sem nome)",
        ativo: c.ativo !== false,
        ordem: c.ordem ?? 999,
        recebidas: s?.recebidas ?? 0,
        total: s?.total ?? 0,
        por_canal: s?.por_canal ?? {},
        canais: s?.canais ?? c.canais ?? null,
      };
    });
    // ativos primeiro, na ordem da fila (menor total); OFF no fim
    merged.sort((a, b) =>
      (a.ativo === b.ativo ? 0 : a.ativo ? -1 : 1) || a.total - b.total || a.ordem - b.ordem || a.name.localeCompare(b.name));
    setRows(merged);

    const reset = cfg?.reset_ts;
    if (reset) {
      const { data: lg } = await supabase.from("roleta_closer_log")
        .select(comCanal ? "reuniao_id, closer_id, evento, ciclo_ts, created_at, canal" : "reuniao_id, closer_id, evento, ciclo_ts, created_at")
        .gte("ciclo_ts", reset).neq("evento", "reset")
        .order("created_at", { ascending: false });
      const rowsLg = (lg || []) as unknown as LogRow[];
      setLog(rowsLg);
      const rids = [...new Set(rowsLg.map(l => l.reuniao_id).filter(Boolean))] as string[];
      if (rids.length) {
        const { data: rs } = await supabase.from("reunioes").select("id, empresa").in("id", rids);
        const map: Record<string, string> = {};
        (rs || []).forEach((r: any) => { if (r.empresa) map[r.id] = r.empresa; });
        setEmpresas(map);
      } else setEmpresas({});
    }
  }, [comCanal]); // o modo (canal × legado) muda depois do mount: load precisa enxergar o atual

  useEffect(() => { load(); }, [load]);

  const toggleAtivo = async (memberId: string, novoAtivo: boolean) => {
    setToggling(memberId);
    const { error } = await supabase.rpc("roleta_set_ativo", { p_member_id: memberId, p_ativo: novoAtivo });
    if (error) console.error("roleta_set_ativo:", error.message);
    await load();
    setToggling(null);
  };

  if (rows.length === 0) return (
    <div className="rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-4 text-sm text-[var(--color-v4-text-muted)]">
      Nenhum closer no rodízio.
    </div>
  );

  const proximoIdx = rows.findIndex(r => r.ativo);
  const evStats = (mid: string) => ({
    atribuida: log.filter(l => l.closer_id === mid && l.evento === "atribuida").length,
    no_show:   log.filter(l => l.closer_id === mid && l.evento === "no_show").length,
    compareceu: log.filter(l => l.closer_id === mid && l.evento === "compareceu").length,
  });
  const nameOf = (mid: string | null) => rows.find(r => r.member_id === mid)?.name || "—";
  const fmt = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const EV: Record<string, { label: string; color: string; Icon: any }> = {
    atribuida:  { label: "atribuída",  color: "text-sky-400",     Icon: CircleDot },
    no_show:    { label: "no-show",    color: "text-red-400",     Icon: XCircle },
    compareceu: { label: "compareceu", color: "text-emerald-400", Icon: CheckCircle2 },
  };

  return (
    <div className="rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-3">
      <div className="flex items-center gap-2 mb-2">
        <Repeat size={14} className="text-[var(--color-v4-red)]" />
        <span className="text-xs font-semibold text-white">Rodízio de Closers</span>
        <span className="text-[11px] text-[var(--color-v4-text-muted)]">— balanço por reunião realizada (no-show sai da conta)</span>
        <button onClick={() => setExpanded(e => !e)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--color-v4-text-muted)] hover:text-white">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {expanded ? "ocultar log do ciclo" : "ver log do ciclo"}
        </button>
      </div>

      {/* PILLS: nome + realizadas líquidas (o que conta no balanço), próximo em destaque */}
      <div className="flex flex-wrap gap-2">
        {rows.map((r, i) => {
          const off = !r.ativo;
          const isProximo = i === proximoIdx && !off;
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
              <span className="text-[10px] opacity-70" title="realizadas líquidas no ciclo (conta no balanço)">{r.recebidas}</span>
              {off && <span className="text-[9px] font-bold uppercase text-amber-400/80">off</span>}
              {isGestor && (
                <button disabled={toggling === r.member_id} onClick={() => toggleAtivo(r.member_id, off)}
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
          {/* breakdown por closer: atribuídas / no-show / compareceu / líquido */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            {rows.map(r => {
              const s = evStats(r.member_id);
              return (
                <div key={r.member_id} className="min-w-0 rounded-lg bg-[var(--color-v4-surface)]/40 p-2">
                  <div className="text-[11px] font-semibold text-white mb-1">{r.name}
                    {!r.ativo && <span className="text-amber-400/80 font-normal"> · off</span>}
                  </div>
                  <div className="text-[10px] text-[var(--color-v4-text-muted)] flex flex-wrap gap-x-2">
                    <span><span className="text-sky-400">{s.atribuida}</span> atribuídas</span>
                    <span><span className="text-red-400">{s.no_show}</span> no-show</span>
                    <span><span className="text-emerald-400">{s.compareceu}</span> compareceu</span>
                  </div>
                  <div className="text-[11px] mt-1">líquido (conta): <span className="text-white font-semibold">{r.recebidas}</span></div>
                  {/* por canal no ciclo (∅ = canal que não pontua, ex.: recomendação) */}
                  <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-1 flex flex-wrap gap-x-2">
                    {Object.entries(r.por_canal as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([c, n]) => (
                      <span key={c} title={semPonto.includes(c) ? "não pontua" : "pontua"}>
                        <span className="text-white">{n}</span> {rotuloCanal(c)}{semPonto.includes(c) ? "∅" : ""}
                      </span>
                    ))}
                    {r.canais && r.canais.length > 0 && <span className="opacity-70">· atende: {r.canais.map(rotuloCanal).join(", ")}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* LOG DO CICLO: por que a fila está como está */}
          <div className="text-[11px] font-semibold text-white mb-1">Log do ciclo</div>
          {log.length === 0 ? (
            <div className="text-[10px] text-[var(--color-v4-text-muted)]">Nenhum evento neste ciclo ainda.</div>
          ) : (
            <div className="max-h-72 overflow-y-auto pr-1">
              {log.map((l, idx) => {
                const ev = EV[l.evento] || { label: l.evento, color: "text-[var(--color-v4-text-muted)]", Icon: CircleDot };
                const empresa = l.reuniao_id ? empresas[l.reuniao_id] : null;
                return (
                  <div key={idx} className="text-[11px] text-[var(--color-v4-text-muted)] flex items-center gap-1.5 py-0.5">
                    <ev.Icon size={12} className={ev.color} />
                    <span className={`${ev.color} uppercase text-[9px] font-bold w-16`}>{ev.label}</span>
                    <span className="text-white">{nameOf(l.closer_id)}</span>
                    {l.canal && <span className="px-1 rounded bg-[var(--color-v4-surface)] text-[9px] uppercase">{rotuloCanal(l.canal)}</span>}
                    {empresa && <span className="opacity-70 truncate">· {empresa}</span>}
                    <span className="opacity-50 ml-auto whitespace-nowrap">{fmt(l.created_at)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">
            O balanço conta as reuniões <span className="text-emerald-400">realizadas</span> (marcadas menos <span className="text-red-400">no-show</span>).
            Distribui na hora por marcada; quando dá no-show, sai da conta e o closer volta a receber até emparelhar. Total do pill = realizadas líquidas do ciclo.
            {comCanal && (semPonto.length
              ? <>Reuniões de <span className="text-white">{semPonto.map(rotuloCanal).join(", ")}</span> (∅) aparecem por canal, mas não pontuam e são distribuídas à parte; cada closer só é "próximo" nos canais que atende (configurar em Reuniões → Rodízio).</>
              : <>Todos os canais pontuam; cada closer só é "próximo" nos canais que atende (configurar em Reuniões → Rodízio).</>)}
          </div>
        </div>
      )}
    </div>
  );
};
