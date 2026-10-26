// Central de Cases — sugestões de cases da rede V4 parecidos com o lead (migration_160, edge central-cases).
// Passada LEVE nasce sozinha ao agendar a reunião (trigger); o closer aprofunda aqui ("Aprofundar").
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ExternalLink, Globe, Instagram, Megaphone, RefreshCw, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface CaseSugerido {
  id_cliente: number; nome: string; cidade?: string | null; uf?: string | null; status?: string | null; tier?: string | null;
  produto_origem?: string | null; lt_meses?: number | null; site?: string | null; instagram?: string | null;
  anuncios?: { ativos: number | null; url: string; nota?: string | null; confirmado?: boolean } | null; por_que?: string[]; score_final?: number;
}
export interface CasesSugestao {
  id: string; reuniao_id: string | null; lead_id: string | null; empresa: string; nicho: string | null;
  profundidade: 'leve' | 'profunda'; status: 'pendente' | 'processando' | 'concluido' | 'erro'; etapa: string | null;
  candidatos: CaseSugerido[]; erro: string | null; criado_em: string; concluido_em: string | null;
}

const ETAPA_LABEL: Record<string, string> = { base: 'buscando na base da rede…', web: 'conferindo presença digital…', anuncios: 'lendo a Biblioteca de Anúncios…', pronto: 'pronto' };

/** Dispara a geração (profunda por padrão) para um lead, com o JWT do usuário logado. */
export async function pedirCases(leadId: string, profundidade: 'leve' | 'profunda' = 'profunda'): Promise<void> {
  const { data: sess } = await supabase.auth.getSession();
  const jwt = sess?.session?.access_token;
  if (!jwt) throw new Error('faça login de novo');
  const r = await fetch(`${SUPABASE_URL}/functions/v1/central-cases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ acao: 'gerar', lead_id: leadId, profundidade }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(t.slice(0, 200) || `HTTP ${r.status}`); }
}

function useSugestoes(filtro: { leadId?: string | null; limite?: number }) {
  const [lista, setLista] = useState<CasesSugestao[]>([]);
  const [loading, setLoading] = useState(true);
  const carregar = useCallback(async () => {
    let q = supabase.from('cases_sugestoes').select('*').order('criado_em', { ascending: false }).limit(filtro.limite ?? 10);
    if (filtro.leadId) q = q.eq('lead_id', filtro.leadId);
    const { data, error } = await q;
    if (!error) setLista((data ?? []) as CasesSugestao[]);
    setLoading(false);
  }, [filtro.leadId, filtro.limite]);
  useEffect(() => {
    carregar();
    const ch = supabase.channel(`cases_sugestoes_${filtro.leadId ?? 'all'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cases_sugestoes' }, () => carregar())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [carregar, filtro.leadId]);
  // recuperação: enquanto houver sugestão em andamento, repete a leitura a cada 15 s (se o realtime falhar)
  const andamento = lista.some(s => s.status === 'pendente' || s.status === 'processando');
  useEffect(() => {
    if (!andamento) return;
    const t = setInterval(() => { carregar(); }, 15000);
    return () => clearInterval(t);
  }, [andamento, carregar]);
  return { lista, loading, recarregar: carregar };
}

const CaseCard: React.FC<{ c: CaseSugerido }> = ({ c }) => (
  <div className="rounded-lg border border-[var(--color-v4-border)] bg-[var(--color-v4-surface)] p-3 text-sm">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="font-semibold truncate" title={c.nome}>{c.nome}</div>
        <div className="text-[11px] text-[var(--color-v4-text-muted)] truncate">
          {[c.cidade, c.uf].filter(Boolean).join(' / ')}{c.status ? ` · ${c.status}` : ''}{c.tier ? ` · ${c.tier}` : ''}{c.lt_meses ? ` · LT ${c.lt_meses}m` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {c.site && <a href={c.site} target="_blank" rel="noopener" title={c.site} className="text-[var(--color-v4-text-muted)] hover:text-white"><Globe size={14} /></a>}
        {c.instagram && <a href={`https://www.instagram.com/${c.instagram}/`} target="_blank" rel="noopener" title={`@${c.instagram}`} className="text-[var(--color-v4-text-muted)] hover:text-white"><Instagram size={14} /></a>}
        {c.anuncios && (() => {
          const a = c.anuncios; const confirmado = a.confirmado !== false;
          const titulo = a.ativos == null ? (a.nota || 'Biblioteca de Anúncios (não medido)')
            : a.ativos > 0 ? (confirmado ? `${a.ativos} anúncios ativos (confirmados)` : `${a.ativos} anúncios a confirmar${a.nota ? ` — ${a.nota}` : ''}`)
            : confirmado ? 'sem anúncios ativos na Meta' : `nenhum anúncio confirmado nesta busca${a.nota ? ` — ${a.nota}` : ''}`;
          const cor = a.ativos && confirmado ? 'text-emerald-400' : a.ativos ? 'text-amber-400' : 'text-[var(--color-v4-text-muted)] hover:text-white';
          return <a href={a.url} target="_blank" rel="noopener" title={titulo} className={cor}><Megaphone size={14} /></a>;
        })()}
      </div>
    </div>
    {!!c.por_que?.length && (
      <ul className="mt-2 space-y-0.5 text-[11px] text-[var(--color-v4-text-muted)]">
        {c.por_que.slice(0, 6).map((m, i) => <li key={i}>• {m}</li>)}
      </ul>
    )}
  </div>
);

const SugestaoBloco: React.FC<{ s: CasesSugestao; compacto?: boolean }> = ({ s, compacto }) => {
  const [aberto, setAberto] = useState(!compacto);
  const andamento = s.status === 'pendente' || s.status === 'processando';
  return (
    <div className="rounded-lg border border-[var(--color-v4-border)] p-3">
      <button className="w-full flex items-center justify-between gap-2 text-left" onClick={() => setAberto(a => !a)}>
        <div className="min-w-0">
          <span className="font-medium text-sm truncate">{s.empresa}</span>
          <span className="ml-2 text-[11px] text-[var(--color-v4-text-muted)]">
            {s.profundidade === 'profunda' ? 'profunda' : 'leve'} · {andamento ? (ETAPA_LABEL[s.etapa ?? ''] ?? 'na fila…') : s.status === 'erro' ? `erro: ${s.erro ?? ''}` : `${s.candidatos?.length ?? 0} cases`}
            {s.nicho ? ` · ${s.nicho}` : ''}
          </span>
        </div>
        <span className="text-[10px] text-[var(--color-v4-text-muted)] shrink-0">{new Date(s.criado_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      </button>
      {aberto && (
        andamento ? <div className="mt-2 text-xs text-[var(--color-v4-text-muted)] flex items-center gap-2"><RefreshCw size={12} className="animate-spin" /> {ETAPA_LABEL[s.etapa ?? ''] ?? 'na fila…'}</div>
        : s.candidatos?.length ? <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">{s.candidatos.map(c => <CaseCard key={c.id_cliente} c={c} />)}</div>
        : <div className="mt-2 text-xs text-[var(--color-v4-text-muted)]">Nenhum case parecido encontrado pelo nome. Tente "Aprofundar" com o segmento preenchido no briefing.</div>
      )}
    </div>
  );
};

/** Painel por LEAD (gaveta do briefing): sugestões do lead + botão Aprofundar. */
export const CasesPanel: React.FC<{ leadId: string | null | undefined; empresa: string }> = ({ leadId, empresa }) => {
  const { lista, loading, recarregar } = useSugestoes({ leadId: leadId ?? undefined, limite: 5 });
  const [pedindo, setPedindo] = useState(false);
  const emAndamento = lista.some(s => s.status === 'pendente' || s.status === 'processando');
  const aprofundar = async () => {
    if (!leadId) return;
    setPedindo(true);
    try { await pedirCases(leadId, 'profunda'); toast.success('Aprofundando cases — acompanhe aqui'); await recarregar(); }
    catch (e: any) { toast.error(e?.message || 'não foi possível pedir'); }
    finally { setPedindo(false); }
  };
  return (
    <div className="mt-6 border-t border-[var(--color-v4-border)] pt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Sparkles size={14} /> Cases da rede parecidos com {empresa}</h3>
        <div className="flex items-center gap-2">
        <button onClick={() => { recarregar(); }} title="Atualizar" className="p-1.5 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white"><RefreshCw size={12} /></button>
        {leadId && (
          <button onClick={aprofundar} disabled={pedindo || emAndamento}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 text-white">
            <RefreshCw size={12} className={emAndamento ? 'animate-spin' : ''} /> {emAndamento ? 'processando…' : 'Aprofundar'}
          </button>
        )}
        </div>
      </div>
      {!leadId ? <p className="text-xs text-[var(--color-v4-text-muted)]">Briefing sem lead vinculado — os cases são sugeridos a partir do lead da reunião.</p>
        : loading ? <p className="text-xs text-[var(--color-v4-text-muted)]">carregando…</p>
        : lista.length === 0 ? <p className="text-xs text-[var(--color-v4-text-muted)]">Ainda sem sugestões. A passada leve nasce ao agendar a reunião; ou clique em Aprofundar.</p>
        : <div className="space-y-2">{lista.map((s, i) => <SugestaoBloco key={s.id} s={s} compacto={i > 0} />)}</div>}
    </div>
  );
};

/** Faixa no topo da aba: últimas reuniões com cases sugeridos (passada automática). */
export const CasesRecentes: React.FC = () => {
  const { lista, loading } = useSugestoes({ limite: 8 });
  if (loading || lista.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-v4-text-muted)] mb-2 flex items-center gap-2"><Sparkles size={12} /> Cases sugeridos — últimas reuniões agendadas</h3>
      <div className="space-y-2">{lista.map(s => <SugestaoBloco key={s.id} s={s} compacto />)}</div>
      <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1 flex items-center gap-1"><ExternalLink size={10} /> Abra o briefing do lead para aprofundar.</p>
    </div>
  );
};
