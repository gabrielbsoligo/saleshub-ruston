import React, { useMemo, useState } from "react";
import { useAppStore } from "../../store";
import { AgendarReuniaoModal } from "../AgendarReuniaoModal";
import { Calendar, Video, Plus, RefreshCw } from "lucide-react";
import type { Deal, Reuniao } from "../../types";

// Aba "Reuniões" do modal de negociação: todas as reuniões que houve com o lead
// (a agenda do SalesHub sincroniza com o Google Calendar na criação — a lista é viva,
// vem do store e recarrega com fetchReunioes). Botão agenda REUNIÃO DE RETORNO:
// mesmo fluxo de criação (Calendar + Meet), mas tipo='retorno' — não conta como
// reunião nova de SDR/closer, não cria negociação ao confirmar, e se o deal estiver
// em "Marcar call proposta" ele move sozinho pra "Call proposta agendada".
export const DealReunioesTab: React.FC<{ deal: Deal }> = ({ deal }) => {
  const { reunioes, leads, addReuniao, fetchReunioes, currentUser } = useAppStore();
  const [agendando, setAgendando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);

  const lead = deal.lead_id ? leads.find(l => l.id === deal.lead_id) : undefined;

  const doDeal = useMemo(() => {
    const list = reunioes.filter(r =>
      r.deal_id === deal.id ||
      (deal.lead_id && r.lead_id === deal.lead_id) ||
      (deal.reuniao_id && r.id === deal.reuniao_id)
    );
    return list.sort((a, b) => (b.data_reuniao || b.created_at || '').localeCompare(a.data_reuniao || a.created_at || ''));
  }, [reunioes, deal]);

  const statusReuniao = (r: Reuniao) => {
    if (!r.realizada) return { label: 'Agendada', cls: 'bg-yellow-500/20 text-yellow-400' };
    if (r.show) return { label: 'Realizada', cls: 'bg-green-500/20 text-green-400' };
    return { label: 'No-show', cls: 'bg-red-500/20 text-red-400' };
  };

  const handleAgendarRetorno = async (iso: string, closerId: string, extras?: string[], leadEmail?: string) => {
    try {
      await addReuniao({
        tipo: 'retorno',
        deal_id: deal.id,
        lead_id: deal.lead_id || undefined,
        empresa: deal.empresa,
        nome_contato: lead?.nome_contato || undefined,
        canal: (deal.origem as any) || lead?.canal || undefined,
        kommo_id: deal.kommo_id || lead?.kommo_id || undefined,
        closer_id: closerId,
        sdr_id: currentUser?.id,
        data_reuniao: iso,
        data_agendamento: new Date().toISOString().split('T')[0],
        lead_email: leadEmail,
        participantes_extras: extras as any,
      } as any);
    } finally {
      setAgendando(false);
    }
  };

  const handleSync = async () => {
    setSincronizando(true);
    try { await fetchReunioes(); } finally { setSincronizando(false); }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-v4-text-muted)]">Reuniões com esse lead (sincronizadas com a agenda).</p>
        <div className="flex gap-2">
          <button type="button" onClick={handleSync}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-v4-text-muted)] hover:text-white border border-[var(--color-v4-border)]">
            <RefreshCw size={12} className={sincronizando ? 'animate-spin' : ''} /> Sincronizar
          </button>
          <button type="button" onClick={() => setAgendando(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-teal-500/20 text-teal-300 hover:bg-teal-500/30 border border-teal-500/30">
            <Plus size={12} /> Agendar retorno
          </button>
        </div>
      </div>

      {doDeal.length === 0 && (
        <div className="text-center py-10">
          <Calendar size={24} className="mx-auto text-[var(--color-v4-text-muted)] mb-2" />
          <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhuma reunião registrada com esse lead.</p>
        </div>
      )}

      <div className="space-y-2">
        {doDeal.map(r => {
          const st = statusReuniao(r);
          return (
            <div key={r.id} className="flex items-center gap-3 p-3 rounded-xl bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)]">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white font-medium">
                    {r.data_reuniao
                      ? new Date(r.data_reuniao).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                      : 'Sem data'}
                  </span>
                  {r.tipo === 'retorno' && (
                    <span className="px-1.5 py-0.5 rounded-full bg-teal-500/20 text-teal-300 text-[10px] font-bold">🔄 RETORNO</span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${st.cls}`}>{st.label}</span>
                </div>
                <p className="text-[11px] text-[var(--color-v4-text-muted)] mt-0.5 truncate">
                  Closer: {r.closer?.name?.split(' ')[0] || '—'} · Agendou: {r.sdr?.name?.split(' ')[0] || '—'}
                  {r.notas ? ` · ${r.notas}` : ''}
                </p>
              </div>
              {r.meet_link && !r.realizada && (
                <a href={r.meet_link} target="_blank" rel="noopener"
                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 text-blue-300 text-[10px] font-bold flex-shrink-0">
                  <Video size={11} /> Meet
                </a>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-[var(--color-v4-text-muted)]">
        🔄 Retornos não entram na contagem de reuniões dos SDRs/closers e nunca criam nova negociação —
        a confirmação só atualiza os registros desta negociação.
      </p>

      {agendando && lead && (
        <AgendarReuniaoModal
          lead={lead}
          retorno
          initialCloserId={deal.closer_id || ''}
          onConfirm={handleAgendarRetorno}
          onClose={() => setAgendando(false)}
        />
      )}
      {agendando && !lead && (
        <AgendarReuniaoModal
          lead={{ id: '', empresa: deal.empresa, canal: (deal.origem as any) || 'outbound', nome_contato: '' } as any}
          retorno
          initialCloserId={deal.closer_id || ''}
          onConfirm={handleAgendarRetorno}
          onClose={() => setAgendando(false)}
        />
      )}
    </>
  );
};
