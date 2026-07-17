import React from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import type { DailyPacePoint } from "../../lib/paceUtils";

// Componentes de pace compartilhados (extraídos do DashboardView pra reuso em Perf. Closers).
// fmt = compacto (ex. "R$ 12.5k", usado nos ticks do eixo Y); fmtFull = moeda BRL completa.

export function fmt(value: number) {
  if (Math.abs(value) >= 1000) return `R$ ${(value / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}
export function fmtFull(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

export function PaceBar({ label, realizado, expected, meta, gap, onTrack, isCurrency = true }: {
  label: string; realizado: number; expected: number; meta: number; gap: number; onTrack: boolean; isCurrency?: boolean;
}) {
  const pct = meta > 0 ? (realizado / meta) * 100 : 0;
  const expectedPct = meta > 0 ? (expected / meta) * 100 : 0;
  const display = isCurrency ? fmtFull(realizado) : String(realizado);
  const metaDisplay = isCurrency ? fmtFull(meta) : String(meta);
  const expectedDisplay = isCurrency ? fmtFull(expected) : String(Math.round(expected));
  const gapDisplay = isCurrency ? fmtFull(Math.abs(gap)) : String(Math.abs(Math.round(gap)));

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-[var(--color-v4-text-muted)]">{label}</span>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold ${onTrack ? 'text-green-400' : 'text-red-400'}`}>{display}</span>
          <span className="text-[10px] text-[var(--color-v4-text-muted)]">/ {metaDisplay}</span>
          {onTrack ? <TrendingUp size={12} className="text-green-400" /> : <TrendingDown size={12} className="text-red-400" />}
        </div>
      </div>
      <div className="relative h-4 bg-[var(--color-v4-surface)] rounded-full overflow-hidden">
        <div className={`absolute h-full rounded-full transition-all ${onTrack ? 'bg-green-500' : 'bg-red-500'}`}
          style={{ width: `${Math.min(pct, 100)}%` }} />
        <div className="absolute top-0 h-full w-0.5 bg-white/60" style={{ left: `${Math.min(expectedPct, 100)}%` }} />
        <span className="absolute text-[8px] text-white font-bold" style={{
          left: `${Math.min(expectedPct, 96)}%`, top: '-14px',
        }}>{expectedDisplay}</span>
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-[var(--color-v4-text-muted)]">{pct.toFixed(0)}% da meta</span>
        {gap > 0 ? (
          <span className="text-[10px] text-red-400 font-medium">Gap: -{gapDisplay} pra chegar no ideal</span>
        ) : gap < 0 ? (
          <span className="text-[10px] text-green-400 font-medium">+{gapDisplay} acima do ideal</span>
        ) : (
          <span className="text-[10px] text-[var(--color-v4-text-muted)]">Exatamente no ideal</span>
        )}
      </div>
    </div>
  );
}

export function PaceLineChart({ title, data, isCurrency = true, color = '#22c55e' }: {
  title: string; data: DailyPacePoint[]; isCurrency?: boolean; color?: string;
}) {
  const formatter = (v: number) => isCurrency ? fmtFull(v) : String(Math.round(v));
  return (
    <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data}>
          <XAxis dataKey="label" tick={{ fill: '#a0a0a0', fontSize: 9 }} interval={2} />
          <YAxis tick={{ fill: '#a0a0a0', fontSize: 9 }} tickFormatter={v => isCurrency ? fmt(v) : String(v)} width={60} />
          <Tooltip contentStyle={{ background: '#1e1e1e', border: '1px solid #2e2e2e', borderRadius: 8, fontSize: 11 }}
            formatter={(v: any, name: string) => [formatter(v), name === 'expected' ? 'Esperado' : 'Realizado']}
            labelFormatter={l => `Dia ${l}`} />
          <Line type="monotone" dataKey="expected" stroke="#666" strokeDasharray="5 5" strokeWidth={1.5} dot={false} name="expected" />
          <Line type="monotone" dataKey="realizado" stroke={color} strokeWidth={2.5} dot={false} connectNulls={false} name="realizado" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
