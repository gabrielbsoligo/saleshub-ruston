import React, { useState, useMemo, useEffect } from "react";
import { useAppStore } from "../store";
import { ROLE_LABELS } from "../types";
import { Save, Phone, PhoneOff, Clock, Headphones, Star } from "lucide-react";
import { supabase } from "../lib/supabase";

export const PerformanceView: React.FC = () => {
  const { members, performanceSdr, savePerformanceSdr, performanceCloser, savePerformanceCloser, ligacoes, deals, reunioes } = useAppStore();
  const [recomendacoes, setRecomendacoes] = useState<any[]>([]);
  const [tab, setTab] = useState<'ligacoes' | 'sdr' | 'closer'>('ligacoes');
  const [selectedMember, setSelectedMember] = useState('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [selectedMes, setSelectedMes] = useState(new Date().toISOString().slice(0, 7));
  const [isProcessing, setIsProcessing] = useState(false);

  const sdrs = members.filter(m => m.role === 'sdr' && m.active);
  const closers = members.filter(m => m.role === 'closer' && m.active);
  const allActive = members.filter(m => m.active);

  // Fetch recomendacoes
  useEffect(() => {
    supabase.from('recomendacoes').select('*').then(({ data }) => { if (data) setRecomendacoes(data); });
  }, []);

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  // SDR form
  const [sdrForm, setSdrForm] = useState({
    ligacoes: 0, ligacoes_atendidas: 0, conversas_whatsapp: 0,
    reunioes_agendadas: 0, reunioes_realizadas: 0, no_shows: 0, indicacoes_coletadas: 0,
  });

  const handleSaveSdr = async () => {
    if (!selectedMember || isProcessing) return;
    setIsProcessing(true);
    try { await savePerformanceSdr({ member_id: selectedMember, data: selectedDate, ...sdrForm }); }
    finally { setIsProcessing(false); }
  };

  const [closerForm, setCloserForm] = useState({ canal: 'inbound' as string, shows: 0, no_shows: 0, vendas: 0 });

  const handleSaveCloser = async () => {
    if (!selectedMember || isProcessing) return;
    setIsProcessing(true);
    try { await savePerformanceCloser({ member_id: selectedMember, mes: `${selectedMes}-01`, ...closerForm }); }
    finally { setIsProcessing(false); }
  };

  // 4com ligacoes metrics
  const [ligPeriodo, setLigPeriodo] = useState<'hoje' | 'semana' | 'mes'>('hoje');

  const ligacoesFiltered = useMemo(() => {
    const now = new Date();
    let start: Date;
    if (ligPeriodo === 'hoje') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (ligPeriodo === 'semana') {
      start = new Date(now.getTime() - 7 * 86400000);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    return ligacoes.filter(l => l.started_at && new Date(l.started_at) >= start);
  }, [ligacoes, ligPeriodo]);

  const ligacoesPorMembro = useMemo(() => {
    return allActive.filter(m => m.ramal_4com).map(member => {
      const memberLigs = ligacoesFiltered.filter(l => l.member_id === member.id);
      const total = memberLigs.length;
      const atendidas = memberLigs.filter(l => l.atendida).length;
      const naoAtendidas = total - atendidas;
      const duracaoTotal = memberLigs.reduce((a, l) => a + (l.duration || 0), 0);
      const duracaoMedia = atendidas > 0 ? Math.round(duracaoTotal / atendidas) : 0;

      return {
        member,
        total,
        atendidas,
        naoAtendidas,
        duracaoTotal,
        duracaoMedia,
        txAtendimento: total > 0 ? ((atendidas / total) * 100).toFixed(0) : '0',
      };
    }).sort((a, b) => b.total - a.total);
  }, [allActive, ligacoesFiltered]);

  const totalGeral = ligacoesFiltered.length;
  const atendidasGeral = ligacoesFiltered.filter(l => l.atendida).length;

  function fmtDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m${s > 0 ? ` ${s}s` : ''}`;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-2xl font-display font-bold text-white mb-6">Performance</h2>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('ligacoes')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'ligacoes' ? 'bg-[var(--color-v4-red)] text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>
          Ligações (4com)
        </button>
        <button onClick={() => setTab('sdr')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'sdr' ? 'bg-[var(--color-v4-red)] text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>
          Pré-venda (SDR)
        </button>
        <button onClick={() => setTab('closer')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'closer' ? 'bg-[var(--color-v4-red)] text-white' : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]'}`}>
          Closer
        </button>
      </div>

      {tab === 'ligacoes' && (
        <>
          {/* Period filter */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
              {(['hoje', 'semana', 'mes'] as const).map(p => (
                <button key={p} onClick={() => setLigPeriodo(p)}
                  className={`px-3 py-1.5 rounded text-xs font-medium ${ligPeriodo === p ? 'bg-[var(--color-v4-red)] text-white' : 'text-[var(--color-v4-text-muted)]'}`}>
                  {p === 'hoje' ? 'Hoje' : p === 'semana' ? '7 dias' : 'Mês'}
                </button>
              ))}
            </div>
            <span className="text-xs text-[var(--color-v4-text-muted)]">
              {totalGeral} ligações · {atendidasGeral} atendidas ({totalGeral > 0 ? ((atendidasGeral / totalGeral) * 100).toFixed(0) : 0}%)
            </span>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><Phone size={14} className="text-blue-400" /><span className="text-xs text-[var(--color-v4-text-muted)]">Total Ligações</span></div>
              <p className="text-2xl font-bold text-white">{totalGeral}</p>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><Headphones size={14} className="text-green-400" /><span className="text-xs text-[var(--color-v4-text-muted)]">Atendidas</span></div>
              <p className="text-2xl font-bold text-green-400">{atendidasGeral}</p>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><PhoneOff size={14} className="text-red-400" /><span className="text-xs text-[var(--color-v4-text-muted)]">Não Atendidas</span></div>
              <p className="text-2xl font-bold text-red-400">{totalGeral - atendidasGeral}</p>
            </div>
            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><Clock size={14} className="text-yellow-400" /><span className="text-xs text-[var(--color-v4-text-muted)]">Duração Total</span></div>
              <p className="text-2xl font-bold text-white">{fmtDuration(ligacoesFiltered.reduce((a, l) => a + (l.duration || 0), 0))}</p>
            </div>
          </div>

          {/* Per member table */}
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)]">
                  <th className="px-4 py-3">Membro</th>
                  <th className="px-4 py-3">Ramal</th>
                  <th className="px-4 py-3">Ligações</th>
                  <th className="px-4 py-3">Atendidas</th>
                  <th className="px-4 py-3">Não Atend.</th>
                  <th className="px-4 py-3">TX Atend.</th>
                  <th className="px-4 py-3">Dur. Total</th>
                  <th className="px-4 py-3">Dur. Média</th>
                </tr>
              </thead>
              <tbody>
                {ligacoesPorMembro.map(({ member, total, atendidas, naoAtendidas, duracaoTotal, duracaoMedia, txAtendimento }) => (
                  <tr key={member.id} className="border-t border-[var(--color-v4-border)]">
                    <td className="px-4 py-3 text-white font-medium">{member.name.split(' ')[0]}</td>
                    <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{member.ramal_4com || '—'}</td>
                    <td className="px-4 py-3 text-white">{total}</td>
                    <td className="px-4 py-3 text-green-400">{atendidas}</td>
                    <td className="px-4 py-3 text-red-400">{naoAtendidas}</td>
                    <td className="px-4 py-3 text-white">{txAtendimento}%</td>
                    <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{fmtDuration(duracaoTotal)}</td>
                    <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{fmtDuration(duracaoMedia)}</td>
                  </tr>
                ))}
                {ligacoesPorMembro.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--color-v4-text-muted)]">
                    Nenhum membro com ramal 4com configurado. Configure o ramal na tela de Equipe.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'sdr' && (
        <>
          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5 mb-6">
            <h3 className="text-sm font-semibold text-white mb-3">Resumo SDR</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[var(--color-v4-text-muted)]">
                  <th className="pb-2">SDR</th><th className="pb-2">Ligações</th><th className="pb-2">Reuniões Ag.</th><th className="pb-2">Realizadas</th><th className="pb-2">No-shows</th><th className="pb-2">Dias</th>
                </tr></thead>
                <tbody>
                  {sdrs.map(s => {
                    const perfs = performanceSdr.filter(p => p.member_id === s.id);
                    return (
                      <tr key={s.id} className="border-t border-[var(--color-v4-border)]">
                        <td className="py-2 text-white">{s.name.split(' ')[0]}</td>
                        <td className="py-2 text-[var(--color-v4-text-muted)]">{perfs.reduce((a, p) => a + (p.ligacoes || 0), 0)}</td>
                        <td className="py-2 text-[var(--color-v4-text-muted)]">{perfs.reduce((a, p) => a + (p.reunioes_agendadas || 0), 0)}</td>
                        <td className="py-2 text-green-400">{perfs.reduce((a, p) => a + (p.reunioes_realizadas || 0), 0)}</td>
                        <td className="py-2 text-red-400">{perfs.reduce((a, p) => a + (p.no_shows || 0), 0)}</td>
                        <td className="py-2 text-[var(--color-v4-text-muted)]">{perfs.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Registrar Performance SDR (manual)</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <select className={inputClass} value={selectedMember} onChange={e => setSelectedMember(e.target.value)}>
                <option value="">Selecionar SDR</option>
                {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <input type="date" className={inputClass} value={selectedDate} onChange={e => setSelectedDate(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              {[['ligacoes', 'Ligações'], ['ligacoes_atendidas', 'Atendidas'], ['conversas_whatsapp', 'WhatsApp'],
                ['reunioes_agendadas', 'Reuniões Ag.'], ['reunioes_realizadas', 'Realizadas'], ['no_shows', 'No-shows'], ['indicacoes_coletadas', 'Indicações'],
              ].map(([key, label]) => (
                <div key={key}>
                  <label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">{label}</label>
                  <input type="number" className={inputClass} value={(sdrForm as any)[key]} onChange={e => setSdrForm(p => ({ ...p, [key]: Number(e.target.value) }))} />
                </div>
              ))}
            </div>
            <button onClick={handleSaveSdr} disabled={!selectedMember || isProcessing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white text-sm">
              <Save size={14} /> {isProcessing ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </>
      )}

      {tab === 'closer' && (() => {
        const [cYear, cMonth] = selectedMes.split('-').map(Number);
        const cStart = new Date(cYear, cMonth - 1, 1);
        const cEnd = new Date(cYear, cMonth, 0);

        const closerStats = closers.map(closer => {
          const closerReunioes = reunioes.filter(r => {
            const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
            return dr && dr >= cStart && dr <= cEnd && r.realizada && (r.closer_id === closer.id || (r as any).closer_confirmado_id === closer.id);
          });
          const shows = closerReunioes.filter(r => r.show).length;
          const noShows = closerReunioes.filter(r => !r.show).length;

          const closerDeals = deals.filter(d => {
            const dc = d.data_fechamento ? new Date(d.data_fechamento) : d.data_call ? new Date(d.data_call) : null;
            return dc && dc >= cStart && dc <= cEnd && d.closer_id === closer.id;
          });
          const vendas = closerDeals.filter(d => d.status === 'contrato_assinado').length;
          const perdidos = closerDeals.filter(d => d.status === 'perdido').length;
          const totalDeals = closerDeals.length;

          const mrr = closerDeals.filter(d => d.status === 'contrato_assinado').reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
          const ot = closerDeals.filter(d => d.status === 'contrato_assinado').reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);
          const ticketMedio = vendas > 0 ? (mrr + ot) / vendas : 0;
          const txConversao = shows > 0 ? (vendas / shows) * 100 : 0;

          // Tempo medio de ciclo (dias entre data_call e data_fechamento)
          const ciclos = closerDeals.filter(d => d.status === 'contrato_assinado' && d.data_call && d.data_fechamento)
            .map(d => (new Date(d.data_fechamento!).getTime() - new Date(d.data_call!).getTime()) / 86400000);
          const tempoCiclo = ciclos.length > 0 ? Math.round(ciclos.reduce((a, b) => a + b, 0) / ciclos.length) : 0;

          const closerRecs = recomendacoes.filter(r => r.closer_id === closer.id && r.created_at >= cStart.toISOString() && r.created_at <= cEnd.toISOString());

          return { closer, shows, noShows, vendas, perdidos, totalDeals, mrr, ot, ticketMedio, txConversao, tempoCiclo, recsColetadas: closerRecs.length };
        });

        const fmt = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(v);

        return (
          <>
            <div className="flex items-center gap-3 mb-6">
              <input type="month" className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm" value={selectedMes} onChange={e => setSelectedMes(e.target.value)} />
              <span className="text-xs text-[var(--color-v4-text-muted)]">Calculado automaticamente dos deals e reuniões</span>
            </div>

            <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--color-v4-text-muted)] bg-[var(--color-v4-surface)]">
                    <th className="px-4 py-3">Closer</th>
                    <th className="px-4 py-3">Shows</th>
                    <th className="px-4 py-3">No-shows</th>
                    <th className="px-4 py-3">Vendas</th>
                    <th className="px-4 py-3">TX Conv.</th>
                    <th className="px-4 py-3">MRR</th>
                    <th className="px-4 py-3">OT</th>
                    <th className="px-4 py-3">Ticket Médio</th>
                    <th className="px-4 py-3">Ciclo</th>
                    <th className="px-4 py-3">Recom.</th>
                  </tr>
                </thead>
                <tbody>
                  {closerStats.map(({ closer, shows, noShows, vendas, txConversao, mrr, ot, ticketMedio, tempoCiclo, recsColetadas }) => (
                    <tr key={closer.id} className="border-t border-[var(--color-v4-border)]">
                      <td className="px-4 py-3 text-white font-medium">{closer.name.split(' ')[0]}</td>
                      <td className="px-4 py-3 text-green-400">{shows}</td>
                      <td className="px-4 py-3 text-red-400">{noShows}</td>
                      <td className="px-4 py-3 text-white font-bold">{vendas}</td>
                      <td className="px-4 py-3 text-white">{txConversao.toFixed(0)}%</td>
                      <td className="px-4 py-3 text-white">{fmt(mrr)}</td>
                      <td className="px-4 py-3 text-white">{fmt(ot)}</td>
                      <td className="px-4 py-3 text-white">{ticketMedio > 0 ? fmt(ticketMedio) : '—'}</td>
                      <td className="px-4 py-3 text-[var(--color-v4-text-muted)]">{tempoCiclo > 0 ? `${tempoCiclo}d` : '—'}</td>
                      <td className="px-4 py-3">
                        {recsColetadas > 0 ? (
                          <span className="flex items-center gap-1 text-purple-400"><Star size={12} />{recsColetadas}</span>
                        ) : <span className="text-[var(--color-v4-text-muted)]">0</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      })()}
    </div>
  );
};
