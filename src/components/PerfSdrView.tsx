import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { HourlyCallsChart, colorForMember } from "./HourlyCallsChart";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from "recharts";
import { Phone, PhoneCall, Link2, Users, ClipboardList, Trophy, Wallet, AlertTriangle, Target, CalendarDays, Flame } from "lucide-react";

// dias úteis (seg-sex) de um mês / decorridos até uma data
const bizDaysInMonth = (y: number, m: number) => {
  let n = 0; const days = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= days; d++) { const wd = new Date(y, m, d).getDay(); if (wd >= 1 && wd <= 5) n++; }
  return n;
};
const bizDaysElapsedMonth = (ref: Date) => {
  let n = 0; for (let d = 1; d <= ref.getDate(); d++) { const wd = new Date(ref.getFullYear(), ref.getMonth(), d).getDay(); if (wd >= 1 && wd <= 5) n++; }
  return n;
};
const bizDaysElapsedWeek = (ref: Date) => {
  const wd = ref.getDay();            // 0=dom..6=sab
  return wd === 0 ? 5 : Math.min(wd, 5);   // dom conta semana cheia (5); seg=1..sex=5
};

const CANAIS = ["leadbroker", "blackbox", "outbound", "recovery", "recomendacao", "indicacao", "sem origem"];
type Preset = "hoje" | "7d" | "30d" | "custom";

const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Dashboard de performance/esforço dos SDRs (gestor). Fontes: get_perf_* (read-only).
export const PerfSdrView: React.FC = () => {
  const { members, ligacoes, metas } = useAppStore();
  const sdrs = useMemo(() => members.filter(m => m.role === "sdr" && m.active), [members]);
  const sdrIds = useMemo(() => sdrs.map(s => s.id), [sdrs]);

  const [preset, setPreset] = useState<Preset>("30d");
  const [cFrom, setCFrom] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [cTo, setCTo] = useState(iso(new Date()));
  const [selSdrs, setSelSdrs] = useState<string[]>([]);   // [] = todos
  const [selCanais, setSelCanais] = useState<string[]>([]);

  const [from, to] = useMemo(() => {
    const today = new Date();
    if (preset === "hoje") return [iso(today), iso(today)];
    if (preset === "7d") return [iso(new Date(Date.now() - 6 * 864e5)), iso(today)];
    if (preset === "30d") return [iso(new Date(Date.now() - 29 * 864e5)), iso(today)];
    return [cFrom, cTo];
  }, [preset, cFrom, cTo]);

  const [lig, setLig] = useState<any[]>([]);
  const [tar, setTar] = useState<any[]>([]);
  const [con, setCon] = useState<any[]>([]);
  const [fun, setFun] = useState<any[]>([]);
  const [evo, setEvo] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const p_sdrs = selSdrs.length ? selSdrs : sdrIds;      // nunca null -> só SDRs
    const p_canais = selCanais.length ? selCanais : null;
    const [a, b, c, d, e] = await Promise.all([
      supabase.rpc("get_perf_ligacoes", { p_from: from, p_to: to, p_sdrs }),
      supabase.rpc("get_perf_tarefas", { p_from: from, p_to: to, p_sdrs }),
      supabase.rpc("get_perf_conexoes", { p_from: from, p_to: to, p_sdrs }),
      supabase.rpc("get_perf_funil", { p_from: from, p_to: to, p_sdrs, p_canais }),
      supabase.rpc("get_perf_evolucao", { p_from: from, p_to: to, p_sdrs }),
    ]);
    setLig(a.data || []); setTar(b.data || []); setCon(c.data || []); setFun(d.data || []); setEvo(e.data || []);
    setLoading(false);
  }, [from, to, selSdrs, selCanais, sdrIds]);

  useEffect(() => { if (sdrIds.length) load(); }, [load, sdrIds.length]);

  // ---- METAS: atingimento (janela Diária/Semanal/Mensal) ----
  type MetaWin = "dia" | "semana" | "mes";
  const [metaWin, setMetaWin] = useState<MetaWin>("dia");
  const [metaLig, setMetaLig] = useState<any[]>([]);   // get_perf_ligacoes na janela da meta
  const [metaFun, setMetaFun] = useState<any[]>([]);   // get_perf_funil na janela da meta

  const [mFrom, mMult] = useMemo(() => {
    const now = new Date();
    if (metaWin === "dia") return [iso(now), 1];
    if (metaWin === "semana") {
      const wd = now.getDay(); const back = wd === 0 ? 6 : wd - 1;   // volta até segunda
      return [iso(new Date(Date.now() - back * 864e5)), 5];
    }
    return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), bizDaysInMonth(now.getFullYear(), now.getMonth())];
  }, [metaWin]);

  const loadMeta = useCallback(async () => {
    const p_sdrs = selSdrs.length ? selSdrs : sdrIds;
    const today = iso(new Date());
    const [a, b] = await Promise.all([
      supabase.rpc("get_perf_ligacoes", { p_from: mFrom, p_to: today, p_sdrs }),
      supabase.rpc("get_perf_funil", { p_from: mFrom, p_to: today, p_sdrs, p_canais: null }),
    ]);
    setMetaLig(a.data || []); setMetaFun(b.data || []);
  }, [mFrom, selSdrs, sdrIds]);
  useEffect(() => { if (sdrIds.length) loadMeta(); }, [loadMeta, sdrIds.length]);

  // ---- PERFORMANCE DO DIA (seletor de data próprio) ----
  const [diaSel, setDiaSel] = useState(iso(new Date()));
  const [diaLig, setDiaLig] = useState<any[]>([]);
  const [diaFun, setDiaFun] = useState<any[]>([]);
  const loadDia = useCallback(async () => {
    const p_sdrs = selSdrs.length ? selSdrs : sdrIds;
    const [a, b] = await Promise.all([
      supabase.rpc("get_perf_ligacoes", { p_from: diaSel, p_to: diaSel, p_sdrs }),
      supabase.rpc("get_perf_funil", { p_from: diaSel, p_to: diaSel, p_sdrs, p_canais: null }),
    ]);
    setDiaLig(a.data || []); setDiaFun(b.data || []);
  }, [diaSel, selSdrs, sdrIds]);
  useEffect(() => { if (sdrIds.length) loadDia(); }, [loadDia, sdrIds.length]);

  // atingimento por indicador na janela da meta
  const metaRows = useMemo(() => {
    const now = new Date();
    const mesAtual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const selForMeta = selSdrs.length ? selSdrs : sdrIds;
    const metasMes = metas.filter(m => selForMeta.includes(m.member_id) && (m.mes || "").slice(0, 10) === mesAtual);
    const elapsed = metaWin === "dia" ? 1 : metaWin === "semana" ? bizDaysElapsedWeek(now) : bizDaysElapsedMonth(now);
    const sumF = (arr: any[], k: string) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const baseSum = (col: string) => metasMes.reduce((a, m: any) => a + (Number(m[col]) || 0), 0);
    const INDS = [
      { k: "ligacoes", label: "Ligações", col: "meta_ligacoes_dia", real: sumF(metaLig, "feitas"), color: "#3b82f6", disp: true },
      { k: "conexoes", label: "Conexões", col: "meta_conexoes_dia", real: sumF(metaLig, "atendidas"), color: "#06b6d4", disp: true },
      { k: "agendados", label: "Agendados", col: "meta_agendados_dia", real: sumF(metaFun, "agendadas"), color: "#8b5cf6", disp: true },
      { k: "realizados", label: "Realizados", col: "meta_realizados_dia", real: sumF(metaFun, "realizadas"), color: "#10b981", disp: true },
      { k: "fechados", label: "Fechados", col: "meta_fechados_dia", real: 0, color: "#f59e0b", disp: false },
    ];
    return INDS.map(ind => {
      const base = baseSum(ind.col);
      const meta = base * mMult;
      const expected = base * elapsed;
      const pct = meta > 0 ? Math.round(100 * ind.real / meta) : null;
      const pace = expected > 0 ? ind.real / expected : null;   // <1 abaixo do ritmo
      const falta = Math.max(0, meta - ind.real);
      return { ...ind, base, meta, pct, pace, falta };
    });
  }, [metas, selSdrs, sdrIds, metaWin, mMult, metaLig, metaFun]);

  const semColor = (pct: number | null) => pct == null ? "#64748b" : pct >= 100 ? "#10b981" : pct >= 70 ? "#f59e0b" : "#ef4444";

  // performance do dia por SDR
  const diaRows = useMemo(() => {
    const ids = selSdrs.length ? selSdrs : sdrIds;
    return ids.map(id => {
      const sdr = sdrs.find(s => s.id === id);
      const L = diaLig.find(x => x.member_id === id);
      const fs = diaFun.filter(x => x.member_id === id);
      return {
        id, name: sdr?.name || "—",
        ligacoes: Number(L?.feitas) || 0,
        conectados: Number(L?.atendidas) || 0,
        agendados: fs.reduce((a, f) => a + (Number(f.agendadas) || 0), 0),
        realizados: fs.reduce((a, f) => a + (Number(f.realizadas) || 0), 0),
        noshow: fs.reduce((a, f) => a + (Number(f.noshow) || 0), 0),
      };
    });
  }, [diaLig, diaFun, selSdrs, sdrIds, sdrs]);

  // agregados por SDR (do funil) p/ esforço + ranking
  const bySdr = useMemo(() => {
    const m: Record<string, { name: string; leads: number; realizadas: number; bant4: number }> = {};
    for (const f of fun) {
      const e = m[f.member_id] || { name: f.name, leads: 0, realizadas: 0, bant4: 0 };
      e.leads += f.leads_trabalhados; e.realizadas += f.realizadas; e.bant4 += f.bant4;
      m[f.member_id] = e;
    }
    return m;
  }, [fun]);

  const tot = (arr: any[], k: string) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const ligHoje = useMemo(() => {
    const start = new Date(from + "T00:00:00"), end = new Date(to + "T23:59:59");
    const ids = selSdrs.length ? selSdrs : sdrIds;
    return ligacoes.filter(l => { const t = new Date(l.started_at); return t >= start && t <= end && l.member_id && ids.includes(l.member_id); });
  }, [ligacoes, from, to, selSdrs, sdrIds]);

  const card = "rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-4";
  const sdrOpts = sdrs.map(s => ({ value: s.id, label: s.name }));
  const canalOpts = CANAIS.map(c => ({ value: c, label: c }));

  // ranking: medalha por dimensão
  const rankRows = Object.entries(bySdr).map(([id, v]) => {
    const t = tar.find(x => x.member_id === id);
    return { id, name: v.name, realizadas: v.realizadas, bant4: v.bant4, tarefas: t?.feitas_humano || 0, caixa: null as number | null };
  });
  const medal = (rows: any[], key: string, id: string) => {
    const sorted = [...rows].filter(r => r[key] > 0).sort((a, b) => b[key] - a[key]);
    const i = sorted.findIndex(r => r.id === id);
    return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "";
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-4">
        <Users size={20} className="text-[var(--color-v4-red)]" />
        <h2 className="text-2xl font-display font-bold text-white">Performance dos SDRs</h2>
        <span className="text-sm text-[var(--color-v4-text-muted)]">— esforço, funil e ranking</span>
      </div>

      {/* FILTROS */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
          {(["hoje", "7d", "30d", "custom"] as Preset[]).map(p => (
            <button key={p} onClick={() => setPreset(p)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium ${preset === p ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)]"}`}>
              {p === "hoje" ? "Hoje" : p === "7d" ? "7 dias" : p === "30d" ? "30 dias" : "Custom"}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <span className="flex items-center gap-1 text-xs text-[var(--color-v4-text-muted)]">
            <input type="date" value={cFrom} onChange={e => setCFrom(e.target.value)} className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-white" />
            até
            <input type="date" value={cTo} onChange={e => setCTo(e.target.value)} className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-white" />
          </span>
        )}
        <MultiSelectFilter options={sdrOpts} selected={selSdrs} onChange={setSelSdrs} placeholder="Todos os SDRs" />
        <MultiSelectFilter options={canalOpts} selected={selCanais} onChange={setSelCanais} placeholder="Todos os canais" />
        {loading && <span className="text-xs text-[var(--color-v4-text-muted)]">carregando…</span>}
      </div>

      {/* CARDS GRANDES + FUNIL TOFU + EVOLUÇÃO */}
      {(() => {
        const sf = (k: string) => fun.reduce((a, f) => a + (Number(f[k]) || 0), 0);
        const big = [
          { l: "Ligações", v: tot(lig, "feitas"), c: "#3b82f6" },
          { l: "Conectados", v: tot(lig, "atendidas"), c: "#06b6d4" },
          { l: "Agendados", v: sf("agendadas"), c: "#8b5cf6" },
          { l: "Realizados", v: sf("realizadas"), c: "#a855f7" },
          { l: "No-show", v: sf("noshow"), c: "#ef4444" },
          { l: "BANT 4", v: sf("bant4"), c: "#10b981" },
        ];
        const tofu = [big[0], big[1], big[2], big[3]];
        const maxT = Math.max(1, ...tofu.map(t => t.v));
        return (
          <>
            <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
              {big.map(b => (
                <div key={b.l} className={card}>
                  <div className="text-[11px] text-[var(--color-v4-text-muted)]">{b.l}</div>
                  <div className="text-3xl font-bold" style={{ color: b.c }}>{b.v}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className={card}>
                <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-2">Funil (topo → fundo)</div>
                <div className="space-y-1.5">
                  {tofu.map((t, i) => (
                    <div key={t.l} className="flex items-center gap-2">
                      <span className="w-20 text-[11px] text-[var(--color-v4-text-muted)] text-right">{t.l}</span>
                      <div className="flex-1 h-6 rounded bg-[var(--color-v4-surface)] overflow-hidden">
                        <div className="h-full rounded flex items-center px-2 text-[11px] text-white font-medium" style={{ width: `${Math.max(6, 100 * t.v / maxT)}%`, background: t.c }}>{t.v}</div>
                      </div>
                      <span className="w-12 text-[10px] text-[var(--color-v4-text-muted)]">{i > 0 && tofu[i - 1].v ? `${Math.round(100 * t.v / tofu[i - 1].v)}%` : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className={card}>
                <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-1">Evolução no período — agendados vs realizados</div>
                <ResponsiveContainer width="100%" height={170}>
                  <LineChart data={evo.map(e => ({ ...e, dia: e.dia?.slice(5) }))} margin={{ left: -20, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-v4-border)" />
                    <XAxis dataKey="dia" tick={{ fontSize: 10, fill: "var(--color-v4-text-muted)" }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "var(--color-v4-text-muted)" }} />
                    <Tooltip contentStyle={{ background: "var(--color-v4-card)", border: "1px solid var(--color-v4-border)", fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="agendados" name="Agendados" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="realizados" name="Realizados" stroke="#10b981" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        );
      })()}

      {/* § METAS — ATINGIMENTO */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5"><Target size={14} className="text-[var(--color-v4-red)]" /> Metas — atingimento</h3>
        <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
          {([["dia", "Diária"], ["semana", "Semanal"], ["mes", "Mensal"]] as [MetaWin, string][]).map(([w, l]) => (
            <button key={w} onClick={() => setMetaWin(w)}
              className={`px-3 py-1 rounded-md text-xs font-medium ${metaWin === w ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)]"}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className={`${card} mb-6`}>
        {metaRows.every(r => r.meta === 0) ? (
          <div className="text-[12px] text-[var(--color-v4-text-muted)] py-2">Sem meta definida para os SDRs selecionados neste mês. Cadastre em <span className="text-white">Metas &gt; Metas de Atividade</span>.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
            {metaRows.map(r => (
              <div key={r.k}>
                <div className="flex items-center justify-between text-[12px] mb-1">
                  <span className="text-white font-medium">{r.label}</span>
                  {!r.disp ? (
                    <span className="text-[10px] text-amber-400/80 flex items-center gap-1"><AlertTriangle size={11} /> realizado indisponível</span>
                  ) : r.meta === 0 ? (
                    <span className="text-[10px] text-[var(--color-v4-text-muted)]">sem meta</span>
                  ) : (
                    <span className="text-[var(--color-v4-text-muted)]">{r.real} de {r.meta} · faltam {r.falta}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-4 rounded bg-[var(--color-v4-surface)] overflow-hidden">
                    <div className="h-full rounded transition-all" style={{ width: `${Math.min(100, r.pct ?? 0)}%`, background: r.disp ? semColor(r.pct) : "#334155" }} />
                  </div>
                  <span className="w-12 text-right text-[11px] font-semibold" style={{ color: r.disp ? semColor(r.pct) : "#64748b" }}>
                    {r.disp && r.pct != null ? `${r.pct}%` : "—"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-3 opacity-70">Meta {metaWin === "dia" ? "diária" : metaWin === "semana" ? "semanal (base ×5)" : "mensal (base × dias úteis)"} · realizado acumulado na janela. Semáforo: <span className="text-emerald-400">≥100%</span> / <span className="text-amber-400">70–99%</span> / <span className="text-red-400">&lt;70%</span>.</div>
      </div>

      {/* § FAROL DE URGÊNCIA */}
      <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5"><Flame size={14} className="text-orange-400" /> Farol de urgência</h3>
      <div className={`${card} mb-6`}>
        {(() => {
          const riscos = metaRows.filter(r => r.disp && r.meta > 0 && r.pace != null && (r.pace as number) < 1)
            .sort((a, b) => (a.pace as number) - (b.pace as number));
          if (riscos.length === 0) {
            return <div className="text-[12px] text-emerald-400 flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Tudo no ritmo — nenhuma meta em risco na janela {metaWin === "dia" ? "diária" : metaWin === "semana" ? "semanal" : "mensal"}.</div>;
          }
          const msg: Record<string, string> = {
            ligacoes: "aumentar volume de discagem",
            conexoes: "melhorar taxa de conexão / horários de ligação",
            agendados: "priorizar prospecção e agendamento",
            realizados: "reforçar confirmação/anti-no-show das agendadas",
          };
          return (
            <div className="space-y-2">
              {riscos.map(r => {
                const pacePct = Math.round((r.pace as number) * 100);
                const crit = (r.pace as number) < 0.7;
                return (
                  <div key={r.k} className="flex items-center gap-3">
                    <span className={`w-2.5 h-2.5 rounded-full ${crit ? "bg-red-500" : "bg-amber-400"}`} />
                    <span className="text-[12px] text-white font-medium w-24">{r.label}</span>
                    <span className="text-[11px] text-[var(--color-v4-text-muted)]">{r.real} de {r.meta} · <span style={{ color: crit ? "#ef4444" : "#f59e0b" }}>{pacePct}% do ritmo</span></span>
                    <span className="text-[11px] text-[var(--color-v4-text-muted)] flex-1 text-right">→ {msg[r.k] || "priorizar"}</span>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      {/* § PERFORMANCE DO DIA */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5"><CalendarDays size={14} className="text-[var(--color-v4-red)]" /> Performance do dia</h3>
        <input type="date" value={diaSel} max={iso(new Date())} onChange={e => setDiaSel(e.target.value)}
          className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-xs text-white" />
      </div>
      <div className={`${card} mb-6`}>
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
            <th className="px-2 py-1">SDR</th>
            <th className="px-2 py-1 text-right">Ligações</th><th className="px-2 py-1 text-right">Conectados</th>
            <th className="px-2 py-1 text-right">Agendados</th><th className="px-2 py-1 text-right">Realizados</th>
            <th className="px-2 py-1 text-right">No-show</th><th className="px-2 py-1 text-right text-amber-400/80">Fechados</th>
          </tr></thead>
          <tbody>
            {diaRows.map(r => (
              <tr key={r.id} className="border-t border-[var(--color-v4-border)] text-white">
                <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: colorForMember({ name: r.name }) }} />{r.name.split(" ")[0]}</span></td>
                <td className="px-2 py-1.5 text-right">{r.ligacoes}</td>
                <td className="px-2 py-1.5 text-right">{r.conectados}</td>
                <td className="px-2 py-1.5 text-right">{r.agendados}</td>
                <td className="px-2 py-1.5 text-right">{r.realizados}</td>
                <td className="px-2 py-1.5 text-right">{r.noshow}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">—</td>
              </tr>
            ))}
            <tr className="border-t-2 border-[var(--color-v4-border)] text-white font-semibold bg-[var(--color-v4-surface)]/40">
              <td className="px-2 py-1.5">Total do dia</td>
              <td className="px-2 py-1.5 text-right">{diaRows.reduce((a, r) => a + r.ligacoes, 0)}</td>
              <td className="px-2 py-1.5 text-right">{diaRows.reduce((a, r) => a + r.conectados, 0)}</td>
              <td className="px-2 py-1.5 text-right">{diaRows.reduce((a, r) => a + r.agendados, 0)}</td>
              <td className="px-2 py-1.5 text-right">{diaRows.reduce((a, r) => a + r.realizados, 0)}</td>
              <td className="px-2 py-1.5 text-right">{diaRows.reduce((a, r) => a + r.noshow, 0)}</td>
              <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">—</td>
            </tr>
          </tbody>
        </table>
        </div>
        <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">Fechados por SDR sem fonte confiável (fonte externa/financeiro).</div>
      </div>

      {/* § ESFORÇO */}
      <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5"><PhoneCall size={14} className="text-[var(--color-v4-red)]" /> Esforço</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className={card}><div className="text-[11px] text-[var(--color-v4-text-muted)] flex items-center gap-1"><Phone size={12} /> Ligações feitas</div><div className="text-2xl font-bold text-white">{tot(lig, "feitas")}</div></div>
        <div className={card}><div className="text-[11px] text-[var(--color-v4-text-muted)]">Atendidas</div><div className="text-2xl font-bold text-white">{tot(lig, "atendidas")}<span className="text-xs text-[var(--color-v4-text-muted)] ml-1">{tot(lig, "feitas") ? Math.round(100 * tot(lig, "atendidas") / tot(lig, "feitas")) : 0}%</span></div></div>
        <div className={card}><div className="text-[11px] text-[var(--color-v4-text-muted)] flex items-center gap-1"><Link2 size={12} /> Conexões (snapshot)</div><div className="text-2xl font-bold text-white">{tot(con, "snapshot_atual")}</div><div className="text-[9px] text-amber-400/80">{con.some(c => c.tem_log_periodo) ? `real no período: ${tot(con, "periodo_real")}` : "por período liga quando o log encher"}</div></div>
        <div className={card}><div className="text-[11px] text-[var(--color-v4-text-muted)]">Leads trabalhados</div><div className="text-2xl font-bold text-white">{Object.values(bySdr).reduce((a, v) => a + v.leads, 0)}</div></div>
      </div>
      <div className={`${card} mb-6`}>
        <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-2">Ligações por hora (período selecionado)</div>
        <HourlyCallsChart ligacoes={ligHoje} members={sdrs} height={220} />
      </div>

      {/* § FUNIL por canal × SDR */}
      <h3 className="text-sm font-semibold text-white mb-2">Funil por canal × SDR</h3>
      <div className={`${card} mb-6`}>
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead><tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
            <th className="px-2 py-1">SDR</th><th className="px-2 py-1">Canal</th><th className="px-2 py-1 text-right">Leads trab.</th>
            <th className="px-2 py-1 text-right">Agendadas</th><th className="px-2 py-1 text-right">Realizadas</th>
            <th className="px-2 py-1 text-right">No-show %</th><th className="px-2 py-1 text-right">Conv. R/A</th><th className="px-2 py-1 text-right">BANT 4</th>
          </tr></thead>
          <tbody>
            {fun.map((f, i) => (
              <tr key={i} className="border-t border-[var(--color-v4-border)] text-white">
                <td className="px-2 py-1.5"><span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: colorForMember({ name: f.name }) }} />{f.name}</span></td>
                <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{f.canal}</td>
                <td className="px-2 py-1.5 text-right">{f.leads_trabalhados}</td>
                <td className="px-2 py-1.5 text-right">{f.agendadas}</td>
                <td className="px-2 py-1.5 text-right">{f.realizadas}</td>
                <td className="px-2 py-1.5 text-right">{f.agendadas ? Math.round(100 * f.noshow / f.agendadas) : 0}%</td>
                <td className="px-2 py-1.5 text-right">{f.agendadas ? Math.round(100 * f.realizadas / f.agendadas) : 0}%</td>
                <td className="px-2 py-1.5 text-right">{f.bant4}</td>
              </tr>
            ))}
            {fun.length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-[var(--color-v4-text-muted)]">Sem dados no período.</td></tr>}
          </tbody>
        </table>
        </div>
        <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">Conexão real por período liga quando o <code>lead_stage_log</code> encher (go-forward); hoje o funil usa reuniões realizadas como base.</div>
      </div>

      {/* § TAREFAS */}
      <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5"><ClipboardList size={14} className="text-[var(--color-v4-red)]" /> Tarefas</h3>
      <div className={`${card} mb-6`}>
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[620px]">
          <thead>
            <tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
              <th className="px-2 py-1" rowSpan={2}>SDR</th>
              <th className="px-2 py-1 text-center border-l border-[var(--color-v4-border)]" colSpan={3}>Feitas</th>
              <th className="px-2 py-1 text-center border-l border-[var(--color-v4-border)]" colSpan={3}>Atrasadas</th>
              <th className="px-2 py-1 text-right border-l border-[var(--color-v4-border)]" rowSpan={2}>% em dia</th>
            </tr>
            <tr className="text-[10px] text-[var(--color-v4-text-muted)] text-right">
              <th className="px-2 py-1 text-right border-l border-[var(--color-v4-border)] text-emerald-400">Humano</th><th className="px-2 py-1 text-right">Auto</th><th className="px-2 py-1 text-right">Total</th>
              <th className="px-2 py-1 text-right border-l border-[var(--color-v4-border)] text-emerald-400">Humano</th><th className="px-2 py-1 text-right">Auto</th><th className="px-2 py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {tar.map(t => (
              <tr key={t.member_id} className="border-t border-[var(--color-v4-border)] text-white">
                <td className="px-2 py-1.5">{t.name}</td>
                <td className="px-2 py-1.5 text-right font-semibold border-l border-[var(--color-v4-border)]">{t.feitas_humano}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{t.feitas_auto}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{t.feitas_humano + t.feitas_auto}</td>
                <td className="px-2 py-1.5 text-right font-semibold text-red-400 border-l border-[var(--color-v4-border)]">{t.atras_humano}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{t.atras_auto}</td>
                <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{t.atras_humano + t.atras_auto}</td>
                <td className="px-2 py-1.5 text-right border-l border-[var(--color-v4-border)]">{t.pct_em_dia ?? 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">Tarefas contadas <span className="text-white">a partir de 06/07</span> (base anterior descartada por limpeza da migração). <span className="text-emerald-400">Humano</span> = esforço real (rankeável); <span className="text-[var(--color-v4-text-muted)]">Auto</span> = tarefa de cadência/salesbot.</div>
      </div>

      {/* § RANKING DA CAMPANHA */}
      <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5"><Trophy size={14} className="text-yellow-400" /> Ranking da campanha</h3>
      <div className={`${card} mb-6`}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            { key: "realizadas", label: "Reuniões realizadas" },
            { key: "bant4", label: "BANT 4" },
            { key: "tarefas", label: "Tarefas (humano)" },
            { key: "caixa", label: "Caixa" },
          ].map(dim => (
            <div key={dim.key}>
              <div className="text-[11px] font-semibold text-white mb-1">{dim.label}
                {dim.key === "caixa" && <span className="text-amber-400/80 font-normal"> (placeholder)</span>}
              </div>
              {dim.key === "caixa" ? (
                <div className="text-[11px] text-[var(--color-v4-text-muted)] flex items-center gap-1"><Wallet size={12} /> fonte externa (financeiro), puxar depois</div>
              ) : (
                [...rankRows].sort((a, b) => (b as any)[dim.key] - (a as any)[dim.key]).map(r => {
                  const max = Math.max(1, ...rankRows.map(x => (x as any)[dim.key]));
                  return (
                    <div key={r.id} className="flex items-center gap-2 py-0.5">
                      <span className="w-5 text-xs">{medal(rankRows, dim.key, r.id)}</span>
                      <span className="text-[11px] text-white w-16 truncate">{r.name}</span>
                      <div className="flex-1 h-3 rounded bg-[var(--color-v4-surface)] overflow-hidden">
                        <div className="h-full rounded" style={{ width: `${100 * (r as any)[dim.key] / max}%`, background: colorForMember({ name: r.name }) }} />
                      </div>
                      <span className="text-[11px] text-[var(--color-v4-text-muted)] w-8 text-right">{(r as any)[dim.key]}</span>
                    </div>
                  );
                })
              )}
            </div>
          ))}
        </div>
      </div>

      {/* § CAIXA */}
      <div className={`${card} mb-4 border-dashed`}>
        <div className="flex items-center gap-2 text-sm text-white"><Wallet size={16} className="text-emerald-400" /> Caixa (placeholder)</div>
        <div className="text-[11px] text-[var(--color-v4-text-muted)] mt-1 flex items-center gap-1"><AlertTriangle size={12} className="text-amber-400" /> Fonte externa (financeiro), puxar depois. Ainda não integrado ao SalesHub.</div>
      </div>
    </div>
  );
};
