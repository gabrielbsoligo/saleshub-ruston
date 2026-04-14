import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import {
  type AuditoriaKommoSnapshot,
  type AuditoriaRegistro,
  type AuditoriaSessao,
  type AuditoriaSeveridade,
  type BridgeToken,
  type Deal,
  type Lead,
} from '../types';
import {
  getKommoLeadIdFromItem,
  getResponsavelId,
  snapshotDeal,
  snapshotLead,
} from '../lib/auditoriaSnapshot';
import { gerarMensagemConsolidada } from '../lib/auditoriaWhatsApp';
import toast from 'react-hot-toast';
import {
  ArrowLeft, ArrowRight, Check, ClipboardCopy, ExternalLink,
  KeyRound, Loader2, Plus, SkipForward, Trash2, X,
} from 'lucide-react';
import { cn } from './Layout';

// =============================================
// AuditoriaView — tela mestre
// =============================================

type Mode =
  | { kind: 'list' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'setup' }
  | { kind: 'resumo'; sessionId: string };

export const AuditoriaView: React.FC = () => {
  const { currentUser } = useAppStore();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });

  if (!currentUser || currentUser.role !== 'gestor') {
    return <div className="p-8 text-slate-400">Acesso restrito a gestores.</div>;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {mode.kind === 'list' && (
        <SessionsList
          onOpen={(id) => setMode({ kind: 'session', sessionId: id })}
          onSetup={() => setMode({ kind: 'setup' })}
        />
      )}
      {mode.kind === 'setup' && (
        <BridgeSetup onBack={() => setMode({ kind: 'list' })} />
      )}
      {mode.kind === 'session' && (
        <SessionRunner
          sessionId={mode.sessionId}
          onClose={() => setMode({ kind: 'list' })}
          onConcluir={(id) => setMode({ kind: 'resumo', sessionId: id })}
        />
      )}
      {mode.kind === 'resumo' && (
        <SessionResumo
          sessionId={mode.sessionId}
          onBack={() => setMode({ kind: 'list' })}
        />
      )}
    </div>
  );
};

// ---------------------------------------------
// SessionsList
// ---------------------------------------------
const SessionsList: React.FC<{
  onOpen: (sessionId: string) => void;
  onSetup: () => void;
}> = ({ onOpen, onSetup }) => {
  const [sessoes, setSessoes] = useState<AuditoriaSessao[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const fetchSessoes = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('auditoria_sessoes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) toast.error('Erro: ' + error.message);
    else setSessoes(data as AuditoriaSessao[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchSessoes(); }, [fetchSessoes]);

  const handleCreateEmpty = async () => {
    if (creating) return;
    setCreating(true);
    const nome = `Auditoria ${new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    const { data, error } = await supabase
      .from('auditoria_sessoes')
      .insert({ nome, origem: 'manual', criado_por: (await getMemberId()) })
      .select('id')
      .single();
    setCreating(false);
    if (error) { toast.error(error.message); return; }
    onOpen(data.id);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-v4-border)] flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Auditoria</h1>
          <p className="text-sm text-[var(--color-v4-text-muted)] mt-1">Fila de auditoria de leads/negociações com bridge Kommo.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onSetup} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white border border-[var(--color-v4-border)] flex items-center gap-2">
            <KeyRound size={14} /> Bridge / Token
          </button>
          <button onClick={handleCreateEmpty} disabled={creating} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-red)] hover:opacity-90 text-white flex items-center gap-2 disabled:opacity-50">
            <Plus size={14} /> Nova sessão
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {loading && <div className="text-slate-400 flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Carregando…</div>}
        {!loading && sessoes.length === 0 && <div className="text-slate-400">Nenhuma sessão. Use "Auditar" no LeadsView/PipelineView.</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {sessoes.map(s => (
            <button key={s.id} onClick={() => onOpen(s.id)} className="text-left p-4 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] transition-colors">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-white">{s.nome}</span>
                <StatusBadge status={s.status} />
              </div>
              <div className="text-xs text-slate-400 space-y-1">
                <div>Itens: {s.total_itens} (✓ {s.total_auditados} · ⤳ {s.total_skipados})</div>
                <div>{new Date(s.created_at).toLocaleString('pt-BR')}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const map: Record<string, string> = {
    aberta: 'bg-blue-500/20 text-blue-300',
    concluida: 'bg-green-500/20 text-green-300',
    arquivada: 'bg-slate-600/30 text-slate-300',
  };
  return <span className={cn('text-[10px] px-2 py-0.5 rounded-full', map[status] || 'bg-slate-600/30')}>{status}</span>;
};

async function getMemberId(): Promise<string> {
  const { data } = await supabase.rpc('get_member_id');
  return data as string;
}

// ---------------------------------------------
// BridgeSetup
// ---------------------------------------------
const BridgeSetup: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [tokens, setTokens] = useState<BridgeToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('bridge_tokens').select('*').order('created_at', { ascending: false });
    if (error) toast.error(error.message);
    else setTokens(data as BridgeToken[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  const handleCreate = async () => {
    setCreating(true);
    const memberId = await getMemberId();
    const token = 'br_' + crypto.getRandomValues(new Uint8Array(32)).reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    const { error } = await supabase.from('bridge_tokens').insert({ team_member_id: memberId, token, label: label || `bridge ${new Date().toLocaleDateString('pt-BR')}` });
    setCreating(false);
    if (error) { toast.error(error.message); return; }
    setLabel('');
    fetchTokens();
    toast.success('Token criado.');
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Revogar este token?')) return;
    const { error } = await supabase.from('bridge_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) toast.error(error.message);
    else { toast.success('Revogado'); fetchTokens(); }
  };

  const userscriptUrl = `${window.location.origin}/kommo-bridge.user.js`;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-v4-border)] flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded hover:bg-[var(--color-v4-card-hover)] text-white"><ArrowLeft size={18} /></button>
        <h1 className="text-xl font-display font-bold text-white">Bridge Kommo — Setup</h1>
      </div>
      <div className="flex-1 overflow-auto p-6 space-y-6">
        <section className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)]">
          <h2 className="font-medium text-white mb-3">1. Instalar Tampermonkey</h2>
          <p className="text-sm text-slate-400 mb-3">Instale <a className="text-[var(--color-v4-red)] underline" target="_blank" rel="noreferrer" href="https://www.tampermonkey.net/">Tampermonkey</a> no navegador.</p>
          <h2 className="font-medium text-white mb-2">2. Instalar userscript</h2>
          <div className="flex items-center gap-2 mb-2">
            <a href={userscriptUrl} target="_blank" rel="noreferrer" className="text-sm text-[var(--color-v4-red)] underline break-all">{userscriptUrl}</a>
            <button onClick={() => { navigator.clipboard.writeText(userscriptUrl); toast.success('Copiado'); }} className="text-xs px-2 py-1 bg-[var(--color-v4-card-hover)] rounded text-white"><ClipboardCopy size={12} /></button>
          </div>
        </section>
        <section className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)]">
          <h2 className="font-medium text-white mb-3">3. Tokens</h2>
          <div className="flex gap-2 mb-4">
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (ex: meu notebook)" className="flex-1 px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-sm" />
            <button onClick={handleCreate} disabled={creating} className="px-3 py-2 bg-[var(--color-v4-red)] text-white rounded text-sm flex items-center gap-2 disabled:opacity-50"><Plus size={14} /> Gerar</button>
          </div>
          {loading ? <div className="text-slate-400 text-sm">Carregando…</div> : (
            <ul className="space-y-2">
              {tokens.map(t => (
                <li key={t.id} className={cn('p-3 rounded border border-[var(--color-v4-border)] flex items-center justify-between', t.revoked_at && 'opacity-50')}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white font-medium truncate">{t.label || 'sem label'}</div>
                    <div className="text-xs text-slate-400 font-mono break-all">{t.token}</div>
                  </div>
                  <div className="flex gap-2 ml-2">
                    <button onClick={() => { navigator.clipboard.writeText(t.token); toast.success('Copiado'); }} className="text-xs p-2 bg-[var(--color-v4-card-hover)] rounded text-white"><ClipboardCopy size={12} /></button>
                    {!t.revoked_at && <button onClick={() => handleRevoke(t.id)} className="text-xs p-2 bg-red-500/20 hover:bg-red-500/40 rounded text-red-300"><Trash2 size={12} /></button>}
                  </div>
                </li>
              ))}
              {tokens.length === 0 && <li className="text-slate-400 text-sm">Nenhum token.</li>}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

// ---------------------------------------------
// SessionRunner — layout side-by-side
// Esquerda: iframe Kommo | Direita: form auditoria compacto
// ---------------------------------------------
const SessionRunner: React.FC<{
  sessionId: string;
  onClose: () => void;
  onConcluir: (sessionId: string) => void;
}> = ({ sessionId, onClose, onConcluir }) => {
  const { leads, deals, members, reunioes } = useAppStore();
  const [sessao, setSessao] = useState<AuditoriaSessao | null>(null);
  const [registros, setRegistros] = useState<AuditoriaRegistro[]>([]);
  const [posicao, setPosicao] = useState(0);
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const popupRef = useRef<Window | null>(null);

  // Form state
  const [observacao, setObservacao] = useState('');
  const [severidade, setSeveridade] = useState<AuditoriaSeveridade | ''>('');
  const [motivoSkip, setMotivoSkip] = useState('');
  const [saving, setSaving] = useState(false);

  // Fetch
  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: s, error: e1 }, { data: r, error: e2 }] = await Promise.all([
      supabase.from('auditoria_sessoes').select('*').eq('id', sessionId).single(),
      supabase.from('auditoria_registros').select('*').eq('sessao_id', sessionId).order('posicao', { ascending: true }),
    ]);
    if (e1) toast.error(e1.message);
    if (e2) toast.error(e2.message);
    setSessao(s as AuditoriaSessao | null);
    setRegistros((r as AuditoriaRegistro[]) || []);
    const idx = ((r as AuditoriaRegistro[]) || []).findIndex(reg => reg.status === 'pendente');
    setPosicao(idx >= 0 ? idx : 0);
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const registroAtual = registros[posicao];

  const itemAtual = useMemo(() => {
    if (!registroAtual) return null;
    if (registroAtual.item_tipo === 'lead') return leads.find(l => l.id === registroAtual.item_id) || null;
    return deals.find(d => d.id === registroAtual.item_id) || null;
  }, [registroAtual, leads, deals]);

  const snapshotSaleshub = useMemo(() => {
    if (!itemAtual || !registroAtual) return null;
    return registroAtual.item_tipo === 'lead'
      ? snapshotLead(itemAtual as Lead, members, reunioes, deals)
      : snapshotDeal(itemAtual as Deal, members, reunioes, leads);
  }, [itemAtual, registroAtual, members, reunioes, deals, leads]);

  const responsavelId = snapshotSaleshub ? getResponsavelId(snapshotSaleshub) : undefined;
  const responsavel = responsavelId ? members.find(m => m.id === responsavelId) : null;

  // Reset form ao trocar item
  useEffect(() => {
    setObservacao(registroAtual?.observacao || '');
    setSeveridade((registroAtual?.severidade as any) || '');
    setMotivoSkip(registroAtual?.motivo_skip || '');
  }, [registroAtual?.id]);

  // Navegar Kommo automaticamente ao trocar item
  const navigateKommo = useCallback((item: Lead | Deal | null) => {
    const link = (item as any)?.kommo_link;
    if (!link) return;
    // Tenta postMessage pro popup/tab com bridge
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.postMessage({ source: 'saleshub', action: 'goto', kommoUrl: link }, '*');
      popupRef.current.focus();
    } else {
      // Abre popup nova
      popupRef.current = window.open(link, 'kommo-audit', 'width=1100,height=900');
    }
  }, []);

  // Ao mudar posição, navega Kommo
  useEffect(() => {
    if (itemAtual) navigateKommo(itemAtual);
  }, [itemAtual?.id]);

  // Navegação
  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= registros.length) return;
    setPosicao(idx);
  }, [registros.length]);

  const next = () => goTo(posicao + 1);
  const prev = () => goTo(posicao - 1);

  // Atalhos teclado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Persistir
  const persistRegistro = async (patch: Partial<AuditoriaRegistro>) => {
    if (!registroAtual) return false;
    setSaving(true);
    const { error } = await supabase.from('auditoria_registros').update(patch).eq('id', registroAtual.id);
    setSaving(false);
    if (error) { toast.error(error.message); return false; }
    setRegistros(rs => rs.map(r => r.id === registroAtual.id ? { ...r, ...patch } as AuditoriaRegistro : r));
    return true;
  };

  const handleSave = async (avancar = true) => {
    if (!registroAtual || !snapshotSaleshub) return;
    if (!observacao.trim()) { toast.error('Adicione uma observação.'); return; }
    const ok = await persistRegistro({
      status: 'auditado',
      observacao,
      severidade: (severidade || null) as any,
      responsavel_id: responsavelId || null as any,
      snapshot_saleshub: snapshotSaleshub as any,
      auditado_em: new Date().toISOString(),
    });
    if (ok) {
      toast.success('Salvo');
      if (avancar) next();
    }
  };

  const handleSkip = async () => {
    if (!registroAtual) return;
    const ok = await persistRegistro({
      status: 'skipado',
      motivo_skip: motivoSkip || null as any,
    });
    if (ok) { toast.success('Pulado'); next(); }
  };

  const handleConcluir = async () => {
    await supabase.from('auditoria_sessoes').update({
      status: 'concluida',
      completed_at: new Date().toISOString(),
    }).eq('id', sessionId);
    toast.success('Sessão concluída');
    onConcluir(sessionId);
  };

  if (loading) return <div className="p-8 text-slate-400 flex items-center gap-2"><Loader2 size={18} className="animate-spin" /> Carregando…</div>;
  if (!sessao) return <div className="p-8 text-slate-400">Sessão não encontrada. <button onClick={onClose} className="underline">voltar</button></div>;

  const totalDone = registros.filter(r => r.status !== 'pendente').length;
  const kommoLink = (itemAtual as any)?.kommo_link || '';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header compacto */}
      <div className="px-4 py-2 border-b border-[var(--color-v4-border)] flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-v4-card-hover)] text-white"><ArrowLeft size={16} /></button>
          <span className="text-sm font-bold text-white truncate">{sessao.nome}</span>
          <span className="text-xs text-slate-400">{posicao + 1}/{registros.length} · {totalDone} feitos</span>
        </div>
        <div className="flex gap-1.5">
          <button onClick={prev} disabled={posicao === 0} className="p-1.5 rounded bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white disabled:opacity-30"><ArrowLeft size={14} /></button>
          <button onClick={next} disabled={posicao >= registros.length - 1} className="p-1.5 rounded bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white disabled:opacity-30"><ArrowRight size={14} /></button>
          <button onClick={handleConcluir} className="px-3 py-1.5 rounded text-xs bg-green-600 hover:bg-green-700 text-white flex items-center gap-1.5"><Check size={12} /> Concluir sessão</button>
        </div>
      </div>

      {/* Body — side by side */}
      {!registroAtual ? (
        <div className="p-8 text-slate-400">Sessão vazia.</div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* ESQUERDA — Kommo popup link + dados SalesHub */}
          <div className="flex-1 overflow-auto p-4 space-y-3 border-r border-[var(--color-v4-border)]">
            {/* Card do item */}
            <div className="bg-[var(--color-v4-card)] p-3 rounded-lg border border-[var(--color-v4-border)] flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[10px] text-slate-400 uppercase">{registroAtual.item_tipo}</div>
                <div className="text-base font-bold text-white truncate">{(itemAtual as any)?.empresa || 'Item não encontrado'}</div>
                <div className="text-xs text-slate-400">Responsável: {responsavel?.name || '—'}</div>
              </div>
              {kommoLink && (
                <a href={kommoLink} target="kommo-audit" className="px-2 py-1.5 bg-[var(--color-v4-red)] text-white text-xs rounded flex items-center gap-1.5 shrink-0" onClick={() => { if (!popupRef.current || popupRef.current.closed) popupRef.current = window.open(kommoLink, 'kommo-audit', 'width=1100,height=900'); }}>
                  <ExternalLink size={12} /> Kommo
                </a>
              )}
            </div>

            {/* Dados SalesHub */}
            {snapshotSaleshub && <SaleshubPanel snapshot={snapshotSaleshub} />}

            {/* Status badge por item */}
            {registroAtual.status !== 'pendente' && (
              <div className={cn('text-xs px-3 py-2 rounded', registroAtual.status === 'auditado' ? 'bg-green-500/20 text-green-300' : 'bg-amber-500/20 text-amber-300')}>
                {registroAtual.status === 'auditado' ? '✓ Auditado' : '⤳ Pulado'}{registroAtual.observacao && ` — ${registroAtual.observacao}`}
              </div>
            )}
          </div>

          {/* DIREITA — form auditoria compacto */}
          <div className="w-[340px] shrink-0 overflow-auto p-4 space-y-3 bg-[var(--color-v4-bg)]">
            {/* Severidade — 3 botões inline */}
            <div>
              <div className="text-[10px] text-slate-400 uppercase mb-1.5">Severidade</div>
              <div className="flex gap-1.5">
                {([
                  { key: 'baixa' as const, label: 'Baixa', color: 'bg-green-600 hover:bg-green-700', active: 'bg-green-600 ring-2 ring-green-400' },
                  { key: 'media' as const, label: 'Média', color: 'bg-yellow-600 hover:bg-yellow-700', active: 'bg-yellow-600 ring-2 ring-yellow-400' },
                  { key: 'alta' as const, label: 'Alta', color: 'bg-red-600 hover:bg-red-700', active: 'bg-red-600 ring-2 ring-red-400' },
                ]).map(s => (
                  <button
                    key={s.key}
                    onClick={() => setSeveridade(severidade === s.key ? '' : s.key)}
                    className={cn('flex-1 py-1.5 rounded text-xs text-white font-medium transition-all', severidade === s.key ? s.active : `${s.color} opacity-60`)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Observação */}
            <div>
              <div className="text-[10px] text-slate-400 uppercase mb-1.5">Observação</div>
              <textarea
                value={observacao}
                onChange={e => setObservacao(e.target.value)}
                placeholder="O que precisa ser corrigido / atualizado?"
                className="w-full px-3 py-2 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded text-white text-sm h-28 resize-none"
              />
            </div>

            {/* Botões salvar */}
            <div className="flex gap-1.5">
              <button
                onClick={() => handleSave(true)}
                disabled={saving}
                className="flex-1 py-2 bg-[var(--color-v4-red)] text-white text-sm rounded font-medium flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Salvar e próximo
              </button>
              <button
                onClick={() => handleSave(false)}
                disabled={saving}
                className="px-3 py-2 bg-[var(--color-v4-card)] text-white text-sm rounded border border-[var(--color-v4-border)] disabled:opacity-50"
              >
                Salvar
              </button>
            </div>

            {/* Pular */}
            <div className="flex gap-1.5">
              <input
                value={motivoSkip}
                onChange={e => setMotivoSkip(e.target.value)}
                placeholder="motivo skip (opcional)"
                className="flex-1 px-2 py-1.5 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded text-white text-xs"
              />
              <button onClick={handleSkip} disabled={saving} className="px-3 py-1.5 bg-amber-700/40 hover:bg-amber-700/60 text-amber-100 text-xs rounded flex items-center gap-1.5 disabled:opacity-50">
                <SkipForward size={12} /> Pular
              </button>
            </div>

            {/* Progress mini */}
            <div className="pt-2 border-t border-[var(--color-v4-border)]">
              <div className="text-[10px] text-slate-400 mb-1">Progresso</div>
              <div className="flex gap-0.5">
                {registros.map((r, i) => (
                  <button
                    key={r.id}
                    onClick={() => goTo(i)}
                    className={cn(
                      'h-2 flex-1 rounded-sm transition-colors',
                      i === posicao ? 'bg-white' :
                        r.status === 'auditado' ? 'bg-green-500' :
                          r.status === 'skipado' ? 'bg-amber-500' : 'bg-slate-600'
                    )}
                    title={`#${i + 1} — ${r.status}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------
// SessionResumo — tela final pós-conclusão
// Gera mensagem WhatsApp consolidada de todos auditados
// ---------------------------------------------
const SessionResumo: React.FC<{
  sessionId: string;
  onBack: () => void;
}> = ({ sessionId, onBack }) => {
  const { leads, deals, members } = useAppStore();
  const [registros, setRegistros] = useState<AuditoriaRegistro[]>([]);
  const [sessao, setSessao] = useState<AuditoriaSessao | null>(null);
  const [loading, setLoading] = useState(true);
  const [waMessage, setWaMessage] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data: s }, { data: r }] = await Promise.all([
        supabase.from('auditoria_sessoes').select('*').eq('id', sessionId).single(),
        supabase.from('auditoria_registros').select('*').eq('sessao_id', sessionId).eq('status', 'auditado').order('posicao', { ascending: true }),
      ]);
      setSessao(s as AuditoriaSessao);
      setRegistros((r as AuditoriaRegistro[]) || []);
      setLoading(false);
    })();
  }, [sessionId]);

  const generateMessage = () => {
    const items = registros.map(reg => {
      const item = reg.item_tipo === 'lead'
        ? leads.find(l => l.id === reg.item_id)
        : deals.find(d => d.id === reg.item_id);
      const respId = reg.responsavel_id;
      const resp = respId ? members.find(m => m.id === respId) : null;
      return {
        empresa: (item as any)?.empresa || 'Desconhecido',
        tipo: reg.item_tipo,
        observacao: reg.observacao || '',
        severidade: reg.severidade as AuditoriaSeveridade | undefined,
        responsavel: resp?.name || '—',
        kommoLink: (item as any)?.kommo_link || '',
      };
    });
    const msg = gerarMensagemConsolidada(sessao?.nome || 'Auditoria', items);
    setWaMessage(msg);
  };

  useEffect(() => {
    if (!loading && registros.length > 0) generateMessage();
  }, [loading, registros.length]);

  if (loading) return <div className="p-8 text-slate-400 flex items-center gap-2"><Loader2 size={18} className="animate-spin" /> Carregando…</div>;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-v4-border)] flex items-center gap-3">
        <button onClick={onBack} className="p-2 rounded hover:bg-[var(--color-v4-card-hover)] text-white"><ArrowLeft size={18} /></button>
        <div>
          <h1 className="text-xl font-display font-bold text-white">Resumo — {sessao?.nome}</h1>
          <div className="text-xs text-slate-400">{registros.length} item(s) auditado(s)</div>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6 space-y-4">
        {/* Lista dos auditados */}
        <div className="bg-[var(--color-v4-card)] rounded-lg border border-[var(--color-v4-border)] divide-y divide-[var(--color-v4-border)]">
          {registros.map((reg, i) => {
            const item = reg.item_tipo === 'lead' ? leads.find(l => l.id === reg.item_id) : deals.find(d => d.id === reg.item_id);
            return (
              <div key={reg.id} className="px-4 py-3 flex items-start gap-3">
                <span className="text-xs text-slate-500 mt-0.5 w-6">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white font-medium">{(item as any)?.empresa || '?'}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{reg.observacao}</div>
                </div>
                {reg.severidade && (
                  <span className={cn('text-[10px] px-2 py-0.5 rounded-full shrink-0',
                    reg.severidade === 'alta' ? 'bg-red-500/20 text-red-300' :
                      reg.severidade === 'media' ? 'bg-yellow-500/20 text-yellow-300' : 'bg-green-500/20 text-green-300'
                  )}>{reg.severidade}</span>
                )}
              </div>
            );
          })}
          {registros.length === 0 && <div className="p-4 text-slate-400 text-sm">Nenhum item auditado nesta sessão.</div>}
        </div>

        {/* WhatsApp consolidado */}
        <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)] space-y-3">
          <h3 className="font-medium text-white text-sm">Mensagem WhatsApp</h3>
          <textarea
            value={waMessage}
            onChange={e => setWaMessage(e.target.value)}
            className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-xs h-64 font-mono resize-y"
          />
          <button
            onClick={() => { navigator.clipboard.writeText(waMessage); toast.success('Mensagem copiada'); }}
            disabled={!waMessage}
            className="w-full px-3 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded font-medium flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <ClipboardCopy size={14} /> Copiar mensagem
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------
// SaleshubPanel
// ---------------------------------------------
const SaleshubPanel: React.FC<{ snapshot: any }> = ({ snapshot }) => {
  if (!snapshot) return null;
  const item = snapshot.item;
  const fields: [string, any][] = snapshot.item_tipo === 'lead'
    ? [
      ['Status', item.status], ['Canal', item.canal], ['Fonte', item.fonte],
      ['Contato', item.nome_contato], ['Telefone', item.telefone], ['Email', item.email],
      ['CNPJ', item.cnpj], ['Faturamento', item.faturamento], ['Produto', item.produto],
    ]
    : [
      ['Status', item.status], ['Temperatura', item.temperatura], ['Tier', item.tier],
      ['MRR', `R$ ${(item.valor_mrr || 0).toLocaleString('pt-BR')}`],
      ['OT', `R$ ${(item.valor_ot || 0).toLocaleString('pt-BR')}`],
      ['BANT', item.bant], ['Origem', item.origem],
      ['Motivo perda', item.motivo_perda],
    ];
  return (
    <div className="bg-[var(--color-v4-card)] p-3 rounded-lg border border-[var(--color-v4-border)]">
      <h3 className="font-medium text-white text-xs mb-2">Dados SalesHub</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
        {fields.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 py-0.5">
            <span className="text-slate-400">{k}</span>
            <span className="text-white truncate text-right">{v ?? '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
