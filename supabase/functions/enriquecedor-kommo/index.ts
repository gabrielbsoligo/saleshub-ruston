// enriquecedor-kommo — recebe o disparo do widget da Kommo (lupinha → modal):
// cria o lead no ENRIQUECEDOR, devolve nota no card com o link de acompanhamento
// e aciona a esteira completa no motor (Railway), que ao final devolve outra
// nota com os ganchos de abordagem.
//
// Auth por segredo (ENRIQ_KOMMO_SECRET, header x-enriq-secret). Deploy --no-verify-jwt.
// Secrets usados: ENRIQ_KOMMO_SECRET, KOMMO_API_TOKEN, ENRIQ_INTEG_EMAIL,
// ENRIQ_INTEG_SENHA. Opcionais: KOMMO_SUBDOMAIN, ENRIQ_MOTOR_URL, ENRIQ_APP_URL.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-enriq-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

const KOMMO_SUB = Deno.env.get('KOMMO_SUBDOMAIN') || 'financeirorustonengenhariacombr'
const MOTOR_URL = (Deno.env.get('ENRIQ_MOTOR_URL') || 'https://saleshub-ruston-production.up.railway.app').replace(/\/$/, '')
const APP_URL = (Deno.env.get('ENRIQ_APP_URL') || 'https://gestao-comercial-rosy.vercel.app').replace(/\/$/, '')
const onlyDigits = (s: unknown) => String(s ?? '').replace(/\D/g, '')

async function kommoNote(leadId: string | number, text: string) {
  try {
    const r = await fetch(`https://${KOMMO_SUB}.kommo.com/api/v4/leads/${leadId}/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ note_type: 'common', params: { text } }]),
    })
    return r.ok
  } catch {
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'método não suportado' })
  if (req.headers.get('x-enriq-secret') !== Deno.env.get('ENRIQ_KOMMO_SECRET')) {
    return json(401, { error: 'segredo inválido' })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'JSON inválido' })
  }

  const cnpj = onlyDigits(body.cnpj)
  const kommoLeadId = String(body.kommo_lead_id ?? '').trim()
  const empresa = String(body.empresa ?? '').trim()
  const perfil = body.perfil === 'geral' ? 'geral' : 'construtoras'
  if (cnpj.length !== 14) return json(400, { error: 'CNPJ inválido (precisa de 14 dígitos)' })
  if (!kommoLeadId) return json(400, { error: 'kommo_lead_id obrigatório' })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  // Cria (ou reaproveita, por CNPJ) o lead no enriquecedor.
  const { data: existente } = await sb.from('enriquecedor_leads').select('id').eq('cnpj', cnpj).maybeSingle()
  let leadId: string
  if (existente?.id) {
    leadId = existente.id
    await sb.from('enriquecedor_leads').update({ kommo_lead_id: kommoLeadId, perfil, status: 'kommo_reenvio' }).eq('id', leadId)
  } else {
    const { data: novo, error } = await sb
      .from('enriquecedor_leads')
      .insert({
        cnpj_raw: cnpj,
        cnpj,
        company_name_raw: empresa || cnpj,
        perfil,
        status: 'kommo_recebido',
        kommo_lead_id: kommoLeadId,
      })
      .select('id')
      .single()
    if (error || !novo) return json(500, { error: `falha ao criar o lead: ${error?.message}` })
    leadId = novo.id
  }

  const link = `${APP_URL}/enriquecedor/#lead=${leadId}`

  // Nota 1: link de acompanhamento, na hora.
  await kommoNote(kommoLeadId, `ENRIQUECEDOR — lead em enriquecimento (${perfil === 'geral' ? 'perfil versátil' : 'perfil construtoras'}).\nAcompanhe em tempo real:\n${link}`)

  // Login do usuário de integração → JWT aceito pelo motor e pelas RLS.
  const { data: sess, error: authErr } = await sb.auth.signInWithPassword({
    email: Deno.env.get('ENRIQ_INTEG_EMAIL')!,
    password: Deno.env.get('ENRIQ_INTEG_SENHA')!,
  })
  if (authErr || !sess.session) return json(500, { error: `auth integração falhou: ${authErr?.message}` })

  // Aciona a esteira no motor (responde 202 e roda em background lá).
  const r = await fetch(`${MOTOR_URL}/api/esteira`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sess.session.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ leadId, kommoLeadId }),
  })
  if (!r.ok && r.status !== 202) {
    return json(502, { error: `motor recusou a esteira: HTTP ${r.status}`, link })
  }

  return json(200, { ok: true, lead_id: leadId, link })
})
