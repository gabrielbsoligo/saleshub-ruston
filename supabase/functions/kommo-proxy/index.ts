// Supabase Edge Function - Kommo API Proxy
// Resolve CORS chamando a API do Kommo server-side

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const CLIENT_ID = '5cb13c31-8c62-4bc9-9bd4-47f09a67b0c0'
const CLIENT_SECRET = 'ezXsO24SuX8sNsRexwMtOhRCNthcnlwUsGlE0hrwQfNTmEACmwlHOasLy5RSaO2O'
const REDIRECT_URI = 'https://gestao-comercial-rosy.vercel.app'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function getSupabaseClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )
}

async function getAccessToken(supabase: any): Promise<string> {
  const { data } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
  if (!data?.value) throw new Error('No access token')
  return data.value
}

async function refreshToken(supabase: any): Promise<string> {
  const { data } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_refresh_token').single()
  if (!data?.value) throw new Error('No refresh token')

  const resp = await fetch(`${KOMMO_BASE}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: data.value,
      redirect_uri: REDIRECT_URI,
    }),
  })

  if (!resp.ok) throw new Error('Token refresh failed')
  const tokens = await resp.json()

  await supabase.from('integracao_config').upsert([
    { key: 'kommo_access_token', value: tokens.access_token },
    { key: 'kommo_refresh_token', value: tokens.refresh_token },
  ], { onConflict: 'key' })

  return tokens.access_token
}

async function kommoFetch(supabase: any, path: string, method: string, body?: any): Promise<any> {
  let token = await getAccessToken(supabase)

  let resp = await fetch(`${KOMMO_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (resp.status === 401) {
    token = await refreshToken(supabase)
    resp = await fetch(`${KOMMO_BASE}${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Kommo ${resp.status}: ${errText}`)
  }

  return resp.json()
}

// Pipeline mapping
const CANAL_TO_PIPELINE: Record<string, { pipeline_id: number; status_id: number }> = {
  blackbox:     { pipeline_id: 10897863, status_id: 83673167 },
  leadbroker:   { pipeline_id: 10897863, status_id: 83673167 },
  outbound:     { pipeline_id: 13250384, status_id: 102173864 },
  recomendacao: { pipeline_id: 13250384, status_id: 102173864 },
  indicacao:    { pipeline_id: 13250384, status_id: 102173864 },
}

const ORIGEM_ENUM: Record<string, number> = {
  recomendacao: 823304, outbound: 823306, leadbroker: 823308,
  indicacao: 823330, blackbox: 863643,
}

const PRODUTO_ENUM: Record<string, number> = {
  'Assessoria': 839446, 'Estruturação Estratégica': 839448,
  'Alavancagem Comercial': 839450, 'Soluções Comerciais': 847003,
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabase = await getSupabaseClient()
    const { action, data } = await req.json()

    if (action === 'create_lead') {
      const customFields: any[] = []
      if (data.cnpj) customFields.push({ field_id: 508460, values: [{ value: data.cnpj }] })
      if (data.faturamento) customFields.push({ field_id: 508510, values: [{ value: data.faturamento }] })
      if (data.canal && ORIGEM_ENUM[data.canal]) {
        customFields.push({ field_id: 975168, values: [{ enum_id: ORIGEM_ENUM[data.canal] }] })
      }
      if (data.produto && PRODUTO_ENUM[data.produto]) {
        customFields.push({ field_id: 986814, values: [{ enum_id: PRODUTO_ENUM[data.produto] }] })
      }

      const pipelineConfig = data.canal ? CANAL_TO_PIPELINE[data.canal] : undefined

      const result = await kommoFetch(supabase, '/api/v4/leads', 'POST', [{
        name: data.empresa,
        pipeline_id: pipelineConfig?.pipeline_id,
        status_id: pipelineConfig?.status_id,
        responsible_user_id: data.kommo_user_id || undefined,
        custom_fields_values: customFields.length > 0 ? customFields : undefined,
      }])

      const createdLead = result?._embedded?.leads?.[0]
      if (!createdLead) throw new Error('Lead not created')

      const kommoId = String(createdLead.id)
      const kommoLink = `${KOMMO_BASE}/leads/detail/${kommoId}`

      // Create + link contact
      if (data.nome_contato || data.telefone) {
        try {
          const contactFields: any[] = []
          if (data.telefone) contactFields.push({ field_id: 399272, values: [{ value: data.telefone, enum_code: 'WORK' }] })

          const contactResult = await kommoFetch(supabase, '/api/v4/contacts', 'POST', [{
            name: data.nome_contato || data.empresa,
            responsible_user_id: data.kommo_user_id || undefined,
            custom_fields_values: contactFields.length > 0 ? contactFields : undefined,
          }])

          const contactId = contactResult?._embedded?.contacts?.[0]?.id
          if (contactId) {
            await kommoFetch(supabase, `/api/v4/leads/${kommoId}/link`, 'POST', [{
              to_entity_id: contactId,
              to_entity_type: 'contacts',
            }])
          }
        } catch (e) {
          console.error('Contact link failed:', e)
        }
      }

      return new Response(JSON.stringify({ kommo_id: kommoId, kommo_link: kommoLink }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    console.error('Kommo proxy error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
