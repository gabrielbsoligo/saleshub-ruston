// Responsável da tabulação "Follow" do 3C: SÓ o cadastro do usuário (migration_176).
// team_members.agente_3c_id → kommo_user_id, via RPC ligacoes_resolver_agente_3c (que também registra a
// pendência quando o agente não tem usuário vinculado). Sem mapa fixo, sem chute por nome.

export interface Responsavel {
  ok: boolean
  motivo?: string        // sem_agente | agente_sem_cadastro | agente_duplicado | membro_sem_kommo | erro_resolucao
  member_id?: string | null
  membro?: string | null
  kommo_user_id?: number | null
  agente: string | null
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }>

/** Nunca lança: falha da RPC = não troca o responsável (e loga). dry = só consulta, não registra pendência. */
export async function resolverResponsavel(
  supabase: { rpc: Rpc }, ch: any, leadId: number | null, dry: boolean,
): Promise<Responsavel> {
  const agente = ch?.agent?.id != null && String(ch.agent.id) !== '' ? String(ch.agent.id) : null
  try {
    const { data, error } = await supabase.rpc('ligacoes_resolver_agente_3c', {
      p_agent_id: agente ?? '', p_agent_nome: ch?.agent?.name ?? null,
      p_lead: leadId, p_call: ch?._id != null ? String(ch._id) : null, p_registrar: !dry,
    })
    if (error) throw new Error(error.message)
    const r: Responsavel = { ok: !!data?.ok, motivo: data?.motivo, member_id: data?.member_id ?? null, membro: data?.membro ?? null,
      kommo_user_id: data?.ok && data?.kommo_user_id != null ? Number(data.kommo_user_id) : null, agente }
    if (!r.ok) console.warn(`[3c ${ch?._id}] responsável mantido: ${r.motivo} (agente ${agente} ${ch?.agent?.name ?? ''})`)
    return r
  } catch (e) {
    console.error(`[3c ${ch?._id}] resolver agente`, String((e as Error)?.message ?? e).slice(0, 200))
    return { ok: false, motivo: 'erro_resolucao', kommo_user_id: null, agente }
  }
}

/** Patch do move "Follow": só inclui responsible_user_id quando o cadastro resolveu. */
export function patchFollow(base: Record<string, unknown>, r: Responsavel | null): Record<string, unknown> {
  return r?.ok && r.kommo_user_id ? { ...base, responsible_user_id: r.kommo_user_id } : { ...base }
}
