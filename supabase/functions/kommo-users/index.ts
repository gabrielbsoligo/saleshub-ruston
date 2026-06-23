// Kommo Users — lista os usuários do Kommo (para vincular ao membro da equipe)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )

    const { data: cfg } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
    const token = cfg?.value
    if (!token) {
      return new Response(JSON.stringify({ error: 'Kommo não conectado (sem access_token).' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const resp = await fetch(`${KOMMO_BASE}/api/v4/users?limit=250`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!resp.ok) {
      const txt = await resp.text()
      return new Response(JSON.stringify({ error: `Kommo respondeu ${resp.status}`, detail: txt.slice(0, 300) }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const data = await resp.json()
    const users = (data?._embedded?.users || [])
      .map((u: any) => ({ id: u.id, name: u.name, email: u.email }))
      .sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''))

    return new Response(JSON.stringify({ users }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
