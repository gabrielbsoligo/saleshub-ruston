// Cadência SDNA — painel "Modelos & Canal". Por qual número (canal do Kommo) a cadência sai,
// quanto já saiu nas últimas 24 h (limite da Meta) e, por modelo, se ele está pronto NESSE
// número: modelo aprovado pela Meta no canal + Salesbot vinculado. Trocar de número ou de
// modelo passa a ser: copiar no Kommo → cadastrar/ativar o canal aqui → vincular os bots.
// Quem decide: gestor (os demais só veem). Nada aqui mexe no Kommo.
import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { CheckCircle2, CircleAlert, Download, Link2, Loader2, Phone, RefreshCw, Send, Unlink } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { cadenciaPainel, estadoModelo, type CanalCadencia, type ModeloCadencia, type PainelCadencia, type ResultadoSync, type Sinal } from '../lib/cadenciaPainel';

const SINAL_COR: Record<Sinal, string> = { verde: 'bg-emerald-500', amarelo: 'bg-amber-400', vermelho: 'bg-red-500', cinza: 'bg-slate-500' };
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const curto = (nome: string) => nome.replace(/^sdna_p\d_/, '').replace(/_/g, ' ');
const inputCls = 'rounded-md border border-v4-border bg-v4-surface px-2 py-1 text-xs text-v4-text';
const btnCls = 'rounded-md border border-v4-border px-2 py-1 text-xs text-v4-text-muted hover:text-v4-text disabled:opacity-40';

export function CadenciaPainelView() {
  const { profile } = useAuth();
  const gestor = profile?.role === 'admin';
  const [dados, setDados] = useState<PainelCadencia | null>(null);
  const [sync, setSync] = useState<ResultadoSync | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try { setDados(await cadenciaPainel.carregar()); } catch (e: any) { toast.error(e?.message || 'erro ao carregar'); }
    finally { setCarregando(false); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  // Executa uma ação de gestor e recarrega; um rótulo por vez trava os botões.
  const agir = async (rotulo: string, fn: () => Promise<unknown>, ok?: string) => {
    setOcupado(rotulo);
    try {
      const r: any = await fn();
      if (r?.canais && Array.isArray(r.canais) && r.canais[0]?.vinculos) setSync(r as ResultadoSync);
      if (ok) toast.success(ok);
      await carregar();
    } catch (e: any) { toast.error(e?.message || 'falhou'); }
    finally { setOcupado(null); }
  };

  const canalAtivo = dados?.canais.find((c) => c.ativo)?.source_id ?? null;
  const sugestoes = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of sync?.canais ?? []) if (c.canal === canalAtivo) for (const v of c.vinculos) if (v.sugestao) m.set(v.nome, v.sugestao);
    return m;
  }, [sync, canalAtivo]);
  const semVinculo = useMemo(() => new Map((sync?.canais.find((c) => c.canal === canalAtivo)?.sem_vinculo ?? []).map((x) => [x.nome, x])), [sync, canalAtivo]);

  if (carregando) return <div className="flex h-full items-center justify-center text-v4-text-muted"><Loader2 className="animate-spin" size={18} /></div>;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-xl font-semibold text-v4-text"><Send size={20} /> Cadência · Modelos &amp; Canal</h1>
          <p className="text-sm text-v4-text-muted">Por qual número a cadência sai e quais modelos estão prontos nele (aprovados pela Meta nesse número + bot vinculado).</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => carregar()} className="rounded-lg border border-v4-border p-2 text-v4-text-muted hover:text-v4-text" title="Atualizar"><RefreshCw size={14} /></button>
          {gestor && (
            <button disabled={!!ocupado} onClick={() => agir('sync', () => cadenciaPainel.sincronizar(), 'conferido no Kommo')} className="flex items-center gap-2 rounded-lg bg-v4-red px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
              {ocupado === 'sync' ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />} Conferir no Kommo
            </button>
          )}
        </div>
      </div>

      {!gestor && <p className="rounded-lg border border-v4-border p-2 text-xs text-v4-text-muted">Só gestor altera. Você está vendo o estado atual.</p>}

      <Canais dados={dados} gestor={gestor} ocupado={ocupado} agir={agir} />

      {[1, 2, 3].map((passo) => (
        <div key={passo} className="rounded-xl border border-v4-border">
          <div className="border-b border-v4-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Passo {passo}</div>
          {(dados?.modelos ?? []).filter((m) => m.passo === passo).map((m) => (
            <LinhaModelo key={m.id} m={m} dados={dados!} canalAtivo={canalAtivo} gestor={gestor} ocupado={ocupado} agir={agir}
              sugestao={sugestoes.get(m.nome) ?? null} candidato={semVinculo.get(m.nome)?.kommo_template_id ?? null} />
          ))}
        </div>
      ))}

      {gestor && <Importar ocupado={ocupado} agir={agir} />}

      <p className="text-[11px] text-v4-text-disabled">
        Verde = pronto no número ativo · amarelo = sem vínculo, sai pelo bot antigo (número não conferido) · vermelho = não sai · cinza = inativo.
        "Conferir no Kommo" relê a aprovação de cada modelo vinculado e se o bot existe/está ativo; não troca modelo nem bot sozinho.
        Se um número está mesmo conectado, o Kommo só mostra na tela dele — marque aqui depois de olhar.
      </p>
    </div>
  );
}

type Agir = (rotulo: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function Canais({ dados, gestor, ocupado, agir }: { dados: PainelCadencia | null; gestor: boolean; ocupado: string | null; agir: Agir }) {
  const [novo, setNovo] = useState({ source_id: '', nome: '', telefone: '' });
  const semCanal = dados?.volume24h?.sem_canal ?? 0;
  return (
    <div className="rounded-xl border border-v4-border p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Números (canais do Kommo)</p>
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {(dados?.canais ?? []).map((c) => <CartaoCanal key={c.source_id} c={c} volume={dados?.volume24h?.[String(c.source_id)] ?? 0} gestor={gestor} ocupado={ocupado} agir={agir} />)}
        {!dados?.canais.length && <p className="text-sm text-v4-text-muted">Nenhum número cadastrado: a cadência usa só os bots antigos.</p>}
      </div>
      {semCanal > 0 && <p className="mt-2 text-[11px] text-v4-text-muted">{semCanal} conversa(s) nas últimas 24 h saíram pelo caminho antigo, sem número registrado.</p>}
      {gestor && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-28`} placeholder="id do canal" value={novo.source_id} onChange={(e) => setNovo({ ...novo, source_id: e.target.value.replace(/\D/g, '') })} />
          <input className={`${inputCls} w-48`} placeholder="nome" value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} />
          <input className={`${inputCls} w-28`} placeholder="final do número" value={novo.telefone} onChange={(e) => setNovo({ ...novo, telefone: e.target.value })} />
          <button className={btnCls} disabled={!novo.source_id || !!ocupado} onClick={() => agir('canal-novo', () => cadenciaPainel.canal({ source_id: Number(novo.source_id), nome: novo.nome || null, telefone: novo.telefone || null }), 'número cadastrado').then(() => setNovo({ source_id: '', nome: '', telefone: '' }))}>Cadastrar número</button>
        </div>
      )}
    </div>
  );
}

function CartaoCanal({ c, volume, gestor, ocupado, agir }: { c: CanalCadencia; volume: number; gestor: boolean; ocupado: string | null; agir: Agir }) {
  const pct = c.limite_24h ? Math.min(100, Math.round((volume / c.limite_24h) * 100)) : 0;
  const cor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-emerald-500';
  const k = `canal-${c.source_id}`;
  return (
    <div className={`rounded-lg border p-3 ${c.ativo ? 'border-emerald-600' : 'border-v4-border'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1 truncate text-sm font-medium text-v4-text"><Phone size={13} /> {c.nome ?? 'sem nome'}</div>
          <div className="text-[11px] text-v4-text-muted">canal {c.source_id}{c.telefone ? ` · ${c.telefone}` : ''}</div>
        </div>
        {c.ativo && <span className="rounded-full bg-emerald-900 px-2 py-0.5 text-[10px] text-emerald-200">em uso</span>}
      </div>
      <div className="mt-2 text-[11px] text-v4-text-muted">
        Conectado: {c.vivo == null ? 'não conferido' : c.vivo ? 'sim' : 'NÃO'} · conferido {fmt(c.verificado_em)}
      </div>
      <div className="mt-2">
        <div className="flex justify-between text-[11px] text-v4-text-muted"><span>Conversas 24 h</span><span>{volume} / {c.limite_24h}</span></div>
        <div className="mt-1 h-1.5 rounded bg-white/10"><div className={`h-1.5 rounded ${cor}`} style={{ width: `${pct}%` }} /></div>
      </div>
      {gestor && (
        <div className="mt-2 flex flex-wrap gap-1">
          {!c.ativo && <button className={btnCls} disabled={!!ocupado} onClick={() => { if (confirm(`A cadência passa a sair pelo canal ${c.source_id}. Os modelos sem vínculo nele voltam ao bot antigo. Confirmar?`)) agir(k, () => cadenciaPainel.canal({ source_id: c.source_id, ativo: true }), 'número em uso trocado'); }}>Usar este número</button>}
          <button className={btnCls} disabled={!!ocupado} onClick={() => agir(k, () => cadenciaPainel.canal({ source_id: c.source_id, vivo: c.vivo !== true }))}>{c.vivo === true ? 'Marcar desconectado' : 'Marcar conectado'}</button>
          <button className={btnCls} disabled={!!ocupado} onClick={() => { const n = prompt('Limite de conversas por 24 h (Meta)', String(c.limite_24h)); if (n != null && /^\d+$/.test(n.trim())) agir(k, () => cadenciaPainel.canal({ source_id: c.source_id, limite_24h: Number(n) })); }}>Limite</button>
        </div>
      )}
    </div>
  );
}

function LinhaModelo({ m, dados, canalAtivo, gestor, ocupado, agir, sugestao, candidato }: {
  m: ModeloCadencia; dados: PainelCadencia; canalAtivo: number | null; gestor: boolean; ocupado: string | null; agir: Agir; sugestao: string | null; candidato: string | null;
}) {
  const est = estadoModelo(m, canalAtivo, dados.vinculos);
  const [bot, setBot] = useState(String(est.vinculo?.kommo_bot_id ?? ''));
  useEffect(() => { setBot(String(est.vinculo?.kommo_bot_id ?? '')); }, [est.vinculo?.kommo_bot_id]);
  const k = `modelo-${m.id}`;
  const vincular = (extra: { bot_id?: number | null; kommo_template_id?: string | null }, ok: string) =>
    canalAtivo != null && agir(k, () => cadenciaPainel.vincular({ template: m.nome, source_id: canalAtivo, ...extra }), ok);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-v4-border px-3 py-2 last:border-b-0">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${SINAL_COR[est.sinal]}`} title={est.texto} />
      <div className="min-w-[220px] flex-1">
        <div className="text-sm text-v4-text">{curto(m.nome)}{m.padrao ? <span className="ml-1 text-[10px] text-emerald-300">padrão{m.cidades?.length ? ` · ${m.cidades.join(', ')}` : ''}</span> : null}</div>
        <div className="text-[11px] text-v4-text-muted">{est.texto}{est.vinculo?.kommo_template_id ? ` · modelo Kommo ${est.vinculo.kommo_template_id}` : ''}{est.vinculo?.verificado_em ? ` · conferido ${fmt(est.vinculo.verificado_em)}` : ''}</div>
        {(sugestao || (!est.vinculo && candidato)) && (
          <div className="flex items-center gap-1 text-[11px] text-amber-300"><CircleAlert size={11} />
            {sugestao ? `há cópia aprovada ${sugestao} neste número` : `existe cópia ${candidato} neste número, sem vínculo`}
            {gestor && <button className="underline" disabled={!!ocupado} onClick={() => vincular({ kommo_template_id: sugestao ?? candidato }, 'modelo do Kommo trocado — confira o bot')}>usar</button>}
          </div>
        )}
      </div>
      {gestor && canalAtivo != null && (
        <div className="flex items-center gap-1">
          <input className={`${inputCls} w-24`} placeholder="id do bot" value={bot} onChange={(e) => setBot(e.target.value.replace(/\D/g, ''))} />
          <button className={btnCls} disabled={!!ocupado || bot === String(est.vinculo?.kommo_bot_id ?? '')} onClick={() => vincular({ bot_id: bot ? Number(bot) : null, ...(est.vinculo ? {} : { kommo_template_id: candidato }) }, 'bot vinculado')} title="Confirme no Kommo que este bot manda este modelo por este número"><Link2 size={12} /></button>
          {est.vinculo && <button className={btnCls} disabled={!!ocupado} onClick={() => { if (confirm('Tirar o vínculo? O modelo volta ao bot antigo.')) agir(k, () => cadenciaPainel.desvincular(m.nome, canalAtivo), 'vínculo removido'); }} title="Tirar vínculo"><Unlink size={12} /></button>}
        </div>
      )}
      {gestor && (
        <div className="flex items-center gap-1">
          <button className={btnCls} disabled={!!ocupado} onClick={() => agir(k, () => cadenciaPainel.modelo({ nome: m.nome, ativo: !m.ativo }))}>{m.ativo ? 'Desativar' : 'Ativar'}</button>
          <button className={btnCls} disabled={!!ocupado} onClick={() => agir(k, () => cadenciaPainel.modelo({ nome: m.nome, padrao: !m.padrao }))}>{m.padrao ? 'Tirar padrão' : 'Tornar padrão'}</button>
          {m.passo === 1 && <button className={btnCls} disabled={!!ocupado} onClick={() => { const c = prompt('Cidades em que é o padrão (separe por vírgula; vazio = geral)', (m.cidades ?? []).join(', ')); if (c != null) agir(k, () => cadenciaPainel.modelo({ nome: m.nome, cidades: c.split(',').map((x) => x.trim()).filter(Boolean) })); }}>Cidades</button>}
        </div>
      )}
    </div>
  );
}

function Importar({ ocupado, agir }: { ocupado: string | null; agir: Agir }) {
  const [nome, setNome] = useState('');
  const [passo, setPasso] = useState(1);
  return (
    <div className="rounded-xl border border-v4-border p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Trazer modelo novo do Kommo</p>
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} w-72`} placeholder="nome exato do modelo no Kommo" value={nome} onChange={(e) => setNome(e.target.value)} />
        <select className={inputCls} value={passo} onChange={(e) => setPasso(Number(e.target.value))}>{[1, 2, 3].map((p) => <option key={p} value={p}>Passo {p}</option>)}</select>
        <button className={`${btnCls} flex items-center gap-1`} disabled={!nome.trim() || !!ocupado} onClick={() => agir('importar', () => cadenciaPainel.importar(nome.trim(), passo), 'importado (inativo): vincule o bot e ative').then(() => setNome(''))}><Download size={12} /> Importar</button>
      </div>
      <p className="mt-1 text-[11px] text-v4-text-muted">O corpo vem do Kommo e as variáveis viram as do hub pelos campos CAD. Entra inativo.</p>
    </div>
  );
}
