// =============================================================
// HourlyCallsChart — barras stacked + linha cumulativa
// =============================================================
// X = horas (8h-19h por padrao)
// Y barras = ligacoes naquela hora por user (cada cor)
// Y linha = acumulado de ligacoes do user no dia (linha por user)
// =============================================================
import React, { useMemo } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { Ligacao4com, TeamMember } from '../types';

interface Props {
  ligacoes: Ligacao4com[];
  members: TeamMember[];
  /** Range de horas exibido (default 8-19) */
  startHour?: number;
  endHour?: number;
  height?: number;
}

// Paleta determinística por nome do membro (estável entre renders).
// 16 cores bem distintas pra evitar duplicatas em times pequenos.
// Exportada pro MemberDrawer mostrar como sugestoes no color picker.
export const CHART_PALETTE = [
  '#ef4444', // red-500
  '#3b82f6', // blue-500
  '#facc15', // yellow-400
  '#10b981', // emerald-500
  '#a855f7', // purple-500
  '#f97316', // orange-500
  '#06b6d4', // cyan-500
  '#ec4899', // pink-500
  '#84cc16', // lime-500
  '#8b5cf6', // violet-500
  '#14b8a6', // teal-500
  '#f59e0b', // amber-500
  '#6366f1', // indigo-500
  '#22d3ee', // cyan-400
  '#f43f5e', // rose-500
  '#65a30d', // lime-600
];

// Hash deterministico por nome (fallback quando member.cor_grafico=null)
export function colorForMemberHash(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CHART_PALETTE[h % CHART_PALETTE.length];
}

// Resolve cor de um member: prioriza cor_grafico explicita, fallback no hash
export function colorForMember(member: { name: string; cor_grafico?: string | null }): string {
  if (member.cor_grafico && /^#[0-9a-f]{6}$/i.test(member.cor_grafico)) {
    return member.cor_grafico;
  }
  return colorForMemberHash(member.name);
}

export const HourlyCallsChart: React.FC<Props> = ({
  ligacoes, members, startHour = 8, endHour = 19, height = 320,
}) => {
  const { data, activeMembers } = useMemo(() => {
    // Agrupa por hora x member_id
    const byHourMember = new Map<number, Map<string, number>>();
    const memberSet = new Set<string>();

    for (const l of ligacoes) {
      if (!l.started_at || !l.member_id) continue;
      const d = new Date(l.started_at);
      const h = d.getHours();
      if (h < startHour || h > endHour) continue;
      memberSet.add(l.member_id);
      if (!byHourMember.has(h)) byHourMember.set(h, new Map());
      const inner = byHourMember.get(h)!;
      inner.set(l.member_id, (inner.get(l.member_id) || 0) + 1);
    }

    const memberIds = Array.from(memberSet);
    const memberById = new Map(members.map(m => [m.id, m]));

    // Constroi serie por hora com bar (count) + cum (acumulado por member)
    const cumByMember = new Map<string, number>();
    const data: any[] = [];
    for (let h = startHour; h <= endHour; h++) {
      const row: any = { hora: `${String(h).padStart(2, '0')}h` };
      const counts = byHourMember.get(h) || new Map();
      memberIds.forEach(mid => {
        const m = memberById.get(mid);
        if (!m) return;
        const k = m.name.split(' ')[0]; // primeiro nome como chave de display
        const v = counts.get(mid) || 0;
        row[`bar_${k}`] = v;
        const newCum = (cumByMember.get(mid) || 0) + v;
        cumByMember.set(mid, newCum);
        row[`cum_${k}`] = newCum;
      });
      data.push(row);
    }

    const activeMembers = memberIds
      .map(id => memberById.get(id))
      .filter((m): m is TeamMember => !!m);

    return { data, activeMembers };
  }, [ligacoes, members, startHour, endHour]);

  if (activeMembers.length === 0) {
    return (
      <div className="flex items-center justify-center text-[var(--color-v4-text-muted)] text-xs" style={{ height }}>
        Nenhuma ligação no período
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 10, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
        <XAxis dataKey="hora" stroke="#a0a0a0" fontSize={11} />
        {/* Eixo esquerdo: volume por hora (barras) */}
        <YAxis
          yAxisId="left"
          orientation="left"
          stroke="#a0a0a0"
          fontSize={11}
          allowDecimals={false}
          label={{ value: 'por hora', angle: -90, position: 'insideLeft', fill: '#666', fontSize: 10, dx: 12 }}
        />
        {/* Eixo direito: acumulado (linhas) */}
        <YAxis
          yAxisId="right"
          orientation="right"
          stroke="#666"
          fontSize={11}
          allowDecimals={false}
          label={{ value: 'acumulado', angle: 90, position: 'insideRight', fill: '#666', fontSize: 10, dx: -12 }}
        />
        <Tooltip
          contentStyle={{ background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#fff' }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {activeMembers.map(m => {
          const k = m.name.split(' ')[0];
          const c = colorForMember(m);
          // sem stackId = barras lado a lado (grouped bars). yAxisId=left.
          return (
            <Bar key={`bar-${m.id}`} yAxisId="left" dataKey={`bar_${k}`} fill={c} name={k} />
          );
        })}
        {activeMembers.map(m => {
          const k = m.name.split(' ')[0];
          const c = colorForMember(m);
          return (
            <Line
              key={`line-${m.id}`}
              yAxisId="right"
              type="monotone"
              dataKey={`cum_${k}`}
              stroke={c}
              strokeWidth={2}
              dot={false}
              name={`${k} (acum.)`}
              opacity={0.5}
            />
          );
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
};
