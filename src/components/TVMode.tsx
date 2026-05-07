// =============================================================
// TVMode — rota pública /?tv=1
// =============================================================
// 4 quadrantes fullscreen, sem auth, refresh realtime.
//   Q1: Ranking de ligações do dia (top 5)
//   Q2: Compromisso do time (todos com %)
//   Q3: Pace do mês (MRR / OT / Reuniões)
//   Q4: Atividade por hora (HourlyCallsChart)
// Overlay quando marco bate (escuta channel realtime "marcos").
// =============================================================
import React, { useEffect, useMemo, useState } from 'react';
import { Phone, Users, TrendingUp, Clock, Trophy } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { CompromissoTeamPanel } from './CompromissoTeamPanel';
import { HourlyCallsChart } from './HourlyCallsChart';
import type { TeamMember, Ligacao4com, Deal, Reuniao, Meta } from '../types';
import { calculatePace, getPacePercentage, getBusinessDaysInMonth, getBusinessDaysSoFar } from '../lib/paceUtils';

// ---------------------------------------------------------
// Hooks de dados pra TV (pega tudo via service-side queries)
// ---------------------------------------------------------
function useTVData() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [ligacoesHoje, setLigacoesHoje] = useState<Ligacao4com[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [reunioes, setReunioes] = useState<Reuniao[]>([]);
  const [metas, setMetas] = useState<Meta[]>([]);

  // Hoje BR (fuso local). UTC dava bug de virar dia antes.
  const now = new Date();
  const todayStartLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEndLocal = new Date(todayStartLocal.getTime() + 24 * 3600 * 1000);
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  useEffect(() => {
    const load = async () => {
      const [m, l, d] = await Promise.all([
        supabase.from('team_members').select('*').eq('active', true),
        supabase.from('ligacoes_4com').select('*')
          .gte('started_at', todayStartLocal.toISOString())
          .lt('started_at', todayEndLocal.toISOString()),
        // get_dashboard_data ja traz deals + reunioes + metas agregados do mes
        supabase.rpc('get_dashboard_data', { p_month: yearMonth }),
      ]);
      setMembers((m.data as TeamMember[]) || []);
      setLigacoesHoje((l.data as Ligacao4com[]) || []);
      const dashData = d.data as any;
      setDeals(dashData?.deals || []);
      setReunioes(dashData?.reunioes || []);
      setMetas(dashData?.metas || []);
    };
    load();
    const id = setInterval(load, 30000); // fallback 30s
    return () => clearInterval(id);
  }, [yearMonth]);

  // realtime subscribe pra ligacoes
  useEffect(() => {
    const ch = supabase
      .channel('tv-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ligacoes_4com' }, async () => {
        const { data } = await supabase
          .from('ligacoes_4com').select('*')
          .gte('started_at', todayStartLocal.toISOString())
          .lt('started_at', todayEndLocal.toISOString());
        setLigacoesHoje((data as Ligacao4com[]) || []);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  return { members, ligacoesHoje, deals, reunioes, metas, yearMonth, year, month };
}

// ---------------------------------------------------------
// Marco overlay
// ---------------------------------------------------------
interface Marco {
  id: string;
  texto: string;
  emoji: string;
  expira: number; // timestamp ms
}

function useMarcos() {
  const [marco, setMarco] = useState<Marco | null>(null);

  useEffect(() => {
    const ch = supabase
      .channel('marcos')
      .on('broadcast', { event: 'marco' }, (payload: any) => {
        const m: Marco = {
          id: crypto.randomUUID(),
          texto: payload.payload?.texto || '',
          emoji: payload.payload?.emoji || '🎉',
          expira: Date.now() + 4500,
        };
        setMarco(m);
        setTimeout(() => {
          setMarco((cur) => (cur && cur.id === m.id ? null : cur));
        }, 4500);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  return marco;
}

// ---------------------------------------------------------
// Component
// ---------------------------------------------------------
export const TVMode: React.FC = () => {
  const { members, ligacoesHoje, deals, reunioes, metas, yearMonth, year, month } = useTVData();
  const marco = useMarcos();

  // Ranking ligações
  const ranking = useMemo(() => {
    const byMember = new Map<string, number>();
    for (const l of ligacoesHoje) {
      if (!l.member_id) continue;
      byMember.set(l.member_id, (byMember.get(l.member_id) || 0) + 1);
    }
    return Array.from(byMember.entries())
      .map(([id, total]) => ({
        member: members.find(m => m.id === id),
        total,
        meta: members.find(m => m.id === id)?.meta_ligacoes_diaria ?? 100,
      }))
      .filter(r => r.member)
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [ligacoesHoje, members]);

  // Pace agregado — alinhado com DashboardView: filtra deals/reunioes do mes
  // antes de agregar. RPC get_dashboard_data retorna TUDO; filtro vive no client.
  const pace = useMemo(() => {
    const mesStart = new Date(year, month - 1, 1);
    const mesEnd = new Date(year, month, 0, 23, 59, 59);

    // Deals do mes: data_fechamento ou data_call dentro do mes corrente
    const dealsDoMes = deals.filter(d => {
      const dc = d.data_fechamento ? new Date(d.data_fechamento)
              : d.data_call ? new Date(d.data_call) : null;
      return dc && dc >= mesStart && dc <= mesEnd;
    });
    const dealsGanhosMes = dealsDoMes.filter(d => d.status === 'contrato_assinado');
    const realMrr = dealsGanhosMes.reduce((a, d) => a + (d.valor_recorrente || d.valor_mrr || 0), 0);
    const realOt = dealsGanhosMes.reduce((a, d) => a + (d.valor_escopo || d.valor_ot || 0), 0);

    // Reunioes do mes (realizada+show)
    const reunioesDoMes = reunioes.filter(r => {
      const dr = r.data_reuniao ? new Date(r.data_reuniao) : null;
      return dr && dr >= mesStart && dr <= mesEnd;
    });
    const realReu = reunioesDoMes.filter(r => r.realizada && r.show).length;

    const totalMetaMrr = metas.reduce((a, m) => a + (m.meta_mrr || 0), 0);
    const totalMetaOt = metas.reduce((a, m) => a + (m.meta_ot || 0), 0);
    const totalMetaReu = metas.reduce((a, m) => a + (m.meta_reunioes || 0), 0);

    const totalBiz = getBusinessDaysInMonth(year, month - 1);
    const now = new Date();
    const today = now.getFullYear() === year && now.getMonth() === month - 1 ? now.getDate() : new Date(year, month, 0).getDate();
    const bizSoFar = getBusinessDaysSoFar(year, month - 1, today);
    const pct = getPacePercentage(year, month - 1, today);

    const data = calculatePace(totalMetaMrr, totalMetaOt, totalMetaReu, realMrr, realOt, realReu, pct);
    return { ...data, bizSoFar, totalBiz, pct };
  }, [deals, reunioes, metas, year, month]);

  return (
    <div className="min-h-screen bg-black text-white p-6 flex flex-col gap-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="text-3xl font-bold tracking-tight">
            SalesHub <span className="text-[var(--color-v4-red,#ef4444)]">TV</span>
          </div>
          <div className="text-sm text-zinc-500">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}</div>
        </div>
        <div className="text-sm text-zinc-500">Dia útil {pace.bizSoFar}/{pace.totalBiz} ({Math.round(pace.pct * 100)}% do mês)</div>
      </div>

      {/* Grid 2x2 */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-4 min-h-0">
        {/* Q1 — Ranking ligações */}
        <Quadrant icon={<Phone size={28} className="text-red-400" />} title="Ranking Ligações Hoje">
          {ranking.length === 0 ? (
            <Empty text="Ninguém ligou ainda. Vai pra cima!" />
          ) : (
            <div className="space-y-3">
              {ranking.map((r, i) => {
                const pct = Math.min(100, Math.round((r.total / r.meta) * 100));
                return (
                  <div key={r.member!.id} className="flex items-center gap-3">
                    <div className={`w-10 text-3xl font-bold ${i === 0 ? 'text-yellow-400' : i === 1 ? 'text-gray-300' : i === 2 ? 'text-orange-400' : 'text-zinc-600'}`}>
                      {i + 1}º
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-2xl font-bold text-white truncate">{r.member!.name.split(' ')[0]}</div>
                      <div className="h-2 bg-zinc-800 rounded mt-1 overflow-hidden">
                        <div className={pct >= 100 ? 'bg-green-500 h-full' : pct >= 70 ? 'bg-blue-500 h-full' : pct >= 40 ? 'bg-amber-500 h-full' : 'bg-red-500 h-full'} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl font-bold text-white tabular-nums">{r.total}</div>
                      <div className="text-[11px] text-zinc-500">/ {r.meta}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Quadrant>

        {/* Q2 — Compromisso do time */}
        <Quadrant icon={<Users size={28} className="text-blue-400" />} title="Compromisso do Time">
          <div className="overflow-hidden">
            <CompromissoTeamPanel big />
          </div>
        </Quadrant>

        {/* Q3 — Pace */}
        <Quadrant icon={<TrendingUp size={28} className="text-green-400" />} title="Pace do Mês">
          <div className="flex flex-col gap-5 mt-2">
            <PaceRow label="MRR" v={pace.realizadoMrr} m={pace.metaMrr} expected={pace.expectedMrr} ok={pace.mrrOnTrack} currency />
            <PaceRow label="OT" v={pace.realizadoOt} m={pace.metaOt} expected={pace.expectedOt} ok={pace.otOnTrack} currency />
            <PaceRow label="Reuniões" v={pace.realizadoReunioes} m={pace.metaReunioes} expected={pace.expectedReunioes} ok={pace.reunioesOnTrack} />
          </div>
        </Quadrant>

        {/* Q4 — Atividade por hora */}
        <Quadrant icon={<Clock size={28} className="text-purple-400" />} title="Atividade por Hora — Hoje">
          <div className="h-full">
            <HourlyCallsChart ligacoes={ligacoesHoje} members={members} height={350} />
          </div>
        </Quadrant>
      </div>

      {/* Marco overlay */}
      {marco && <MarcoOverlay marco={marco} />}
    </div>
  );
};

const Quadrant: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode }> = ({ icon, title, children }) => (
  <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-6 flex flex-col min-h-0 overflow-hidden">
    <div className="flex items-center gap-3 mb-4 flex-shrink-0">
      {icon}
      <h2 className="text-2xl font-bold text-white">{title}</h2>
    </div>
    <div className="flex-1 overflow-auto">{children}</div>
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <div className="h-full flex items-center justify-center text-zinc-600 text-xl">{text}</div>
);

const PaceRow: React.FC<{ label: string; v: any; m: any; expected: any; ok: any; currency?: boolean }> = ({ label, v, m, expected, ok, currency }) => {
  // V e m sao numeros mas o componente recebe pace inteiro (com nomes diferentes)
  // entao normalizamos: pace.realizadoX, pace.metaX (mas chegou camuflado).
  // Como na call de cima passamos pace.mrr (que tem campos), aqui tratamos defensivo.
  const realizado = typeof v === 'number' ? v : 0;
  const meta = typeof m === 'number' ? m : 0;
  const exp = typeof expected === 'number' ? expected : 0;
  const fmt = (n: number) => currency ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(n) : String(n);
  const pct = meta > 0 ? Math.round((realizado / meta) * 100) : 0;
  const expectedPct = meta > 0 ? Math.round((exp / meta) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-zinc-400 text-base">{label}</span>
        <span className="text-base text-zinc-400">{fmt(realizado)} / <span className="text-zinc-500">{fmt(meta)}</span></span>
      </div>
      <div className="relative h-4 bg-zinc-900 rounded overflow-hidden">
        <div className={`h-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
        {expectedPct > 0 && expectedPct < 100 && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-yellow-300" style={{ left: `${expectedPct}%` }} title="Esperado pra hoje" />
        )}
      </div>
      <div className="text-xs text-zinc-500 mt-0.5">{pct}% — esperado {expectedPct}%</div>
    </div>
  );
};

const MarcoOverlay: React.FC<{ marco: Marco }> = ({ marco }) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none animate-in fade-in zoom-in duration-300">
    <div className="absolute inset-0 bg-gradient-to-br from-yellow-500/30 via-red-500/30 to-purple-500/30 backdrop-blur-md" />
    <div className="relative px-12 py-8 bg-zinc-900 border-2 border-yellow-400 rounded-3xl shadow-[0_0_80px_rgba(250,204,21,0.6)]">
      <div className="text-7xl mb-2 text-center">{marco.emoji}</div>
      <div className="text-5xl font-black text-white text-center tracking-tight">{marco.texto}</div>
    </div>
  </div>
);
