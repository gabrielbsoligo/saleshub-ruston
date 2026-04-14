import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import {
  CATEGORIA_LABELS,
  type AuditoriaCategoria,
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
import { gerarMensagemWhatsApp } from '../lib/auditoriaWhatsApp';
import toast from 'react-hot-toast';
import {
  ArrowLeft, ArrowRight, ArrowUpRightSquare, Check, ClipboardCopy, ExternalLink,
  KeyRound, ListPlus, Loader2, Plus, RefreshCcw, SkipForward, Trash2, X,
} from 'lucide-react';
import { cn } from './Layout';

// =============================================
// AuditoriaView — tela mestre da feature
// =============================================

type Mode =
  | { kind: 'list' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'setup' };

export const AuditoriaView: React.FC = () => {
  const { currentUser } = useAppStore();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });

  if (!currentUser || currentUser.role !== 'gestor') {
    return (
      <div className="p-8 text-slate-400">
        Acesso restrito a gestores.
      </div>
    );
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
  const { leads, deals } = useAppStore();
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
    if (error) {
      toast.error('Erro carregando sessões: ' + error.message);
    } else {
      setSessoes(data as AuditoriaSessao[]);
    }
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
    if (error) {
      toast.error('Falha criando sessão: ' + error.message);
      return;
    }
    onOpen(data.id);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-v4-border)] flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Auditoria</h1>
          <p className="text-sm text-[var(--color-v4-text-muted)] mt-1">
            Fila de auditoria de leads/negociações com bridge Kommo.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onSetup}
            className="px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white border border-[var(--color-v4-border)] flex items-center gap-2"
          >
            <KeyRound size={14} /> Bridge / Token
          </button>
          <button
            onClick={handleCreateEmpty}
            disabled={creating}
            className="px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-red)] hover:opacity-90 text-white flex items-center gap-2 disabled:opacity-50"
          >
            <Plus size={14} /> Nova sessão (vazia)
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {loading && (
          <div className="text-slate-400 flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Carregando…</div>
        )}
        {!loading && sessoes.length === 0 && (
          <div className="text-slate-400">
            Nenhuma sessão ainda. Crie uma vazia ou use o botão "Auditar" no LeadsView/PipelineView.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {sessoes.map(s => (
            <button
              key={s.id}
              onClick={() => onOpen(s.id)}
              className="text-left p-4 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-white">{s.nome}</span>
                <StatusBadge status={s.status} />
              </div>
              <div className="text-xs text-slate-400 space-y-1">
                <div>Origem: {s.origem}</div>
                <div>Itens: {s.total_itens} (✓ {s.total_auditados} · ⤳ {s.total_skipados})</div>
                <div>Criada: {new Date(s.created_at).toLocaleString('pt-BR')}</div>
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
    const { data, error } = await supabase
      .from('bridge_tokens')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) toast.error(error.message);
    else setTokens(data as BridgeToken[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  const handleCreate = async () => {
    setCreating(true);
    const memberId = await getMemberId();
    const token = 'br_' + crypto.getRandomValues(new Uint8Array(32))
      .reduce((acc, b) => acc + b.toString(16).padStart(2, '0'), '');
    const { error } = await supabase.from('bridge_tokens').insert({
      team_member_id: memberId,
      token,
      label: label || `bridge ${new Date().toLocaleDateString('pt-BR')}`,
    });
    setCreating(false);
    if (error) {
      toast.error('Falha gerando token: ' + error.message);
      return;
    }
    setLabel('');
    fetchTokens();
    toast.success('Token criado.');
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Revogar este token? Bridges instaladas com ele param de funcionar.')) return;
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
          <p className="text-sm text-slate-400 mb-3">
            Instale a extensão <a className="text-[var(--color-v4-red)] underline" target="_blank" rel="noreferrer" href="https://www.tampermonkey.net/">Tampermonkey</a> no seu navegador. Funciona em Chrome, Edge, Firefox.
          </p>
          <h2 className="font-medium text-white mb-2">2. Instalar o userscript</h2>
          <p className="text-sm text-slate-400 mb-2">Abra este link e o Tampermonkey vai oferecer instalação:</p>
          <div className="flex items-center gap-2 mb-2">
            <a href={userscriptUrl} target="_blank" rel="noreferrer" className="text-sm text-[var(--color-v4-red)] underline break-all">{userscriptUrl}</a>
            <button onClick={() => { navigator.clipboard.writeText(userscriptUrl); toast.success('Link copiado'); }} className="text-xs px-2 py-1 bg-[var(--color-v4-card-hover)] rounded text-white"><ClipboardCopy size={12} /></button>
          </div>
          <p className="text-xs text-slate-500">Updates futuros são puxados automaticamente pelo Tampermonkey.</p>
        </section>

        <section className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)]">
          <h2 className="font-medium text-white mb-3">3. Tokens</h2>
          <p className="text-sm text-slate-400 mb-3">Quando o bridge perguntar, cole um destes tokens. Ele autentica o envio de snapshots.</p>
          <div className="flex gap-2 mb-4">
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Label (ex: meu notebook)"
              className="flex-1 px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-sm"
            />
            <button onClick={handleCreate} disabled={creating} className="px-3 py-2 bg-[var(--color-v4-red)] text-white rounded text-sm flex items-center gap-2 disabled:opacity-50">
              <Plus size={14} /> Gerar token
            </button>
          </div>
          {loading ? (
            <div className="text-slate-400 text-sm">Carregando…</div>
          ) : (
            <ul className="space-y-2">
              {tokens.map(t => (
                <li key={t.id} className={cn('p-3 rounded border border-[var(--color-v4-border)] flex items-center justify-between', t.revoked_at && 'opacity-50')}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white font-medium truncate">{t.label || 'sem label'}</div>
                    <div className="text-xs text-slate-400 font-mono break-all">{t.token}</div>
                    <div className="text-[10px] text-slate-500">criado {new Date(t.created_at).toLocaleString('pt-BR')}{t.last_used_at && ` • último uso ${new Date(t.last_used_at).toLocaleString('pt-BR')}`}{t.revoked_at && ` • revogado ${new Date(t.revoked_at).toLocaleString('pt-BR')}`}</div>
                  </div>
                  <div className="flex gap-2 ml-2">
                    <button onClick={() => { navigator.clipboard.writeText(t.token); toast.success('Token copiado'); }} className="text-xs p-2 bg-[var(--color-v4-card-hover)] rounded text-white"><ClipboardCopy size={12} /></button>
                    {!t.revoked_at && (
                      <button onClick={() => handleRevoke(t.id)} className="text-xs p-2 bg-red-500/20 hover:bg-red-500/40 rounded text-red-300"><Trash2 size={12} /></button>
                    )}
                  </div>
                </li>
              ))}
              {tokens.length === 0 && <li className="text-slate-400 text-sm">Nenhum token ainda.</li>}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};

// ---------------------------------------------
// SessionRunner — fila de auditoria
// ---------------------------------------------
const SessionRunner: React.FC<{
  sessionId: string;
  onClose: () => void;
}> = ({ sessionId, onClose }) => {
  const { leads, deals, members, reunioes, currentUser } = useAppStore();
  const [sessao, setSessao] = useState<AuditoriaSessao | null>(null);
  const [registros, setRegistros] = useState<AuditoriaRegistro[]>([]);
  const [posicao, setPosicao] = useState(0);
  const [loading, setLoading] = useState(true);
  const [kommoSnapshot, setKommoSnapshot] = useState<AuditoriaKommoSnapshot | null>(null);
  const popupRef = useRef<Window | null>(null);

  // -- Form state
  const [observacao, setObservacao] = useState('');
  const [categoria, setCategoria] = useState<AuditoriaCategoria | ''>('');
  const [severidade, setSeveridade] = useState<AuditoriaSeveridade | ''>('');
  const [motivoSkip, setMotivoSkip] = useState('');
  const [saving, setSaving] = useState(false);
  const [waMessage, setWaMessage] = useState('');

  // ---- Fetch sessao + registros
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
    // posiciona no primeiro pendente
    const idx = ((r as AuditoriaRegistro[]) || []).findIndex(reg => reg.status === 'pendente');
    setPosicao(idx >= 0 ? idx : 0);
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const registroAtual = registros[posicao];

  // Resolver item atual a partir do store
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

  // ---- Reset form ao trocar item
  useEffect(() => {
    setObservacao(registroAtual?.observacao || '');
    setCategoria((registroAtual?.categoria as any) || '');
    setSeveridade((registroAtual?.severidade as any) || '');
    setMotivoSkip(registroAtual?.motivo_skip || '');
    setWaMessage('');
  }, [registroAtual?.id]);

  // ---- Carregar snapshot Kommo mais recente para item atual + Realtime
  useEffect(() => {
    if (!itemAtual) { setKommoSnapshot(null); return; }
    const kommoLeadId = getKommoLeadIdFromItem(itemAtual);
    if (!kommoLeadId) { setKommoSnapshot(null); return; }

    let cancelled = false;
    const fetchLatest = async () => {
      const { data } = await supabase
        .from('auditoria_kommo_snapshots')
        .select('*')
        .eq('kommo_lead_id', kommoLeadId)
        .order('capturado_em', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setKommoSnapshot(data as AuditoriaKommoSnapshot | null);
    };
    fetchLatest();

    const channel = supabase
      .channel(`kommo-snap-${kommoLeadId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'auditoria_kommo_snapshots',
        filter: `kommo_lead_id=eq.${kommoLeadId}`,
      }, (payload) => {
        if (cancelled) return;
        setKommoSnapshot(payload.new as AuditoriaKommoSnapshot);
      })
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [itemAtual?.id]);

  // ---- Navegação
  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= registros.length) return;
    setPosicao(idx);
    // Se popup Kommo aberta, navegar
    const nextItem = registros[idx];
    if (!nextItem) return;
    const itm = nextItem.item_tipo === 'lead'
      ? leads.find(l => l.id === nextItem.item_id)
      : deals.find(d => d.id === nextItem.item_id);
    const link = (itm as any)?.kommo_link;
    if (popupRef.current && !popupRef.current.closed && link) {
      popupRef.current.postMessage({ source: 'saleshub', action: 'goto', kommoUrl: link }, '*');
    }
  }, [registros, leads, deals]);

  const next = () => goTo(posicao + 1);
  const prev = () => goTo(posicao - 1);

  // ---- Atalhos teclado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 's' || e.key === 'S') handleSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- Salvar / skip
  const persistRegistro = async (patch: Partial<AuditoriaRegistro>) => {
    if (!registroAtual) return;
    setSaving(true);
    const { error } = await supabase
      .from('auditoria_registros')
      .update(patch)
      .eq('id', registroAtual.id);
    setSaving(false);
    if (error) {
      toast.error('Falha salvando: ' + error.message);
      return false;
    }
    setRegistros(rs => rs.map(r => r.id === registroAtual.id ? { ...r, ...patch } as AuditoriaRegistro : r));
    return true;
  };

  const handleSave = async (avancar = true) => {
    if (!registroAtual || !snapshotSaleshub) return;
    if (!observacao.trim()) {
      toast.error('Adicione uma observação antes de salvar.');
      return;
    }
    const ok = await persistRegistro({
      status: 'auditado',
      observacao,
      categoria: (categoria || null) as any,
      severidade: (severidade || null) as any,
      responsavel_id: responsavelId || null as any,
      snapshot_saleshub: snapshotSaleshub as any,
      kommo_snapshot_id: (kommoSnapshot?.id || null) as any,
      auditado_em: new Date().toISOString(),
    });
    if (ok) {
      toast.success('Auditado.');
      if (avancar) next();
    }
  };

  const handleSkip = async () => {
    if (!registroAtual) return;
    const ok = await persistRegistro({
      status: 'skipado',
      motivo_skip: motivoSkip || null as any,
    });
    if (ok) {
      toast.success('Pulado.');
      next();
    }
  };

  const handleConcluir = async () => {
    await supabase.from('auditoria_sessoes').update({
      status: 'concluida',
      completed_at: new Date().toISOString(),
    }).eq('id', sessionId);
    toast.success('Sessão concluída.');
    onClose();
  };

  const openKommo = () => {
    const link = (itemAtual as any)?.kommo_link;
    if (!link) {
      toast.error('Item sem kommo_link.');
      return;
    }
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.location.href = link;
      popupRef.current.focus();
    } else {
      popupRef.current = window.open(link, 'kommo-audit', 'width=1100,height=900');
    }
  };

  const generateWa = () => {
    if (!itemAtual || !registroAtual) return;
    const msg = gerarMensagemWhatsApp({
      item: itemAtual,
      itemTipo: registroAtual.item_tipo,
      observacao,
      categoria: (categoria || undefined) as AuditoriaCategoria | undefined,
      severidade: (severidade || undefined) as AuditoriaSeveridade | undefined,
      responsavel: responsavel || null,
    });
    setWaMessage(msg);
    persistRegistro({ mensagem_gerada: msg });
  };

  if (loading) {
    return <div className="p-8 text-slate-400 flex items-center gap-2"><Loader2 size={18} className="animate-spin" /> Carregando sessão…</div>;
  }
  if (!sessao) {
    return <div className="p-8 text-slate-400">Sessão não encontrada. <button onClick={onClose} className="underline">voltar</button></div>;
  }

  const totalDone = registros.filter(r => r.status !== 'pendente').length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-[var(--color-v4-border)] flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onClose} className="p-2 rounded hover:bg-[var(--color-v4-card-hover)] text-white"><ArrowLeft size={16} /></button>
          <div className="min-w-0">
            <h1 className="text-lg font-display font-bold text-white truncate">{sessao.nome}</h1>
            <div className="text-xs text-slate-400">
              {posicao + 1} / {registros.length} • {totalDone} processados
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={prev} disabled={posicao === 0} className="p-2 rounded bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white disabled:opacity-30"><ArrowLeft size={16} /></button>
          <button onClick={next} disabled={posicao >= registros.length - 1} className="p-2 rounded bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white disabled:opacity-30"><ArrowRight size={16} /></button>
          <button onClick={handleConcluir} className="px-3 py-2 rounded text-sm bg-green-600 hover:bg-green-700 text-white flex items-center gap-2"><Check size={14} /> Concluir sessão</button>
        </div>
      </div>

      {/* Body */}
      {!registroAtual && (
        <div className="p-8 text-slate-400">Sessão vazia. Adicione itens via LeadsView/PipelineView.</div>
      )}
      {registroAtual && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] overflow-hidden">
          {/* Left — SalesHub + Kommo snapshot */}
          <div className="overflow-auto p-5 border-r border-[var(--color-v4-border)] space-y-4">
            <ItemHeader item={itemAtual} tipo={registroAtual.item_tipo} responsavel={responsavel} onOpenKommo={openKommo} />
            <SaleshubPanel snapshot={snapshotSaleshub} />
            <KommoSnapshotPanel snapshot={kommoSnapshot} kommoLeadId={getKommoLeadIdFromItem(itemAtual!)} onRefresh={() => {
              if (popupRef.current && !popupRef.current.closed) {
                popupRef.current.postMessage({ source: 'saleshub', action: 'extract' }, '*');
              } else {
                openKommo();
              }
            }} />
          </div>

          {/* Right — form + WhatsApp */}
          <div className="overflow-auto p-5 space-y-4 bg-[var(--color-v4-bg)]">
            <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)] space-y-3">
              <h3 className="font-medium text-white text-sm">Auditoria</h3>
              <textarea
                value={observacao}
                onChange={e => setObservacao(e.target.value)}
                placeholder="O que precisa ser corrigido / atualizado?"
                className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-sm h-32"
              />
              <div className="grid grid-cols-2 gap-2">
                <select value={categoria} onChange={e => setCategoria(e.target.value as any)} className="px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-sm">
                  <option value="">— categoria —</option>
                  {Object.entries(CATEGORIA_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <select value={severidade} onChange={e => setSeveridade(e.target.value as any)} className="px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-sm">
                  <option value="">— severidade —</option>
                  <option value="alta">🔴 Alta</option>
                  <option value="media">🟡 Média</option>
                  <option value="baixa">🟢 Baixa</option>
                </select>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => handleSave(true)} disabled={saving} className="flex-1 px-3 py-2 bg-[var(--color-v4-red)] text-white text-sm rounded flex items-center justify-center gap-2 disabled:opacity-50">
                  <Check size={14} /> Salvar e próximo
                </button>
                <button onClick={() => handleSave(false)} disabled={saving} className="px-3 py-2 bg-[var(--color-v4-card-hover)] text-white text-sm rounded flex items-center gap-2 disabled:opacity-50">
                  Salvar
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={motivoSkip}
                  onChange={e => setMotivoSkip(e.target.value)}
                  placeholder="motivo skip (opcional)"
                  className="flex-1 px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-xs"
                />
                <button onClick={handleSkip} className="px-3 py-2 bg-amber-700/40 hover:bg-amber-700/60 text-amber-100 text-sm rounded flex items-center gap-2">
                  <SkipForward size={14} /> Pular
                </button>
              </div>
            </div>

            <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)] space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-medium text-white text-sm">Mensagem WhatsApp</h3>
                <button onClick={generateWa} className="text-xs px-2 py-1 bg-[var(--color-v4-card-hover)] rounded text-white flex items-center gap-1">
                  <RefreshCcw size={11} /> Gerar
                </button>
              </div>
              <textarea
                value={waMessage}
                onChange={e => setWaMessage(e.target.value)}
                placeholder="Clique 'Gerar' pra montar a mensagem"
                className="w-full px-3 py-2 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded text-white text-xs h-48 font-mono"
              />
              <button
                onClick={() => { navigator.clipboard.writeText(waMessage); toast.success('Mensagem copiada'); }}
                disabled={!waMessage}
                className="w-full px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded flex items-center justify-center gap-2 disabled:opacity-50"
              >
                <ClipboardCopy size={14} /> Copiar mensagem
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------
// Sub-componentes
// ---------------------------------------------

const ItemHeader: React.FC<{
  item: Lead | Deal | null;
  tipo: 'lead' | 'deal';
  responsavel: any;
  onOpenKommo: () => void;
}> = ({ item, tipo, responsavel, onOpenKommo }) => {
  if (!item) return <div className="text-slate-400 text-sm">Item não encontrado no SalesHub (foi deletado?).</div>;
  return (
    <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)] flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-400 uppercase">{tipo === 'lead' ? 'Lead' : 'Negociação'}</div>
        <div className="text-lg font-bold text-white truncate">{(item as any).empresa}</div>
        <div className="text-xs text-slate-400">Responsável: {responsavel?.name || '—'}</div>
      </div>
      <div className="flex gap-2">
        <button onClick={onOpenKommo} className="px-3 py-2 bg-[var(--color-v4-red)] text-white text-sm rounded flex items-center gap-2">
          <ArrowUpRightSquare size={14} /> Kommo
        </button>
      </div>
    </div>
  );
};

const SaleshubPanel: React.FC<{ snapshot: any }> = ({ snapshot }) => {
  if (!snapshot) return null;
  const item = snapshot.item;
  const fields: [string, any][] = snapshot.item_tipo === 'lead'
    ? [
      ['Status', item.status], ['Canal', item.canal], ['Fonte', item.fonte],
      ['Contato', item.nome_contato], ['Telefone', item.telefone], ['Email', item.email],
      ['CNPJ', item.cnpj], ['Faturamento', item.faturamento], ['Produto', item.produto],
      ['Cadastrado', new Date(item.created_at).toLocaleString('pt-BR')],
    ]
    : [
      ['Status', item.status], ['Temperatura', item.temperatura], ['Tier', item.tier],
      ['MRR', `R$ ${(item.valor_mrr || 0).toLocaleString('pt-BR')}`],
      ['OT', `R$ ${(item.valor_ot || 0).toLocaleString('pt-BR')}`],
      ['BANT', item.bant], ['Origem', item.origem],
      ['Data call', item.data_call ? new Date(item.data_call).toLocaleString('pt-BR') : '—'],
      ['Data fechamento', item.data_fechamento ? new Date(item.data_fechamento).toLocaleString('pt-BR') : '—'],
      ['Motivo perda', item.motivo_perda],
    ];
  return (
    <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)]">
      <h3 className="font-medium text-white text-sm mb-3">SalesHub</h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {fields.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-[var(--color-v4-border)]/40 py-1">
            <span className="text-slate-400">{k}</span>
            <span className="text-white truncate text-right">{v ?? '—'}</span>
          </div>
        ))}
      </div>
      {snapshot.reunioes && snapshot.reunioes.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-slate-400 mb-1">Reuniões ({snapshot.reunioes.length})</div>
          <ul className="space-y-1 text-xs text-white">
            {snapshot.reunioes.slice(0, 5).map((r: any) => (
              <li key={r.id} className="flex justify-between border-b border-[var(--color-v4-border)]/40 py-1">
                <span>{r.data_reuniao ? new Date(r.data_reuniao).toLocaleString('pt-BR') : '—'}</span>
                <span className="text-slate-400">{r.realizada ? '✓' : '○'} {r.show ? 'show' : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const KommoSnapshotPanel: React.FC<{
  snapshot: AuditoriaKommoSnapshot | null;
  kommoLeadId: number | null;
  onRefresh: () => void;
}> = ({ snapshot, kommoLeadId, onRefresh }) => {
  if (!kommoLeadId) {
    return (
      <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)] text-sm text-slate-400">
        Item sem kommo_id — bridge não tem o que extrair.
      </div>
    );
  }
  return (
    <div className="bg-[var(--color-v4-card)] p-4 rounded-lg border border-[var(--color-v4-border)]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-white text-sm">Kommo (bridge)</h3>
        <button onClick={onRefresh} className="text-xs px-2 py-1 bg-[var(--color-v4-card-hover)] rounded text-white flex items-center gap-1">
          <RefreshCcw size={11} /> Atualizar
        </button>
      </div>
      {!snapshot && (
        <div className="text-sm text-slate-400">
          Aguardando snapshot. Abra o lead {kommoLeadId} no Kommo (botão acima) com a bridge instalada.
        </div>
      )}
      {snapshot && (
        <div className="space-y-3 text-xs">
          <div className="text-[10px] text-slate-500">
            Capturado {new Date(snapshot.capturado_em).toLocaleString('pt-BR')} · v{snapshot.bridge_version || '?'}
          </div>
          {snapshot.payload?.header && (
            <div className="border-b border-[var(--color-v4-border)]/40 pb-2">
              <div className="text-white font-medium">{snapshot.payload.header.name}</div>
              <div className="text-slate-400">Status: {snapshot.payload.header.status_label || '—'}</div>
              <div className="text-slate-400">Resp: {snapshot.payload.header.responsible_label || '—'}</div>
            </div>
          )}
          {snapshot.payload?.custom_fields?.length > 0 && (
            <div>
              <div className="text-slate-400 mb-1">Custom fields ({snapshot.payload.custom_fields.length})</div>
              <ul className="space-y-1">
                {snapshot.payload.custom_fields.slice(0, 20).map((f: any, i: number) => (
                  <li key={i} className="border-b border-[var(--color-v4-border)]/40 py-1">
                    <span className="text-slate-400">{f.label}: </span>
                    <span className="text-white">{f.value || '—'}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {snapshot.payload?.notes?.length > 0 && (
            <div>
              <div className="text-slate-400 mb-1">Notas ({snapshot.payload.notes.length})</div>
              <ul className="space-y-2">
                {snapshot.payload.notes.slice(0, 10).map((n: any, i: number) => (
                  <li key={i} className="bg-[var(--color-v4-bg)] p-2 rounded">
                    <div className="text-[10px] text-slate-500">{n.author} · {n.time}</div>
                    <div className="text-white whitespace-pre-wrap">{n.text}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {snapshot.payload?.whatsapp_messages?.length > 0 && (
            <div>
              <div className="text-slate-400 mb-1">WhatsApp ({snapshot.payload.whatsapp_messages.length})</div>
              <ul className="space-y-1">
                {snapshot.payload.whatsapp_messages.map((m: any, i: number) => (
                  <li key={i} className={cn('p-2 rounded', m.author === 'sdr' ? 'bg-blue-900/30' : 'bg-[var(--color-v4-bg)]')}>
                    <div className="text-[10px] text-slate-500">{m.author} · {m.timestamp}</div>
                    <div className="text-white whitespace-pre-wrap">{m.text}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(!snapshot.payload?.custom_fields?.length && !snapshot.payload?.notes?.length && !snapshot.payload?.whatsapp_messages?.length) && (
            <pre className="text-[10px] bg-[var(--color-v4-bg)] p-2 rounded overflow-auto max-h-64 text-slate-300">{JSON.stringify(snapshot.payload, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
};
