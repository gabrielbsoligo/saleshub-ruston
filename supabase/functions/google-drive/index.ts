// Google Drive - Busca transcricoes e gravacoes de reunioes do Google Meet
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Reutiliza mesmo padrao de refresh de token do google-calendar
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

/**
 * Busca no Google Drive a transcricao (Google Docs) de uma reuniao Meet.
 * Google Meet salva transcricoes como Google Docs no Drive do organizador.
 * O nome do arquivo segue o padrao: "{titulo do evento} - Transcript"
 */
async function findTranscriptInDrive(token: string, meetingTitle: string, meetingDate: string): Promise<{
  transcript_text: string | null;
  transcript_url: string | null;
  recording_url: string | null;
}> {
  // Buscar transcricao: Google Meet cria docs com nome "{event title} - Transcript" ou "Transcrição..."
  // Tambem buscar pelo nome da empresa que esta no titulo do evento
  const searchTerms = [
    meetingTitle, // ex: "V4 Company + Empresa XYZ"
    meetingTitle.replace('V4 Company + ', ''), // ex: "Empresa XYZ"
  ]

  let transcriptDocId: string | null = null
  let transcriptUrl: string | null = null
  let recordingUrl: string | null = null

  // Calcular range de datas para busca (dia da reuniao +/- 1 dia)
  const meetDate = new Date(meetingDate)
  const dayBefore = new Date(meetDate.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const dayAfter = new Date(meetDate.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  for (const term of searchTerms) {
    if (transcriptDocId) break

    // Buscar Google Docs (transcricoes)
    const query = `name contains '${term.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.document' and modifiedTime >= '${dayBefore}T00:00:00' and modifiedTime <= '${dayAfter}T23:59:59'`

    const searchResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink,modifiedTime)&orderBy=modifiedTime desc&pageSize=5`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )

    if (!searchResp.ok) {
      const err = await searchResp.text()
      console.error('Drive search failed:', err)
      continue
    }

    const searchData = await searchResp.json()
    const files = searchData.files || []

    // Procurar arquivo de transcricao (contem "Transcript" ou "Transcrição" no nome)
    const transcriptFile = files.find((f: any) =>
      f.name.toLowerCase().includes('transcript') ||
      f.name.toLowerCase().includes('transcrição') ||
      f.name.toLowerCase().includes('transcricao')
    ) || files[0] // fallback: primeiro resultado

    if (transcriptFile) {
      transcriptDocId = transcriptFile.id
      transcriptUrl = transcriptFile.webViewLink
    }
  }

  // Buscar gravacao de video (mp4 no Drive)
  for (const term of searchTerms) {
    if (recordingUrl) break

    const videoQuery = `name contains '${term.replace(/'/g, "\\'")}' and (mimeType contains 'video/' or mimeType='application/vnd.google-apps.video') and modifiedTime >= '${dayBefore}T00:00:00' and modifiedTime <= '${dayAfter}T23:59:59'`

    const videoResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(videoQuery)}&fields=files(id,name,webViewLink)&orderBy=modifiedTime desc&pageSize=3`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )

    if (videoResp.ok) {
      const videoData = await videoResp.json()
      if (videoData.files?.length > 0) {
        recordingUrl = videoData.files[0].webViewLink
      }
    }
  }

  // Se encontrou a transcricao, extrair texto do Google Docs
  let transcriptText: string | null = null
  if (transcriptDocId) {
    const docResp = await fetch(
      `https://docs.googleapis.com/v1/documents/${transcriptDocId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )

    if (docResp.ok) {
      const doc = await docResp.json()
      // Extrair texto de todos os paragrafos do documento
      transcriptText = extractTextFromDoc(doc)
    }
  }

  return { transcript_text: transcriptText, transcript_url: transcriptUrl, recording_url: recordingUrl }
}

/**
 * Extrai texto plano de um Google Docs document object.
 * Percorre body.content → paragraph → elements → textRun.content
 */
function extractTextFromDoc(doc: any): string {
  const parts: string[] = []

  if (!doc.body?.content) return ''

  for (const element of doc.body.content) {
    if (element.paragraph?.elements) {
      for (const elem of element.paragraph.elements) {
        if (elem.textRun?.content) {
          parts.push(elem.textRun.content)
        }
      }
    }
    if (element.table) {
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellContent of cell.content || []) {
            if (cellContent.paragraph?.elements) {
              for (const elem of cellContent.paragraph.elements) {
                if (elem.textRun?.content) {
                  parts.push(elem.textRun.content)
                }
              }
            }
          }
        }
      }
    }
  }

  return parts.join('').trim()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { action, data } = await req.json()

    if (action === 'fetch_transcript') {
      // Buscar dados da reuniao
      const { data: reuniao, error: reuniaoError } = await supabase.from('reunioes')
        .select('*, closer:team_members!closer_id(*), sdr:team_members!sdr_id(*)')
        .eq('id', data.reuniao_id)
        .single()

      if (reuniaoError || !reuniao) {
        return new Response(JSON.stringify({ error: 'Reuniao nao encontrada' }), {
          status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Tentar token do organizador (SDR primeiro, depois closer)
      const organizerId = reuniao.sdr_id || reuniao.closer_id || reuniao.closer_confirmado_id
      if (!organizerId) {
        return new Response(JSON.stringify({ error: 'Nenhum organizador encontrado para esta reuniao' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      let token = await getValidToken(supabase, organizerId)

      // Fallback: tentar closer se SDR falhou
      if (!token && reuniao.closer_id && reuniao.closer_id !== organizerId) {
        token = await getValidToken(supabase, reuniao.closer_id)
      }
      // Fallback: tentar closer confirmado
      if (!token && reuniao.closer_confirmado_id && reuniao.closer_confirmado_id !== organizerId) {
        token = await getValidToken(supabase, reuniao.closer_confirmado_id)
      }

      if (!token) {
        return new Response(JSON.stringify({
          error: 'Google Drive nao conectado. O organizador precisa reconectar na tela de Equipe para autorizar acesso ao Drive.',
          needs_reauth: true,
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Montar titulo de busca (mesmo padrao do Calendar: "V4 Company + {empresa}")
      const meetingTitle = `V4 Company + ${reuniao.empresa || ''}`
      const meetingDate = reuniao.data_reuniao || reuniao.data_agendamento || new Date().toISOString()

      const result = await findTranscriptInDrive(token, meetingTitle, meetingDate)

      // Retornar resultado com status de disponibilidade
      if (!result.transcript_text) {
        return new Response(JSON.stringify({
          status: 'not_found',
          message: 'Transcricao ainda nao disponivel no Google Drive. O Google Meet leva ~30 minutos para gerar.',
          recording_url: result.recording_url,
        }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({
        status: 'found',
        transcript_text: result.transcript_text,
        transcript_url: result.transcript_url,
        recording_url: result.recording_url,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    console.error('Google Drive error:', e)
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
