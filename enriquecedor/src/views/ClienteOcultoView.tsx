// Cliente oculto — persona de cliente (Haiku) conversa pelo WhatsApp anônimo (Evolution API) com a
// empresa do lead; a tela mostra as sessões, a conversa, as notas por critério e o parecer.
// Começa SEM número: o painel "Número" cria a instância e mostra o QR para o Gabriel conectar.
import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, MessageSquare, Play, QrCode, RefreshCw, Search, StopCircle, UserSearch } from 'lucide-react';
import type { Lead } from '../types';
import { leadsRepo } from '../lib/leadsRepo';
import { ocultoRepo, type OcultoConfig, type OcultoMensagem, type OcultoSessao } from '../lib/ocultoRepo';

const STATUS_LABEL: Record<OcultoSessao['status'], string> = { pendente: 'na fila (sem número)', enviada: 'abertura enviada', conversando: 'conversando', aguardando_followup: 'esperando follow-up', avaliando: 'avaliando (IA)', concluida: 'concluída', erro: 'erro', cancelada: 'cancelada' };
const STATUS_COR: Record<OcultoSessao['status'], string> = { pendente: 'bg-slate-700 text-slate-200', enviada: 'bg-sky-900 text-sky-200', conversando: 'bg-amber-900 text-amber-200', aguardando_followup: 'bg-violet-900 text-violet-200', avaliando: 'bg-indigo-900 text-indigo-200', concluida: 'bg-emerald-900 text-emerald-200', erro: 'bg-red-900 text-red-200', cancelada: 'bg-slate-800 text-slate-400' };
const nota = (n: number | null | undefined) => (n == null ? '—' : String(n));
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const tempo = (s?: number | null) => (s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

export function ClienteOcultoView() {
  const [config, setConfig] = useState<OcultoConfig | null>(null);
  const [sessoes, setSessoes] = useState<OcultoSessao[]>([]);
  const [sel, setSel] = useState<OcultoSessao | null>(null);
  const [msgs, setMsgs] = useState<OcultoMensagem[]>([]);
  const [loading, setLoading] = useState(true);
  const [novo, setNovo] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([ocultoRepo.config(), ocultoRepo.sessoes()]);
      setConfig(c); setSessoes(s);
      if (sel) { const atual = s.find(x => x.id === sel.id) ?? null; setSel(atual); if (atual) setMsgs(await ocultoRepo.mensagens(atual.id)); }
    } catch (e: any) { toast.error(e?.message || 'erro ao carregar'); }
    finally { setLoading(false); }
  }, [sel?.id]);
  useEffect(() => { carregar(); return ocultoRepo.assinar(() => { carregar(); }); }, [carregar]);
  useEffect(() => { if (sel) ocultoRepo.mensagens(sel.id).then(setMsgs).catch(() => setMsgs([])); else setMsgs([]); }, [sel?.id]);

  const resumo = useMemo(() => ({ abertas: sessoes.filter(s => ['pendente', 'enviada', 'conversando', 'aguardando_followup', 'avaliando'].includes(s.status)).length, concluidas: sessoes.filter(s => s.status === 'concluida').length, media: (() => { const n = sessoes.filter(s => s.notas && s.notas.final != null); return n.length ? (n.reduce((a, s) => a + (s.notas!.final as number), 0) / n.length).toFixed(1) : '—'; })() }), [sessoes]);

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold text-v4-text flex items-center gap-2"><UserSearch size={20} /> Cliente oculto</h1>
          <p className="text-sm text-v4-text-muted">Persona de cliente conversa pelo WhatsApp anônimo e avalia o atendimento: tempo de resposta, qualificação, proposta/preço, follow-up 24/48/72 h.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => carregar()} className="rounded-lg border border-v4-border p-2 text-v4-text-muted hover:text-v4-text" title="Atualizar"><RefreshCw size={14} /></button>
          <button onClick={() => setNovo(true)} className="flex items-center gap-2 rounded-lg bg-v4-red px-3 py-2 text-sm font-medium text-white hover:opacity-90"><Play size={14} /> Nova sondagem</button>
        </div>
      </div>

      <NumeroPanel config={config} onChange={carregar} />

      <div className="grid grid-cols-3 gap-3 text-sm">
        <Stat label="Em andamento" value={String(resumo.abertas)} />
        <Stat label="Concluídas" value={String(resumo.concluidas)} />
        <Stat label="Nota média" value={resumo.media} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="min-h-0 overflow-y-auto rounded-xl border border-v4-border">
          {loading ? <div className="flex items-center justify-center p-8 text-v4-text-muted"><Loader2 className="animate-spin" size={18} /></div>
            : sessoes.length === 0 ? <div className="p-8 text-center text-sm text-v4-text-muted">Nenhuma sondagem ainda. Clique em "Nova sondagem" para escolher um lead.</div>
            : sessoes.map(s => (
              <button key={s.id} onClick={() => setSel(s)} className={`flex w-full items-start justify-between gap-3 border-b border-v4-border px-3 py-2.5 text-left hover:bg-white/5 ${sel?.id === s.id ? 'bg-white/5' : ''}`}>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-v4-text">{s.empresa}</div>
                  <div className="truncate text-[11px] text-v4-text-muted">{s.nicho ?? '—'} · {s.numero_alvo} · {fmt(s.criado_em)}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS_COR[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                  {s.notas && <span className="text-xs font-semibold text-v4-text">{s.notas.final == null ? 'incompleta' : `${s.notas.final.toFixed(1)}/10`}</span>}
                </div>
              </button>
            ))}
        </div>
        <div className="min-h-0 overflow-y-auto rounded-xl border border-v4-border p-4">
          {!sel ? <div className="flex h-full items-center justify-center text-sm text-v4-text-muted"><MessageSquare size={16} className="mr-2" /> Selecione uma sondagem</div> : <SessaoDetalhe s={sel} msgs={msgs} onCancelar={async () => { try { await ocultoRepo.cancelar(sel.id); toast.success('cancelada'); carregar(); } catch (e: any) { toast.error(e?.message); } }} />}
        </div>
      </div>

      {novo && <NovaSondagem onClose={() => setNovo(false)} onCriada={() => { setNovo(false); carregar(); }} config={config} />}
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-xl border border-v4-border px-4 py-3"><div className="text-[11px] uppercase tracking-wide text-v4-text-muted">{label}</div><div className="text-lg font-semibold text-v4-text">{value}</div></div>
);

const QR_SEGUNDOS = 25;
function NumeroPanel({ config, onChange }: { config: OcultoConfig | null; onChange: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [numeroChip, setNumeroChip] = useState('');
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);          // QR auto-atualizando até 'open'
  const [restante, setRestante] = useState(QR_SEGUNDOS);
  const [estado, setEstado] = useState<string | null>(null);
  const [tentativas, setTentativas] = useState(0);
  const pedirQr = useCallback(async () => {
    const r = await ocultoRepo.instancia('qr');
    setEstado(r.estado ?? null);
    if (r.estado === 'open') { setAuto(false); setQr(null); toast.success('Conectado!'); onChange(); return; }
    if (r.qr) { setQr(r.qr); setRestante(QR_SEGUNDOS); setTentativas(t => t + 1); }
    else toast(r.nota || r.error || 'sem QR agora (instância conectando?) — tentando de novo');
  }, [onChange]);
  // (1) auto-atualização do QR a cada 25 s + (4) polling do estado a cada 5 s, até 'open'
  useEffect(() => {
    if (!auto) return;
    const tick = setInterval(() => setRestante(r => r - 1), 1000);
    const refresh = setInterval(() => { pedirQr().catch(() => {}); }, QR_SEGUNDOS * 1000);
    const poll = setInterval(async () => {
      try { const r = await ocultoRepo.instancia('estado'); setEstado(r.estado ?? null); if (r.estado === 'open') { setAuto(false); setQr(null); setPairing(null); toast.success('Número conectado!'); onChange(); } } catch { /* tenta de novo */ }
    }, 5000);
    return () => { clearInterval(tick); clearInterval(refresh); clearInterval(poll); };
  }, [auto, pedirQr, onChange]);
  const run = async (op: 'criar' | 'qr' | 'estado' | 'pairing') => {
    setBusy(true);
    try {
      if (op === 'estado') { const r = await ocultoRepo.instancia('estado'); setEstado(r.estado ?? null); toast.success(`estado: ${r.estado ?? '?'}`); onChange(); return; }
      if (op === 'pairing') {
        const r = await ocultoRepo.instancia('pairing', { numero: numeroChip });
        if (r.pairingCode) { setPairing(r.pairingCode); setQr(null); setAuto(true); toast.success('Código de pareamento gerado — digite no WhatsApp do chip'); }
        else toast(r.nota || r.error || 'sem código');
        return;
      }
      if (op === 'criar') { const r = await ocultoRepo.instancia('criar'); toast.success(r.jaExistia ? 'Instância já existia — webhook atualizado' : 'Instância criada'); if (r.qr) { setQr(r.qr); setRestante(QR_SEGUNDOS); } }
      await pedirQr();
      setAuto(true);
    } catch (e: any) { toast.error(e?.message || 'falhou'); }
    finally { setBusy(false); }
  };
  const pronto = !!config?.conectado && !!config?.ativo;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-v4-border px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${config?.conectado ? 'bg-emerald-400' : 'bg-slate-500'}`} />
        <div>
          <div className="font-medium text-v4-text">Número anônimo: {config?.conectado ? `conectado${config.numero ? ` (${config.numero})` : ''}` : 'não conectado'} · envios {config?.ativo ? 'ligados' : 'desligados'}</div>
          <div className="text-[11px] text-v4-text-muted">{pronto ? 'Sondagens novas saem na hora.' : 'Sem número conectado e ativo, as sondagens ficam na fila e saem quando o número estiver pronto (ativar: oculto_config.ativo).'}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button disabled={busy} onClick={() => run('estado')} className="rounded-lg border border-v4-border px-3 py-1.5 text-xs text-v4-text-muted hover:text-v4-text disabled:opacity-50">Ver estado</button>
        <button disabled={busy} onClick={() => run('criar')} className="rounded-lg border border-v4-border px-3 py-1.5 text-xs text-v4-text-muted hover:text-v4-text disabled:opacity-50">Criar instância</button>
        <button disabled={busy} onClick={() => run('qr')} className="flex items-center gap-1.5 rounded-lg border border-v4-border px-3 py-1.5 text-xs text-v4-text-muted hover:text-v4-text disabled:opacity-50"><QrCode size={12} /> QR code</button>
        <input value={numeroChip} onChange={e => setNumeroChip(e.target.value)} placeholder="nº do chip (DDD+número)" className="w-44 rounded-lg border border-v4-border bg-transparent px-2 py-1.5 text-xs text-v4-text" />
        <button disabled={busy || !numeroChip} onClick={() => run('pairing')} className="rounded-lg border border-v4-border px-3 py-1.5 text-xs text-v4-text-muted hover:text-v4-text disabled:opacity-50" title="Mais fácil que o QR: gera um código de 8 caracteres para digitar no WhatsApp do chip (Conectar dispositivo → Conectar com número de telefone)">Código de pareamento</button>
        {auto && <button onClick={() => setAuto(false)} className="rounded-lg px-2 py-1.5 text-xs text-v4-text-muted">parar</button>}
      </div>
      {(qr || pairing) && (
        <div className="basis-full rounded-lg border border-v4-border bg-white p-3 text-center">
          {pairing ? <div className="font-mono text-3xl tracking-widest text-black">{pairing}</div>
            : qr!.startsWith('data:image') ? <img src={qr!} alt="QR code" className="mx-auto h-56 w-56" /> : <code className="break-all text-xs text-black">{qr}</code>}
          <div className="mt-2 text-[11px] text-slate-600">
            {pairing ? 'WhatsApp → Dispositivos conectados → Conectar dispositivo → "Conectar com número de telefone" → digite o código.' : 'WhatsApp → Dispositivos conectados → Conectar dispositivo → aponte para o QR.'}
            {auto && <span className="ml-2 text-slate-500">· estado: {estado ?? '…'} · {pairing ? 'verificando a cada 5 s' : `novo QR em ${Math.max(0, restante)} s (${tentativas})`}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function SessaoDetalhe({ s, msgs, onCancelar }: { s: OcultoSessao; msgs: OcultoMensagem[]; onCancelar: () => void }) {
  const aberta = ['pendente', 'enviada', 'conversando', 'aguardando_followup', 'avaliando'].includes(s.status);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-v4-text">{s.empresa}</div>
          <div className="text-xs text-v4-text-muted">{s.nicho ?? '—'} · {s.numero_alvo} · persona: {s.persona?.contexto ?? '—'}</div>
          <div className="mt-1 text-[11px] text-v4-text-muted">início {fmt(s.iniciada_em)} · última da empresa {fmt(s.ultima_in_em)} · turnos {s.turnos_persona}/{s.max_turnos}</div>
          {s.fase && s.fase !== 'ocioso' && <div className="mt-1 text-xs text-amber-300">envio {s.fase === 'enviando' ? 'em curso' : 'incerto — reconciliando com o provedor'}</div>}
          {s.erro && <div className="mt-1 text-xs text-red-300">{s.erro}</div>}
        </div>
        {aberta && <button onClick={onCancelar} className="flex items-center gap-1 rounded-lg border border-v4-border px-2.5 py-1.5 text-xs text-v4-text-muted hover:text-red-300"><StopCircle size={12} /> cancelar</button>}
      </div>
      {s.notas && (
        <div className="rounded-lg border border-v4-border p-3">
          <div className="mb-2 flex items-center justify-between"><span className="text-sm font-medium text-v4-text">Nota final{s.notas.incompleta ? ' (incompleta: IA indisponível)' : ''}</span><span className="text-xl font-bold text-v4-text">{s.notas.final == null ? '—' : s.notas.final.toFixed(1)}<span className="text-xs text-v4-text-muted">/10</span></span></div>
          <div className="grid grid-cols-5 gap-2 text-center text-[11px]">
            {([['tempo_resposta', 'Tempo'], ['qualificacao', 'Qualificação'], ['proposta_preco', 'Proposta/preço'], ['followup', 'Follow-up'], ['tom', 'Tom']] as const).map(([k, l]) => (
              <div key={k} className="rounded bg-white/5 p-2"><div className="text-v4-text-muted">{l}</div><div className="text-sm font-semibold text-v4-text">{nota(s.notas![k])}</div></div>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-v4-text-muted">1ª resposta em {tempo(s.metricas?.tempo_primeira_resposta_s)} · follow-up {s.metricas?.followup_24h ? '24 h' : s.metricas?.followup_48h ? '48 h' : s.metricas?.followup_72h ? '72 h' : 'nenhum'}</div>
          {s.parecer && <p className="mt-2 text-sm text-v4-text">{s.parecer}</p>}
          {(s.avaliacao_ia?.pontos_fortes?.length || s.avaliacao_ia?.pontos_fracos?.length) ? (
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <div><div className="text-emerald-300">Pontos fortes</div><ul>{(s.avaliacao_ia?.pontos_fortes ?? []).map((p, i) => <li key={i}>• {p}</li>)}</ul></div>
              <div><div className="text-amber-300">Pontos fracos</div><ul>{(s.avaliacao_ia?.pontos_fracos ?? []).map((p, i) => <li key={i}>• {p}</li>)}</ul></div>
            </div>
          ) : null}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {msgs.length === 0 && <div className="text-xs text-v4-text-muted">{s.status === 'pendente' ? 'Abertura ainda não enviada (sem número conectado).' : 'Sem mensagens.'}</div>}
        {msgs.map(m => (
          <div key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.direcao === 'out' ? 'self-end bg-emerald-900/60 text-emerald-50' : 'self-start bg-white/10 text-v4-text'}`}>
            <div>{m.texto}</div>
            <div className="mt-0.5 text-[10px] opacity-60">{m.direcao === 'out' ? 'cliente (persona)' : 'empresa'} · {fmt(m.em)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NovaSondagem({ onClose, onCriada, config }: { onClose: () => void; onCriada: () => void; config: OcultoConfig | null }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [busca, setBusca] = useState('');
  const [lead, setLead] = useState<Lead | null>(null);
  const [numero, setNumero] = useState('');
  const [nicho, setNicho] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { leadsRepo.list().then(setLeads).catch(() => setLeads([])); }, []);
  const opcoes = useMemo(() => { const q = busca.toLowerCase(); return leads.filter(l => !q || (l.nomeFantasia ?? l.razaoSocial ?? '').toLowerCase().includes(q)).slice(0, 15); }, [leads, busca]);
  const escolher = (l: Lead) => { setLead(l); setBusca(l.nomeFantasia ?? l.razaoSocial ?? ''); setNumero(l.phoneRaw ?? l.googleBusiness?.phone ?? ''); setNicho(l.segmento ?? ''); };
  const criar = async () => {
    if (!lead) return;
    setBusy(true);
    try {
      const r = await ocultoRepo.iniciar(lead.id, numero || undefined, nicho || undefined);
      toast.success(r.status === 'pendente' ? 'Sondagem na fila (sem número conectado)' : r.status === 'erro' ? 'Sondagem criada, mas o envio falhou (veja o erro na lista)' : 'Abertura enviada');
      onCriada();
    } catch (e: any) { toast.error(e?.message || 'falhou'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-v4-border bg-v4-surface p-5" onClick={e => e.stopPropagation()}>
        <h2 className="mb-3 text-base font-semibold text-v4-text">Nova sondagem (cliente oculto)</h2>
        {!config?.conectado && <p className="mb-3 rounded bg-amber-900/40 p-2 text-xs text-amber-200">Sem número conectado: a sondagem fica na fila e a abertura sai quando o número estiver pronto.</p>}
        <label className="text-xs text-v4-text-muted">Lead</label>
        <div className="relative mb-3">
          <Search size={14} className="absolute left-2 top-2.5 text-v4-text-muted" />
          <input value={busca} onChange={e => { setBusca(e.target.value); setLead(null); }} placeholder="buscar pelo nome" className="w-full rounded-lg border border-v4-border bg-transparent py-2 pl-7 pr-2 text-sm text-v4-text" />
          {!lead && busca && <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-v4-border bg-v4-surface">{opcoes.map(l => <button key={l.id} onClick={() => escolher(l)} className="block w-full px-3 py-1.5 text-left text-sm hover:bg-white/5">{l.nomeFantasia ?? l.razaoSocial} <span className="text-[11px] text-v4-text-muted">· {l.cidade ?? ''} {l.uf ?? ''}</span></button>)}</div>}
        </div>
        <label className="text-xs text-v4-text-muted">WhatsApp da empresa (telefone do lead / Google Business)</label>
        <input value={numero} onChange={e => setNumero(e.target.value)} placeholder="(11) 99999-9999" className="mb-3 w-full rounded-lg border border-v4-border bg-transparent px-2 py-2 text-sm text-v4-text" />
        <label className="text-xs text-v4-text-muted">Nicho (define a persona)</label>
        <input value={nicho} onChange={e => setNicho(e.target.value)} placeholder="ex.: odontologia, imobiliária, academia" className="mb-4 w-full rounded-lg border border-v4-border bg-transparent px-2 py-2 text-sm text-v4-text" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-v4-border px-3 py-2 text-sm text-v4-text-muted">cancelar</button>
          <button disabled={!lead || !numero || busy} onClick={criar} className="flex items-center gap-2 rounded-lg bg-v4-red px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} iniciar</button>
        </div>
      </div>
    </div>
  );
}
