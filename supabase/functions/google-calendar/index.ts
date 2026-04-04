// Google Calendar - Create/update/delete events
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function getValidToken(supabase: any, memberId: string): Promise<string | null> {
  const { data: member } = await supabase.from('team_members')
    .select('google_access_token, google_refresh_token, google_token_expiry')
    .eq('id', memberId).single()

  if (!member?.google_access_token) return null

  if (member.google_token_expiry && new Date(member.google_token_expiry) < new Date()) {
    if (!member.google_refresh_token) return null
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: member.google_refresh_token, grant_type: 'refresh_token',
      }),
    })
    if (!resp.ok) return null
    const tokens = await resp.json()
    await supabase.from('team_members').update({
      google_access_token: tokens.access_token,
      google_token_expiry: new Date(Date.now() + (tokens.expires_in * 1000)).toISOString(),
    }).eq('id', memberId)
    return tokens.access_token
  }
  return member.google_access_token
}

const EVENT_DESCRIPTION = `✅ Para acessar a reunião basta clicar no link abaixo e depois no botão azul de "Entrar com Google Meet" ou se estiver em inglês "Login with Google Meet". Algumas informações sobre a nossa reunião:

💻 1) É fundamental acessar de um computador ou notebook com câmera, para visualizar melhor as informações;

🎥 2) Não é obrigatório, mas é melhor usar uma webcam;

🎧 3) Fundamental você ter microfone e de preferência um fone de ouvido, também;

📶 4) É importante ter uma boa conexão de 'internet'. Se possível, com cabo.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { action, data } = await req.json()

    if (action === 'create_event') {
      // Use SDR token as organizer, closer is attendee
      const organizerId = data.sdr_id || data.closer_id
      if (!organizerId) throw new Error('No SDR or closer ID')

      const token = await getValidToken(supabase, organizerId)
      if (!token) {
        // Try closer as fallback
        if (data.closer_id && data.closer_id !== organizerId) {
          const fallbackToken = await getValidToken(supabase, data.closer_id)
          if (!fallbackToken) {
            return new Response(JSON.stringify({ error: 'Google Calendar não conectado. O SDR ou Closer precisa conectar o Calendar na tela de Equipe.' }), {
              status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
          }
          // Use closer token but still add SDR as attendee
        } else {
          return new Response(JSON.stringify({ error: 'Google Calendar não conectado. Conecte na tela de Equipe.' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          })
        }
      }

      const activeToken = token || await getValidToken(supabase, data.closer_id)

      // Build attendees
      const attendees: { email: string }[] = []

      // Closer as attendee
      if (data.closer_id) {
        const { data: closer } = await supabase.from('team_members').select('email').eq('id', data.closer_id).single()
        if (closer?.email) attendees.push({ email: closer.email })
      }

      // SDR as attendee (if different from organizer)
      if (data.sdr_id && data.sdr_id !== data.closer_id) {
        const { data: sdr } = await supabase.from('team_members').select('email').eq('id', data.sdr_id).single()
        if (sdr?.email) attendees.push({ email: sdr.email })
      }

      // Lead email
      if (data.lead_email) attendees.push({ email: data.lead_email })

      // Extra participants
      if (data.participantes_extras) {
        for (const email of data.participantes_extras) {
          if (email.trim()) attendees.push({ email: email.trim() })
        }
      }

      const startTime = new Date(data.data_reuniao)
      const endTime = new Date(startTime.getTime() + 60 * 60 * 1000)

      const event = {
        summary: `V4 Company + ${data.empresa}`,
        description: EVENT_DESCRIPTION,
        start: { dateTime: startTime.toISOString(), timeZone: 'America/Sao_Paulo' },
        end: { dateTime: endTime.toISOString(), timeZone: 'America/Sao_Paulo' },
        attendees,
        conferenceData: {
          createRequest: { requestId: `saleshub-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
        extendedProperties: {
          private: {
            saleshub_lead_id: data.lead_id || '',
            saleshub_reuniao_id: data.reuniao_id || '',
            saleshub_empresa: data.empresa || '',
          },
        },
      }

      const calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${activeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      })

      if (!calResp.ok) {
        const err = await calResp.text()
        throw new Error(`Calendar API: ${err}`)
      }

      const created = await calResp.json()

      return new Response(JSON.stringify({
        event_id: created.id,
        meet_link: created.hangoutLink || created.conferenceData?.entryPoints?.[0]?.uri || null,
        html_link: created.htmlLink,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'delete_event') {
      const token = await getValidToken(supabase, data.member_id)
      if (!token) throw new Error('No valid token')
      await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${data.event_id}?sendUpdates=all`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      })
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
