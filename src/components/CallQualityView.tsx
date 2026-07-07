import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { colorForMember } from "./HourlyCallsChart";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Headphones, ThumbsUp, AlertTriangle, X, Play, Star } from "lucide-react";

type Preset = "hoje" | "7d" | "30d" | "custom";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s || 0}s`;
const notaColor = (n: number | null) => n == null ? "text-[var(--color-v4-text-muted)]"
  : n >= 8 ? "text-emerald-400" : n >= 5 ? "text-amber-400" : "text-red-400";
const notaBg = (n: number | null) => n == null ? "bg-[var(--color-v4-surface)]"
  : n >= 8 ? "bg-emerald-500/15" : n >= 5 ? "bg-amber-500/15" : "bg-red-500/15";

interface Row {
  call_id: string; sdr_id: string | null; sdr_name: string | null; nota_final: number | null;
  pontos_positivos: string[]; pontos_negativos: string[]; transcricao: string | null;
  record_url: string | null; duration: number; direction: string; started_at: string;
  kommo_lead_id: number | null; analisado_em: string | null; tem_analise: boolean;
}

// Tela Qualidade de Ligação (gestor). Fonte: get_call_quality (read-only).
export const CallQualityView: React.FC = () => {
  const { members } = useAppStore();
  const sdrs = useMemo(() => members.filter(m => m.role === "sdr" && m.active), [members]);
  const sdrIds = useMemo(() => sdrs.map(s => s.id), [sdrs]);
  const [preset, setPreset] = useState<Preset>("30d");
  const [cFrom, setCFrom] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [cTo, setCTo] = useState(iso(new Date()));
  const [selSdrs, setSelSdrs] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState<Row | null>(null);

  const [from, to] = useMemo(() => {
    const t = new Date();
    if (preset === "hoje") return [iso(t), iso(t)];
    if (preset === "7d") return [iso(new Date(Date.now() - 6 * 864e5)), iso(t)];
    if (preset === "30d") return [iso(new Date(Date.now() - 29 * 864e5)), iso(t)];
    return [cFrom, cTo];
  }, [preset, cFrom, cTo]);

  const load = useCallback(async () => {
    setLoading(true);
    const p_sdrs = selSdrs.length ? selSdrs : sdrIds;
    const { data } = await supabase.rpc("get_call_quality", { p_from: from, p_to: to, p_sdrs });
    setRows((data || []) as Row[]);
    setLoading(false);
  }, [from, to, selSdrs, sdrIds]);
  useEffect(() => { if (sdrIds.length) load(); }, [load, sdrIds.length]);

  const analisadas = rows.filter(r => r.tem_analise);
  const semAnalise = rows.length - analisadas.length;

  // média por SDR + distribuição
  const avgBySdr = useMemo(() => {
    const m: Record<string, { name: string; soma: number; n: number }> = {};
    for (const r of analisadas) {
      if (r.nota_final == null || !r.sdr_id) continue;
      const e = m[r.sdr_id] || { name: r.sdr_name || "?", soma: 0, n: 0 };
      e.soma += r.nota_final; e.n++; m[r.sdr_id] = e;
    }
    return Object.values(m).map(e => ({ name: e.name, media: +(e.soma / e.n).toFixed(1), n: e.n })).sort((a, b) => b.media - a.media);
  }, [analisadas]);
  const dist = useMemo(() => {
    const buckets = [{ faixa: "0-4", n: 0 }, { faixa: "5-7", n: 0 }, { faixa: "8-10", n: 0 }];
    for (const r of analisadas) { if (r.nota_final == null) continue; buckets[r.nota_final >= 8 ? 2 : r.nota_final >= 5 ? 1 : 0].n++; }
    return buckets;
  }, [analisadas]);
  const mediaGeral = analisadas.length ? +(analisadas.reduce((a, r) => a + (r.nota_final || 0), 0) / analisadas.filter(r => r.nota_final != null).length).toFixed(1) : null;

  const card = "rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-4";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-4">
        <Headphones size={20} className="text-[var(--color-v4-red)]" />
        <h2 className="text-2xl font-display font-bold text-white">Qualidade de Ligação</h2>
        <span className="text-sm text-[var(--color-v4-text-muted)]">— análise da IA por ligação</span>
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
        <MultiSelectFilter options={sdrs.map(s => ({ value: s.id, label: s.name }))} selected={selSdrs} onChange={setSelSdrs} placeholder="Todos os SDRs" />
        {loading && <span className="text-xs text-[var(--color-v4-text-muted)]">carregando…</span>}
      </div>

      {/* CARDS + GRÁFICOS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className={card}>
          <div className="text-[11px] text-[var(--color-v4-text-muted)]">Nota média geral</div>
          <div className={`text-4xl font-bold ${notaColor(mediaGeral)}`}>{mediaGeral ?? "—"}</div>
          <div className="text-[11px] text-[var(--color-v4-text-muted)] mt-1">{analisadas.length} ligações analisadas · <span className="text-amber-400/80">{semAnalise} sem análise</span></div>
        </div>
        <div className={`${card} lg:col-span-1`}>
          <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-1">Nota média por SDR</div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={avgBySdr} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-v4-border)" />
              <XAxis type="number" domain={[0, 10]} tick={{ fontSize: 10, fill: "var(--color-v4-text-muted)" }} />
              <YAxis type="category" dataKey="name" width={60} tick={{ fontSize: 10, fill: "var(--color-v4-text-muted)" }} />
              <Tooltip contentStyle={{ background: "var(--color-v4-card)", border: "1px solid var(--color-v4-border)", fontSize: 12 }} />
              <Bar dataKey="media" radius={[0, 4, 4, 0]}>
                {avgBySdr.map((d, i) => <Cell key={i} fill={colorForMember({ name: d.name })} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className={card}>
          <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-1">Distribuição de notas</div>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={dist} margin={{ left: 0, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-v4-border)" />
              <XAxis dataKey="faixa" tick={{ fontSize: 10, fill: "var(--color-v4-text-muted)" }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "var(--color-v4-text-muted)" }} />
              <Tooltip contentStyle={{ background: "var(--color-v4-card)", border: "1px solid var(--color-v4-border)", fontSize: 12 }} />
              <Bar dataKey="n" radius={[4, 4, 0, 0]}>
                <Cell fill="#ef4444" /><Cell fill="#f59e0b" /><Cell fill="#10b981" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* TABELA */}
      <div className={`${card} overflow-x-auto`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[680px]">
            <thead><tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
              <th className="px-2 py-1">Nota</th><th className="px-2 py-1">SDR</th><th className="px-2 py-1">Lead</th>
              <th className="px-2 py-1">Data</th><th className="px-2 py-1 text-right">Duração</th><th className="px-2 py-1">Resumo</th><th className="px-2 py-1"></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.call_id} className="border-t border-[var(--color-v4-border)] text-white hover:bg-[var(--color-v4-surface)]/40">
                  <td className="px-2 py-1.5">
                    {r.tem_analise
                      ? <span className={`inline-flex items-center justify-center w-8 h-6 rounded font-bold text-xs ${notaBg(r.nota_final)} ${notaColor(r.nota_final)}`}>{r.nota_final ?? "?"}</span>
                      : <span className="text-[10px] text-amber-400/70 border border-dashed border-amber-400/40 rounded px-1.5 py-0.5">sem análise</span>}
                  </td>
                  <td className="px-2 py-1.5">{r.sdr_name || "—"}</td>
                  <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{r.kommo_lead_id ?? "—"}</td>
                  <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{new Date(r.started_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{fmtDur(r.duration)}</td>
                  <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)] truncate max-w-[220px]">{r.tem_analise ? (r.pontos_negativos?.[0] || r.pontos_positivos?.[0] || "") : ""}</td>
                  <td className="px-2 py-1.5">{r.tem_analise && <button onClick={() => setDrill(r)} className="text-[11px] text-[var(--color-v4-red)] hover:underline">ver</button>}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="px-2 py-4 text-center text-[var(--color-v4-text-muted)]">Nenhuma ligação no período.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* DRILL-DOWN */}
      {drill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrill(null)} />
          <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center justify-center w-12 h-12 rounded-xl text-2xl font-bold ${notaBg(drill.nota_final)} ${notaColor(drill.nota_final)}`}>{drill.nota_final ?? "?"}</span>
                <div>
                  <div className="text-white font-semibold">{drill.sdr_name || "—"}</div>
                  <div className="text-[11px] text-[var(--color-v4-text-muted)]">{new Date(drill.started_at).toLocaleString("pt-BR")} · {fmtDur(drill.duration)} · {drill.direction}</div>
                </div>
              </div>
              <button onClick={() => setDrill(null)} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
            </div>

            {drill.record_url && (
              <div className="mb-3">
                <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-1 flex items-center gap-1"><Play size={12} /> Áudio</div>
                <audio controls src={drill.record_url} className="w-full h-9" />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div className="text-[11px] font-semibold text-emerald-400 mb-1 flex items-center gap-1"><ThumbsUp size={12} /> Pontos positivos</div>
                <ul className="text-[12px] text-white space-y-1 list-disc pl-4">{(drill.pontos_positivos || []).map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="text-[11px] font-semibold text-amber-400 mb-1 flex items-center gap-1"><AlertTriangle size={12} /> Pontos negativos / oportunidades</div>
                <ul className="text-[12px] text-white space-y-1 list-disc pl-4">{(drill.pontos_negativos || []).map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            </div>

            <div className="text-[11px] font-semibold text-white mb-1">Transcrição</div>
            <div className="text-[12px] text-[var(--color-v4-text-muted)] whitespace-pre-wrap max-h-64 overflow-y-auto bg-[var(--color-v4-surface)] rounded-lg p-3">{drill.transcricao || "—"}</div>
          </div>
        </div>
      )}
    </div>
  );
};
