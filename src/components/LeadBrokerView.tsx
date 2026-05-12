// =============================================================
// LeadBrokerView — espelho do BlackBox pro canal "leadbroker"
// =============================================================
// Diferenca chave vs BlackBox:
//  - Nao tem contrato fixo de "X leads por R$ Y" — leadbroker eh
//    compra avulsa lead-a-lead com preco variavel (leads.valor_lead).
//  - Investimento = sum(valor_lead) dos leads do mes.
//  - Em vez de "pace por tier de faturamento", mostra distribuicao
//    por faixa de preco pago + analise de ROI (caro vs barato vs
//    conversao).
//
// Filtros: mes (data_cadastro). Funil identico ao BlackBox.
// =============================================================
import React, { useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { TrendingUp, TrendingDown } from 'lucide-react';

function fmt(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(v);
}
function pct(a: number, b: number) {
  return b > 0 ? ((a / b) * 100).toFixed(0) + '%' : '0%';
}

// Aceita 'YYYY-MM-DD' e ISO timestamp. Parse local pra evitar shift TZ.
function parseLocalDate(s?: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Faixas de preco do leadbroker — uteis pra entender o investimento
// medio e descobrir se os leads mais caros tem ROI proporcional.
interface FaixaPreco {
  id: string;
  label: string;
  min: number;
  max: number; // exclusivo
}
const FAIXAS: FaixaPreco[] = [
  { id: 'gratis',    label: 'Grátis (R$0)',     min: 0,    max: 0.01  },
  { id: '0-500',     label: 'R$ 1 – 500',       min: 0.01, max: 500   },
  { id: '500-1000',  label: 'R$ 500 – 1.000',   min: 500,  max: 1000  },
  { id: '1000-1500', label: 'R$ 1.000 – 1.500', min: 1000, max: 1500  },
  { id: '1500-2000', label: 'R$ 1.500 – 2.000', min: 1500, max: 2000  },
  { id: '2000+',     label: 'R$ 2.000+',        min: 2000, max: Infinity },
];

function faixaDoLead(valor: number | null | undefined): FaixaPreco | null {
  if (valor == null) return null;
  for (const f of FAIXAS) {
    if (valor >= f.min && valor < f.max) return f;
  }
  return null;
}

export const LeadBrokerView: React.FC = () => {
  const { leads, reunioes, deals } = useAppStore();
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });

  const [year, month] = selectedMonth.split('-').map(Number);
  const mesStart = new Date(year, month - 1, 1);
  const mesEnd = new Date(year, month, 0, 23, 59, 59);
  const now = new Date();
  const currentDay = now.getFullYear() === year && now.getMonth() === month - 1 ? now.getDate() : mesEnd.getDate();
  const totalDays = mesEnd.getDate();

  // Leads do leadbroker no mes
  const lbLeads = useMemo(() => leads.filter(l => {
    if (l.canal !== 'leadbroker') return false;
    const d = parseLocalDate(l.data_cadastro) || parseLocalDate(l.created_at);
    return d && d >= mesStart && d <= mesEnd;
  }), [leads, mesStart, mesEnd]);

  // Funil
  const totalLeads = lbLeads.length;
  const conexoes = lbLeads.filter(l => l.status !== 'sem_contato').length;
  const reunioesMarcadas = lbLeads.filter(l => ['reuniao_marcada', 'reuniao_realizada'].includes(l.status)).length;

  // Reunioes do mes que vieram de lead leadbroker
  const lbReunioes = useMemo(() => reunioes.filter(r => {
    const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
    if (!dr || dr < mesStart || dr > mesEnd) return false;
    const lead = r.lead_id ? leads.find(l => l.id === r.lead_id) : null;
    return lead?.canal === 'leadbroker';
  }), [reunioes, leads, mesStart, mesEnd]);

  const reunioesRealizadas = lbReunioes.filter(r => r.realizada && r.show).length;
  const noShows = lbReunioes.filter(r => r.realizada && !r.show).length;

  // Deals leadbroker fechados no mes
  const lbDeals = useMemo(() => deals.filter(d => {
    if (d.origem !== 'leadbroker') return false;
    const dc = d.data_fechamento ? new Date(d.data_fechamento) : d.data_call ? new Date(d.data_call) : null;
    return dc && dc >= mesStart && dc <= mesEnd && d.status === 'contrato_assinado';
  }), [deals, mesStart, mesEnd]);

  const vendas = lbDeals.length;
  const fatMrr = lbDeals.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
  const fatOt = lbDeals.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);
  const fatTotal = fatMrr + fatOt;
  const ticketMedio = vendas > 0 ? fatTotal / vendas : 0;

  // Investimento = soma valor_lead dos leads do mes
  const investimento = lbLeads.reduce((a, l) => a + (l.valor_lead || 0), 0);
  const custoLead = totalLeads > 0 ? investimento / totalLeads : 0;
  const custoReuniao = reunioesRealizadas > 0 ? investimento / reunioesRealizadas : 0;
  const cac = vendas > 0 ? investimento / vendas : 0;
  const roas = investimento > 0 ? fatTotal / investimento : 0;

  // Distribuicao por faixa de preco
  const faixaStats = useMemo(() => {
    return FAIXAS.map(f => {
      const leadsFaixa = lbLeads.filter(l => {
        const v = l.valor_lead;
        if (v == null) return false;
        return v >= f.min && v < f.max;
      });
      const invFaixa = leadsFaixa.reduce((a, l) => a + (l.valor_lead || 0), 0);
      const dealsFaixa = lbDeals.filter(d => leadsFaixa.some(l => l.id === d.lead_id));
      const fatFaixa = dealsFaixa.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0) + (d.valor_escopo || d.valor_ot || 0), 0);
      const roasFaixa = invFaixa > 0 ? fatFaixa / invFaixa : 0;
      return {
        faixa: f,
        leads: leadsFaixa.length,
        investimento: invFaixa,
        custoMedio: leadsFaixa.length > 0 ? invFaixa / leadsFaixa.length : 0,
        vendas: dealsFaixa.length,
        faturamento: fatFaixa,
        roas: roasFaixa,
        conversao: leadsFaixa.length > 0 ? dealsFaixa.length / leadsFaixa.length : 0,
      };
    });
  }, [lbLeads, lbDeals]);

  // Top leads por preco — analise ROI lead-a-lead
  const topLeadsCaros = useMemo(() => {
    return [...lbLeads]
      .filter(l => (l.valor_lead || 0) > 0)
      .sort((a, b) => (b.valor_lead || 0) - (a.valor_lead || 0))
      .slice(0, 10)
      .map(l => {
        const deal = deals.find(d => d.lead_id === l.id && d.status === 'contrato_assinado');
        const fat = deal ? ((deal.valor_recorrente || deal.valor_mrr || 0) + (deal.valor_escopo || deal.valor_ot || 0)) : 0;
        return { lead: l, deal, fat, virouVenda: !!deal };
      });
  }, [lbLeads, deals]);

  const MetricRow = ({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'green' | 'red' | 'neutral' }) => (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-v4-border)] last:border-0">
      <span className="text-xs text-[var(--color-v4-text-muted)]">{label}</span>
      <div className="text-right">
        <span className={`text-sm font-medium ${
          accent === 'green' ? 'text-green-400' :
          accent === 'red' ? 'text-red-400' : 'text-white'
        }`}>{value}</span>
        {sub && <span className="text-[10px] text-[var(--color-v4-text-muted)] ml-2">{sub}</span>}
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-display font-bold text-white">LeadBroker</h2>
          <p className="text-[11px] text-[var(--color-v4-text-muted)] mt-0.5">
            Compra avulsa lead-a-lead (preço variável). Investimento = soma do valor pago.
          </p>
        </div>
        <input
          type="month"
          value={selectedMonth}
          onChange={e => setSelectedMonth(e.target.value)}
          className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm"
        />
      </div>

      {/* KPIs principais */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
          <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">Investimento</span>
          <p className="text-2xl font-bold text-white mt-1">{fmt(investimento)}</p>
          <p className="text-[10px] text-[var(--color-v4-text-muted)]">CPL médio {custoLead > 0 ? fmt(custoLead) : '—'}</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
          <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">Leads comprados</span>
          <p className="text-2xl font-bold text-white mt-1">{totalLeads}</p>
          <p className="text-[10px] text-[var(--color-v4-text-muted)]">{conexoes} conexões · {reunioesMarcadas} reuniões</p>
        </div>
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
          <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">Vendas</span>
          <p className="text-2xl font-bold text-green-400 mt-1">{vendas}</p>
          <p className="text-[10px] text-[var(--color-v4-text-muted)]">{fmt(fatTotal)} faturado</p>
        </div>
        <div className={`bg-[var(--color-v4-card)] border rounded-xl p-4 ${roas >= 1 ? 'border-green-500/30 bg-green-500/5' : roas > 0 ? 'border-amber-500/30 bg-amber-500/5' : 'border-[var(--color-v4-border)]'}`}>
          <span className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">ROAS</span>
          <p className={`text-2xl font-bold mt-1 ${roas >= 1 ? 'text-green-400' : roas > 0 ? 'text-amber-400' : 'text-white'}`}>
            {roas > 0 ? `${roas.toFixed(2)}x` : '—'}
          </p>
          <p className="text-[10px] text-[var(--color-v4-text-muted)]">CAC {cac > 0 ? fmt(cac) : '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Coluna 1: Funil */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Funil LeadBroker</h3>
          <MetricRow label="Investimento" value={fmt(investimento)} />
          <MetricRow label="Custo médio por lead" value={custoLead > 0 ? fmt(custoLead) : '—'} />
          <MetricRow label="Leads comprados" value={String(totalLeads)} sub="MQL" />
          <MetricRow label="TX Lead/Conexão" value={pct(conexoes, totalLeads)} />
          <MetricRow label="Conexões" value={String(conexoes)} />
          <MetricRow label="Reuniões marcadas" value={String(reunioesMarcadas)} sub="SQL" />
          <MetricRow label="TX Show" value={pct(reunioesRealizadas, reunioesMarcadas)} />
          <MetricRow label="Reuniões realizadas" value={String(reunioesRealizadas)} sub="SAL" />
          <MetricRow label="No-show" value={String(noShows)} />
          <MetricRow label="TX Reunião/Venda" value={pct(vendas, reunioesRealizadas)} />
          <MetricRow label="Vendas" value={String(vendas)} sub="WON" accent="green" />
          <hr className="border-[var(--color-v4-border)] my-2" />
          <MetricRow label="Custo por reunião realizada" value={custoReuniao > 0 ? fmt(custoReuniao) : '—'} />
          <MetricRow label="CAC" value={cac > 0 ? fmt(cac) : '—'} />
          <MetricRow label="Ticket Médio" value={ticketMedio > 0 ? fmt(ticketMedio) : '—'} />
          <MetricRow label="ROAS" value={roas > 0 ? roas.toFixed(2) + 'x' : '—'} accent={roas >= 1 ? 'green' : roas > 0 ? 'red' : 'neutral'} />
          <MetricRow label="Faturamento MRR" value={fmt(fatMrr)} />
          <MetricRow label="Faturamento OT" value={fmt(fatOt)} />
          <MetricRow label="Faturamento Total" value={fmt(fatTotal)} />
          <MetricRow label="Eficiência do funil" value={pct(vendas, totalLeads)} />
        </div>

        {/* Coluna 2: Distribuicao por faixa de preco */}
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Distribuição por faixa de preço</h3>
          <p className="text-[11px] text-[var(--color-v4-text-muted)] mb-4">
            Lead caro converte mais? ROAS por faixa revela onde o investimento dá retorno.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--color-v4-text-muted)] uppercase text-[9px]">
                <tr>
                  <th className="text-left py-2">Faixa</th>
                  <th className="text-right py-2">Leads</th>
                  <th className="text-right py-2">Invest.</th>
                  <th className="text-right py-2">Vendas</th>
                  <th className="text-right py-2">Conv.</th>
                  <th className="text-right py-2">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {faixaStats.map(row => (
                  <tr key={row.faixa.id} className="border-t border-[var(--color-v4-border)]">
                    <td className="py-2 text-white text-[11px]">{row.faixa.label}</td>
                    <td className="py-2 text-right text-white">{row.leads}</td>
                    <td className="py-2 text-right text-[var(--color-v4-text-muted)]">{row.investimento > 0 ? fmt(row.investimento) : '—'}</td>
                    <td className="py-2 text-right text-green-400">{row.vendas || '—'}</td>
                    <td className="py-2 text-right text-[var(--color-v4-text-muted)]">
                      {row.leads > 0 ? `${(row.conversao * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td className={`py-2 text-right font-medium ${row.roas >= 1 ? 'text-green-400' : row.roas > 0 ? 'text-amber-400' : 'text-[var(--color-v4-text-muted)]'}`}>
                      {row.roas > 0 ? `${row.roas.toFixed(2)}x` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Top leads mais caros — ROI lead-a-lead */}
      <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 mt-6">
        <h3 className="text-sm font-semibold text-white mb-1">Top 10 leads mais caros do mês</h3>
        <p className="text-[11px] text-[var(--color-v4-text-muted)] mb-4">
          Quais leads premium voltaram o investimento? Verde = virou venda.
        </p>
        {topLeadsCaros.length === 0 ? (
          <p className="text-center py-6 text-xs text-[var(--color-v4-text-muted)]">
            Nenhum lead com preço registrado neste mês.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--color-v4-text-muted)] uppercase text-[9px]">
                <tr>
                  <th className="text-left py-2">Empresa</th>
                  <th className="text-left py-2">SDR</th>
                  <th className="text-right py-2">Pago</th>
                  <th className="text-left py-2">Status</th>
                  <th className="text-right py-2">Faturamento</th>
                  <th className="text-right py-2">ROI</th>
                </tr>
              </thead>
              <tbody>
                {topLeadsCaros.map(({ lead, deal, fat, virouVenda }) => {
                  const roi = (lead.valor_lead || 0) > 0 ? fat / (lead.valor_lead || 1) : 0;
                  return (
                    <tr key={lead.id} className={`border-t border-[var(--color-v4-border)] ${virouVenda ? 'bg-green-500/5' : ''}`}>
                      <td className="py-2 text-white">{lead.empresa}</td>
                      <td className="py-2 text-[var(--color-v4-text-muted)]">{lead.sdr?.name?.split(' ')[0] || '—'}</td>
                      <td className="py-2 text-right text-white">{fmt(lead.valor_lead || 0)}</td>
                      <td className="py-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          virouVenda ? 'bg-green-500/15 text-green-400'
                          : lead.status === 'reuniao_realizada' ? 'bg-blue-500/15 text-blue-400'
                          : lead.status === 'reuniao_marcada' ? 'bg-amber-500/15 text-amber-400'
                          : lead.status === 'perdido' ? 'bg-red-500/15 text-red-400'
                          : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'
                        }`}>
                          {virouVenda ? 'Fechado' : lead.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-2 text-right text-green-400">{fat > 0 ? fmt(fat) : '—'}</td>
                      <td className={`py-2 text-right font-medium ${roi >= 1 ? 'text-green-400' : roi > 0 ? 'text-amber-400' : 'text-[var(--color-v4-text-muted)]'}`}>
                        {roi > 0 ? `${roi.toFixed(1)}x` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
