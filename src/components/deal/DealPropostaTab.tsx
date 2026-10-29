import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store";
import { supabase } from "../../lib/supabase";
import { FileText, Loader2, ExternalLink, RefreshCw, Send, Trash2, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import type { Deal } from "../../types";

// Aba "Proposta" do modal de negociação: gerador de propostas no Google Slides
// (edge proposta-gerar). A proposta nasce do deck EE 2026 + escopo/preço tirados
// da transcrição da reunião e fica em REVISÃO: o closer abre no Slides, ajusta
// e, só depois, envia ao cliente por conta própria. "Marcar como enviada" apenas
// registra o envio — o SalesHub NUNCA envia nada ao cliente.

export interface Proposta {
  id: string;
  deal_id: string;
  reuniao_id: string | null;
  origem: 'manual' | 'auto';
  status: 'pendente' | 'analisando' | 'gerando' | 'revisao' | 'erro' | 'enviada' | 'descartada';
  url: string | null;
  pendencias: string[];
  erro: string | null;
  visto_em: string | null;
  enviada_em: string | null;
  created_at: string;
}

const STATUS: Record<Proposta['status'], { label: string; cls: string }> = {
  pendente: { label: 'Na fila', cls: 'bg-yellow-500/20 text-yellow-400' },
  analisando: { label: 'Analisando a call', cls: 'bg-yellow-500/20 text-yellow-400' },
  gerando: { label: 'Gerando no Slides', cls: 'bg-yellow-500/20 text-yellow-400' },
  revisao: { label: 'Para revisar', cls: 'bg-blue-500/20 text-blue-400' },
  erro: { label: 'Erro', cls: 'bg-red-500/20 text-red-400' },
  enviada: { label: 'Enviada ao cliente', cls: 'bg-green-500/20 text-green-400' },
  descartada: { label: 'Descartada', cls: 'bg-gray-500/20 text-gray-400' },
};
const EM_ANDAMENTO = ['pendente', 'analisando', 'gerando'];

// Quantas propostas do deal estão para revisar e ainda não foram vistas (badge da aba).
export function usePropostasNaoVistas(dealId?: string) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!dealId) return;
    let vivo = true;
    supabase.from('propostas').select('id', { count: 'exact', head: true })
      .eq('deal_id', dealId).eq('status', 'revisao').is('visto_em', null)
      .then(({ count }) => { if (vivo) setN(count || 0); });
    return () => { vivo = false; };
  }, [dealId]);
  return n;
}

async function chamarEdge(body: Record<string, unknown>) {
  const { data: s } = await supabase.auth.getSession();
  const jwt = s.session?.access_token;
  if (!jwt) throw new Error('sem sessão');
  const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/proposta-gerar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

export const DealPropostaTab: React.FC<{ deal: Deal }> = ({ deal }) => {
  const { reunioes, currentUser } = useAppStore();
  const [propostas, setPropostas] = useState<Proposta[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [reuniaoId, setReuniaoId] = useState('');
  const [colar, setColar] = useState(false);
  const [texto, setTexto] = useState('');
  const [autoAtivo, setAutoAtivo] = useState<boolean | null>(null);
  const ehGestor = currentUser?.role === 'gestor';

  const realizadas = useMemo(() => reunioes
    .filter(r => r.realizada && r.show && (r.deal_id === deal.id || (deal.lead_id && r.lead_id === deal.lead_id) || (deal.reuniao_id && r.id === deal.reuniao_id)))
    .sort((a, b) => (b.data_reuniao || '').localeCompare(a.data_reuniao || '')), [reunioes, deal]);

  const carregar = useCallback(async () => {
    const { data, error } = await supabase.from('propostas')
      .select('id, deal_id, reuniao_id, origem, status, url, pendencias, erro, visto_em, enviada_em, created_at')
      .eq('deal_id', deal.id).order('created_at', { ascending: false });
    if (error) toast.error(`Propostas: ${error.message}`);
    setPropostas((data as Proposta[]) || []);
    setCarregando(false);
  }, [deal.id]);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    supabase.from('propostas_config').select('auto_ativo').eq('id', true).maybeSingle()
      .then(({ data }) => setAutoAtivo(data?.auto_ativo ?? null));
  }, []);

  // Enquanto alguma estiver em andamento (ex.: gatilho automático), atualiza a cada 5 s.
  const emAndamento = propostas.some(p => EM_ANDAMENTO.includes(p.status));
  useEffect(() => {
    if (!emAndamento) return;
    const t = setInterval(carregar, 5000);
    return () => clearInterval(t);
  }, [emAndamento, carregar]);

  // Abrir a aba conta como "visto" para as propostas em revisão (some o aviso).
  useEffect(() => {
    const naoVistas = propostas.filter(p => p.status === 'revisao' && !p.visto_em).map(p => p.id);
    if (!naoVistas.length) return;
    supabase.from('propostas').update({ visto_em: new Date().toISOString() }).in('id', naoVistas).then(() => {});
  }, [propostas]);

  const gerar = async () => {
    setGerando(true);
    try {
      const r = await chamarEdge({
        action: 'gerar', deal_id: deal.id,
        reuniao_id: reuniaoId || null,
        transcricao_texto: colar && texto.trim() ? texto : null,
      });
      if (r.status === 'revisao') toast.success('Proposta gerada — revise no Google Slides antes de enviar.');
      else if (r.status === 'erro') toast.error(`Não gerou: ${r.erro}`);
      setTexto(''); setColar(false);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setGerando(false);
      carregar();
    }
  };

  const reprocessar = async (p: Proposta) => {
    try {
      const r = await chamarEdge({ action: 'reprocessar', proposta_id: p.id });
      if (r.status === 'erro') toast.error(`Não gerou: ${r.erro}`); else toast.success('Proposta gerada.');
    } catch (e: any) { toast.error(e.message); } finally { carregar(); }
  };

  const mudarStatus = async (p: Proposta, status: 'enviada' | 'descartada') => {
    const msg = status === 'enviada'
      ? 'Isto só REGISTRA que você já enviou a proposta ao cliente (o SalesHub não envia nada). Confirmar?'
      : 'Descartar esta proposta? O arquivo continua no seu Drive.';
    if (!window.confirm(msg)) return;
    const { error } = await supabase.from('propostas').update({ status }).eq('id', p.id);
    if (error) toast.error(error.message); else toast.success(status === 'enviada' ? 'Envio registrado.' : 'Proposta descartada.');
    carregar();
  };

  const alternarAuto = async () => {
    if (autoAtivo === null) return;
    const { error } = await supabase.from('propostas_config').update({ auto_ativo: !autoAtivo, updated_at: new Date().toISOString() }).eq('id', true);
    if (error) toast.error(error.message); else setAutoAtivo(!autoAtivo);
  };

  const inputCls = "w-full bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg px-3 py-2 text-sm text-white";

  return (
    <div className="space-y-4">
      <div className="bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-white"><FileText size={16} /> Gerar proposta (Google Slides)</div>
        <p className="text-xs text-[var(--color-v4-text-muted)]">
          Usa o deck oficial EE 2026 e monta escopo, plano e preço a partir da transcrição da reunião. A proposta fica para
          você revisar e editar no Slides; o envio ao cliente é sempre feito por você.
        </p>
        <div>
          <label className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">Reunião</label>
          <select value={reuniaoId} onChange={e => setReuniaoId(e.target.value)} className={inputCls}>
            <option value="">Mais recente com transcrição</option>
            {realizadas.map(r => (
              <option key={r.id} value={r.id}>{(r.data_reuniao || '').slice(0, 10)} · {r.tipo === 'retorno' ? 'Retorno' : 'Reunião'}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-[var(--color-v4-text-muted)]">
          <input type="checkbox" checked={colar} onChange={e => setColar(e.target.checked)} /> Colar a transcrição (quando o Meet não gravou)
        </label>
        {colar && <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={6} className={inputCls} placeholder="Cole aqui a transcrição da call" />}
        <button onClick={gerar} disabled={gerando || emAndamento}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] text-white text-sm disabled:opacity-50">
          {gerando ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
          {gerando ? 'Gerando (até 2 min)…' : 'Gerar proposta'}
        </button>
        {ehGestor && autoAtivo !== null && (
          <label className="flex items-center gap-2 text-xs text-[var(--color-v4-text-muted)] pt-2 border-t border-[var(--color-v4-border)]">
            <input type="checkbox" checked={autoAtivo} onChange={alternarAuto} />
            Gerar automaticamente depois da análise da call (teste — vale para todos os deals)
          </label>
        )}
      </div>

      {carregando ? (
        <div className="flex justify-center py-6"><Loader2 className="animate-spin text-[var(--color-v4-text-muted)]" /></div>
      ) : propostas.length === 0 ? (
        <p className="text-xs text-[var(--color-v4-text-muted)]">Nenhuma proposta gerada para este deal.</p>
      ) : (
        <div className="space-y-3">
          {propostas.map(p => (
            <div key={p.id} className="border border-[var(--color-v4-border)] rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`px-2 py-0.5 rounded-full ${STATUS[p.status].cls}`}>{STATUS[p.status].label}</span>
                  <span className="text-[var(--color-v4-text-muted)]">
                    {new Date(p.created_at).toLocaleString('pt-BR')} · {p.origem === 'auto' ? 'automática' : 'manual'}
                  </span>
                </div>
                {EM_ANDAMENTO.includes(p.status) && <Loader2 size={14} className="animate-spin text-yellow-400" />}
              </div>
              {p.url && (
                <a href={p.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-blue-400 hover:underline">
                  <ExternalLink size={14} /> Abrir no Google Slides
                </a>
              )}
              {p.pendencias?.length > 0 && p.status === 'revisao' && (
                <div className="text-xs bg-yellow-500/10 border border-yellow-500/30 rounded p-2 text-yellow-300">
                  <div className="flex items-center gap-1 font-medium mb-1"><AlertTriangle size={12} /> Complete antes de enviar:</div>
                  <ul className="list-disc ml-4 space-y-0.5">{p.pendencias.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              )}
              {p.erro && <p className={`text-xs ${p.status === 'erro' ? 'text-red-400' : 'text-[var(--color-v4-text-muted)]'}`}>{p.erro}</p>}
              {p.enviada_em && <p className="text-xs text-green-400">Envio registrado em {new Date(p.enviada_em).toLocaleString('pt-BR')}</p>}
              <div className="flex gap-2">
                {p.status === 'revisao' && (
                  <button onClick={() => mudarStatus(p, 'enviada')} className="flex items-center gap-1 px-3 py-1.5 rounded bg-green-600/20 text-green-400 text-xs hover:bg-green-600/30">
                    <Send size={12} /> Marcar como enviada
                  </button>
                )}
                {p.status === 'erro' && (
                  <button onClick={() => reprocessar(p)} className="flex items-center gap-1 px-3 py-1.5 rounded bg-[var(--color-v4-card-hover)] text-white text-xs">
                    <RefreshCw size={12} /> Tentar de novo
                  </button>
                )}
                {['revisao', 'erro'].includes(p.status) && (
                  <button onClick={() => mudarStatus(p, 'descartada')} className="flex items-center gap-1 px-3 py-1.5 rounded text-[var(--color-v4-text-muted)] text-xs hover:text-red-400">
                    <Trash2 size={12} /> Descartar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
