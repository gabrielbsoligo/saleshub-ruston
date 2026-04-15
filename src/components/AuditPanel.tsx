// AuditPanel — componente standalone renderizado dentro do iframe no Kommo.
// Comunica com o bridge (parent) via postMessage.
// URL: /?audit_panel=1&session=<sessionId>
// Layout: Floating Card (opcao B)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);

  // Form state
  const [observacao, setObservacao] = useState('');
  const [severidade, setSeveridade] = useState<AuditoriaSeveridade | ''>('');
  const [motivoSkip, setMotivoSkip] = useState('');
  const [saving, setSaving] = useState(false);

  // Fetch — auth já foi restaurada pelo AuditPanelBootstrap (App.tsx).
  // Usa maybeSingle pra tratar 0 rows sem lançar PGRST116.
  const fetchAll = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    const [{ data: s, error: e1 }, { data: r, error: e2 }] = await Promise.all([
      supabase.from('auditoria_sessoes').select('*').eq('id', sessionId).maybeSingle(),
      supabase.from('auditoria_registros').select('*').eq('sessao_id', sessionId).order('posicao', { ascending: true }),
    ]);
    if (e1) {
      setFetchError(`Erro ao carregar sessão: ${e1.message}`);
      toast.error(e1.message);
      setLoading(false);
      return;
    }
    if (e2) {
      setFetchError(`Erro ao carregar registros: ${e2.message}`);
      toast.error(e2.message);
      setLoading(false);
      return;
    }
    if (!s) {
      // Sessão não encontrada (RLS ou deletada)
      setFetchError('Sessão não encontrada ou sem permissão. Clique em "Reabrir Kommo / reinjetar painel" no SalesHub.');
      setLoading(false);
      return;
    }
    setSessao(s as AuditoriaSessao);
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

  // Navegar Kommo ao trocar item — só se URL mudou
  const lastNavigatedId = useRef<string | null>(null);
  useEffect(() => {
    if (!itemAtual) return;
    const link = (itemAtual as any)?.kommo_link;
    const itemId = (itemAtual as any)?.id;
    if (link && itemId && itemId !== lastNavigatedId.current) {
      lastNavigatedId.current = itemId;
      postToParent({ action: 'check-url-then-navigate', kommoUrl: link });
    }
    postToParent({ action: 'extract' });
  }, [itemAtual?.id]);

  // Ouvir mensagens do bridge
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!ev.data || ev.data.source !== 'kommo-bridge') return;
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
    if (!observacao.trim()) { toast.error('Observacao obrigatoria'); return; }
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
    toast.success('Sessao concluida!');
    postToParent({ action: 'close' });
  };

  const handleClose = () => postToParent({ action: 'close' });

  const handleDragStart = (e: React.MouseEvent) => {
    // Ignora se clicou num botão
    if ((e.target as HTMLElement).closest('button')) return;
    // Envia posição relativa ao iframe (o bridge calcula o offset real)
    postToParent({
      action: 'drag-start',
      offsetX: e.clientX,
      offsetY: e.clientY,
    });
  };

  const toggleMinimize = () => {
    const next = !minimized;
    setMinimized(next);
    postToParent({ action: next ? 'minimize' : 'maximize' });
  };

  const storeLoading = isLoadingAuth || !currentUser;

  // --- STYLES ---
  const S = {
    root: {
      height: '100%', display: 'flex', flexDirection: 'column' as const,
      background: '#0f1117', color: '#fff', fontFamily: 'system-ui, -apple-system, sans-serif',
      borderRadius: 16, overflow: 'hidden',
    },
    header: {
      padding: '10px 12px', background: '#161922',
      borderBottom: '1px solid #2a3040',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      cursor: 'grab', userSelect: 'none' as const, minHeight: 44,
    },
    headerInfo: { display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 0, flex: 1 },
    leadName: { fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
    meta: { fontSize: 10, color: '#6b7280' },
    controls: { display: 'flex', gap: 3, flexShrink: 0 },
    ctrlBtn: {
      width: 24, height: 24, border: 'none', background: '#2a3040',
      color: '#9ca3af', borderRadius: 4, cursor: 'pointer', fontSize: 13,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    },
    body: { flex: 1, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column' as const, gap: 10 },
    sevRow: { display: 'flex', gap: 4 },
    sevBtn: (color: string, active: boolean) => ({
      flex: 1, padding: '7px 0', border: 'none', borderRadius: 8, fontSize: 11,
      fontWeight: 600, cursor: 'pointer', color: '#fff', background: color,
      opacity: active ? 1 : 0.35,
      boxShadow: active ? '0 0 0 2px rgba(255,255,255,0.25)' : 'none',
      transition: 'all 0.15s',
    }),
    textarea: {
      width: '100%', padding: '8px 10px', background: '#1a1f2e', border: '1px solid #2a3040',
      borderRadius: 8, color: '#fff', fontSize: 12, resize: 'none' as const, height: 64,
      outline: 'none', fontFamily: 'inherit',
    },
    btnSave: {
      flex: 1, padding: '10px 0', background: '#dc2626', border: 'none', borderRadius: 8,
      color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    },
    btnOnly: {
      padding: '10px 12px', background: '#2a3040', border: 'none', borderRadius: 8,
      color: '#9ca3af', fontSize: 11, cursor: 'pointer',
    },
    skipRow: { display: 'flex', gap: 4 },
    skipInput: {
      flex: 1, padding: '6px 8px', background: '#1a1f2e', border: '1px solid #2a3040',
      borderRadius: 6, color: '#fff', fontSize: 11, outline: 'none', fontFamily: 'inherit',
    },
    btnSkip: {
      padding: '6px 10px', background: 'rgba(180,130,0,0.25)', border: 'none', borderRadius: 6,
      color: '#fbbf24', fontSize: 11, cursor: 'pointer',
    },
    progress: { display: 'flex', gap: 2 },
    seg: (status: string, isCurrent: boolean) => ({
      flex: 1, height: 4, borderRadius: 2,
      background: isCurrent ? '#fff' : status === 'auditado' ? '#16a34a' : status === 'skipado' ? '#ca8a04' : '#2a3040',
      cursor: 'pointer',
    }),
    footer: {
      padding: '8px 12px', borderTop: '1px solid #2a3040', background: '#161922',
    },
    btnConcluir: {
      width: '100%', padding: '8px 0', background: '#15803d', border: 'none', borderRadius: 8,
      color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer',
    },
    // minimized
    miniRoot: {
      height: '100%', display: 'flex', alignItems: 'center', gap: 8,
      background: '#0f1117', color: '#fff', fontFamily: 'system-ui, sans-serif',
      borderRadius: 12, padding: '0 12px', cursor: 'pointer',
    },
    miniDot: { width: 8, height: 8, borderRadius: '50%', background: '#16a34a', flexShrink: 0 },
    miniText: { fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' as const },
    label: { fontSize: 10, color: '#5a6478', textTransform: 'uppercase' as const, letterSpacing: 0.3 },
    badge: (status: string) => ({
      fontSize: 10, padding: '3px 8px', borderRadius: 6,
      background: status === 'auditado' ? 'rgba(22,163,74,0.2)' : 'rgba(202,138,4,0.2)',
      color: status === 'auditado' ? '#86efac' : '#fde047',
    }),
  };

  // --- MINIMIZED ---
  if (minimized) {
    const totalDone = registros.filter(r => r.status !== 'pendente').length;
    return (
      <div style={S.miniRoot} onClick={toggleMinimize}>
        <div style={S.miniDot} />
        <span style={S.miniText}>Auditoria {totalDone}/{registros.length}</span>
      </div>
    );
  }

  // --- LOADING ---
  if (loading || storeLoading) {
    return (
      <div style={{ ...S.root, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#6b7280', fontSize: 12 }}>
          {storeLoading ? 'Carregando dados...' : 'Carregando...'}
        </div>
      </div>
    );
  }

  // --- ERROR (sessão não carregou ou RLS bloqueou) ---
  if (fetchError || !sessao) {
    return (
      <div style={{ ...S.root, alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center', gap: 10 }}>
        <div style={{ color: '#fbbf24', fontSize: 24 }}>⚠️</div>
        <div style={{ color: '#e5e7eb', fontSize: 12, lineHeight: 1.5 }}>
          {fetchError || 'Sessão não encontrada.'}
        </div>
        <button
          onClick={() => postToParent({ action: 'need-new-tokens' })}
          style={{
            padding: '8px 14px', background: '#dc2626', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', marginTop: 4,
          }}
        >
          Pedir tokens novos
        </button>
        <button
          onClick={() => fetchAll()}
          style={{
            padding: '6px 12px', background: '#2a3040', color: '#9ca3af',
            border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer',
          }}
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const totalDone = registros.filter(r => r.status !== 'pendente').length;
  const leadName = (itemAtual as any)?.empresa || (leads.length === 0 && deals.length === 0 ? 'Carregando...' : 'Item nao encontrado');

  return (
    <div style={S.root}>
      {/* Header — draggable area */}
      <div style={S.header} onMouseDown={handleDragStart}>
        <div style={S.headerInfo}>
          <div style={S.leadName}>{leadName}</div>
          <div style={S.meta}>
            Resp: {responsavel?.name || '—'} · {posicao + 1}/{registros.length} · {totalDone} feitos
          </div>
        </div>
        <div style={S.controls}>
          <button style={S.ctrlBtn} onClick={prev} disabled={posicao === 0} title="Anterior">&#8592;</button>
          <button style={S.ctrlBtn} onClick={next} disabled={posicao >= registros.length - 1} title="Proximo">&#8594;</button>
          <button style={S.ctrlBtn} onClick={toggleMinimize} title="Minimizar">&#8211;</button>
          <button style={{ ...S.ctrlBtn, color: '#ef4444' }} onClick={handleClose} title="Fechar">&#10005;</button>
        </div>
      </div>

      {/* Body */}
      {!registroAtual ? (
        <div style={{ ...S.body, alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
          Sessao vazia
        </div>
      ) : (
        <div style={S.body}>
          {/* Already done badge */}
          {registroAtual.status !== 'pendente' && (
            <div style={S.badge(registroAtual.status)}>
              {registroAtual.status === 'auditado' ? '✓ Auditado' : '⤳ Pulado'}
              {registroAtual.observacao && ` — ${registroAtual.observacao}`}
            </div>
          )}

          {/* Severidade */}
          <div>
            <div style={S.label}>Severidade</div>
            <div style={{ ...S.sevRow, marginTop: 4 }}>
              <button style={S.sevBtn('#16a34a', severidade === 'baixa')} onClick={() => setSeveridade(severidade === 'baixa' ? '' : 'baixa')}>Baixa</button>
              <button style={S.sevBtn('#ca8a04', severidade === 'media')} onClick={() => setSeveridade(severidade === 'media' ? '' : 'media')}>Media</button>
              <button style={S.sevBtn('#dc2626', severidade === 'alta')} onClick={() => setSeveridade(severidade === 'alta' ? '' : 'alta')}>Alta</button>
            </div>
          </div>

          {/* Observação */}
          <div>
            <div style={S.label}>Observacao</div>
            <textarea
              style={{ ...S.textarea, marginTop: 4 }}
              value={observacao}
              onChange={e => setObservacao(e.target.value)}
              placeholder="O que precisa ser corrigido?"
            />
          </div>

          {/* Save */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={S.btnSave} onClick={() => handleSave(true)} disabled={saving}>
              {saving ? '...' : '✓ Salvar e proximo'}
            </button>
            <button style={S.btnOnly} onClick={() => handleSave(false)} disabled={saving}>Salvar</button>
          </div>

          {/* Skip */}
          <div style={S.skipRow}>
            <input style={S.skipInput} value={motivoSkip} onChange={e => setMotivoSkip(e.target.value)} placeholder="motivo skip" />
            <button style={S.btnSkip} onClick={handleSkip} disabled={saving}>Pular</button>
          </div>

          {/* Progress */}
          <div style={S.progress}>
            {registros.map((r, i) => (
              <div key={r.id} style={S.seg(r.status, i === posicao)} onClick={() => goTo(i)} />
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={S.footer}>
        <button style={S.btnConcluir} onClick={handleConcluir}>✓ Concluir sessao</button>
      </div>
    </div>
  );
};
