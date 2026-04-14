// Google Drive — Busca transcrições/gravações de reuniões do Google Meet
//
// Duas ações:
//   action='fetch_transcript'  → on-demand (chamado pela UI) - tenta agora e retorna
//   action='process_pending'   → invocado pelo pg_cron a cada 5 min para avançar
//                                automations em estados 'pending' / 'fetching_transcript'
//                                (e disparar analyze + apply downstream)
//
// Estratégia de busca: usa calendar_event_id da reunião para puxar o evento real
// no Google Calendar (título canônico, data exata, conferenceData) e procura o
// arquivo de transcrição no Drive do organizador via título + janela temporal
// estreita. Mais robusto que assumir "V4 Company + {empresa}".

import { createClient } from 'npm:@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const TRANSCRIPT_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2h até desistir

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ============================================================
// Token / Calendar helpers
// ============================================================

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

interface CalendarEventInfo {
  summary: string
  startIso: string
  meetCode: string | null  // ex: 'abc-defg-hij' do hangoutLink
}

async function getCalendarEvent(token: string, eventId: string): Promise<CalendarEventInfo | null> {
  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )
  if (!resp.ok) return null
  const ev = await resp.json()
  // Extrair meet code do hangoutLink (ex: https://meet.google.com/abc-defg-hij)
  const hangoutLink: string = ev.hangoutLink || ''
  const match = hangoutLink.match(/meet\.google\.com\/([a-z0-9-]+)/i)
  return {
    summary: ev.summary || '',
    startIso: ev.start?.dateTime || ev.start?.date || '',
    meetCode: match ? match[1] : null,
  }
}

// ============================================================
// Drive search
// ============================================================

interface FoundFiles {
  transcript_text: string | null
  transcript_url: string | null
  recording_url: string | null
}

async function findTranscriptInDrive(
  token: string,
  fingerprint: { summary: string; startIso: string; meetCode: string | null; fallbackEmpresa?: string },
): Promise<FoundFiles> {
  const out: FoundFiles = { transcript_text: null, transcript_url: null, recording_url: null }
  if (!fingerprint.startIso) return out

  // Janela temporal: do início do evento até 24h depois (transcript demora ~30 min)
  const start = new Date(fingerprint.startIso)
  const after = new Date(start.getTime() - 60 * 60 * 1000).toISOString() // 1h antes (margem)
  const before = new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString()

  // Termos de busca: priorizar título do evento, fallback no nome da empresa
  const searchTerms: string[] = []
  if (fingerprint.summary) searchTerms.push(fingerprint.summary)
  if (fingerprint.fallbackEmpresa && !searchTerms.includes(fingerprint.fallbackEmpresa)) {
    searchTerms.push(fingerprint.fallbackEmpresa)
  }
  if (searchTerms.length === 0) return out

  // Localizar pasta "Meet Recordings" (limita ruído) — opcional, fallback global
  const meetFolderId = await findMeetRecordingsFolderId(token)

  let transcriptDocId: string | null = null

  for (const term of searchTerms) {
    if (transcriptDocId) break
    const safe = term.replace(/'/g, "\\'")
    const parts = [
      `name contains '${safe}'`,
      `mimeType='application/vnd.google-apps.document'`,
      `modifiedTime >= '${after}'`,
      `modifiedTime <= '${before}'`,
      `trashed=false`,
    ]
    if (meetFolderId) parts.push(`'${meetFolderId}' in parents`)
    const query = parts.join(' and ')

    const searchResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )
    if (!searchResp.ok) continue

    const files = (await searchResp.json()).files || []
    // Preferência: arquivo cujo nome contenha "Transcript|Transcrição|Transcricao"
    const isTranscript = (n: string) => /transcript|transcri[çc][ãa]o/i.test(n)
    const transcript = files.find((f: any) => isTranscript(f.name)) || files[0]
    if (transcript) {
      transcriptDocId = transcript.id
      out.transcript_url = transcript.webViewLink
    }
  }

  // Vídeo (gravação)
  for (const term of searchTerms) {
    if (out.recording_url) break
    const safe = term.replace(/'/g, "\\'")
    const parts = [
      `name contains '${safe}'`,
      `(mimeType contains 'video/' or mimeType='application/vnd.google-apps.video')`,
      `modifiedTime >= '${after}'`,
      `modifiedTime <= '${before}'`,
      `trashed=false`,
    ]
    if (meetFolderId) parts.push(`'${meetFolderId}' in parents`)
    const query = parts.join(' and ')
    const videoResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)&orderBy=modifiedTime desc&pageSize=3`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )
    if (videoResp.ok) {
      const v = (await videoResp.json()).files || []
      if (v.length > 0) out.recording_url = v[0].webViewLink
    }
  }

  // Extrair texto do Doc de transcrição
  if (transcriptDocId) {
    const docResp = await fetch(
      `https://docs.googleapis.com/v1/documents/${transcriptDocId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )
    if (docResp.ok) {
      const doc = await docResp.json()
      out.transcript_text = extractTextFromDoc(doc)
    }
  }

  return out
}

let cachedMeetFolderId: { token: string; id: string | null } | null = null
async function findMeetRecordingsFolderId(token: string): Promise<string | null> {
  if (cachedMeetFolderId && cachedMeetFolderId.token === token) return cachedMeetFolderId.id
  const q = `name='Meet Recordings' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const resp = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  )
  let id: string | null = null
  if (resp.ok) {
    const files = (await resp.json()).files || []
    if (files.length > 0) id = files[0].id
  }
  cachedMeetFolderId = { token, id }
  return id
}

function extractTextFromDoc(doc: any): string {
  const parts: string[] = []
  if (!doc.body?.content) return ''
  const walk = (els: any[]) => {
    for (const el of els || []) {
      if (el.paragraph?.elements) {
        for (const e of el.paragraph.elements) {
          if (e.textRun?.content) parts.push(e.textRun.content)
        }
      }
      if (el.table?.tableRows) {
        for (const row of el.table.tableRows) {
          for (const cell of row.tableCells || []) walk(cell.content || [])
        }
      }
    }
  }
  walk(doc.body.content)
  return parts.join('').trim()
}

// ============================================================
// Core: tentar buscar transcrição de uma reunião
// ============================================================

interface FetchResult {
  status: 'found' | 'not_found' | 'needs_reauth'
  transcript_text?: string
  transcript_url?: string
  recording_url?: string
  error?: string
}

async function tryFetchTranscriptForReuniao(supabase: any, reuniaoId: string): Promise<FetchResult> {
  const { data: reuniao } = await supabase.from('reunioes')
    .select('id, empresa, sdr_id, closer_id, closer_confirmado_id, calendar_event_id, data_reuniao, data_agendamento')
    .eq('id', reuniaoId).single()

  if (!reuniao) return { status: 'not_found', error: 'Reunião não encontrada' }

  // Candidatos: SDR primeiro (geralmente é o organizador do Meet e dono da transcrição),
  // depois closer_confirmado, depois closer
  const candidateIds = [...new Set(
    [reuniao.sdr_id, reuniao.closer_confirmado_id, reuniao.closer_id].filter(Boolean)
  )]

  // Coletar todos os tokens válidos (pra buscar no Drive de cada um)
  const tokenEntries: { memberId: string; token: string }[] = []
  for (const id of candidateIds) {
    const t = await getValidToken(supabase, id)
    if (t) tokenEntries.push({ memberId: id, token: t })
  }
  if (tokenEntries.length === 0) {
    return { status: 'needs_reauth', error: 'Organizador precisa reconectar Google na tela de Equipe' }
  }

  // Montar fingerprint usando o primeiro token disponível pra acessar Calendar
  let fingerprint = {
    summary: '',
    startIso: reuniao.data_reuniao || reuniao.data_agendamento || '',
    meetCode: null as string | null,
    fallbackEmpresa: reuniao.empresa || '',
  }
  if (reuniao.calendar_event_id) {
    for (const entry of tokenEntries) {
      const ev = await getCalendarEvent(entry.token, reuniao.calendar_event_id)
      if (ev) {
        fingerprint.summary = ev.summary
        fingerprint.startIso = ev.startIso || fingerprint.startIso
        fingerprint.meetCode = ev.meetCode
        break
      }
    }
  }

  // Buscar transcrição no Drive de CADA candidato até encontrar
  let lastRecordingUrl: string | undefined
  for (const entry of tokenEntries) {
    const found = await findTranscriptInDrive(entry.token, fingerprint)
    if (found.recording_url) lastRecordingUrl = found.recording_url
    if (found.transcript_text) {
      return {
        status: 'found',
        transcript_text: found.transcript_text,
        transcript_url: found.transcript_url || undefined,
        recording_url: found.recording_url || lastRecordingUrl,
      }
    }
  }
  return {
    status: 'not_found',
    recording_url: lastRecordingUrl,
    error: 'Transcrição ainda não disponível no Drive de nenhum participante',
  }
}

// ============================================================
// Prompt + analyze + apply (server-side, alinhado com client)
// ============================================================

const PRODUTOS_MRR = ['Gestor de Tráfego','Designer','Social Media','IA','Landing Page Recorrente','CRM','Email Mkt'] as const
const PRODUTOS_OT  = ['Estruturação Estratégica','Site','MIV','DRX','LP One Time','Implementação CRM','Implementação IA'] as const
const TIER_LABELS: Record<string, string> = {
  tiny: 'Tiny (51k - 100k)', small: 'Small (101k - 400k)',
  medium: 'Medium (401k - 4MM)', large: 'Large (4MM - 40MM)', enterprise: 'Enterprise (40MM+)',
}

function buildPrompt(transcript: string, meetingDate: string): string {
  const tierList = Object.entries(TIER_LABELS).map(([k, l]) => `- ${k}: ${l}`).join('\n')
  return `Analise a seguinte transcricao de uma call de vendas e extraia os dados estruturados.
Retorne APENAS um JSON valido com os campos especificados.

## Regras de Classificacao
### Temperatura
- "quente": Proposta foi formalizada, cliente demonstrou alta intencao de fechar
- "morno": Cliente demonstrou interesse mas tem objecoes, marcou segunda call
- "frio": Cliente deu negativa, nao demonstrou interesse

### BANT Score (1-4)
- 1: Apenas Budget; 2: + Authority; 3: + Need; 4: + Timeline

### Tier (faturamento MENSAL do cliente)
${tierList}
Use o faturamento que o LEAD menciona sobre a empresa DELE, nao o valor da proposta.
Se nao for mencionado, use "small".

### Produtos
**MRR:** ${PRODUTOS_MRR.join(', ')}
**OT:** ${PRODUTOS_OT.join(', ')}
So inclua produtos EXPLICITAMENTE discutidos. Use os nomes EXATOS.

### Valores
- valor_escopo (OT): VALOR TOTAL do projeto. Se mencionou parcelas, calcule o total.
- valor_recorrente (MRR): valor MENSAL recorrente.

### Indicacoes
Pessoas/empresas que o lead INDICOU. Inclua telefone se mencionado.

### Proxima Reuniao
Procure "amanha as Xh", "quinta-feira", etc. Calcule a data a partir de ${meetingDate}.
SEMPRE inclua hora HH:MM. Se nao foi mencionada, retorne null.

## Formato JSON
{
  "temperatura": "quente"|"morno"|"frio",
  "valor_escopo": number, "valor_recorrente": number,
  "produtos_ot": [string], "produtos_mrr": [string],
  "bant": number, "tier": "tiny"|"small"|"medium"|"large"|"enterprise",
  "resumo_executivo": "string max 200 palavras pt-br",
  "indicacoes": [{"nome": string, "empresa": string, "telefone": string|null}],
  "proxima_reuniao": {"data": "YYYY-MM-DD", "hora": "HH:MM"}|null
}

## Data da Reuniao: ${meetingDate}

## Transcricao
${transcript}`
}

async function callAnalyzeCall(transcript: string, prompt: string): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/analyze-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ transcript, prompt }),
  })
  if (!resp.ok) throw new Error(`analyze-call HTTP ${resp.status}: ${await resp.text()}`)
  return resp.json()
}

async function getRecomendacaoSdrId(supabase: any, fallbackSdrId: string | null): Promise<string | null> {
  const { data } = await supabase.from('integracao_config').select('value').eq('key', 'recomendacao_sdr_id').maybeSingle()
  if (data?.value) return data.value
  return fallbackSdrId
}

async function applyActionsServerSide(
  supabase: any,
  reuniao: any,
  dealId: string | null,
  analysis: any,
  transcript_url: string | null,
  recording_url: string | null,
): Promise<any> {
  const actions: any = {
    deal_updated: false, deal_fields: [],
    leads_created: 0, lead_ids: [],
    meeting_scheduled: false,
    transcript_url: transcript_url || undefined,
    recording_url: recording_url || undefined,
  }

  // 1) Atualizar deal
  if (dealId) {
    const upd: any = {}
    const fields: string[] = []
    if (analysis.temperatura) { upd.temperatura = analysis.temperatura; fields.push('temperatura') }
    if (analysis.valor_escopo > 0) { upd.valor_escopo = analysis.valor_escopo; upd.valor_ot = analysis.valor_escopo; fields.push('valor_escopo') }
    if (analysis.valor_recorrente > 0) { upd.valor_recorrente = analysis.valor_recorrente; upd.valor_mrr = analysis.valor_recorrente; fields.push('valor_recorrente') }
    if (analysis.produtos_ot?.length) { upd.produtos_ot = analysis.produtos_ot; fields.push('produtos_ot') }
    if (analysis.produtos_mrr?.length) { upd.produtos_mrr = analysis.produtos_mrr; fields.push('produtos_mrr') }
    if (analysis.bant) { upd.bant = analysis.bant; fields.push('bant') }
    if (analysis.tier) { upd.tier = analysis.tier; fields.push('tier') }
    if (analysis.resumo_executivo) { upd.observacoes = analysis.resumo_executivo; fields.push('observacoes') }
    if (recording_url) { upd.link_call_vendas = recording_url; fields.push('link_call_vendas') }
    if (transcript_url) { upd.link_transcricao = transcript_url; fields.push('link_transcricao') }
    if (fields.length) {
      const { error } = await supabase.from('deals').update(upd).eq('id', dealId)
      if (!error) { actions.deal_updated = true; actions.deal_fields = fields }
    }
  }

  // 2) Leads de indicacao (Kommo WhatsApp complement fica para o client; degradação graceful)
  const indicacoes = Array.isArray(analysis.indicacoes) ? analysis.indicacoes : []
  if (indicacoes.length > 0) {
    const sdrId = await getRecomendacaoSdrId(supabase, reuniao.sdr_id || null)
    for (const ind of indicacoes) {
      if (!ind?.nome || !ind?.empresa) continue
      const newLead = {
        empresa: ind.empresa,
        nome_contato: ind.nome,
        telefone: ind.telefone || null,
        canal: 'recomendacao',
        status: 'sem_contato',
        sdr_id: sdrId,
        data_cadastro: new Date().toISOString().split('T')[0],
        mes_referencia: new Date().toISOString().slice(0, 7),
      }
      const { data: lead, error } = await supabase.from('leads').insert(newLead).select('id').single()
      if (!error && lead) { actions.leads_created++; actions.lead_ids.push(lead.id) }
    }
  }

  // 3) Proxima reuniao
  if (analysis.proxima_reuniao?.data && analysis.proxima_reuniao?.hora) {
    const dataReuniaoISO = `${analysis.proxima_reuniao.data}T${analysis.proxima_reuniao.hora}:00-03:00`
    const newReuniao = {
      lead_id: reuniao.lead_id || null,
      closer_id: reuniao.closer_confirmado_id || reuniao.closer_id || null,
      sdr_id: reuniao.sdr_id || null,
      empresa: reuniao.empresa,
      nome_contato: reuniao.nome_contato,
      canal: reuniao.canal,
      data_agendamento: new Date().toISOString().split('T')[0],
      data_reuniao: dataReuniaoISO,
      realizada: false,
    }
    const { data: nova, error } = await supabase.from('reunioes').insert(newReuniao).select('id').single()
    if (!error && nova) {
      actions.meeting_scheduled = true
      actions.next_reuniao_id = nova.id
      if (reuniao.lead_id) {
        await supabase.from('leads').update({ status: 'reuniao_marcada' }).eq('id', reuniao.lead_id)
      }
    }
  }

  return actions
}

// ============================================================
// process_pending: state machine server-side, chamado pelo pg_cron
// ============================================================

async function processPending(supabase: any): Promise<{ processed: number; advanced: number; errors: number }> {
  const { data: pending } = await supabase.from('post_meeting_automations')
    .select('id, reuniao_id, deal_id, status, created_at, transcript_text, ai_result, actions_taken')
    .in('status', ['pending', 'fetching_transcript', 'analyzing', 'applying'])
    .order('created_at', { ascending: true })
    .limit(20)

  if (!pending || pending.length === 0) return { processed: 0, advanced: 0, errors: 0 }

  let advanced = 0
  let errors = 0

  for (const auto of pending) {
    try {
      // ---- Stage 1: fetching transcript ----
      if (auto.status === 'pending' || auto.status === 'fetching_transcript') {
        const age = Date.now() - new Date(auto.created_at).getTime()
        if (age > TRANSCRIPT_TIMEOUT_MS) {
          await supabase.from('post_meeting_automations').update({
            status: 'error',
            error_message: 'Transcrição não apareceu em 2h. Verifique se gravação/transcrição do Meet está ativada para o organizador.',
          }).eq('id', auto.id)
          errors++
          continue
        }

        if (auto.status === 'pending') {
          await supabase.from('post_meeting_automations').update({ status: 'fetching_transcript' }).eq('id', auto.id)
        }

        const result = await tryFetchTranscriptForReuniao(supabase, auto.reuniao_id)

        if (result.status === 'needs_reauth') {
          await supabase.from('post_meeting_automations').update({
            status: 'error', error_message: result.error,
          }).eq('id', auto.id)
          errors++
          continue
        }

        if (result.status !== 'found' || !result.transcript_text) continue

        await supabase.from('post_meeting_automations').update({
          status: 'analyzing',
          transcript_text: result.transcript_text,
          actions_taken: { transcript_url: result.transcript_url || null, recording_url: result.recording_url || null },
        }).eq('id', auto.id)
        advanced++
        // Avanca imediatamente para analyzing nesta mesma tick
        auto.status = 'analyzing'
        auto.transcript_text = result.transcript_text
        auto.actions_taken = { transcript_url: result.transcript_url || null, recording_url: result.recording_url || null }
      }

      // ---- Stage 2: analyzing ----
      if (auto.status === 'analyzing' && auto.transcript_text) {
        const { data: reuniao } = await supabase.from('reunioes')
          .select('data_reuniao, data_agendamento')
          .eq('id', auto.reuniao_id).single()
        const meetingDate = (reuniao?.data_reuniao || reuniao?.data_agendamento || new Date().toISOString()).slice(0, 10)
        const prompt = buildPrompt(auto.transcript_text, meetingDate)
        const analysis = await callAnalyzeCall(auto.transcript_text, prompt)

        // Sanitizar
        analysis.produtos_ot = (analysis.produtos_ot || []).filter((p: string) => (PRODUTOS_OT as readonly string[]).includes(p))
        analysis.produtos_mrr = (analysis.produtos_mrr || []).filter((p: string) => (PRODUTOS_MRR as readonly string[]).includes(p))
        analysis.bant = Math.max(1, Math.min(4, Math.round(analysis.bant || 1)))
        analysis.valor_escopo = Math.max(0, analysis.valor_escopo || 0)
        analysis.valor_recorrente = Math.max(0, analysis.valor_recorrente || 0)

        await supabase.from('post_meeting_automations').update({
          status: 'applying', ai_result: analysis,
        }).eq('id', auto.id)
        advanced++
        auto.status = 'applying'
        auto.ai_result = analysis
      }

      // ---- Stage 3: applying ----
      if (auto.status === 'applying' && auto.ai_result) {
        const { data: reuniao } = await supabase.from('reunioes').select('*').eq('id', auto.reuniao_id).single()
        if (!reuniao) {
          await supabase.from('post_meeting_automations').update({
            status: 'error', error_message: 'Reunião não encontrada na fase apply',
          }).eq('id', auto.id)
          errors++; continue
        }

        const prev = auto.actions_taken || {}
        const actions = await applyActionsServerSide(
          supabase, reuniao, auto.deal_id,
          auto.ai_result,
          prev.transcript_url || null,
          prev.recording_url || null,
        )

        await supabase.from('post_meeting_automations').update({
          status: 'completed',
          actions_taken: actions,
          leads_created: actions.lead_ids,
          next_reuniao_id: actions.next_reuniao_id || null,
          completed_at: new Date().toISOString(),
        }).eq('id', auto.id)
        advanced++
      }
    } catch (e: any) {
      console.error('processPending erro em automation', auto.id, e?.message || e)
      await supabase.from('post_meeting_automations').update({
        status: 'error', error_message: e?.message || 'erro desconhecido',
      }).eq('id', auto.id)
      errors++
    }
  }

  return { processed: pending.length, advanced, errors }
}

// ============================================================
// HTTP entry
// ============================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const { action, data } = await req.json()

    if (action === 'process_pending') {
      const stats = await processPending(supabase)
      return json({ ok: true, ...stats })
    }

    if (action === 'fetch_transcript') {
      if (!data?.reuniao_id) return json({ error: 'reuniao_id obrigatório' }, 400)
      const result = await tryFetchTranscriptForReuniao(supabase, data.reuniao_id)
      if (result.status === 'needs_reauth') {
        return json({ error: result.error, needs_reauth: true }, 400)
      }
      if (result.status === 'not_found') {
        return json({ status: 'not_found', message: result.error, recording_url: result.recording_url })
      }
      return json({
        status: 'found',
        transcript_text: result.transcript_text,
        transcript_url: result.transcript_url,
        recording_url: result.recording_url,
      })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e: any) {
    console.error('google-drive error:', e)
    return json({ error: e.message }, 500)
  }
})

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
