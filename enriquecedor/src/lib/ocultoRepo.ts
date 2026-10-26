// Cliente oculto — leitura (Supabase, RLS de membro) e ações (edge cliente-oculto com o JWT da sessão).
import { supabase } from './supabase';

export type OcultoStatus = 'pendente' | 'enviada' | 'conversando' | 'aguardando_followup' | 'avaliando' | 'concluida' | 'erro' | 'cancelada';
export interface OcultoSessao {
  id: string; lead_id: string | null; concorrente: string | null; empresa: string; nicho: string | null; numero_alvo: string;
  persona: { nome?: string; contexto?: string; objetivo?: string } | null; status: OcultoStatus;
  iniciada_em: string | null; ultima_in_em: string | null; ultima_out_em: string | null; turnos_persona: number; max_turnos: number;
  metricas: { tempo_primeira_resposta_s?: number | null; respondeu?: boolean; followup_24h?: boolean; followup_48h?: boolean; followup_72h?: boolean } | null;
  fase?: 'ocioso' | 'enviando' | 'envio_incerto';
  notas: { tempo_resposta: number; qualificacao: number | null; proposta_preco: number | null; followup: number; tom: number | null; final: number | null; incompleta?: boolean } | null;
  parecer: string | null; avaliacao_ia: { pontos_fortes?: string[]; pontos_fracos?: string[] } | null; erro: string | null;
  criado_em: string; concluida_em: string | null;
}
export interface OcultoMensagem { id: number; sessao_id: string; direcao: 'in' | 'out'; texto: string; em: string }
export interface OcultoConfig { instancia: string; ativo: boolean; conectado: boolean; numero: string | null; max_turnos: number; janela_followup_h: number }

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

async function edge(body: Record<string, unknown>): Promise<any> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error('faça login no SalesHub');
  const r = await fetch(`${SUPABASE_URL}/functions/v1/cliente-oculto`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null } catch { j = { raw: txt } }
  if (!r.ok) throw new Error(j?.error || j?.erro || `HTTP ${r.status}`);
  return j;
}

export const ocultoRepo = {
  async config(): Promise<OcultoConfig | null> {
    const { data, error } = await supabase.from('oculto_config').select('*').eq('id', 1).maybeSingle();
    if (error) throw error; return (data as OcultoConfig) ?? null;
  },
  async sessoes(limite = 100): Promise<OcultoSessao[]> {
    const { data, error } = await supabase.from('oculto_sessoes').select('*').order('criado_em', { ascending: false }).limit(limite);
    if (error) throw error; return (data ?? []) as OcultoSessao[];
  },
  async sessoesDoLead(leadId: string): Promise<OcultoSessao[]> {
    const { data, error } = await supabase.from('oculto_sessoes').select('*').eq('lead_id', leadId).order('criado_em', { ascending: false });
    if (error) throw error; return (data ?? []) as OcultoSessao[];
  },
  async mensagens(sessaoId: string): Promise<OcultoMensagem[]> {
    const { data, error } = await supabase.from('oculto_mensagens').select('id, sessao_id, direcao, texto, em').eq('sessao_id', sessaoId).order('em');
    if (error) throw error; return (data ?? []) as OcultoMensagem[];
  },
  iniciar: (leadId: string, numero?: string, nicho?: string) => edge({ acao: 'iniciar', lead_id: leadId, numero, nicho }),
  cancelar: (sessaoId: string) => edge({ acao: 'cancelar', sessao_id: sessaoId }),
  instancia: (op: 'criar' | 'qr' | 'estado') => edge({ acao: 'instancia', op }),
  assinar(onChange: () => void) {
    const ch = supabase.channel('oculto_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oculto_sessoes' }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'oculto_mensagens' }, onChange)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  },
};
