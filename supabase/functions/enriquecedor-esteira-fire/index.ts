// enriquecedor-esteira-fire — dispara a esteira do MOTOR (Railway) para um lead
// que JÁ EXISTE no enriquecedor (uso ops: rodar lotes importados por planilha,
// como as construtoras de 08/08, que nunca passaram de F1).
//
// Por que existe: o motor exige JWT de usuário e o login de integração
// (ENRIQ_INTEG_EMAIL/SENHA) só está disponível no ambiente das edge functions —
// os valores não são recuperáveis pela API de management (vem hash). Esta função
// replica o disparo que a enriquecedor-kommo faz, mas SEM kommo_lead_id: a
// esteira roda inteira e não escreve nota nenhuma no Kommo.
//
// Ações (POST JSON, auth por body.secret === ESTEIRA_FIRE_SECRET):
//   {secret, acao:'fire',   leadId}    → login integração + POST /api/esteira no motor (202)
//   {secret, acao:'status', leadIds[]} → status atual dos leads (p/ o runner serializar o lote)
// Deploy: verify_jwt OFF.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MOTOR_URL = (Deno.env.get('ENRIQ_MOTOR_URL') || 'https://saleshub-ruston-production.up.railway.app').replace(/\/$/, '')

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'método não suportado' })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'JSON inválido' })
  }
  const secret = Deno.env.get('ESTEIRA_FIRE_SECRET') ?? ''
  if (!secret || body.secret !== secret) return json(401, { error: 'segredo inválido' })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  if (body.acao === 'status') {
    const ids = Array.isArray(body.leadIds) ? body.leadIds.map(String).slice(0, 200) : []
    if (!ids.length) return json(400, { error: 'leadIds obrigatório' })
    const { data, error } = await sb
      .from('enriquecedor_leads')
      .select('id, status, updated_at, briefing, anuncios')
      .in('id', ids)
    if (error) return json(500, { error: error.message })
    return json(200, {
      ok: true,
      leads: (data ?? []).map((l) => ({
        id: l.id,
        status: l.status,
        updated_at: l.updated_at,
        tem_briefing: l.briefing != null,
        tem_anuncios: l.anuncios != null,
      })),
    })
  }

  if (body.acao === 'fire') {
    const leadId = String(body.leadId ?? '').trim()
    if (!leadId) return json(400, { error: 'leadId obrigatório' })

    const { data: lead, error: leadErr } = await sb
      .from('enriquecedor_leads').select('id, status').eq('id', leadId).maybeSingle()
    if (leadErr) return json(500, { error: leadErr.message })
    if (!lead) return json(404, { error: 'lead não encontrado' })

    const { data: sess, error: authErr } = await sb.auth.signInWithPassword({
      email: Deno.env.get('ENRIQ_INTEG_EMAIL')!,
      password: Deno.env.get('ENRIQ_INTEG_SENHA')!,
    })
    if (authErr || !sess?.session) return json(500, { error: `auth integração falhou: ${authErr?.message}` })

    // Sem kommoLeadId de propósito: a esteira não posta nota nenhuma no Kommo.
    const r = await fetch(`${MOTOR_URL}/api/esteira`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leadId }),
    })
    const rb = await r.json().catch(() => null)
    return json(r.status === 202 || r.ok ? 200 : 502, {
      ok: r.status === 202 || r.ok,
      motor_status: r.status,
      motor_body: rb,
      status_anterior: lead.status,
    })
  }

  return json(400, { error: 'acao desconhecida (use fire ou status)' })
})
