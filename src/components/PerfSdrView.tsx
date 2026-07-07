import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { HourlyCallsChart, colorForMember } from "./HourlyCallsChart";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Phone, PhoneCall, Link2, Users, ClipboardList, Trophy, Wallet, AlertTriangle } from "lucide-react";

const CANAIS = ["leadbroker", "blackbox", "outbound", "recovery", "recomendacao", "indicacao", "sem origem"];
type Preset = "hoje" | "7d" | "30d" | "custom";

const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Dashboard de performance/esforço dos SDRs (gestor). Fontes: get_perf_* (read-only).
export const PerfSdrView: React.FC = () => {
  const { members, ligacoes } = useAppStore();
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const p_sdrs = selSdrs.length ? selSdrs : sdrIds;      // nunca null -> só SDRs
    const p_canais = selCanais.length ? selCanais : null;
    const [a, b, c, d] = await Promise.all([
      supabase.rpc("get_perf_ligacoes", { p_from: from, p_to: to, p_sdrs }),
      supabase.rpc("get_perf_tarefas", { p_from: from, p_to: to, p_sdrs }),
      supabase.rpc("get_perf_conexoes", { p_from: from, p_to: to, p_sdrs }),
      supabase.rpc("get_perf_funil", { p_from: from, p_to: to, p_sdrs, p_canais }),
    ]);
    setLig(a.data || []); setTar(b.data || []); setCon(c.data || []); setFun(d.data || []);
    setLoading(false);
  }, [from, to, selSdrs, selCanais, sdrIds]);

  useEffect(() => { if (sdrIds.length) load(); }, [load, sdrIds.length]);

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
