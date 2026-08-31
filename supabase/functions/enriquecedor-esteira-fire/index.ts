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
//   {secret, acao:'fire',     leadId}    → login integração + POST /api/esteira no motor (202)
//   {secret, acao:'status',   leadIds[]} → status atual dos leads (p/ o runner serializar o lote)
//   {secret, acao:'importar', leadIds[]} → POST /api/cadencia/importar-kommo (cria card no
//                                          funil Outbound Cadência SDNA, etapa Fila — nada
//                                          é enviado: o Passo 1 é manual, arrastando o card)
//   {secret, acao:'campos'}              → lista os custom fields de lead do Kommo (nome→id)
//   {secret, acao:'card-prep', kommoLeadId, nome?, tags?[], campos?[{field_id,value,enum_id?}],
//            nota?}                       → completa UM card: renomeia, aplica tags, preenche
//                                          custom fields e posta nota (paths fixos da API v4;
//                                          o KOMMO_API_TOKEN só existe no env das functions)
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

  const KOMMO_SUB = Deno.env.get('KOMMO_SUBDOMAIN') || 'financeirorustonengenhariacombr'
  const kommoApi = async (method: string, path: string, payload?: unknown) => {
    const r = await fetch(`https://${KOMMO_SUB}.kommo.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'content-type': 'application/json' },
      body: payload != null ? JSON.stringify(payload) : undefined,
    })
    const txt = await r.text()
    let parsed: unknown = null
    try { parsed = txt ? JSON.parse(txt) : null } catch { parsed = txt }
    return { ok: r.ok, status: r.status, body: parsed as any }
  }

  // Renova o OAuth do Kommo server-side (mesmo fluxo do src/lib/kommoChat.ts, que só
  // roda no navegador) e grava os tokens novos no integracao_config. Os tokens nunca
  // saem daqui — a resposta só traz statuses. Uso: incidente de token expirado/rotacionado.
  if (body.acao === 'kommo-refresh') {
    const { data: rt } = await sb.from('integracao_config').select('value').eq('key', 'kommo_refresh_token').maybeSingle()
    if (!rt?.value) return json(500, { error: 'kommo_refresh_token ausente no integracao_config' })
    const r = await fetch(`https://${KOMMO_SUB}.kommo.com/oauth2/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: Deno.env.get('KOMMO_CLIENT_ID'),
        client_secret: Deno.env.get('KOMMO_CLIENT_SECRET'),
        grant_type: 'refresh_token',
        refresh_token: rt.value,
        redirect_uri: 'https://gestao-comercial-rosy.vercel.app',
      }),
    })
    const tokens = await r.json().catch(() => null)
    if (!r.ok || !tokens?.access_token) {
      return json(502, { ok: false, kommo_status: r.status, detalhe: tokens ? { hint: tokens.hint, title: tokens.title, status: tokens.status } : null })
    }
    const { error: upErr } = await sb.from('integracao_config').upsert([
      { key: 'kommo_access_token', value: tokens.access_token },
      { key: 'kommo_refresh_token', value: tokens.refresh_token },
    ], { onConflict: 'key' })
    const chk = await fetch(`https://${KOMMO_SUB}.kommo.com/api/v4/account`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    return json(200, { ok: true, gravado: !upErr, erro_gravacao: upErr?.message ?? null, account_check: chk.status, expires_in: tokens.expires_in })
  }

  // Ponte pro MOTOR (Railway), que tem token Kommo próprio e vivo: enquanto o token
  // das edges não for reposto, as operações de card saem por lá. Auth = login do
  // usuário de integração, igual à esteira.
  if (body.acao === 'motor-campos' || body.acao === 'motor-card-prep' || body.acao === 'motor-token-heal') {
    const { data: sess, error: authErr } = await sb.auth.signInWithPassword({
      email: Deno.env.get('ENRIQ_INTEG_EMAIL')!,
      password: Deno.env.get('ENRIQ_INTEG_SENHA')!,
    })
    if (authErr || !sess?.session) return json(500, { error: `auth integração falhou: ${authErr?.message}` })
    const rota = body.acao === 'motor-campos' ? '/api/kommo/campos'
      : body.acao === 'motor-card-prep' ? '/api/kommo/card-prep'
      : '/api/kommo/token-heal'
    const payload = body.acao === 'motor-card-prep'
      ? { kommoLeadId: body.kommoLeadId, nome: body.nome, tags: body.tags, campos: body.campos, nota: body.nota }
      : {}
    const r = await fetch(`${MOTOR_URL}${rota}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const rb = await r.json().catch(() => null)
    return json(r.ok ? 200 : 502, { ok: r.ok, motor_status: r.status, resultado: rb })
  }

  if (body.acao === 'campos') {
    const out: Array<{ id: number; name: string; type: string; enums?: unknown }> = []
    let debug: unknown = null
    for (let page = 1; page <= 4; page++) {
      const r = await kommoApi('GET', `/api/v4/leads/custom_fields?limit=250&page=${page}`)
      const items = r.body?._embedded?.custom_fields ?? []
      if (!items.length && !out.length) debug = { status: r.status, corpo: JSON.stringify(r.body).slice(0, 300) }
      for (const f of items) out.push({ id: f.id, name: f.name, type: f.type, enums: f.enums ?? undefined })
      if (items.length < 250) break
    }
    return json(200, { ok: true, campos: out, debug })
  }

  // Atribui responsável em massa (bulk PATCH da v4, 40 cards por chamada).
  // {secret, acao:'atribuir', pares:[{kommoLeadId, userId}]}
  if (body.acao === 'atribuir') {
    const pares = Array.isArray(body.pares) ? body.pares : []
    if (!pares.length) return json(400, { error: 'pares obrigatório' })
    const resultados: Array<{ lote: number; ok: boolean; status: number }> = []
    for (let i = 0; i < pares.length; i += 40) {
      const lote = pares.slice(i, i + 40).map((p: any) => ({
        id: Number(p.kommoLeadId),
        responsible_user_id: Number(p.userId),
      }))
      const r = await kommoApi('PATCH', '/api/v4/leads', lote)
      resultados.push({ lote: i / 40 + 1, ok: r.ok, status: r.status })
      await new Promise((res) => setTimeout(res, 400))
    }
    return json(200, { ok: resultados.every((r) => r.ok), resultados })
  }

  if (body.acao === 'card-prep') {
    const kommoLeadId = Number(body.kommoLeadId)
    if (!kommoLeadId) return json(400, { error: 'kommoLeadId obrigatório' })
    const resultado: Record<string, unknown> = {}

    const patch: Record<string, unknown> = {}
    if (body.nome) patch.name = String(body.nome).slice(0, 250)
    if (Array.isArray(body.tags) && body.tags.length) {
      patch._embedded = { tags: body.tags.map((t: unknown) => ({ name: String(t).slice(0, 60) })) }
    }
    if (Array.isArray(body.campos) && body.campos.length) {
      patch.custom_fields_values = body.campos.map((c: any) => ({
        field_id: Number(c.field_id),
        values: [c.enum_id != null ? { enum_id: Number(c.enum_id) } : { value: c.value }],
      }))
    }
    if (Object.keys(patch).length) {
      const r = await kommoApi('PATCH', `/api/v4/leads/${kommoLeadId}`, patch)
      resultado.patch = { ok: r.ok, status: r.status, detalhe: r.ok ? undefined : r.body }
    }

    if (body.nota) {
      const r = await kommoApi('POST', `/api/v4/leads/${kommoLeadId}/notes`, [
        { note_type: 'common', params: { text: String(body.nota).slice(0, 15000) } },
      ])
      resultado.nota = { ok: r.ok, status: r.status, detalhe: r.ok ? undefined : r.body }
    }

    return json(200, { ok: true, resultado })
  }

  if (body.acao === 'importar') {
    const ids = Array.isArray(body.leadIds) ? body.leadIds.map(String).slice(0, 200) : []
    if (!ids.length) return json(400, { error: 'leadIds obrigatório' })
    const { data: sess, error: authErr } = await sb.auth.signInWithPassword({
      email: Deno.env.get('ENRIQ_INTEG_EMAIL')!,
      password: Deno.env.get('ENRIQ_INTEG_SENHA')!,
    })
    if (authErr || !sess?.session) return json(500, { error: `auth integração falhou: ${authErr?.message}` })
    const r = await fetch(`${MOTOR_URL}/api/cadencia/importar-kommo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sess.session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ leadIds: ids }),
    })
    const rb = await r.json().catch(() => null)
    return json(r.ok ? 200 : 502, { ok: r.ok, motor_status: r.status, resultado: rb })
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
