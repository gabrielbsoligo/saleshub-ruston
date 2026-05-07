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

// Paleta determinística por nome do membro (estável entre renders)
function colorForMember(name: string): string {
  const palette = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#facc15', '#14b8a6'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
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
      <ComposedChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
        <XAxis dataKey="hora" stroke="#a0a0a0" fontSize={11} />
        <YAxis stroke="#a0a0a0" fontSize={11} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#fff' }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {activeMembers.map(m => {
          const k = m.name.split(' ')[0];
          const c = colorForMember(m.name);
          return (
            <Bar key={`bar-${m.id}`} dataKey={`bar_${k}`} stackId="a" fill={c} name={k} />
          );
        })}
        {activeMembers.map(m => {
          const k = m.name.split(' ')[0];
          const c = colorForMember(m.name);
          return (
            <Line
              key={`line-${m.id}`}
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
