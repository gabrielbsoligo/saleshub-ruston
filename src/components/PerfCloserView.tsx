import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Trophy, Target, TrendingUp, Percent, Wallet, CalendarDays } from "lucide-react";
import { supabase } from "../lib/supabase";
import { useAppStore } from "../store";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { colorForMember } from "./HourlyCallsChart";
import { PaceLineChart, PaceBar, fmtFull } from "./pace/PaceCharts";
import { generateDailyPaceLine, getPacePercentage } from "../lib/paceUtils";

const CANAIS = ["leadbroker", "blackbox", "outbound", "recovery", "reativacao", "recomendacao", "indicacao", "sem origem"];
const card = "rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-4";
const iso = (d: Date) => d.toISOString().slice(0, 10);

interface CloserRow {
  member_id: string; name: string;
  vendido_mrr: number; vendido_ot: number; vendido_total: number;
  deals_ganhos: number; deals_mrr: number; deals_ot: number;
  shows: number; meta_mrr: number; meta_ot: number;
  recomendacoes: number;                       // do ai_result.indicacoes[] (nunca manual)
  deals_por_etapa: Record<string, number>;     // snapshot dos deals ativos
}
const ETAPA_ABREV: Record<string, string> = { negociacao: 'NEG', contrato_na_rua: 'CTR', dar_feedback: 'FB', follow_longo: 'FL' };
const fmtEtapas = (e: Record<string, number>) =>
  Object.entries(e || {}).map(([k, v]) => `${ETAPA_ABREV[k] || k} ${v}`).join(' · ') || '—';
interface PacePoint { dia: string; mrr: number; ot: number; }

// Filtro de intervalo de data (de/até) com botão limpar. Um por tipo de data.
const DateRange: React.FC<{ label: string; de: string; ate: string;
  onDe: (v: string) => void; onAte: (v: string) => void }> = ({ label, de, ate, onDe, onAte }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-[11px] text-[var(--color-v4-text-muted)] w-24">{label}</span>
    <input type="date" value={de} onChange={e => onDe(e.target.value)}
      className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-xs text-white" />
    <span className="text-[11px] text-[var(--color-v4-text-muted)]">até</span>
    <input type="date" value={ate} onChange={e => onAte(e.target.value)}
      className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-xs text-white" />
    {(de || ate) && (
      <button onClick={() => { onDe(""); onAte(""); }}
        className="text-[11px] text-[var(--color-v4-text-muted)] hover:text-white px-1">limpar</button>
    )}
  </div>
);

export const PerfCloserView: React.FC = () => {
  const { members } = useAppStore();
  const closers = useMemo(() => members.filter(m => m.role === "closer" && m.active), [members]);
  const closerOpts = useMemo(() => closers.map(c => ({ value: c.id, label: c.name })), [closers]);
  const canalOpts = useMemo(() => CANAIS.map(c => ({ value: c, label: c })), []);

  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const [selClosers, setSelClosers] = useState<string[]>([]);
  const [selCanais, setSelCanais] = useState<string[]>([]);
  const [fechDe, setFechDe] = useState(iso(monthStart));
  const [fechAte, setFechAte] = useState(iso(today));
  const [callDe, setCallDe] = useState("");
  const [callAte, setCallAte] = useState("");
  const [leadDe, setLeadDe] = useState("");
  const [leadAte, setLeadAte] = useState("");
  const [rows, setRows] = useState<CloserRow[]>([]);
  const [pace, setPace] = useState<PacePoint[]>([]);
  const [loading, setLoading] = useState(false);

  // mês de referência (meta + pace) = mês da data de fechamento (fim, senão início, senão hoje)
  const refDate = useMemo(() => new Date((fechAte || fechDe || iso(today)) + "T00:00:00"),
    [fechAte, fechDe]); // eslint-disable-line
  const refMes = iso(new Date(refDate.getFullYear(), refDate.getMonth(), 1));

  const load = useCallback(async () => {
    setLoading(true);
    const p_closers = selClosers.length ? selClosers : null;
    const p_canais = selCanais.length ? selCanais : null;
    const args = {
      p_closers, p_canais,
      p_fech_de: fechDe || null, p_fech_ate: fechAte || null,
      p_call_de: callDe || null, p_call_ate: callAte || null,
      p_lead_de: leadDe || null, p_lead_ate: leadAte || null,
    };
    const [{ data: r }, { data: pc }] = await Promise.all([
      supabase.rpc("get_perf_closer", { ...args, p_ref_mes: refMes }),
      supabase.rpc("get_perf_closer_pace", {
        p_closers, p_canais, p_ref_mes: refMes,
        p_call_de: callDe || null, p_call_ate: callAte || null,
        p_lead_de: leadDe || null, p_lead_ate: leadAte || null,
      }),
    ]);
    setRows((r || []).map((x: any) => ({
      ...x,
      vendido_mrr: +x.vendido_mrr, vendido_ot: +x.vendido_ot, vendido_total: +x.vendido_total,
      meta_mrr: +x.meta_mrr, meta_ot: +x.meta_ot,
    })) as CloserRow[]);
    setPace((pc || []).map((x: any) => ({ dia: x.dia, mrr: +x.mrr, ot: +x.ot })) as PacePoint[]);
    setLoading(false);
  }, [selClosers, selCanais, fechDe, fechAte, callDe, callAte, leadDe, leadAte, refMes]);

  useEffect(() => { load(); }, [load]);

  // Agregados do time (soma da seleção) + derivados (ticket / conversão)
  const T = useMemo(() => {
    const s = rows.reduce((a, r) => ({
      mrr: a.mrr + r.vendido_mrr, ot: a.ot + r.vendido_ot, total: a.total + r.vendido_total,
      ganhos: a.ganhos + r.deals_ganhos, dmrr: a.dmrr + r.deals_mrr, dot: a.dot + r.deals_ot,
      shows: a.shows + r.shows, metaMrr: a.metaMrr + r.meta_mrr, metaOt: a.metaOt + r.meta_ot,
      recs: a.recs + (r.recomendacoes || 0),
    }), { mrr: 0, ot: 0, total: 0, ganhos: 0, dmrr: 0, dot: 0, shows: 0, metaMrr: 0, metaOt: 0, recs: 0 });
    return {
      ...s, metaTotal: s.metaMrr + s.metaOt,
      ticketMrr: s.dmrr > 0 ? s.mrr / s.dmrr : 0,
      ticketOt: s.dot > 0 ? s.ot / s.dot : 0,
      conversao: s.shows > 0 ? (s.ganhos / s.shows) * 100 : 0,
    };
  }, [rows]);

  // Gráficos de pace (Total / MRR / OT) a partir da série diária por data de fechamento
  const year = refDate.getFullYear(), month = refDate.getMonth();
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
  const currentDay = isCurrentMonth ? today.getDate() : new Date(year, month + 1, 0).getDate();
  const pacePct = getPacePercentage(year, month, currentDay);

  const cumMap = useCallback((sel: (p: PacePoint) => number) => {
    const daily: Record<number, number> = {};
    for (const p of pace) {
      const d = new Date(p.dia + "T00:00:00");
      if (d.getFullYear() === year && d.getMonth() === month) {
        const day = d.getDate();
        daily[day] = (daily[day] || 0) + sel(p);
      }
    }
    let cum = 0; const out: Record<number, number> = {};
    for (let dd = 1; dd <= 31; dd++) { if (daily[dd]) cum += daily[dd]; out[dd] = cum; }
    return out;
  }, [pace, year, month]);

  const lineTotal = useMemo(() => generateDailyPaceLine(year, month, T.metaTotal, currentDay, cumMap(p => p.mrr + p.ot)), [year, month, T.metaTotal, currentDay, cumMap]);
  const lineMrr = useMemo(() => generateDailyPaceLine(year, month, T.metaMrr, currentDay, cumMap(p => p.mrr)), [year, month, T.metaMrr, currentDay, cumMap]);
  const lineOt = useMemo(() => generateDailyPaceLine(year, month, T.metaOt, currentDay, cumMap(p => p.ot)), [year, month, T.metaOt, currentDay, cumMap]);

  const paceBar = (meta: number, realizado: number) => {
    const expected = meta * pacePct;
    return { meta, realizado, expected, gap: expected - realizado, onTrack: realizado >= expected };
  };

  const kpi = (label: string, value: string, Icon: any, color: string, sub?: string) => (
    <div className={card}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} style={{ color }} />
        <span className="text-xs text-[var(--color-v4-text-muted)]">{label}</span>
      </div>
      <p className="text-xl font-bold text-white">{value}</p>
      {sub && <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-4">
        <Trophy size={20} className="text-[var(--color-v4-red)]" />
        <h1 className="text-lg font-semibold text-white">Performance dos Closers</h1>
        {loading && <span className="text-[11px] text-[var(--color-v4-text-muted)]">carregando…</span>}
      </div>

      {/* FILTROS */}
      <div className={`${card} mb-4 space-y-2`}>
        <div className="flex flex-wrap items-center gap-2">
          <MultiSelectFilter options={closerOpts} selected={selClosers} onChange={setSelClosers} placeholder="Todos os closers" />
          <MultiSelectFilter options={canalOpts} selected={selCanais} onChange={setSelCanais} placeholder="Todos os canais" />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
          <DateRange label="Fechamento" de={fechDe} ate={fechAte} onDe={setFechDe} onAte={setFechAte} />
          <DateRange label="Data da call" de={callDe} ate={callAte} onDe={setCallDe} onAte={setCallAte} />
          <DateRange label="Receb. lead" de={leadDe} ate={leadAte} onDe={setLeadDe} onAte={setLeadAte} />
        </div>
        {selCanais.length > 0 && (
          <p className="text-[10px] text-amber-400/80">
            Meta é mensal por closer (não por canal) — com filtro de canal, "vs meta" compara vendas do canal contra a meta cheia.
          </p>
        )}
      </div>

      {/* PACE — 3 gráficos acumulados vs meta */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <PaceLineChart title="Pace Total (MRR+OT)" data={lineTotal} color="#e63946" />
        <PaceLineChart title="Pace MRR" data={lineMrr} color="#22c55e" />
        <PaceLineChart title="Pace OT" data={lineOt} color="#3b82f6" />
      </div>

      {/* vs pace meta (barras) */}
      <div className={`${card} mb-4`}>
        <div className="flex items-center gap-2 mb-3">
          <Target size={14} className="text-[var(--color-v4-red)]" />
          <span className="text-xs font-semibold text-white">Vendido vs pace meta ({isCurrentMonth ? "mês atual" : refMes.slice(0, 7)})</span>
        </div>
        <PaceBar label="Total vendido" {...paceBar(T.metaTotal, T.total)} />
        <PaceBar label="MRR vendido" {...paceBar(T.metaMrr, T.mrr)} />
        <PaceBar label="OT vendido" {...paceBar(T.metaOt, T.ot)} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        {kpi("Total vendido", fmtFull(T.total), Wallet, "#e63946", `${T.ganhos} deals ganhos`)}
        {kpi("Ticket médio MRR", fmtFull(T.ticketMrr), TrendingUp, "#22c55e", `${T.dmrr} deals c/ MRR`)}
        {kpi("Ticket médio OT", fmtFull(T.ticketOt), TrendingUp, "#3b82f6", `${T.dot} deals c/ OT`)}
        {kpi("Taxa de conversão", `${T.conversao.toFixed(1)}%`, Percent, "#a855f7", `${T.ganhos}/${T.shows} reuniões`)}
        {kpi("Recomendações", String(T.recs), Trophy, "#f59e0b", "extraídas das calls (IA)")}
      </div>

      {/* TABELA por closer */}
      <div className={card}>
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays size={14} className="text-[var(--color-v4-red)]" />
          <span className="text-xs font-semibold text-white">Por closer</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
                <th className="px-2 py-1">Closer</th>
                <th className="px-2 py-1 text-right">Total</th>
                <th className="px-2 py-1 text-right">MRR</th>
                <th className="px-2 py-1 text-right">OT</th>
                <th className="px-2 py-1 text-right">Ticket MRR</th>
                <th className="px-2 py-1 text-right">Ticket OT</th>
                <th className="px-2 py-1 text-right">Ganhos</th>
                <th className="px-2 py-1 text-right">Conv.</th>
                <th className="px-2 py-1 text-right">Recom.</th>
                <th className="px-2 py-1">Pipe (etapas)</th>
                <th className="px-2 py-1 text-right" title="A atribuição de caixa está furada na origem (contrato caiu no gestor) — coluna presente, mas sem número inventado.">Caixa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const m = closers.find(c => c.id === r.member_id);
                const tMrr = r.deals_mrr > 0 ? r.vendido_mrr / r.deals_mrr : 0;
                const tOt = r.deals_ot > 0 ? r.vendido_ot / r.deals_ot : 0;
                const conv = r.shows > 0 ? (r.deals_ganhos / r.shows) * 100 : 0;
                return (
                  <tr key={r.member_id} className="border-t border-[var(--color-v4-border)] text-white">
                    <td className="px-2 py-1.5">
                      <span className="inline-flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ background: m ? colorForMember(m) : "#666" }} />
                        {r.name}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right font-medium">{fmtFull(r.vendido_total)}</td>
                    <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{fmtFull(r.vendido_mrr)}</td>
                    <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{fmtFull(r.vendido_ot)}</td>
                    <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{fmtFull(tMrr)}</td>
                    <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{fmtFull(tOt)}</td>
                    <td className="px-2 py-1.5 text-right">{r.deals_ganhos}</td>
                    <td className="px-2 py-1.5 text-right text-[var(--color-v4-text-muted)]">{conv.toFixed(1)}%</td>
                    <td className="px-2 py-1.5 text-right text-amber-400">{r.recomendacoes || 0}</td>
                    <td className="px-2 py-1.5 text-[11px] text-[var(--color-v4-text-muted)]">{fmtEtapas(r.deals_por_etapa)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <span className="text-[9px] uppercase tracking-wide text-[var(--color-v4-text-muted)] border border-dashed border-[var(--color-v4-border)] rounded px-1 py-px"
                        title="Atribuição de caixa sem fonte confiável (contrato de julho caiu no gestor). Melhor honesto que zero.">sem atribuição</span>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={11} className="px-2 py-4 text-center text-[var(--color-v4-text-muted)]">Nenhum closer / dado no período.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
