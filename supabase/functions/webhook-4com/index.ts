// Webhook receiver for 4com call events
// Receives call data from n8n redirect and saves to ligacoes_4com
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Hangup causes that indicate the call was answered (only if duration > 0)
const ANSWERED_CAUSES = [
  'NORMAL_CLEARING',        // Normal hangup after conversation
  'SUCCESS',
]

// Hangup causes that indicate NOT answered
const NOT_ANSWERED_CAUSES = [
  'NO_ANSWER',
  'USER_BUSY',
  'CALL_REJECTED',
  'NO_USER_RESPONSE',
  'SUBSCRIBER_ABSENT',
  'UNALLOCATED_NUMBER',
  'NUMBER_CHANGED',
  'INVALID_NUMBER_FORMAT',
  'NORMAL_TEMPORARY_FAILURE',
  'RECOVERY_ON_TIMER_EXPIRE',
  'DESTINATION_OUT_OF_ORDER',
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json()

    // Support both direct 4com payload and n8n wrapped payload
    const data = body.body || body

    if (!data.id && !data._id && !data.caller) {
      return new Response(JSON.stringify({ error: 'Invalid payload' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // provider: 'api4com' (default, fluxo atual) ou '3c' (n8n clonado). 3C usa _id como call_id.
    const provider = String(data.provider || body.provider || 'api4com').toLowerCase() === '3c' ? '3c' : 'api4com'
    const callId = provider === '3c'
      ? (data._id || data.id)
      : (data.id || `${data.caller}-${data.startedAt}`)
    const duration = parseInt(data.duration) || 0
    const hangupCause = data.hangupCause || ''

    // Determine if call was answered
    // Must have duration > 0 (actual conversation happened) AND not a failed cause
    const atendida = duration > 0 && !NOT_ANSWERED_CAUSES.includes(hangupCause)

    // Resolve SDR: 3C -> pelo agente (agent.id/agent.name via agente_3c_map); API4COM -> pelo ramal (caller).
    let memberId: string | null = null
    if (provider === '3c') {
      const agentId = data.agent?.id ?? data.agent_id ?? null
      const agentName = data.agent?.name ?? data.agent_name ?? null
      if (agentId) {
        const { data: m } = await supabase.from('agente_3c_map').select('member_id').eq('agent_id', String(agentId)).maybeSingle()
        if (m?.member_id) memberId = m.member_id
      }
      if (!memberId && agentName) {
        const { data: tm } = await supabase.from('team_members').select('id').ilike('name', String(agentName)).maybeSingle()
        if (tm) memberId = tm.id
      }
    } else if (data.caller) {
      const { data: member } = await supabase.from('team_members').select('id').eq('ramal_4com', data.caller).maybeSingle()
      if (member) memberId = member.id
    }

    // Parse dates
    const startedAt = data.startedAt ? new Date(data.startedAt.replace(' ', 'T') + '-03:00').toISOString() : null
    const endedAt = data.endedAt ? new Date(data.endedAt.replace(' ', 'T') + '-03:00').toISOString() : null

    // Upsert call record
    const { error } = await supabase.from('ligacoes_4com').upsert({
      call_id: callId,
      domain: data.domain || null,
      direction: data.direction || 'outbound',
      caller: data.caller || null,
      called: data.called || null,
      started_at: startedAt,
      ended_at: endedAt,
      duration,
      hangup_cause: hangupCause,
      hangup_cause_code: data.hangupCauseCode || null,
      record_url: data.recordUrl || null,
      event_type: data.eventType || 'channel-hangup',
      member_id: memberId,
      atendida,
      provider,
    }, { onConflict: 'call_id' })

    if (error) {
      console.error('DB error:', error)
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({
      ok: true,
      call_id: callId,
      atendida,
      member_id: memberId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    console.error('Webhook error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
