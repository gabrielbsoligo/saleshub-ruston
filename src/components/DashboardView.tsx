import React from "react";
import { useAppStore } from "../store";
import { DEAL_STATUS_LABELS, CANAL_LABELS } from "../types";
import { TrendingUp, Users, Target, DollarSign, BarChart3, Calendar, AlertCircle } from "lucide-react";

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(value);
}

function KpiCard({ label, value, sub, icon: Icon, color }: { label: string; value: string; sub?: string; icon: any; color: string }) {
  return (
    <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-[var(--color-v4-text-muted)]">{label}</span>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
          <Icon size={16} />
        </div>
      </div>
      <p className="text-2xl font-display font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-[var(--color-v4-text-muted)] mt-1">{sub}</p>}
    </div>
  );
}

export const DashboardView: React.FC = () => {
  const { deals, leads, reunioes, members } = useAppStore();

  const now = new Date();
  const mesAtual = new Date(now.getFullYear(), now.getMonth(), 1);

  const dealsDoMes = deals.filter(d => {
    const dc = d.data_call ? new Date(d.data_call) : null;
    return dc && dc >= mesAtual;
  });

  const dealsGanhos = deals.filter(d => d.status === 'contrato_assinado');
  const dealsGanhosMes = dealsDoMes.filter(d => d.status === 'contrato_assinado');

  const mrrTotal = dealsGanhos.reduce((acc, d) => acc + (d.valor_mrr || 0), 0);
  const mrrMes = dealsGanhosMes.reduce((acc, d) => acc + (d.valor_mrr || 0), 0);
  const otMes = dealsGanhosMes.reduce((acc, d) => acc + (d.valor_ot || 0), 0);

  const pipelineAtivo = deals.filter(d => d.status === 'negociacao' || d.status === 'contrato_na_rua');
  const pipelineMrr = pipelineAtivo.reduce((acc, d) => acc + (d.valor_mrr || 0), 0);
  const pipelineOt = pipelineAtivo.reduce((acc, d) => acc + (d.valor_ot || 0), 0);

  const leadsDoMes = leads.filter(l => {
    const dc = l.data_cadastro ? new Date(l.data_cadastro) : null;
    return dc && dc >= mesAtual;
  });

  const reunioesDoMes = reunioes.filter(r => {
    const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
    return dr && dr >= mesAtual;
  });
  const reunioesRealizadas = reunioesDoMes.filter(r => r.realizada);

  // Conversão
  const totalDealsComCall = dealsDoMes.length || 1;
  const conversao = ((dealsGanhosMes.length / totalDealsComCall) * 100).toFixed(1);

  // Por closer
  const closers = members.filter(m => m.role === 'closer');
  const closerStats = closers.map(c => {
    const cd = deals.filter(d => d.closer_id === c.id);
    const ganhos = cd.filter(d => d.status === 'contrato_assinado');
    return {
      name: c.name.split(' ')[0],
      total: cd.length,
      ganhos: ganhos.length,
      mrr: ganhos.reduce((acc, d) => acc + (d.valor_mrr || 0), 0),
      ot: ganhos.reduce((acc, d) => acc + (d.valor_ot || 0), 0),
    };
  }).sort((a, b) => b.mrr - a.mrr);

  // Por canal
  const canalStats = Object.keys(CANAL_LABELS).map(canal => {
    const cl = leads.filter(l => l.canal === canal);
    const clMes = cl.filter(l => {
      const dc = l.data_cadastro ? new Date(l.data_cadastro) : null;
      return dc && dc >= mesAtual;
    });
    return { canal, label: CANAL_LABELS[canal as keyof typeof CANAL_LABELS], total: cl.length, mes: clMes.length };
  }).sort((a, b) => b.total - a.total);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-2xl font-display font-bold text-white mb-6">Dashboard</h2>

      {/* PENDENTES DE FEEDBACK - alerta pro gestor */}
      {deals.filter(d => d.status === 'dar_feedback').length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle size={18} className="text-amber-400" />
            <h3 className="text-sm font-bold text-amber-400">
              Pendentes de Feedback ({deals.filter(d => d.status === 'dar_feedback').length})
            </h3>
          </div>
          <div className="space-y-2">
            {deals.filter(d => d.status === 'dar_feedback').map(d => (
              <div key={d.id} className="flex items-center justify-between bg-[var(--color-v4-card)] rounded-lg px-3 py-2">
                <div>
                  <span className="text-sm text-white font-medium">{d.empresa}</span>
                  <span className="text-xs text-[var(--color-v4-text-muted)] ml-2">
                    {d.closer?.name || 'Sem closer'} · {d.data_call ? new Date(d.data_call).toLocaleDateString('pt-BR') : ''}
                  </span>
                </div>
                <span className="text-xs px-2 py-1 rounded bg-amber-500/20 text-amber-400 animate-pulse">Aguardando</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="MRR Ganho (mês)" value={formatCurrency(mrrMes)} sub={`${dealsGanhosMes.length} contratos`} icon={DollarSign} color="bg-green-500/20 text-green-400" />
        <KpiCard label="OT Ganho (mês)" value={formatCurrency(otMes)} icon={TrendingUp} color="bg-blue-500/20 text-blue-400" />
        <KpiCard label="Pipeline Ativo" value={formatCurrency(pipelineMrr + pipelineOt)} sub={`${pipelineAtivo.length} negociações`} icon={Target} color="bg-yellow-500/20 text-yellow-400" />
        <KpiCard label="Conversão (mês)" value={`${conversao}%`} sub={`${dealsGanhosMes.length}/${totalDealsComCall}`} icon={BarChart3} color="bg-purple-500/20 text-purple-400" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard label="MRR Total Carteira" value={formatCurrency(mrrTotal)} icon={DollarSign} color="bg-emerald-500/20 text-emerald-400" />
        <KpiCard label="Leads (mês)" value={String(leadsDoMes.length)} sub={`${leads.length} total`} icon={Users} color="bg-cyan-500/20 text-cyan-400" />
        <KpiCard label="Reuniões (mês)" value={String(reunioesDoMes.length)} sub={`${reunioesRealizadas.length} realizadas`} icon={Calendar} color="bg-orange-500/20 text-orange-400" />
        <KpiCard label="Deals no Mês" value={String(dealsDoMes.length)} icon={Target} color="bg-pink-500/20 text-pink-400" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Ranking Closers */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Ranking Closers</h3>
          <div className="space-y-3">
            {closerStats.map((c, i) => (
              <div key={c.name} className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs w-5 h-5 rounded-full flex items-center justify-center bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{i + 1}</span>
                  <span className="text-sm text-white">{c.name}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-green-400">{formatCurrency(c.mrr)}/mês</span>
                  <span className="text-blue-400">{formatCurrency(c.ot)} OT</span>
                  <span className="text-[var(--color-v4-text-muted)]">{c.ganhos}/{c.total}</span>
                </div>
              </div>
            ))}
            {closerStats.length === 0 && <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhum closer cadastrado</p>}
          </div>
        </div>

        {/* Leads por Canal */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Leads por Canal</h3>
          <div className="space-y-3">
            {canalStats.map(c => {
              const pct = leads.length > 0 ? (c.total / leads.length * 100) : 0;
              return (
                <div key={c.canal}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white">{c.label}</span>
                    <span className="text-xs text-[var(--color-v4-text-muted)]">{c.total} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-2 bg-[var(--color-v4-surface)] rounded-full overflow-hidden">
                    <div className="h-full bg-[var(--color-v4-red)] rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
