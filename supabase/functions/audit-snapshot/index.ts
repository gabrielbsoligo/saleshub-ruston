// Edge Function: audit-snapshot
// Recebe POST do Kommo Bridge (userscript Tampermonkey rodando em *.kommo.com)
// com snapshot bruto do lead atual. Valida bridge_token, persiste em
// auditoria_kommo_snapshots. Realtime entrega ao SalesHub.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  // Bridge roda em qualquer subdominio kommo.com -- aceitamos qualquer origem
  // mas exigimos token valido. Mantemos lista permissiva pra evitar pesadelo
  // de configuracao (cada conta Kommo tem subdominio diferente).
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-bridge-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405)
  }

  const token = req.headers.get('x-bridge-token') ?? ''
  if (!token) {
    return json({ error: 'missing x-bridge-token' }, 401)
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }

  const { kommo_lead_id, kommo_account_subdomain, payload, bridge_version, source } = body ?? {}

  if (!kommo_lead_id || typeof kommo_lead_id !== 'number') {
    return json({ error: 'kommo_lead_id (number) required' }, 400)
  }
  if (!payload || typeof payload !== 'object') {
    return json({ error: 'payload (object) required' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Resolve token -> team_member_id
  const { data: tokenRow, error: tokenErr } = await supabase
    .from('bridge_tokens')
    .select('id, team_member_id, revoked_at')
    .eq('token', token)
    .maybeSingle()

  if (tokenErr) return json({ error: 'token lookup failed', detail: tokenErr.message }, 500)
  if (!tokenRow) return json({ error: 'invalid token' }, 401)
  if (tokenRow.revoked_at) return json({ error: 'token revoked' }, 401)

  // Rate limit simples: max 60 snapshots/min por token
  const oneMinAgo = new Date(Date.now() - 60_000).toISOString()
  const { count: recentCount, error: rateErr } = await supabase
    .from('auditoria_kommo_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('capturado_por', tokenRow.team_member_id)
    .gte('capturado_em', oneMinAgo)

  if (rateErr) return json({ error: 'rate check failed', detail: rateErr.message }, 500)
  if ((recentCount ?? 0) >= 60) {
    return json({ error: 'rate limit (60/min)' }, 429)
  }

  // Insert snapshot
  const { data: inserted, error: insErr } = await supabase
    .from('auditoria_kommo_snapshots')
    .insert({
      kommo_lead_id,
      kommo_account_subdomain: kommo_account_subdomain ?? null,
      capturado_por: tokenRow.team_member_id,
      payload,
      bridge_version: bridge_version ?? null,
      source: source === 'manual_command' ? 'manual_command' : 'auto',
    })
    .select('id, capturado_em')
    .single()

  if (insErr) return json({ error: 'insert failed', detail: insErr.message }, 500)

  // Update last_used_at do token (best effort)
  await supabase
    .from('bridge_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', tokenRow.id)

  return json({ ok: true, snapshot_id: inserted.id, capturado_em: inserted.capturado_em }, 200)
})

function json(body: any, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
