// AuditPanel — componente standalone renderizado dentro do iframe no Kommo.
// Comunica com o bridge (parent) via postMessage.
// URL: /?audit_panel=1&session=<sessionId>

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { supabase } from '../lib/supabase';
import type {
  AuditoriaRegistro,
  AuditoriaSessao,
  AuditoriaSeveridade,
  Deal,
  Lead,
} from '../types';
import {
  getKommoLeadIdFromItem,
  getResponsavelId,
  snapshotDeal,
  snapshotLead,
} from '../lib/auditoriaSnapshot';
import toast from 'react-hot-toast';
import { ArrowLeft, ArrowRight, Check, Loader2, SkipForward, X } from 'lucide-react';
import { cn } from './Layout';

const SALESHUB_ORIGIN = window.location.origin;

function postToParent(data: any) {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ source: 'saleshub-audit-panel', ...data }, '*');
  }
}

export const AuditPanel: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { leads, deals, members, reunioes, currentUser, isLoadingAuth } = useAppStore();
  const [sessao, setSessao] = useState<AuditoriaSessao | null>(null);
  const [registros, setRegistros] = useState<AuditoriaRegistro[]>([]);
  const [posicao, setPosicao] = useState(0);
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false);

  // Restore auth session from URL hash (passed by bridge to bypass 3p cookie block)
  useEffect(() => {
    (async () => {
      const hash = window.location.hash.slice(1);
      const params = new URLSearchParams(hash);
      const at = params.get('at');
      const rt = params.get('rt');
      if (at && rt) {
        await supabase.auth.setSession({ access_token: at, refresh_token: rt });
        // Clear hash from URL
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      setAuthReady(true);
    })();
  }, []);

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

  useEffect(() => { if (authReady) fetchAll(); }, [fetchAll, authReady]);

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

  // Navegar Kommo ao trocar item — só se URL mudou (evita loop de reload)
  const lastNavigatedId = React.useRef<string | null>(null);
  useEffect(() => {
    if (!itemAtual) return;
    const link = (itemAtual as any)?.kommo_link;
    const itemId = (itemAtual as any)?.id;
    // Só navega se for item diferente do último navegado
    if (link && itemId && itemId !== lastNavigatedId.current) {
      lastNavigatedId.current = itemId;
      // Pergunta ao bridge a URL atual antes de navegar
      postToParent({ action: 'check-url-then-navigate', kommoUrl: link });
    }
    // Também pede extração
    postToParent({ action: 'extract' });
  }, [itemAtual?.id]);

  // Ouvir mensagens do bridge (lead changed)
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!ev.data || ev.data.source !== 'kommo-bridge') return;
      // Futuro: sincronizar posição se lead mudar externamente
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Navegação
  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= registros.length) return;
    setPosicao(idx);
  }, [registros.length]);

  const next = () => goTo(posicao + 1);
  const prev = () => goTo(posicao - 1);

  // Atalhos
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    }
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
    if (!observacao.trim()) { toast.error('Observação obrigatória'); return; }
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
    toast.success('Sessão concluída!');
    postToParent({ action: 'close' });
  };

  const handleClose = () => {
    postToParent({ action: 'close' });
  };

  const storeLoading = isLoadingAuth || (!currentUser && authReady);

  if (loading || storeLoading) {
    return <div className="h-full flex items-center justify-center bg-[#0f1117] text-slate-400"><Loader2 size={18} className="animate-spin" /> <span className="ml-2 text-xs">{storeLoading ? 'Carregando dados...' : ''}</span></div>;
  }

  if (!sessao) {
    return <div className="h-full flex items-center justify-center bg-[#0f1117] text-slate-400 text-sm p-4">Sessão não encontrada</div>;
  }

  const totalDone = registros.filter(r => r.status !== 'pendente').length;

  return (
    <div className="h-screen flex flex-col bg-[#0f1117] text-white overflow-hidden" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-700 flex items-center justify-between gap-2 bg-[#161922]">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-bold truncate">{sessao.nome}</div>
          <div className="text-[10px] text-slate-400">{posicao + 1}/{registros.length} · {totalDone} feitos</div>
        </div>
        <div className="flex gap-1">
          <button onClick={prev} disabled={posicao === 0} className="p-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30"><ArrowLeft size={12} /></button>
          <button onClick={next} disabled={posicao >= registros.length - 1} className="p-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30"><ArrowRight size={12} /></button>
          <button onClick={handleClose} className="p-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"><X size={12} /></button>
        </div>
      </div>

      {/* Content */}
      {!registroAtual ? (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-sm p-4">Sessão vazia</div>
      ) : (
        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* Item info */}
          <div className="bg-[#161922] p-2.5 rounded border border-slate-700">
            <div className="text-[10px] text-slate-400 uppercase">{registroAtual.item_tipo}</div>
            <div className="text-sm font-bold truncate">{(itemAtual as any)?.empresa || (leads.length === 0 && deals.length === 0 ? 'Carregando...' : 'Item não encontrado')}</div>
            <div className="text-[11px] text-slate-400">Resp: {responsavel?.name || '—'}</div>
          </div>

          {/* Already audited badge */}
          {registroAtual.status !== 'pendente' && (
            <div className={cn('text-[11px] px-2.5 py-1.5 rounded',
              registroAtual.status === 'auditado' ? 'bg-green-500/20 text-green-300' : 'bg-amber-500/20 text-amber-300'
            )}>
              {registroAtual.status === 'auditado' ? '✓ Auditado' : '⤳ Pulado'}
              {registroAtual.observacao && ` — ${registroAtual.observacao}`}
            </div>
          )}

          {/* Severidade */}
          <div>
            <div className="text-[10px] text-slate-400 uppercase mb-1">Severidade</div>
            <div className="flex gap-1">
              {([
                { key: 'baixa' as const, label: 'Baixa', color: 'bg-green-600', active: 'bg-green-600 ring-2 ring-green-400' },
                { key: 'media' as const, label: 'Média', color: 'bg-yellow-600', active: 'bg-yellow-600 ring-2 ring-yellow-400' },
                { key: 'alta' as const, label: 'Alta', color: 'bg-red-600', active: 'bg-red-600 ring-2 ring-red-400' },
              ]).map(s => (
                <button
                  key={s.key}
                  onClick={() => setSeveridade(severidade === s.key ? '' : s.key)}
                  className={cn('flex-1 py-1.5 rounded text-[11px] text-white font-medium transition-all',
                    severidade === s.key ? s.active : s.color + ' opacity-50'
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Observação */}
          <div>
            <div className="text-[10px] text-slate-400 uppercase mb-1">Observação</div>
            <textarea
              value={observacao}
              onChange={e => setObservacao(e.target.value)}
              placeholder="O que precisa ser corrigido?"
              className="w-full px-2.5 py-2 bg-[#161922] border border-slate-700 rounded text-white text-xs h-24 resize-none focus:outline-none focus:border-slate-500"
            />
          </div>

          {/* Salvar */}
          <div className="flex gap-1.5">
            <button
              onClick={() => handleSave(true)}
              disabled={saving}
              className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white text-xs rounded font-medium flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              Salvar e próximo
            </button>
            <button
              onClick={() => handleSave(false)}
              disabled={saving}
              className="px-2.5 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs rounded disabled:opacity-50"
            >
              Salvar
            </button>
          </div>

          {/* Pular */}
          <div className="flex gap-1.5">
            <input
              value={motivoSkip}
              onChange={e => setMotivoSkip(e.target.value)}
              placeholder="motivo skip"
              className="flex-1 px-2 py-1.5 bg-[#161922] border border-slate-700 rounded text-white text-[11px] focus:outline-none focus:border-slate-500"
            />
            <button onClick={handleSkip} disabled={saving} className="px-2.5 py-1.5 bg-amber-700/40 hover:bg-amber-700/60 text-amber-100 text-[11px] rounded flex items-center gap-1 disabled:opacity-50">
              <SkipForward size={11} /> Pular
            </button>
          </div>

          {/* Progress */}
          <div className="pt-1">
            <div className="flex gap-0.5">
              {registros.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => goTo(i)}
                  className={cn(
                    'h-1.5 flex-1 rounded-sm transition-colors',
                    i === posicao ? 'bg-white' :
                      r.status === 'auditado' ? 'bg-green-500' :
                        r.status === 'skipado' ? 'bg-amber-500' : 'bg-slate-600'
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="px-3 py-2 border-t border-slate-700 bg-[#161922]">
        <button onClick={handleConcluir} className="w-full py-2 bg-green-600 hover:bg-green-700 text-white text-xs rounded font-medium flex items-center justify-center gap-1.5">
          <Check size={12} /> Concluir sessão
        </button>
      </div>
    </div>
  );
};
