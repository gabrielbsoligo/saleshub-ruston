// Kommo Import Status — drena respostas pendentes e reporta o progresso de
// criação no Kommo dos leads importados. Opcionalmente reenvia os que falharam.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

    const body = await req.json().catch(() => ({}))
    const leadIds: string[] = Array.isArray(body.leadIds) ? body.leadIds : []
    const retry: boolean = !!body.retry
    if (!leadIds.length) {
      return new Response(JSON.stringify({ error: 'leadIds obrigatório' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Reenvia os que ainda não têm kommo_id (paced: 10 por chamada)
    let retried = 0
    if (retry) {
      const { data: r } = await supabase.rpc('retry_kommo_create_leads', { p_ids: leadIds, p_limit: 10 })
      retried = typeof r === 'number' ? r : 0
    }

    // Drena respostas pendentes do pg_net (duas passadas)
    await supabase.rpc('process_kommo_responses')
    await supabase.rpc('process_kommo_responses')

    // Status atual dos leads
    const { data: leads } = await supabase
      .from('leads')
      .select('id, empresa, kommo_id')
      .in('id', leadIds)

    const created = (leads || []).filter((l: any) => l.kommo_id).length
    const pendingIds = (leads || []).filter((l: any) => !l.kommo_id).map((l: any) => l.id)

    // Erros: último log com falha para os leads ainda sem kommo_id
    let errors: { empresa: string; status: number | null; msg: string }[] = []
    let failed = 0
    if (pendingIds.length) {
      const { data: logs } = await supabase
        .from('kommo_sync_log')
        .select('lead_id, response_status, error_message, completed_at')
        .eq('action', 'create_lead')
        .in('lead_id', pendingIds)
        .not('error_message', 'is', null)
        .order('attempted_at', { ascending: false })

      const seen = new Set<string>()
      const empresaById = new Map((leads || []).map((l: any) => [l.id, l.empresa]))
      for (const lg of logs || []) {
        if (seen.has(lg.lead_id)) continue
        seen.add(lg.lead_id)
        failed++
        if (errors.length < 30) {
          errors.push({
            empresa: empresaById.get(lg.lead_id) || '(?)',
            status: lg.response_status ?? null,
            msg: (lg.error_message || '').slice(0, 160),
          })
        }
      }
    }

    const total = leadIds.length
    const pending = total - created - failed

    return new Response(JSON.stringify({ total, created, failed, pending, retried, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
