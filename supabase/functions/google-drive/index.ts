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
const MIN_TRANSCRICAO_CHARS = 200 // abaixo disso: sem fala suficiente -> "sem transcrição válida"

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

// Uma sessão da reunião = um Doc de transcrição do Meet (cliente que cai e
// reentra gera N Docs no mesmo evento). recording_url é anexado por ordem/tempo.
interface TranscriptSession {
  drive_file_id: string
  titulo: string
  transcript_url: string | null
  transcript_text: string | null
  recording_url: string | null
  started_at: string | null   // modifiedTime do Doc (ordena cronologicamente)
}

class InsufficientScopeError extends Error {
  constructor() { super('ACCESS_TOKEN_SCOPE_INSUFFICIENT'); this.name = 'InsufficientScopeError' }
}

// Coleta TODAS as sessões (Docs de transcrição) da janela do evento — não pega só 1.
// Dedup por id. Vídeos coletados à parte e anexados por ordem cronológica.
async function collectSessionsInDrive(
  token: string,
  fingerprint: { summary: string; startIso: string; meetCode: string | null; fallbackEmpresa?: string },
): Promise<TranscriptSession[]> {
  if (!fingerprint.startIso) return []

  // Janela temporal: do início do evento até 24h depois (transcript demora ~30 min)
  const start = new Date(fingerprint.startIso)
  const after = new Date(start.getTime() - 60 * 60 * 1000).toISOString() // 1h antes (margem)
  const before = new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString()

  // Termos de busca: priorizar título do evento, fallback no nome da empresa
  const searchTerms: string[] = []
  if (fingerprint.summary) searchTerms.push(fingerprint.summary)
  if (fingerprint.fallbackEmpresa) {
    if (!searchTerms.includes(fingerprint.fallbackEmpresa)) searchTerms.push(fingerprint.fallbackEmpresa)
    const firstName = fingerprint.fallbackEmpresa.split(/\s+/)[0]
    if (firstName && firstName.length >= 3 && !searchTerms.includes(firstName)) searchTerms.push(firstName)
  }
  if (searchTerms.length === 0) return []

  const meetFolderId = await findMeetRecordingsFolderId(token)
  console.log(`  searchTerms: ${JSON.stringify(searchTerms)}, meetFolder: ${meetFolderId ? 'found' : 'none'}`)

  const isTranscript = (n: string) => /transcript|transcri[çc][ãa]o/i.test(n)

  // ---- Coletar TODOS os Docs candidatos (dedup por id) ----
  const docsById = new Map<string, { id: string; name: string; webViewLink: string; modifiedTime: string }>()
  const folderPasses = meetFolderId ? [meetFolderId, null] : [null]
  for (const folderId of folderPasses) {
    for (const term of searchTerms) {
      const safe = term.replace(/'/g, "\\'")
      const parts = [
        `name contains '${safe}'`,
        `mimeType='application/vnd.google-apps.document'`,
        `modifiedTime >= '${after}'`,
        `modifiedTime <= '${before}'`,
        `trashed=false`,
      ]
      if (folderId) parts.push(`'${folderId}' in parents`)
      const query = parts.join(' and ')
      const searchResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink,modifiedTime)&orderBy=modifiedTime desc&pageSize=25`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      )
      if (searchResp.status === 403) {
        const errBody = await searchResp.json().catch(() => ({}))
        if (JSON.stringify(errBody).includes('SCOPE_INSUFFICIENT')) throw new InsufficientScopeError()
      }
      if (!searchResp.ok) { console.log(`  Drive search failed: ${searchResp.status}`); continue }
      const files = (await searchResp.json()).files || []
      for (const f of files) if (f.id && !docsById.has(f.id)) docsById.set(f.id, f)
    }
  }

  let docs = [...docsById.values()]
  // Se algum arquivo parece transcrição pelo nome, mantém só esses (evita puxar
  // outros Docs com o mesmo termo no título). Senão, usa todos os candidatos.
  const named = docs.filter(d => isTranscript(d.name))
  if (named.length > 0) docs = named
  console.log(`  Docs candidatos: ${docs.length}`, docs.map(d => d.name))

  // ---- Coletar vídeos (gravações) ----
  const recordings: { url: string; modifiedTime: string }[] = []
  for (const term of searchTerms) {
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
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )
    if (videoResp.status === 403) {
      const errBody = await videoResp.json().catch(() => ({}))
      if (JSON.stringify(errBody).includes('SCOPE_INSUFFICIENT')) throw new InsufficientScopeError()
    }
    if (videoResp.ok) {
      const v = (await videoResp.json()).files || []
      for (const f of v) if (f.webViewLink && !recordings.some(r => r.url === f.webViewLink)) {
        recordings.push({ url: f.webViewLink, modifiedTime: f.modifiedTime })
      }
    }
  }
  recordings.sort((a, b) => (a.modifiedTime || '').localeCompare(b.modifiedTime || ''))

  // ---- Extrair texto de cada Doc; montar sessões em ordem cronológica ----
  const sessions: TranscriptSession[] = []
  // ordena por modifiedTime asc (cronológico)
  docs.sort((a, b) => (a.modifiedTime || '').localeCompare(b.modifiedTime || ''))
  for (const d of docs) {
    let text: string | null = null
    const docResp = await fetch(
      `https://docs.googleapis.com/v1/documents/${d.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    )
    if (docResp.ok) text = extractTextFromDoc(await docResp.json())
    sessions.push({
      drive_file_id: d.id,
      titulo: d.name,
      transcript_url: d.webViewLink || null,
      transcript_text: text,
      recording_url: null,
      started_at: d.modifiedTime || null,
    })
  }
  // anexa gravações por ordem (sessão i ↔ gravação i)
  sessions.forEach((s, i) => { if (recordings[i]) s.recording_url = recordings[i].url })
  return sessions
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
  transcript_text?: string        // concatenado de TODAS as sessões (cache/compat)
  transcript_url?: string          // 1ª sessão
  recording_url?: string
  sessions?: TranscriptSession[]   // todas as sessões (fonte-da-verdade)
  error?: string
}

// Concatena o texto das sessões em ordem cronológica com marcador por sessão.
function concatSessions(sessions: TranscriptSession[]): string {
  const withText = sessions.filter(s => (s.transcript_text || '').trim().length > 0)
  if (withText.length === 0) return ''
  if (withText.length === 1) return (withText[0].transcript_text || '').trim()
  return withText.map((s, i) => {
    const hhmm = s.started_at ? new Date(s.started_at).toISOString().slice(11, 16) : `${i + 1}`
    return `--- Sessão ${i + 1} (${hhmm}) ---\n${(s.transcript_text || '').trim()}`
  }).join('\n\n')
}

// Persiste as sessões em reuniao_transcricoes (upsert por (reuniao_id, drive_file_id) —
// re-execução não duplica). Fonte-da-verdade das transcrições.
async function persistSessions(supabase: any, reuniaoId: string, sessions: TranscriptSession[]): Promise<void> {
  if (!sessions.length) return
  const rows = sessions.map((s, i) => ({
    reuniao_id: reuniaoId,
    sessao: i + 1,
    fonte: 'google_meet',
    titulo: s.titulo || null,
    transcript_url: s.transcript_url,
    transcript_text: s.transcript_text,
    recording_url: s.recording_url,
    drive_file_id: s.drive_file_id,
    started_at: s.started_at,
  }))
  const { error } = await supabase
    .from('reuniao_transcricoes')
    .upsert(rows, { onConflict: 'reuniao_id,drive_file_id' })
  if (error) console.error('persistSessions erro:', error.message)
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

  // Buscar TODAS as sessões no Drive de CADA candidato até encontrar
  let lastRecordingUrl: string | undefined
  const needsReauthMembers: string[] = []
  let successfulSearches = 0

  for (const entry of tokenEntries) {
    try {
      console.log(`Buscando transcrições no Drive do membro ${entry.memberId}...`)
      console.log(`  fingerprint: summary="${fingerprint.summary}", empresa="${fingerprint.fallbackEmpresa}", startIso="${fingerprint.startIso}"`)
      const sessions = await collectSessionsInDrive(entry.token, fingerprint)
      successfulSearches++
      const rec = sessions.find(s => s.recording_url)?.recording_url
      if (rec) lastRecordingUrl = rec
      const concat = concatSessions(sessions)
      console.log(`  resultado: ${sessions.length} sessões, texto=${concat.length} chars, recording=${!!rec}`)
      if (concat.length > 0) {
        return {
          status: 'found',
          transcript_text: concat,
          transcript_url: sessions.find(s => s.transcript_url)?.transcript_url || undefined,
          recording_url: rec || lastRecordingUrl,
          sessions,
        }
      }
    } catch (e: any) {
      if (e instanceof InsufficientScopeError) {
        // Marcar membro como desconectado para forçar reconexão com scopes corretos
        await supabase.from('team_members').update({
          google_calendar_connected: false,
        }).eq('id', entry.memberId)
        const { data: member } = await supabase.from('team_members')
          .select('name').eq('id', entry.memberId).single()
        needsReauthMembers.push(member?.name || 'Membro desconhecido')
        console.warn(`InsufficientScope para membro ${entry.memberId} (${member?.name}), marcado para reconexão`)
        continue
      }
      throw e
    }
  }

  // Só retorna needs_reauth se NENHUM membro conseguiu buscar (todos deram scope error)
  if (needsReauthMembers.length > 0 && successfulSearches === 0) {
    return {
      status: 'needs_reauth',
      recording_url: lastRecordingUrl,
      error: `${needsReauthMembers.join(', ')} precisa(m) reconectar o Google na tela de Equipe (permissões insuficientes para acessar Drive)`,
    }
  }

  // Se houve buscas bem-sucedidas mas não achou, retorna not_found (com nota de reauth se aplicável)
  const reauthNote = needsReauthMembers.length > 0
    ? ` (${needsReauthMembers.join(', ')} precisa reconectar Google)`
    : ''
  return {
    status: 'not_found',
    recording_url: lastRecordingUrl,
    error: `Transcrição ainda não disponível no Drive de nenhum participante${reauthNote}`,
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
- "quente": Cliente vai analisar contrato, pediu proposta formal, ou ja tomou decisao de fechar na call
- "morno": Cliente precisa levar para o decisor, ou tem interesse mas depende de outra pessoa
- "frio": Nao tem data definida para fechar, cliente indefinido, sem compromisso concreto

### Proximo Passo
- "contrato_na_rua": Cliente pediu contrato ou esta analisando proposta formal (temperatura quente)
- "contrato_assinado": Cliente confirmou fechamento na propria call
- "negociacao": Ainda em negociacao ativa, com proxima reuniao marcada
- "follow_longo": Sem data definida para proximo contato, acompanhamento de longo prazo
- "perdido": Cliente deu negativa clara, nao quer prosseguir

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

### Perfil de Cadencia (perfil_cadencia)
Extraia o retrato do lead para personalizar o follow-up do closer:
- nome: nome do contato/decisor; segmento: setor/nicho da empresa
- dores[]: principais dores/problemas ditos (mais forte primeiro)
- deadline: prazo/urgencia mencionado (texto livre) ou null
- plano: plano/pacote discutido ou null; preco: valor proposto (number) ou null; desconto: desconto falado ou null
- metas[]: metas/objetivos do lead; objecoes[]: objecoes levantadas; decisor: quem decide (texto) ou null
Preencha so o que foi dito; use null/[] quando nao houver.

### Plano de Cadencia (plano_cadencia)
Monte o follow-up personalizado do closer com base no que foi ACORDADO na call:
- datas_acordadas[]: datas/horarios ABSOLUTOS combinados para retomar (ISO "YYYY-MM-DDTHH:MM:SS", fuso America/Sao_Paulo). Use as datas ACORDADAS na call; se so houve "semana que vem"/"depois do feriado", converta para uma data concreta a partir de ${meetingDate} e empurre para dia util (evite sabado/domingo).
- tarefas_especificas[]: compromissos pontuais explicitos (ex: "mandar proposta ate sexta") -> {"quando": ISO absoluto, "o_que": texto do que fazer}
A quantidade/tipo base de toques vem do balde (stage) no SalesHub; aqui voce SO informa as datas acordadas e tarefas pontuais. Se nada foi acordado, retorne datas_acordadas:[] e tarefas_especificas:[].

## Formato JSON
{
  "temperatura": "quente"|"morno"|"frio",
  "proximo_passo": "negociacao"|"contrato_na_rua"|"contrato_assinado"|"follow_longo"|"perdido",
  "valor_escopo": number, "valor_recorrente": number,
  "produtos_ot": [string], "produtos_mrr": [string],
  "bant": number, "tier": "tiny"|"small"|"medium"|"large"|"enterprise",
  "resumo_executivo": "string max 200 palavras pt-br",
  "indicacoes": [{"nome": string, "empresa": string, "telefone": string|null}],
  "proxima_reuniao": {"data": "YYYY-MM-DD", "hora": "HH:MM"}|null,
  "perfil_cadencia": {"nome": string|null, "segmento": string|null, "dores": [string], "deadline": string|null, "plano": string|null, "preco": number|null, "desconto": string|null, "metas": [string], "objecoes": [string], "decisor": string|null},
  "plano_cadencia": {"datas_acordadas": [string], "tarefas_especificas": [{"quando": string, "o_que": string}]}
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
    // Cadencia do closer: perfil + plano personalizado (usados pelo kommo.plan_closer atras da flag)
    if (analysis.perfil_cadencia && typeof analysis.perfil_cadencia === 'object') { upd.cadencia_perfil = analysis.perfil_cadencia; fields.push('cadencia_perfil') }
    if (analysis.plano_cadencia && typeof analysis.plano_cadencia === 'object'
        && (Array.isArray(analysis.plano_cadencia.datas_acordadas) || Array.isArray(analysis.plano_cadencia.tarefas_especificas))) {
      upd.cadencia_closer_plan = analysis.plano_cadencia; fields.push('cadencia_closer_plan')
    }
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

  // 3) Proxima reuniao — DESATIVADO.
  // A IA NAO cria mais reuniao de retorno automaticamente (gerava duplicatas sem vinculo
  // Kommo/Calendar, que apareciam como 1a call que ninguem agendou). A data sugerida pela
  // IA (analysis.proxima_reuniao) continua disponivel no resultado e so preenche data_retorno
  // no drawer, sem criar reuniao. meeting_scheduled fica sempre false.

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
          // Se já há sessões persistidas mas sem fala suficiente = "sem transcrição válida"
          // (não gera resumo falso). Senão, transcrição realmente não apareceu.
          const { data: sess } = await supabase.from('reuniao_transcricoes')
            .select('transcript_text').eq('reuniao_id', auto.reuniao_id)
          const totalChars = (sess || []).reduce((n: number, s: any) => n + ((s.transcript_text || '').trim().length), 0)
          const error_message = (sess && sess.length > 0 && totalChars < MIN_TRANSCRICAO_CHARS)
            ? 'Sem transcrição válida: sessões encontradas mas sem fala suficiente para analisar.'
            : 'Transcrição não apareceu em 2h. Verifique se gravação/transcrição do Meet está ativada para o organizador.'
          await supabase.from('post_meeting_automations').update({ status: 'error', error_message }).eq('id', auto.id)
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

        // Persiste TODAS as sessões encontradas (fonte-da-verdade), mesmo que ainda
        // vá esperar mais — dedup por drive_file_id evita duplicar na próxima tick.
        if (result.sessions?.length) await persistSessions(supabase, auto.reuniao_id, result.sessions)

        if (result.status !== 'found' || !result.transcript_text) continue

        // FALLBACK: texto concatenado abaixo do limiar = sem fala suficiente.
        // Não gera resumo falso — segue esperando (mais sessões/transcrição pode chegar);
        // ao estourar o timeout de 2h vira erro "sem transcrição válida".
        if (result.transcript_text.trim().length < MIN_TRANSCRICAO_CHARS) {
          console.log(`  transcrição abaixo do limiar (${result.transcript_text.trim().length} < ${MIN_TRANSCRICAO_CHARS}), aguardando`)
          continue
        }

        await supabase.from('post_meeting_automations').update({
          status: 'analyzing',
          transcript_text: result.transcript_text,   // cache do concatenado
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
      // Persiste as sessões achadas (mesmo comportamento do cron) — dedup evita duplicar.
      if (result.sessions?.length) await persistSessions(supabase, data.reuniao_id, result.sessions)
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
        sessions_count: result.sessions?.length || 0,
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
