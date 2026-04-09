import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useAppStore } from "../store";
import { DEAL_STATUS_LABELS, CANAL_LABELS, ROLE_LABELS } from "../types";
import { AlertCircle, TrendingUp, TrendingDown, ChevronDown, ChevronRight, Phone, PhoneOff, PhoneIncoming, RefreshCw } from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, ComposedChart } from 'recharts';
import { getPacePercentage, getBusinessDaysInMonth, getBusinessDaysSoFar, calculatePace, generateDailyPaceLine } from "../lib/paceUtils";

function fmt(value: number) {
  if (Math.abs(value) >= 1000) return `R$ ${(value / 1000).toFixed(1)}k`;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}
function fmtFull(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

function PaceBar({ label, realizado, expected, meta, gap, onTrack, isCurrency = true }: {
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
        {/* Expected value label on the white line */}
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

function PaceLineChart({ title, data, isCurrency = true, color = '#22c55e' }: {
  title: string; data: { day: number; label: string; expected: number; realizado: number | null }[]; isCurrency?: boolean; color?: string;
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

export const DashboardView: React.FC = () => {
  const { deals, leads, reunioes, members, metas, ligacoes, fetchLeads, fetchDeals, fetchReunioes, fetchMetas, fetchLigacoes } = useAppStore();
  const [viewMode, setViewMode] = useState<'geral' | 'individual'>('geral');
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [showPendentes, setShowPendentes] = useState(true);

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchLeads(); fetchDeals(); fetchReunioes(); fetchMetas(); fetchLigacoes();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchLeads, fetchDeals, fetchReunioes, fetchMetas, fetchLigacoes]);

  const [year, month] = selectedMonth.split('-').map(Number);
  const mesStart = new Date(year, month - 1, 1);
  const mesEnd = new Date(year, month, 0);
  const now = new Date();
  const currentDay = now.getFullYear() === year && now.getMonth() === month - 1 ? now.getDate() : mesEnd.getDate();
  const pacePercent = getPacePercentage(year, month - 1, currentDay);
  const totalBizDays = getBusinessDaysInMonth(year, month - 1);
  const bizDaysSoFar = getBusinessDaysSoFar(year, month - 1, currentDay);

  const dealsDoMes = useMemo(() => deals.filter(d => {
    const dc = d.data_fechamento ? new Date(d.data_fechamento) : d.data_call ? new Date(d.data_call) : null;
    return dc && dc >= mesStart && dc <= mesEnd;
  }), [deals, mesStart, mesEnd]);

  const dealsGanhosMes = dealsDoMes.filter(d => d.status === 'contrato_assinado');
  const mrrMes = dealsGanhosMes.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
  const otMes = dealsGanhosMes.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);

  const reunioesDoMes = reunioes.filter(r => {
    const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
    return dr && dr >= mesStart && dr <= mesEnd && r.realizada && r.show;
  });

  const pipelineAtivo = deals.filter(d => ['negociacao', 'contrato_na_rua', 'dar_feedback'].includes(d.status));
  const pipelineMrr = pipelineAtivo.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
  const pipelineOt = pipelineAtivo.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);

  const mesDate = `${selectedMonth}-01`;
  const metasDoMes = metas.filter(m => m.mes === mesDate);
  const totalMetaMrr = metasDoMes.reduce((a, m) => a + (m.meta_mrr || 0), 0);
  const totalMetaOt = metasDoMes.reduce((a, m) => a + (m.meta_ot || 0), 0);
  const totalMetaReunioes = metasDoMes.reduce((a, m) => a + (m.meta_reunioes || 0), 0);

  const generalPace = calculatePace(totalMetaMrr, totalMetaOt, totalMetaReunioes, mrrMes, otMes, reunioesDoMes.length, pacePercent);

  // Daily cumulative data for line charts
  const dailyMrr = useMemo(() => {
    const cum: Record<number, number> = {};
    let total = 0;
    for (let d = 1; d <= mesEnd.getDate(); d++) {
      const dayDeals = dealsGanhosMes.filter(deal => {
        const dc = deal.data_fechamento ? new Date(deal.data_fechamento) : null;
        return dc && dc.getDate() === d;
      });
      total += dayDeals.reduce((a, deal) => a + (deal.valor_recorrente || deal.valor_mrr || 0), 0);
      cum[d] = total;
    }
    return generateDailyPaceLine(year, month - 1, totalMetaMrr, currentDay, cum);
  }, [dealsGanhosMes, year, month, totalMetaMrr, currentDay]);

  const dailyOt = useMemo(() => {
    const cum: Record<number, number> = {};
    let total = 0;
    for (let d = 1; d <= mesEnd.getDate(); d++) {
      const dayDeals = dealsGanhosMes.filter(deal => {
        const dc = deal.data_fechamento ? new Date(deal.data_fechamento) : null;
        return dc && dc.getDate() === d;
      });
      total += dayDeals.reduce((a, deal) => a + (deal.valor_escopo || deal.valor_ot || 0), 0);
      cum[d] = total;
    }
    return generateDailyPaceLine(year, month - 1, totalMetaOt, currentDay, cum);
  }, [dealsGanhosMes, year, month, totalMetaOt, currentDay]);

  const dailyReunioes = useMemo(() => {
    const cum: Record<number, number> = {};
    let total = 0;
    for (let d = 1; d <= mesEnd.getDate(); d++) {
      const dayReunioes = reunioesDoMes.filter(r => {
        const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
        return dr && dr.getDate() === d;
      });
      total += dayReunioes.length;
      cum[d] = total;
    }
    return generateDailyPaceLine(year, month - 1, totalMetaReunioes, currentDay, cum);
  }, [reunioesDoMes, year, month, totalMetaReunioes, currentDay]);

  const pendentes = deals.filter(d => d.status === 'dar_feedback');
  const activeMembers = members.filter(m => m.active);

  // Daily calls by SDR (today)
  const todayStr = new Date().toISOString().slice(0, 10);
  const ligacoesHoje = useMemo(() => ligacoes.filter(l => l.started_at && l.started_at.slice(0, 10) === todayStr), [ligacoes, todayStr]);
  const callsBySdr = useMemo(() => {
    const sdrs = activeMembers.filter(m => m.role === 'sdr' || m.role === 'gestor');
    return sdrs.map(sdr => {
      const sdrCalls = ligacoesHoje.filter(l => l.member_id === sdr.id);
      const total = sdrCalls.length;
      const atendidas = sdrCalls.filter(l => l.atendida).length;
      const durTotal = sdrCalls.filter(l => l.atendida).reduce((a, l) => a + (l.duration || 0), 0);
      return { sdr, total, atendidas, naoAtendidas: total - atendidas, durMedia: atendidas > 0 ? Math.round(durTotal / atendidas) : 0 };
    }).sort((a, b) => b.total - a.total);
  }, [activeMembers, ligacoesHoje]);

  const individualData = useMemo(() => activeMembers.map(member => {
    const meta = metasDoMes.find(m => m.member_id === member.id);
    const memberDeals = dealsGanhosMes.filter(d => d.closer_id === member.id || d.sdr_id === member.id);
    const memberMrr = memberDeals.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
    const memberOt = memberDeals.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);
    const memberReunioes = reunioesDoMes.filter(r => r.sdr_id === member.id || r.closer_id === member.id).length;
    return {
      member,
      pace: calculatePace(meta?.meta_mrr || 0, meta?.meta_ot || 0, meta?.meta_reunioes || 0, memberMrr, memberOt, memberReunioes, pacePercent),
    };
  }), [activeMembers, metasDoMes, dealsGanhosMes, reunioesDoMes, pacePercent]);

  const pipelineData = useMemo(() => {
    const stages: { name: string; count: number }[] = [];
    for (const [status, label] of Object.entries(DEAL_STATUS_LABELS)) {
      const stageDeals = deals.filter(d => d.status === status);
      if (stageDeals.length > 0) stages.push({ name: label.replace('🔔 ', ''), count: stageDeals.length });
    }
    return stages;
  }, [deals]);

  const canalData = useMemo(() => Object.keys(CANAL_LABELS).map(canal => {
    const canalDeals = dealsGanhosMes.filter(d => d.origem === canal);
    return {
      name: CANAL_LABELS[canal as keyof typeof CANAL_LABELS],
      mrr: canalDeals.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0),
      ot: canalDeals.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0),
      count: canalDeals.length,
    };
  }).filter(c => c.count > 0), [dealsGanhosMes]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">Dashboard</h2>
        <div className="flex items-center gap-3">
          <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
            className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm" />
          <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
            <button onClick={() => setViewMode('geral')} className={`px-3 py-1.5 rounded text-xs font-medium ${viewMode === 'geral' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}>Geral</button>
            <button onClick={() => setViewMode('individual')} className={`px-3 py-1.5 rounded text-xs font-medium ${viewMode === 'individual' ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}>Individual</button>
          </div>
        </div>
      </div>

      {/* LIGACOES DO DIA POR SDR */}
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Phone size={16} className="text-[var(--color-v4-red)]" />
            <h3 className="text-sm font-bold text-white">Ligações do Dia</h3>
            <span className="text-xs text-[var(--color-v4-text-muted)]">({ligacoesHoje.length} total)</span>
          </div>
          <span className="text-[10px] text-[var(--color-v4-text-muted)]">Atualiza a cada 30s</span>
        </div>
        {callsBySdr.length > 0 ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {callsBySdr.map(({ sdr, total, atendidas, naoAtendidas, durMedia }) => (
              <div key={sdr.id} className="bg-[var(--color-v4-surface)] rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-[10px]">
                    {sdr.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-xs font-medium text-white truncate">{sdr.name.split(' ')[0]}</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="text-center">
                    <p className="text-lg font-bold text-white">{total}</p>
                    <p className="text-[9px] text-[var(--color-v4-text-muted)]">Total</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-green-400">{atendidas}</p>
                    <p className="text-[9px] text-[var(--color-v4-text-muted)]">Atendidas</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-red-400">{naoAtendidas}</p>
                    <p className="text-[9px] text-[var(--color-v4-text-muted)]">N/A</p>
                  </div>
                </div>
                {durMedia > 0 && <p className="text-[9px] text-[var(--color-v4-text-muted)] mt-1 text-center">{Math.floor(durMedia / 60)}m{durMedia % 60}s média</p>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-v4-text-muted)] text-center py-2">Nenhuma ligação registrada hoje</p>
        )}
      </div>

      {/* GERAL */}
      {viewMode === 'geral' && (
        <>
          {/* Pace bars */}
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-sm font-bold text-white">Pace do Mês</h3>
                <p className="text-xs text-[var(--color-v4-text-muted)]">Dia útil {bizDaysSoFar} de {totalBizDays} ({(pacePercent * 100).toFixed(0)}% do mês)</p>
              </div>
              <div className={`px-3 py-1.5 rounded-lg text-sm font-bold ${
                generalPace.mrrOnTrack && generalPace.otOnTrack ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}>
                {generalPace.mrrOnTrack && generalPace.otOnTrack ? '✅ No ritmo' : '⚠️ Abaixo'}
              </div>
            </div>
            <PaceBar label="MRR Ganho" realizado={mrrMes} expected={generalPace.expectedMrr} meta={totalMetaMrr} gap={generalPace.gapMrr} onTrack={generalPace.mrrOnTrack} />
            <PaceBar label="OT Ganho" realizado={otMes} expected={generalPace.expectedOt} meta={totalMetaOt} gap={generalPace.gapOt} onTrack={generalPace.otOnTrack} />
            <PaceBar label="Reuniões Realizadas" realizado={reunioesDoMes.length} expected={generalPace.expectedReunioes} meta={totalMetaReunioes} gap={generalPace.gapReunioes} onTrack={generalPace.reunioesOnTrack} isCurrency={false} />
          </div>

          {/* Pace line charts */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <PaceLineChart title="Pace MRR" data={dailyMrr} color="#22c55e" />
            <PaceLineChart title="Pace OT" data={dailyOt} color="#3b82f6" />
            <PaceLineChart title="Pace Reuniões" data={dailyReunioes} isCurrency={false} color="#f59e0b" />
          </div>

          {/* PENDENTES (after paces) */}
          {pendentes.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
              <button onClick={() => setShowPendentes(!showPendentes)} className="flex items-center gap-2 w-full">
                <AlertCircle size={16} className="text-amber-400" />
                <span className="text-sm font-bold text-amber-400 flex-1 text-left">Pendentes de Feedback ({pendentes.length})</span>
                {showPendentes ? <ChevronDown size={14} className="text-amber-400" /> : <ChevronRight size={14} className="text-amber-400" />}
              </button>
              {showPendentes && (
                <div className="space-y-2 mt-3">
                  {pendentes.map(d => (
                    <div key={d.id} className="flex items-center justify-between bg-[var(--color-v4-card)] rounded-lg px-3 py-2">
                      <span className="text-sm text-white font-medium">{d.empresa} <span className="text-xs text-[var(--color-v4-text-muted)]">{d.closer?.name || ''}</span></span>
                      <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400 animate-pulse">Aguardando</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <span className="text-xs text-[var(--color-v4-text-muted)]">Pipeline Ativo</span>
              <p className="text-xl font-bold text-white mt-1">{fmtFull(pipelineMrr + pipelineOt)}</p>
              <p className="text-[10px] text-[var(--color-v4-text-muted)]">{pipelineAtivo.length} negociações</p>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <span className="text-xs text-[var(--color-v4-text-muted)]">Conversão</span>
              <p className="text-xl font-bold text-white mt-1">{dealsDoMes.length > 0 ? ((dealsGanhosMes.length / dealsDoMes.length) * 100).toFixed(0) : 0}%</p>
              <p className="text-[10px] text-[var(--color-v4-text-muted)]">{dealsGanhosMes.length}/{dealsDoMes.length} deals</p>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <span className="text-xs text-[var(--color-v4-text-muted)]">Leads no Mês</span>
              <p className="text-xl font-bold text-white mt-1">{leads.filter(l => { const d = l.data_cadastro ? new Date(l.data_cadastro) : null; return d && d >= mesStart && d <= mesEnd; }).length}</p>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <span className="text-xs text-[var(--color-v4-text-muted)]">Deals no Mês</span>
              <p className="text-xl font-bold text-white mt-1">{dealsDoMes.length}</p>
              <p className="text-[10px] text-[var(--color-v4-text-muted)]">{dealsGanhosMes.length} ganhos</p>
            </div>
          </div>

          {/* Bar charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Pipeline por Etapa</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={pipelineData} layout="vertical">
                  <XAxis type="number" tick={{ fill: '#a0a0a0', fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#a0a0a0', fontSize: 10 }} width={110} />
                  <Tooltip contentStyle={{ background: '#1e1e1e', border: '1px solid #2e2e2e', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="#e63946" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
              <h3 className="text-sm font-semibold text-white mb-4">Vendas por Canal</h3>
              {canalData.length > 0 ? (
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={canalData}>
                    <XAxis dataKey="name" tick={{ fill: '#a0a0a0', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#a0a0a0', fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: '#1e1e1e', border: '1px solid #2e2e2e', borderRadius: 8, fontSize: 12 }} formatter={(v: number) => [fmtFull(v)]} />
                    <Bar dataKey="mrr" name="MRR" fill="#22c55e" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="ot" name="OT" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm text-[var(--color-v4-text-muted)] text-center py-8">Sem vendas</p>}
            </div>
          </div>
        </>
      )}

      {/* INDIVIDUAL */}
      {viewMode === 'individual' && (
        <div className="space-y-4">
          {individualData.map(({ member, pace }) => {
            const hasMeta = pace.metaMrr > 0 || pace.metaOt > 0 || pace.metaReunioes > 0;
            return (
              <div key={member.id} className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-xs">
                    {member.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <span className="text-sm font-medium text-white">{member.name}</span>
                    <span className="text-xs text-[var(--color-v4-text-muted)] ml-2">{ROLE_LABELS[member.role]}</span>
                  </div>
                  {hasMeta && (
                    <div className={`px-2 py-1 rounded text-[10px] font-bold ${
                      (pace.metaMrr <= 0 || pace.mrrOnTrack) && (pace.metaOt <= 0 || pace.otOnTrack) && (pace.metaReunioes <= 0 || pace.reunioesOnTrack)
                        ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                    }`}>
                      {(pace.metaMrr <= 0 || pace.mrrOnTrack) && (pace.metaOt <= 0 || pace.otOnTrack) && (pace.metaReunioes <= 0 || pace.reunioesOnTrack) ? 'No ritmo' : 'Abaixo'}
                    </div>
                  )}
                </div>
                {hasMeta ? (
                  <>
                    {pace.metaMrr > 0 && <PaceBar label="MRR" realizado={pace.realizadoMrr} expected={pace.expectedMrr} meta={pace.metaMrr} gap={pace.gapMrr} onTrack={pace.mrrOnTrack} />}
                    {pace.metaOt > 0 && <PaceBar label="OT" realizado={pace.realizadoOt} expected={pace.expectedOt} meta={pace.metaOt} gap={pace.gapOt} onTrack={pace.otOnTrack} />}
                    {pace.metaReunioes > 0 && <PaceBar label="Reuniões" realizado={pace.realizadoReunioes} expected={pace.expectedReunioes} meta={pace.metaReunioes} gap={pace.gapReunioes} onTrack={pace.reunioesOnTrack} isCurrency={false} />}
                  </>
                ) : (
                  <p className="text-xs text-[var(--color-v4-text-muted)]">Sem meta definida para este mês</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
