import React, { useState } from 'react';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';
import {
  snapshotDeal,
  snapshotLead,
} from '../lib/auditoriaSnapshot';
import type { AuditoriaSessaoOrigem } from '../types';
import toast from 'react-hot-toast';

interface Item { tipo: 'lead' | 'deal'; id: string }

interface Props {
  items: Item[];
  origem: AuditoriaSessaoOrigem;
  filtros?: any;
  className?: string;
}

export const SendToAuditoriaButton: React.FC<Props> = ({ items, origem, filtros, className }) => {
  const { currentUser, leads, deals, members, reunioes } = useAppStore();
  const [loading, setLoading] = useState(false);

  if (!currentUser || currentUser.role !== 'gestor') return null;
  if (items.length === 0) return null;

  const handleClick = async () => {
    if (loading) return;
    if (!confirm(`Criar sessão de auditoria com ${items.length} item(s)?`)) return;
    setLoading(true);
    try {
      const { data: memberId } = await supabase.rpc('get_member_id');
      const nome = `Auditoria ${new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
      const { data: sessao, error: e1 } = await supabase
        .from('auditoria_sessoes')
        .insert({ nome, origem, filtros_aplicados: filtros || null, criado_por: memberId })
        .select('id')
        .single();
      if (e1) throw e1;

      const rows = items.map((it, idx) => {
        let snap: any = null;
        let responsavel_id: string | null = null;
        if (it.tipo === 'lead') {
          const lead = leads.find(l => l.id === it.id);
          if (lead) {
            snap = snapshotLead(lead, members, reunioes, deals);
            responsavel_id = lead.sdr_id || null;
          }
        } else {
          const deal = deals.find(d => d.id === it.id);
          if (deal) {
            snap = snapshotDeal(deal, members, reunioes, leads);
            responsavel_id = deal.closer_id || deal.sdr_id || null;
          }
        }
        return {
          sessao_id: sessao.id,
          item_tipo: it.tipo,
          item_id: it.id,
          posicao: idx,
          status: 'pendente',
          snapshot_saleshub: snap,
          responsavel_id,
        };
      });

      const { error: e2 } = await supabase.from('auditoria_registros').insert(rows);
      if (e2) throw e2;

      toast.success(`Sessão criada com ${items.length} item(s).`);
      // Forçar troca de view via custom event
      window.dispatchEvent(new CustomEvent('saleshub:open-auditoria', { detail: { sessionId: sessao.id } }));
    } catch (err: any) {
      toast.error('Falha: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className={className || 'px-3 py-2 rounded-lg text-sm bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-2 disabled:opacity-50'}
      title={`Enviar ${items.length} item(s) para auditoria`}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
      Auditar ({items.length})
    </button>
  );
};
