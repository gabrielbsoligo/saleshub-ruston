import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import {
  type AuditoriaRegistro,
  type AuditoriaSessao,
  type AuditoriaSeveridade,
  type BridgeToken,
} from '../types';
import { gerarMensagemConsolidada } from '../lib/auditoriaWhatsApp';
import toast from 'react-hot-toast';
import {
  ArrowLeft, Check, ClipboardCopy, ExternalLink,
  KeyRound, Loader2, Plus, Trash2,
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
          <h2 className="font-medium text-white mb-2">2. Instalar userscript <span className="text-xs text-slate-400 font-normal">v0.3.1</span></h2>
          <div className="flex items-center gap-2 mb-2">
            <a href={userscriptUrl} target="_blank" rel="noreferrer" className="text-sm text-[var(--color-v4-red)] underline break-all">{userscriptUrl}</a>
            <button onClick={() => { navigator.clipboard.writeText(userscriptUrl); toast.success('Copiado'); }} className="text-xs px-2 py-1 bg-[var(--color-v4-card-hover)] rounded text-white"><ClipboardCopy size={12} /></button>
          </div>
          <p className="text-xs text-slate-500">Clique no link acima para instalar/atualizar. Versão atual: <span className="text-slate-300 font-mono">0.3.1</span></p>
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
// SessionRunner — abre Kommo e injeta sidebar de auditoria
// A auditoria acontece DENTRO da aba do Kommo (via AuditPanel no iframe)
// Esta tela no SalesHub só faz o launch e mostra status.
// ---------------------------------------------
const SessionRunner: React.FC<{
  sessionId: string;
  onClose: () => void;
  onConcluir: (sessionId: string) => void;
}> = ({ sessionId, onClose, onConcluir }) => {
  const { leads, deals } = useAppStore();
  const [sessao, setSessao] = useState<AuditoriaSessao | null>(null);
  const [registros, setRegistros] = useState<AuditoriaRegistro[]>([]);
  const [loading, setLoading] = useState(true);
  const [launched, setLaunched] = useState(false);
  const kommoRef = useRef<Window | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: s }, { data: r }] = await Promise.all([
      supabase.from('auditoria_sessoes').select('*').eq('id', sessionId).single(),
      supabase.from('auditoria_registros').select('*').eq('sessao_id', sessionId).order('posicao', { ascending: true }),
    ]);
    setSessao(s as AuditoriaSessao | null);
    setRegistros((r as AuditoriaRegistro[]) || []);
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Poll para atualizar contadores
  useEffect(() => {
    const interval = setInterval(fetchAll, 8000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Achar primeiro link Kommo da sessão
  const firstKommoLink = useMemo(() => {
    const first = registros.find(r => r.status === 'pendente') || registros[0];
    if (!first) return null;
    const item = first.item_tipo === 'lead'
      ? leads.find(l => l.id === first.item_id)
      : deals.find(d => d.id === first.item_id);
    return (item as any)?.kommo_link || null;
  }, [registros, leads, deals]);

  const handleLaunch = async () => {
    if (!firstKommoLink) {
      toast.error('Nenhum item com link Kommo.');
      return;
    }
    // Pega o access_token pra repassar ao iframe (cookies 3p bloqueados)
    const { data: { session } } = await supabase.auth.getSession();
    const accessToken = session?.access_token || '';
    const refreshToken = session?.refresh_token || '';

    // Abre aba do Kommo
    kommoRef.current = window.open(firstKommoLink, 'kommo-audit');
    setLaunched(true);

    const msg = {
      source: 'saleshub',
      action: 'start-audit',
      sessionId: sessionId,
      accessToken: accessToken,
      refreshToken: refreshToken,
    };

    // Espera o bridge carregar e manda start-audit com tokens
    // Usa intervalo que para de mandar assim que o bridge confirma recebimento
    let attempts = 0;
    const maxAttempts = 5;
    const intervalId = setInterval(function sendStart() {
      attempts++;
      if (!kommoRef.current || kommoRef.current.closed || attempts > maxAttempts) {
        clearInterval(intervalId);
        return;
      }
      kommoRef.current.postMessage(msg, '*');
    }, 3000);

    // Ouve confirmação do bridge para parar de reenviar
    function onBridgeReady(ev: MessageEvent) {
      if (ev.data?.source === 'kommo-bridge' && ev.data?.type === 'sidebar-ack') {
        clearInterval(intervalId);
        window.removeEventListener('message', onBridgeReady);
      }
    }
    window.addEventListener('message', onBridgeReady);
  };

  const handleViewResumo = () => {
    onConcluir(sessionId);
  };

  if (loading) return <div className="p-8 text-slate-400 flex items-center gap-2"><Loader2 size={18} className="animate-spin" /> Carregando…</div>;
  if (!sessao) return <div className="p-8 text-slate-400">Sessão não encontrada. <button onClick={onClose} className="underline">voltar</button></div>;

  const totalDone = registros.filter(r => r.status !== 'pendente').length;
  const totalAuditado = registros.filter(r => r.status === 'auditado').length;
  const totalSkipado = registros.filter(r => r.status === 'skipado').length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-[var(--color-v4-border)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="p-2 rounded hover:bg-[var(--color-v4-card-hover)] text-white"><ArrowLeft size={16} /></button>
          <div>
            <h1 className="text-lg font-display font-bold text-white">{sessao.nome}</h1>
            <div className="text-xs text-slate-400">{registros.length} itens · {totalDone} processados</div>
          </div>
        </div>
        {sessao.status === 'concluida' && (
          <button onClick={handleViewResumo} className="px-3 py-2 rounded text-sm bg-green-600 hover:bg-green-700 text-white flex items-center gap-2">
            <Check size={14} /> Ver resumo / WhatsApp
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-lg mx-auto space-y-6">
          {/* Status */}
          <div className="bg-[var(--color-v4-card)] p-6 rounded-lg border border-[var(--color-v4-border)] text-center space-y-4">
            <div className="text-4xl font-bold text-white">{totalAuditado}<span className="text-slate-400 text-lg">/{registros.length}</span></div>
            <div className="text-sm text-slate-400">
              {totalAuditado} auditados · {totalSkipado} pulados · {registros.length - totalDone} pendentes
            </div>

            {/* Progress bar */}
            <div className="flex gap-0.5 h-3">
              {registros.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'flex-1 rounded-sm',
                    r.status === 'auditado' ? 'bg-green-500' :
                      r.status === 'skipado' ? 'bg-amber-500' : 'bg-slate-600'
                  )}
                />
              ))}
            </div>
          </div>

          {/* Launch button */}
          {!launched ? (
            <button
              onClick={handleLaunch}
              disabled={!firstKommoLink}
              className="w-full py-4 bg-[var(--color-v4-red)] hover:opacity-90 text-white text-lg rounded-lg font-medium flex items-center justify-center gap-3 disabled:opacity-50"
            >
              <ExternalLink size={20} /> Iniciar auditoria no Kommo
            </button>
          ) : (
            <div className="space-y-3">
              <div className="bg-blue-500/10 text-blue-300 px-4 py-3 rounded-lg text-sm text-center">
                Auditoria em andamento na aba do Kommo. O painel lateral aparecerá automaticamente.
              </div>
              <button
                onClick={handleLaunch}
                className="w-full py-3 bg-[var(--color-v4-card)] hover:bg-[var(--color-v4-card-hover)] text-white text-sm rounded-lg border border-[var(--color-v4-border)] flex items-center justify-center gap-2"
              >
                <ExternalLink size={14} /> Reabrir Kommo / reinjetar painel
              </button>
            </div>
          )}

          {totalDone > 0 && (
            <button
              onClick={handleViewResumo}
              className="w-full py-3 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg font-medium flex items-center justify-center gap-2"
            >
              <Check size={14} /> Concluir e ver resumo / WhatsApp
            </button>
          )}
        </div>
      </div>
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
