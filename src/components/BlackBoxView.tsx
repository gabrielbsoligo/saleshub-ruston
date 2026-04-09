import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { Save, TrendingUp, TrendingDown } from "lucide-react";
// BlackBox pace uses calendar days (not business days)
import toast from "react-hot-toast";

function fmt(v: number) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(v); }
function pct(a: number, b: number) { return b > 0 ? ((a / b) * 100).toFixed(0) + '%' : '0%'; }

type TierName = 'large' | 'medium' | 'small' | 'tiny';

const TIER_FATURAMENTO: Record<TierName, string[]> = {
  large: ['De 4 a 16 milhões', 'De 16 a 40 milhões', 'Acima de 40 milhões'],
  medium: ['De 401 mil à 1 milhão', 'De 1 a 4 milhões'],
  small: ['De 101 mil à 200 mil', 'De 201 mil à 400 mil'],
  tiny: ['Até 50 mil', 'De 51 mil à 70 mil', 'De 71 mil à 100 mil'],
};

function normalize(s: string): string {
  return s.normalize('NFC').replace(/[\u00a0\u00c0-\u00ff]/g, c => {
    const map: Record<string, string> = { '\u00e0': 'a', '\u00e1': 'a', '\u00e3': 'a', '\u00c3': '', '\u00e9': 'e', '\u00f5': 'o', '\u00e7': 'c', '\u00ed': 'i', '\u00f3': 'o', '\u00fa': 'u', '\u00a0': ' ' };
    return map[c.toLowerCase()] ?? c;
  }).toLowerCase().replace(/\s+/g, ' ').trim();
}

function getTier(faturamento?: string): TierName | null {
  if (!faturamento) return null;
  const norm = normalize(faturamento);
  for (const [tier, values] of Object.entries(TIER_FATURAMENTO)) {
    if (values.some(v => normalize(v) === norm)) return tier as TierName;
  }
  return null;
}

interface Contrato {
  id?: string;
  mes: string;
  plano: string;
  investimento: number;
  leads_large: number;
  leads_medium: number;
  leads_small: number;
  leads_tiny: number;
}

export const BlackBoxView: React.FC = () => {
  const { leads, reunioes, deals, currentUser } = useAppStore();
  const isGestor = currentUser?.role === 'gestor';
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [contrato, setContrato] = useState<Contrato>({ mes: '', plano: '', investimento: 0, leads_large: 0, leads_medium: 0, leads_small: 0, leads_tiny: 0 });
  const [isProcessing, setIsProcessing] = useState(false);

  const mesDate = `${selectedMonth}-01`;
  const [year, month] = selectedMonth.split('-').map(Number);
  const mesStart = new Date(year, month - 1, 1);
  const mesEnd = new Date(year, month, 0);
  const now = new Date();
  const currentDay = now.getFullYear() === year && now.getMonth() === month - 1 ? now.getDate() : mesEnd.getDate();
  const totalDays = mesEnd.getDate(); // total calendar days in month
  const daysSoFar = currentDay;

  // Load contrato
  const loadContrato = useCallback(async () => {
    const { data } = await supabase.from('blackbox_contratos').select('*').eq('mes', mesDate).single();
    if (data) {
      setContrato(data);
    } else {
      setContrato({ mes: mesDate, plano: '', investimento: 0, leads_large: 0, leads_medium: 0, leads_small: 0, leads_tiny: 0 });
    }
  }, [mesDate]);

  useEffect(() => { loadContrato(); }, [loadContrato]);

  const saveContrato = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      const payload = { ...contrato, mes: mesDate };
      await supabase.from('blackbox_contratos').upsert(payload, { onConflict: 'mes' });
      toast.success('Contrato BlackBox salvo!');
      loadContrato();
    } finally { setIsProcessing(false); }
  };

  // Filter BB leads by month
  const bbLeads = useMemo(() => leads.filter(l => {
    if (l.canal !== 'blackbox') return false;
    const d = l.data_cadastro ? new Date(l.data_cadastro) : l.created_at ? new Date(l.created_at) : null;
    return d && d >= mesStart && d <= mesEnd;
  }), [leads, mesStart, mesEnd]);

  // Tier breakdown
  const tierCounts = useMemo(() => {
    const counts: Record<TierName, number> = { large: 0, medium: 0, small: 0, tiny: 0 };
    for (const l of bbLeads) {
      const tier = getTier(l.faturamento);
      if (tier) counts[tier]++;
    }
    return counts;
  }, [bbLeads]);

  // Funil metrics
  const totalLeads = bbLeads.length;
  const conexoes = bbLeads.filter(l => !['sem_contato'].includes(l.status)).length;
  const reunioesMarcadas = bbLeads.filter(l => ['reuniao_marcada', 'reuniao_realizada'].includes(l.status)).length;

  const bbReunioes = useMemo(() => reunioes.filter(r => {
    const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
    if (!dr || dr < mesStart || dr > mesEnd) return false;
    const lead = r.lead_id ? leads.find(l => l.id === r.lead_id) : null;
    return lead?.canal === 'blackbox';
  }), [reunioes, leads, mesStart, mesEnd]);

  const reunioesRealizadas = bbReunioes.filter(r => r.realizada && r.show).length;
  const noShows = bbReunioes.filter(r => r.realizada && !r.show).length;
  const txShow = reunioesMarcadas > 0 ? (reunioesRealizadas / reunioesMarcadas) : 0;

  const bbDeals = useMemo(() => deals.filter(d => {
    if (d.origem !== 'blackbox') return false;
    const dc = d.data_fechamento ? new Date(d.data_fechamento) : d.data_call ? new Date(d.data_call) : null;
    return dc && dc >= mesStart && dc <= mesEnd && d.status === 'contrato_assinado';
  }), [deals, mesStart, mesEnd]);

  const vendas = bbDeals.length;
  const fatMrr = bbDeals.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
  const fatOt = bbDeals.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);
  const fatTotal = fatMrr + fatOt;
  const ticketMedio = vendas > 0 ? fatTotal / vendas : 0;

  const investimento = contrato.investimento || 0;
  const custoLead = totalLeads > 0 ? investimento / totalLeads : 0;
  const custoReuniao = reunioesRealizadas > 0 ? investimento / reunioesRealizadas : 0;
  const cac = vendas > 0 ? investimento / vendas : 0;
  const roas = investimento > 0 ? fatTotal / investimento : 0;
  const leadsContratados = contrato.leads_large + contrato.leads_medium + contrato.leads_small + contrato.leads_tiny;

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
  const labelClass = "block text-[10px] font-medium text-[var(--color-v4-text-muted)] mb-1 uppercase tracking-wider";

  const MetricRow = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-v4-border)] last:border-0">
      <span className="text-xs text-[var(--color-v4-text-muted)]">{label}</span>
      <div className="text-right">
        <span className="text-sm text-white font-medium">{value}</span>
        {sub && <span className="text-[10px] text-[var(--color-v4-text-muted)] ml-2">{sub}</span>}
      </div>
    </div>
  );

  const TierRow = ({ tier, label, contratado, recebido }: { tier: string; label: string; contratado: number; recebido: number }) => {
    const idealDia = totalDays > 0 ? Math.round((contratado / totalDays) * daysSoFar) : 0;
    const onTrack = recebido >= idealDia;
    return (
      <div className="flex items-center justify-between py-2 border-b border-[var(--color-v4-border)] last:border-0">
        <span className="text-xs text-white font-medium w-20">{label}</span>
        <span className="text-xs text-[var(--color-v4-text-muted)] w-20 text-center">{contratado}</span>
        <span className={`text-xs font-medium w-20 text-center ${onTrack ? 'text-green-400' : 'text-red-400'}`}>{recebido}</span>
        <span className="text-xs text-[var(--color-v4-text-muted)] w-20 text-center">{idealDia}</span>
        <div className="w-20">
          {contratado > 0 && (
            <div className="h-2 bg-[var(--color-v4-surface)] rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${onTrack ? 'bg-green-500' : 'bg-red-500'}`}
                style={{ width: `${Math.min((recebido / contratado) * 100, 100)}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-display font-bold text-white">BlackBox</h2>
        <input type="month" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}
          className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Coluna 1: Contrato (input) */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Contrato do Mês</h3>
          <div className="space-y-3">
            <div><label className={labelClass}>Plano</label>
              <input className={inputClass} value={contrato.plano} onChange={e => setContrato(p => ({ ...p, plano: e.target.value }))} placeholder="Ex: 2 Prata" disabled={!isGestor} /></div>
            <div><label className={labelClass}>Investimento (R$)</label>
              <input type="number" className={inputClass} value={contrato.investimento} onChange={e => setContrato(p => ({ ...p, investimento: Number(e.target.value) }))} disabled={!isGestor} /></div>
            <hr className="border-[var(--color-v4-border)]" />
            <p className="text-[10px] text-[var(--color-v4-text-muted)] uppercase tracking-wider">Leads contratados por tier</p>
            <div className="grid grid-cols-2 gap-2">
              <div><label className={labelClass}>Large (4M+)</label>
                <input type="number" className={inputClass} value={contrato.leads_large} onChange={e => setContrato(p => ({ ...p, leads_large: Number(e.target.value) }))} disabled={!isGestor} /></div>
              <div><label className={labelClass}>Medium (401k-4M)</label>
                <input type="number" className={inputClass} value={contrato.leads_medium} onChange={e => setContrato(p => ({ ...p, leads_medium: Number(e.target.value) }))} disabled={!isGestor} /></div>
              <div><label className={labelClass}>Small (101-400k)</label>
                <input type="number" className={inputClass} value={contrato.leads_small} onChange={e => setContrato(p => ({ ...p, leads_small: Number(e.target.value) }))} disabled={!isGestor} /></div>
              <div><label className={labelClass}>Tiny (até 100k)</label>
                <input type="number" className={inputClass} value={contrato.leads_tiny} onChange={e => setContrato(p => ({ ...p, leads_tiny: Number(e.target.value) }))} disabled={!isGestor} /></div>
            </div>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Total: {leadsContratados} leads · CPL: {leadsContratados > 0 ? fmt(investimento / leadsContratados) : '—'}</p>
            {isGestor && (
              <button onClick={saveContrato} disabled={isProcessing}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm font-medium">
                <Save size={14} /> {isProcessing ? 'Salvando...' : 'Salvar'}
              </button>
            )}
          </div>
        </div>

        {/* Coluna 2: Funil */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Funil BlackBox</h3>
          <MetricRow label="Investimento" value={fmt(investimento)} />
          <MetricRow label="Custo médio Lead" value={custoLead > 0 ? fmt(custoLead) : '—'} />
          <MetricRow label="Leads comprados" value={String(totalLeads)} sub="MQL" />
          <MetricRow label="TX Lead/Conexão" value={pct(conexoes, totalLeads)} />
          <MetricRow label="Conexão" value={String(conexoes)} />
          <MetricRow label="Reuniões Marcadas" value={String(reunioesMarcadas)} sub="SQL" />
          <MetricRow label="TX Show" value={pct(reunioesRealizadas, reunioesMarcadas)} />
          <MetricRow label="Reuniões Realizadas" value={String(reunioesRealizadas)} sub="SAL" />
          <MetricRow label="TX Reunião/Venda" value={pct(vendas, reunioesRealizadas)} />
          <MetricRow label="Vendas" value={String(vendas)} sub="WON" />
          <hr className="border-[var(--color-v4-border)] my-2" />
          <MetricRow label="Custo por Reunião" value={custoReuniao > 0 ? fmt(custoReuniao) : '—'} />
          <MetricRow label="CAC" value={cac > 0 ? fmt(cac) : '—'} />
          <MetricRow label="Ticket Médio" value={ticketMedio > 0 ? fmt(ticketMedio) : '—'} />
          <MetricRow label="ROAS" value={roas > 0 ? roas.toFixed(2) + 'x' : '—'} />
          <MetricRow label="Faturamento MRR" value={fmt(fatMrr)} />
          <MetricRow label="Faturamento OT" value={fmt(fatOt)} />
          <MetricRow label="Faturamento Total" value={fmt(fatTotal)} />
          <MetricRow label="Eficiência Funil" value={pct(vendas, totalLeads)} />
        </div>

        {/* Coluna 3: Pace por Tier */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-2">Pace de Leads por Tier</h3>
          <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">Dia {daysSoFar} de {totalDays}</p>

          <div className="flex items-center justify-between py-2 border-b border-[var(--color-v4-border)] text-[10px] text-[var(--color-v4-text-muted)] uppercase tracking-wider">
            <span className="w-20">Tier</span>
            <span className="w-20 text-center">Contratado</span>
            <span className="w-20 text-center">Recebido</span>
            <span className="w-20 text-center">Ideal dia</span>
            <span className="w-20 text-center">Pace</span>
          </div>

          <TierRow tier="large" label="Large" contratado={contrato.leads_large} recebido={tierCounts.large} />
          <TierRow tier="medium" label="Medium" contratado={contrato.leads_medium} recebido={tierCounts.medium} />
          <TierRow tier="small" label="Small" contratado={contrato.leads_small} recebido={tierCounts.small} />
          <TierRow tier="tiny" label="Tiny" contratado={contrato.leads_tiny} recebido={tierCounts.tiny} />

          <div className="flex items-center justify-between py-3 mt-2 border-t border-[var(--color-v4-border)]">
            <span className="text-xs text-white font-bold w-20">Total</span>
            <span className="text-xs text-white font-bold w-20 text-center">{leadsContratados}</span>
            <span className={`text-xs font-bold w-20 text-center ${totalLeads >= (totalDays > 0 ? Math.round((leadsContratados / totalDays) * daysSoFar) : 0) ? 'text-green-400' : 'text-red-400'}`}>{totalLeads}</span>
            <span className="text-xs text-[var(--color-v4-text-muted)] w-20 text-center">{totalDays > 0 ? Math.round((leadsContratados / totalDays) * daysSoFar) : 0}</span>
            <div className="w-20">
              {leadsContratados > 0 && (
                <div className="h-2 bg-[var(--color-v4-surface)] rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${totalLeads >= Math.round((leadsContratados / totalDays) * daysSoFar) ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.min((totalLeads / leadsContratados) * 100, 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
