// =============================================================
// Agente do 3C no cadastro do membro (migration_176)
// =============================================================
// O webhook-3c-calls resolve o responsável da tabulação "Follow" SÓ por
// team_members.agente_3c_id → kommo_user_id. Aqui: a lista de agentes do 3C
// (edge threec-agentes, só gestor), as pendências (agentes que tabularam sem
// usuário vinculado) e a checagem de duplicidade antes de salvar.
// =============================================================
import { supabase } from './supabase';
import type { TeamMember } from '../types';

export interface Agente3C { id: string; nome: string; ramal: string | null }
export interface Pendencia3C {
  agent_ref: string;
  agent_nome: string | null;
  motivo: 'agente_sem_cadastro' | 'agente_duplicado' | 'membro_sem_kommo';
  ocorrencias: number;
  ultima_em: string;
  ultimo_lead_kommo_id: number | null;
}

export const MOTIVO_LABEL: Record<Pendencia3C['motivo'], string> = {
  agente_sem_cadastro: 'sem usuário vinculado',
  agente_duplicado: 'em mais de um membro ativo',
  membro_sem_kommo: 'membro sem usuário do Kommo',
};

/** Outros membros ATIVOS com o mesmo agente (o banco recusa; a tela avisa antes). */
export function conflitosAgente(members: TeamMember[], memberId: string, agenteId: string | null | undefined): TeamMember[] {
  const ref = (agenteId ?? '').trim();
  if (!ref) return [];
  return members.filter((m) => m.id !== memberId && m.active && (m.agente_3c_id ?? '').trim() === ref);
}

export async function listarAgentes3C(): Promise<{ agentes: Agente3C[]; erro: string | null }> {
  try {
    const { data: s } = await supabase.auth.getSession();
    const jwt = s.session?.access_token;
    if (!jwt) return { agentes: [], erro: 'sem sessão' };
    const r = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/threec-agentes`, {
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${jwt}` },
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { agentes: [], erro: j?.erro || j?.error || `HTTP ${r.status}` };
    // lista parcial (uma página seguinte falhou): mostra o que veio E avisa — a digitação continua disponível
    return { agentes: j.agentes ?? [], erro: j.incompleta ? (j.erro || 'lista incompleta') : null };
  } catch (e: any) {
    return { agentes: [], erro: e?.message || 'falha ao listar agentes do 3C' };
  }
}

export async function listarPendencias3C(): Promise<Pendencia3C[]> {
  const { data } = await supabase
    .from('ligacoes_agente_pendencias_abertas')
    .select('agent_ref, agent_nome, motivo, ocorrencias, ultima_em, ultimo_lead_kommo_id')
    .order('ultima_em', { ascending: false });
  return (data as Pendencia3C[]) ?? [];
}
