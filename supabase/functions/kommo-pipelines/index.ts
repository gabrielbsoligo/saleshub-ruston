// Kommo Pipelines — lista funis e etapas (para a importação de leads escolher)
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

    const resp = await fetch(`${KOMMO_BASE}/api/v4/leads/pipelines`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!resp.ok) {
      const txt = await resp.text()
      return new Response(JSON.stringify({ error: `Kommo respondeu ${resp.status}`, detail: txt.slice(0, 300) }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const data = await resp.json()
    const pipelines = (data?._embedded?.pipelines || []).map((p: any) => ({
      pipeline_id: p.id,
      name: p.name,
      is_archive: !!p.is_archive,   // p/ o front esconder funis arquivados
      // type 1 = "Etapa de leads de entrada" (incoming); 142/143 = ganho/perdido
      statuses: (p?._embedded?.statuses || [])
        .filter((s: any) => s.type !== 1 && s.id !== 142 && s.id !== 143)
        .map((s: any) => ({ id: s.id, name: s.name })),
    }))

    // Tags existentes (até 250) para sugerir na importação
    let tags: string[] = []
    try {
      const tagResp = await fetch(`${KOMMO_BASE}/api/v4/leads/tags?limit=250`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (tagResp.ok) {
        const td = await tagResp.json()
        tags = (td?._embedded?.tags || []).map((t: any) => t.name).filter(Boolean)
      }
    } catch { /* tags são opcionais */ }

    return new Response(JSON.stringify({ pipelines, tags }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
