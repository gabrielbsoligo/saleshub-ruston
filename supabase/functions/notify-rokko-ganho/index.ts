// =============================================================
// Edge Function: notify-rokko-ganho
// =============================================================
// Quando um deal vira contrato_assinado, o SalesHub chama esta
// edge function (autenticada via session do supabase client) que
// faz o POST pro Rokko com o webhook secret server-side.
//
// Secret esperada no env do Supabase: ROKKO_WEBHOOK_SECRET
// Endpoint Rokko: https://rokko.rustontools.tech/api/webhooks/lead-intake
//
// Payload esperado pelo Rokko (JSON):
//   {
//     client_name, contact_name, contact_email, contact_phone,
//     kommo_lead_id, kommo_link, sold_by_email,
//     valor_recorrente, produtos_recorrente, project_start_date
//   }
// =============================================================

const ROKKO_WEBHOOK_URL = Deno.env.get('ROKKO_WEBHOOK_URL') ??
  'https://rokko.rustontools.tech/api/webhooks/lead-intake'
const ROKKO_WEBHOOK_SECRET = Deno.env.get('ROKKO_WEBHOOK_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface RokkoPayload {
  client_name: string
  contact_name?: string | null
  contact_email?: string | null
  contact_phone?: string | null
  kommo_lead_id?: string | null
  kommo_link?: string | null
  sold_by_email?: string | null
  valor_recorrente?: number | null
  produtos_recorrente?: string[]
  project_start_date?: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!ROKKO_WEBHOOK_SECRET) {
    console.error('[notify-rokko-ganho] ROKKO_WEBHOOK_SECRET nao configurado')
    return new Response(JSON.stringify({ error: 'Secret nao configurado no servidor' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let payload: RokkoPayload
  try {
    payload = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Body JSON invalido' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Validacao minima
  if (!payload.client_name || typeof payload.client_name !== 'string') {
    return new Response(JSON.stringify({ error: 'client_name obrigatorio' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Encaminha pro Rokko com o secret
  let upstreamStatus = 0
  let upstreamBody: any = null
  try {
    const r = await fetch(ROKKO_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': ROKKO_WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    })
    upstreamStatus = r.status
    try { upstreamBody = await r.json() }
    catch { upstreamBody = await r.text().catch(() => null) }

    console.log('[notify-rokko-ganho]', upstreamStatus, payload.client_name)

    if (!r.ok) {
      return new Response(JSON.stringify({
        error: 'Rokko respondeu erro',
        upstreamStatus,
        upstreamBody,
      }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
  } catch (err: any) {
    console.error('[notify-rokko-ganho] Erro de rede', err)
    return new Response(JSON.stringify({ error: 'Falha ao chamar Rokko', detail: String(err?.message || err) }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ success: true, rokko: upstreamBody }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
