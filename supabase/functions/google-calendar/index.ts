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

// Calcula janelas livres em comum dentro de [timeMin, timeMax]:
// une todos os blocos busy de todas as pessoas, faz merge dos sobrepostos
// e inverte dentro do intervalo. Pessoas com erro (busy desconhecido) não contam.
function computeCommonFree(
  people: { busy?: { start: string; end: string; status?: string; all_day?: boolean }[] }[],
  timeMin: string,
  timeMax: string,
): { start: string; end: string }[] {
  const rangeStart = new Date(timeMin).getTime()
  const rangeEnd = new Date(timeMax).getTime()
  if (!(rangeStart < rangeEnd)) return []

  const intervals: [number, number][] = []
  for (const p of people) {
    for (const b of p.busy || []) {
      // Recusados e eventos de dia inteiro não bloqueiam a janela livre
      if (b.status === 'declined' || b.all_day) continue
      const s = Math.max(new Date(b.start).getTime(), rangeStart)
      const e = Math.min(new Date(b.end).getTime(), rangeEnd)
      if (s < e) intervals.push([s, e])
    }
  }
  if (!intervals.length) {
    return [{ start: new Date(rangeStart).toISOString(), end: new Date(rangeEnd).toISOString() }]
  }

  intervals.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = [intervals[0]]
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1]
    if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1])
    else merged.push(intervals[i])
  }

  const free: { start: string; end: string }[] = []
  let cursor = rangeStart
  for (const [s, e] of merged) {
    if (s > cursor) free.push({ start: new Date(cursor).toISOString(), end: new Date(s).toISOString() })
    cursor = Math.max(cursor, e)
  }
  if (cursor < rangeEnd) free.push({ start: new Date(cursor).toISOString(), end: new Date(rangeEnd).toISOString() })
  return free
}

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

      let activeToken = await getValidToken(supabase, organizerId)

      // Fallback to closer token if SDR token failed
      if (!activeToken && data.closer_id && data.closer_id !== organizerId) {
        activeToken = await getValidToken(supabase, data.closer_id)
      }

      if (!activeToken) {
        return new Response(JSON.stringify({ error: 'Google Calendar não conectado. O SDR ou Closer precisa conectar o Calendar na tela de Equipe.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

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

      // Gestor (always invited)
      attendees.push({ email: 'ruston@v4company.com' })

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

    if (action === 'query_availability') {
      // Disponibilidade do time: blocos ocupados por pessoa + janelas livres em comum.
      // Híbrido: membro conectado -> events.list (com título); externo/sem token -> freeBusy (sem título).
      const emails: string[] = Array.isArray(data?.emails)
        ? data.emails.map((e: string) => String(e).trim()).filter(Boolean)
        : []
      const timeMin: string = data?.timeMin
      const timeMax: string = data?.timeMax
      const timeZone: string = data?.timeZone || 'America/Sao_Paulo'

      if (!emails.length) throw new Error('Lista de e-mails vazia')
      if (!timeMin || !timeMax) throw new Error('timeMin e timeMax são obrigatórios')

      // Mapear e-mails -> membros conectados
      const { data: memberRows } = await supabase.from('team_members')
        .select('id, name, email, google_calendar_connected')
        .in('email', emails)

      const memberByEmail = new Map<string, { id: string; name: string; connected: boolean }>()
      for (const m of memberRows || []) {
        if (m.email) memberByEmail.set(m.email.toLowerCase(), { id: m.id, name: m.name, connected: !!m.google_calendar_connected })
      }

      // Token de fallback (qualquer membro conectado) — resolvido sob demanda e cacheado
      let fallbackToken: string | null | undefined = undefined
      const getFallbackToken = async (): Promise<string | null> => {
        if (fallbackToken !== undefined) return fallbackToken
        fallbackToken = null
        let pool = (memberRows || []).filter((m: any) => m.google_calendar_connected)
        if (!pool.length) {
          const { data: anyConnected } = await supabase.from('team_members')
            .select('id').eq('google_calendar_connected', true).limit(10)
          pool = anyConnected || []
        }
        for (const c of pool) {
          const t = await getValidToken(supabase, c.id)
          if (t) { fallbackToken = t; break }
        }
        return fallbackToken
      }

      // Busca em paralelo (events.list por membro conectado) para reduzir latência
      const people: any[] = await Promise.all(emails.map(async (email) => {
        const m = memberByEmail.get(email.toLowerCase())
        if (m && m.connected) {
          const token = await getValidToken(supabase, m.id)
          if (token) {
            try {
              const params = new URLSearchParams({
                timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
              })
              const evResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
                headers: { 'Authorization': `Bearer ${token}` },
              })
              if (!evResp.ok) throw new Error(await evResp.text())
              const evData = await evResp.json()
              const busy = (evData.items || [])
                .filter((ev: any) => ev.status !== 'cancelled' && ev.transparency !== 'transparent' && (ev.start?.dateTime || ev.start?.date))
                .map((ev: any) => {
                  // Status de resposta do próprio usuário: accepted | declined | tentative | needsAction
                  const self = (ev.attendees || []).find((a: any) => a.self)
                  const status = self?.responseStatus
                    || (ev.organizer?.self ? 'accepted' : ((ev.attendees && ev.attendees.length) ? 'needsAction' : 'accepted'))
                  return {
                    start: ev.start.dateTime || ev.start.date,
                    end: ev.end?.dateTime || ev.end?.date || ev.start.dateTime || ev.start.date,
                    title: ev.summary || '(sem título)',
                    all_day: !ev.start.dateTime,
                    status,
                  }
                })
              return { email, member_id: m.id, name: m.name, connected: true, source: 'events', busy }
            } catch (_e) {
              // token/calendário falhou -> cai pro freeBusy
            }
          }
        }
        return { email, member_id: m?.id, name: m?.name, connected: !!(m && m.connected), source: 'freebusy', busy: [], _needsFreebusy: true }
      }))

      const freebusyEmails: string[] = people.filter((p) => p._needsFreebusy).map((p) => p.email)
      for (const p of people) delete p._needsFreebusy

      // FreeBusy em lote para os e-mails restantes (sem título, só ocupado/livre)
      if (freebusyEmails.length) {
        const token = await getFallbackToken()
        if (!token) {
          for (const email of freebusyEmails) {
            const p = people.find(x => x.email === email)
            if (p) p.error = 'Nenhuma conta Google conectada para consultar disponibilidade.'
          }
        } else {
          const fbResp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ timeMin, timeMax, timeZone, items: freebusyEmails.map(id => ({ id })) }),
          })
          if (!fbResp.ok) {
            const errText = await fbResp.text()
            for (const email of freebusyEmails) {
              const p = people.find(x => x.email === email)
              if (p) p.error = `FreeBusy falhou: ${errText}`
            }
          } else {
            const fbData = await fbResp.json()
            const cals = fbData.calendars || {}
            for (const email of freebusyEmails) {
              const p = people.find(x => x.email === email)
              if (!p) continue
              const cal = cals[email]
              if (!cal) { p.error = 'Calendário não retornado pela API.'; continue }
              if (cal.errors && cal.errors.length) {
                p.error = cal.errors.map((e: any) => e.reason || e.domain || 'erro').join(', ')
                continue
              }
              p.busy = (cal.busy || []).map((b: any) => ({ start: b.start, end: b.end }))
            }
          }
        }
      }

      const common_free = computeCommonFree(people, timeMin, timeMax)

      return new Response(JSON.stringify({ timeMin, timeMax, timeZone, people, common_free }), {
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
