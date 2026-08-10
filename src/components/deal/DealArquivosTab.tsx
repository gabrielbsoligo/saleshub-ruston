import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { FileText, ExternalLink, Sparkles, Loader2, RefreshCw, Mic, Receipt, FileSignature } from "lucide-react";
import toast from "react-hot-toast";
import type { Deal } from "../../types";

// Aba "Arquivos" do modal de negociação:
//  - transcrições das reuniões do deal/lead (reuniao_transcricoes, populada pelo Google Drive)
//  - contrato + comprovante anexados no Fechamento
//  - FERRAMENTAS: dispara a rotina de diagnóstico (transcrição -> apresentação/personas);
//    o arquivo gerado volta pela edge deal-diagnostico e aparece aqui.
interface Transcricao {
  id: string; reuniao_id: string; titulo?: string;
  transcript_url?: string; recording_url?: string; transcript_text?: string;
  started_at?: string; created_at: string;
}
interface Diagnostico {
  id: string; status: string; arquivo_url?: string; arquivo_filename?: string;
  routine_session_url?: string; error_message?: string; created_at: string; completed_at?: string;
}

export const DealArquivosTab: React.FC<{ deal: Deal }> = ({ deal }) => {
  const [transcricoes, setTranscricoes] = useState<Transcricao[]>([]);
  const [diagnosticos, setDiagnosticos] = useState<Diagnostico[]>([]);
  const [loading, setLoading] = useState(true);
  const [gerando, setGerando] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const orClauses = [`deal_id.eq.${deal.id}`];
      if (deal.lead_id) orClauses.push(`lead_id.eq.${deal.lead_id}`);
      const { data: rs } = await supabase.from('reunioes').select('id').or(orClauses.join(','));
      const rids = (rs || []).map(r => r.id);
      if (deal.reuniao_id && !rids.includes(deal.reuniao_id)) rids.push(deal.reuniao_id);

      const [trs, diags] = await Promise.all([
        rids.length
          ? supabase.from('reuniao_transcricoes')
              .select('id, reuniao_id, titulo, transcript_url, recording_url, transcript_text, started_at, created_at')
              .in('reuniao_id', rids).order('created_at', { ascending: false })
          : Promise.resolve({ data: [] } as any),
        supabase.from('deal_diagnosticos')
          .select('id, status, arquivo_url, arquivo_filename, routine_session_url, error_message, created_at, completed_at')
          .eq('deal_id', deal.id).order('created_at', { ascending: false }),
      ]);
      setTranscricoes(trs.data || []);
      setDiagnosticos(diags.data || []);
    } finally { setLoading(false); }
  }, [deal.id, deal.lead_id, deal.reuniao_id]);

  useEffect(() => { load(); }, [load]);

  const gerarDiagnostico = async () => {
    if (gerando) return;
    setGerando(true);
    const t = toast.loading('Disparando rotina de diagnóstico...');
    try {
      const { data, error } = await supabase.functions.invoke('deal-diagnostico', {
        body: { action: 'fire', deal_id: deal.id },
      });
      if (error) {
        const ctx = await (error as any)?.context?.json?.().catch(() => null);
        throw new Error(ctx?.error || error.message);
      }
      if (data?.error) throw new Error(data.error);
      toast.success('Rotina disparada! O diagnóstico aparece aqui quando ficar pronto.', { id: t, icon: '✨', duration: 6000 });
      await load();
    } catch (e: any) {
      toast.error('Erro: ' + (e.message || 'falha ao disparar'), { id: t, duration: 8000 });
    } finally { setGerando(false); }
  };

  const dataFmt = (s?: string) => s ? new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
  const row = "flex items-center gap-3 p-3 rounded-xl bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)]";

  return (
    <>
      {/* FERRAMENTAS */}
      <div className="bg-purple-500/5 border border-purple-500/20 rounded-xl p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-bold text-purple-400 uppercase tracking-wider">Ferramentas</h4>
            <p className="text-[11px] text-[var(--color-v4-text-muted)] mt-1">
              Gera a análise de diagnóstico do negócio (personas, benchmark etc.) a partir da transcrição da reunião.
            </p>
          </div>
          <button type="button" onClick={gerarDiagnostico} disabled={gerando}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/30 disabled:opacity-50 flex-shrink-0">
            {gerando ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Gerar diagnóstico
          </button>
        </div>
        {diagnosticos.length > 0 && (
          <div className="mt-3 space-y-2">
            {diagnosticos.map(d => (
              <div key={d.id} className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-[var(--color-v4-card)]">
                {d.status === 'processing' && <Loader2 size={12} className="text-purple-400 animate-spin flex-shrink-0" />}
                {d.status === 'completed' && <Sparkles size={12} className="text-green-400 flex-shrink-0" />}
                {d.status === 'error' && <span className="text-red-400 flex-shrink-0">✕</span>}
                <span className="text-white flex-1 truncate">
                  Diagnóstico {dataFmt(d.created_at)} — {d.status === 'processing' ? 'gerando...' : d.status === 'completed' ? (d.arquivo_filename || 'pronto') : 'erro'}
                </span>
                {d.status === 'error' && d.error_message && (
                  <span className="text-[10px] text-red-400 truncate max-w-[140px]" title={d.error_message}>{d.error_message}</span>
                )}
                {d.arquivo_url && (
                  <a href={d.arquivo_url} target="_blank" rel="noopener" className="text-blue-400 hover:underline flex items-center gap-1 flex-shrink-0">
                    abrir <ExternalLink size={10} />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ARQUIVOS */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-[var(--color-v4-text-muted)] uppercase tracking-wider">Arquivos vinculados</h4>
        <button type="button" onClick={load}
          className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--color-v4-text-muted)] hover:text-white">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> atualizar
        </button>
      </div>

      <div className="space-y-2">
        {transcricoes.map(tr => (
          <div key={tr.id} className={row}>
            <Mic size={15} className="text-cyan-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-white truncate">{tr.titulo || 'Transcrição da reunião'}</p>
              <p className="text-[10px] text-[var(--color-v4-text-muted)]">{dataFmt(tr.started_at || tr.created_at)} · Google Meet</p>
            </div>
            {tr.transcript_url && (
              <a href={tr.transcript_url} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline flex-shrink-0">transcrição</a>
            )}
            {tr.recording_url && (
              <a href={tr.recording_url} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline flex-shrink-0">gravação</a>
            )}
          </div>
        ))}

        {deal.link_transcricao && transcricoes.length === 0 && (
          <div className={row}>
            <Mic size={15} className="text-cyan-400 flex-shrink-0" />
            <p className="text-xs text-white flex-1 truncate">Transcrição (link no deal)</p>
            <a href={deal.link_transcricao} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline flex-shrink-0">abrir</a>
          </div>
        )}

        {deal.contrato_url && (
          <div className={row}>
            <FileSignature size={15} className="text-green-400 flex-shrink-0" />
            <p className="text-xs text-white flex-1 truncate">{deal.contrato_filename || 'Contrato PDF'}</p>
            <a href={deal.contrato_url} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline flex-shrink-0">abrir</a>
          </div>
        )}

        {deal.comprovante_url && (
          <div className={row}>
            <Receipt size={15} className="text-emerald-400 flex-shrink-0" />
            <p className="text-xs text-white flex-1 truncate">{deal.comprovante_filename || 'Comprovante de pagamento'}</p>
            <a href={deal.comprovante_url} target="_blank" rel="noopener" className="text-[10px] text-blue-400 hover:underline flex-shrink-0">abrir</a>
          </div>
        )}

        {!loading && transcricoes.length === 0 && !deal.link_transcricao && !deal.contrato_url && !deal.comprovante_url && (
          <div className="text-center py-8">
            <FileText size={22} className="mx-auto text-[var(--color-v4-text-muted)] mb-2" />
            <p className="text-sm text-[var(--color-v4-text-muted)]">Nenhum arquivo vinculado ainda.</p>
            <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-1">Transcrições aparecem depois de buscadas no Drive; contrato e comprovante entram pela aba Fechamento.</p>
          </div>
        )}
      </div>
    </>
  );
};
