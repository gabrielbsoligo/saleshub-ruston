// =============================================================
// Edge Function: webhook-3c-calls
// =============================================================
// Porta do fluxo n8n "{0.1-sales}[3cplus] storeNewCalls [kommo][saleshub]"
// pra dentro do SalesHub. O 3C Plus (evento call-history-was-created)
// chama direto:  POST /functions/v1/webhook-3c-calls?t=<THREEC_WEBHOOK_TOKEN>
//
// RESPOSTA IMEDIATA (10/08): o 3C desativa o webhook após 50 falhas e timeout
// conta como falha — o handler devolve 200 na hora e TODO o processamento roda
// em background (EdgeRuntime.waitUntil). A varredura sweep-3c-calls (cron 30min)
// reinjeta qualquer evento perdido caso o webhook caia mesmo assim.
//
// PROCESSAMENTO (background):
//   1. Resolve o lead: mailing_data.identifier (= id do lead no Kommo,
//      embutido na lista de discagem) com validação via GET no Kommo;
//      fallback: busca contato pelos 8 últimos dígitos do telefone.
//   2. Move por TABULAÇÃO (pedido do Gabriel, 09/08):
//      - 240055 "Conectei/Follow No Kommo" -> Pre Vendas (14062096) /
//        Conexão Realizada (108545100) + reatribui SDR pelo mapa 3C->Kommo
//        (fallback: mantém o responsável atual).
//      - 240056 "Não ligar mais" -> Outbound Disparo (14062116) /
//        OPT OUT (108545304).
//      - Qualquer outra tabulação (240054 rediscar, -2/-3/-4/-5 do sistema):
//        NENHUM move.
//      Guardas (caso Mega Ômega): lead no funil Closer nunca é movido;
//      ganho/perdido (142/143) não move; não regride lead que já está em
//      Reunião Marcada/NOSHOW do Pre Vendas.
//
// ASSÍNCRONO (EdgeRuntime.waitUntil, só se speaking_time > 0):
//   espera 8s -> baixa gravação do 3C (THREEC_API_TOKEN) -> transcreve
//   (Whisper, OPENAI_API_KEY) -> resumo -> nota "LIGAÇÃO" no lead ->
//   extração BANT -> atualiza os 11 campos textarea -> auditoria de cold
//   call -> POST callquality-ingest (call_quality + ligacoes_4com, '3c').
//   LLM de texto: OpenAI (gpt-4.1-mini) é a PRIMÁRIA; Claude entra como
//   RESERVA se a OpenAI falhar (sem saldo, 4xx/5xx, timeout) — pedido do
//   Gabriel em 09/08.
//
// Dedup por _id da chamada via call_quality (3C pode reentregar webhook).
// ?dry=1 executa o pipeline INTEIRO (inclusive gravação+Whisper+LLM) mas
// não escreve NADA (sem nota, sem PATCH, sem ingest) e responde com o
// diagnóstico — usado pra testar transcrição em produção sem sujar lead.
// Deploy: management API, verify_jwt=false (o 3C não manda header; o
// token de querystring faz o papel do path secreto do n8n).
// =============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? 'https://iaompeiokjxbffwehhrx.supabase.co'

// Tabulações do grupo "tabulações-ruston" no 3C
const QUAL_FOLLOW_KOMMO = 240055 // Conectei/Follow No Kommo
const QUAL_NAO_LIGAR = 240056    // Não ligar mais (opt-out)

// Destinos
const PRE_VENDAS_PIPELINE = 14062096
const CONEXAO_REALIZADA = 108545100
const PV_REUNIAO_MARCADA = 108545240
const PV_NOSHOW = 108545244
const DISPARO_PIPELINE = 14062116   // "Outbound Disparo"
const DISPARO_OPT_OUT = 108545304   // etapa OPT OUT
// Guarda
const CLOSER_PIPELINE = 11010459

// FALLBACK: id do agente no 3C -> usuário no Kommo (mapa fixo herdado do n8n).
// A fonte principal agora é team_members.agente_3c_id (editável na tela de equipe,
// migration_137) — usuário novo no 3C só precisa do campo preenchido lá.
const AGENTE_3C_KOMMO: Record<string, number> = {
  '234399': 15444836, // Edric
  '234394': 14559996, // Lary
  '234396': 15458912, // Bianca
  '236763': 14941987, // Guilherme (Olimpo)
  '234873': 11420911, // Gabriel Bianchini Soligo
  // '235982' Erick — sem id válido no Kommo: cai no fallback (mantém atual)
}

// Campos BANT (textarea) do lead no Kommo <-> chaves da extração
const BANT_FIELDS: Array<[number, string]> = [
  [508770, 'Resumo da Empresa'],
  [508772, 'Dor que precisa resolver'],
  [508774, 'Objetivos'],
  [508776, 'Faturamento'],
  [508778, 'Ticket Médio'],
  [508828, 'Como Investe? Quanto?'],
  [508830, 'Como Funciona o Marketing?'],
  [508832, 'Como é o processo comercial?'],
  [508834, 'Tem CRM? Qual?'],
  [508884, 'Quem vem para a reunião?'],
  [508886, 'Timming para fechamento'],
]

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

const KH = () => ({ Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'Content-Type': 'application/json' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- LLM de texto: OpenAI primária, Claude como reserva ----------------------
const OPENAI_MODEL = 'gpt-4.1-mini'                    // mesmo modelo do fluxo n8n
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'       // reserva

async function openaiChat(system: string, user: string, maxTokens: number): Promise<string | null> {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) return null
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  })
  if (!r.ok) { console.error('openai', r.status, (await r.text().catch(() => '')).slice(0, 300)); return null }
  const j = await r.json()
  return j?.choices?.[0]?.message?.content ?? null
}

async function claudeChat(system: string, user: string, maxTokens: number): Promise<string | null> {
  const key = Deno.env.get('ANTHROPIC_API_KEY')
  if (!key) return null
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: maxTokens,
      system, messages: [{ role: 'user', content: user }],
    }),
  })
  if (!r.ok) { console.error('claude', r.status, (await r.text().catch(() => '')).slice(0, 300)); return null }
  const j = await r.json()
  return j?.content?.[0]?.text ?? null
}

// OpenAI primeiro; se falhar (sem saldo, erro, sem chave), Claude assume.
async function ai(system: string, user: string, maxTokens = 2000): Promise<{ text: string | null; via: string | null }> {
  try {
    const t = await openaiChat(system, user, maxTokens)
    if (t) return { text: t, via: 'openai' }
  } catch (e) { console.error('openai exception', e) }
  try {
    const t = await claudeChat(system, user, maxTokens)
    if (t) return { text: t, via: 'claude(reserva)' }
  } catch (e) { console.error('claude exception', e) }
  return { text: null, via: null }
}

function parseJson(text: string | null): any {
  if (!text) return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// ---- Transcrição (3C recording -> Whisper) ----------------------------------
async function transcrever(callId: string): Promise<{ text: string | null; motivo?: string }> {
  const oak = Deno.env.get('OPENAI_API_KEY')
  if (!oak) return { text: null, motivo: 'OPENAI_API_KEY não configurada' }
  const t3c = Deno.env.get('THREEC_API_TOKEN')
  if (!t3c) return { text: null, motivo: 'THREEC_API_TOKEN não configurada' }

  let rec = await fetch(`https://app.3c.plus/api/v1/calls/${callId}/recording?api_token=${t3c}`)
  if (!rec.ok) rec = await fetch(`http://app.3c.plus/api/v1/calls/${callId}/recording?api_token=${t3c}`)
  if (!rec.ok) return { text: null, motivo: `gravação 3C HTTP ${rec.status}` }
  const buf = await rec.arrayBuffer()
  if (buf.byteLength < 1000) return { text: null, motivo: 'gravação vazia' }
  if (buf.byteLength > 24_000_000) return { text: null, motivo: 'gravação > 24MB (limite Whisper)' }

  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: rec.headers.get('content-type') ?? 'audio/mpeg' }), 'call.mp3')
  fd.append('model', 'whisper-1')
  fd.append('language', 'pt')
  const w = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${oak}` }, body: fd,
  })
  if (!w.ok) return { text: null, motivo: `whisper HTTP ${w.status}: ${(await w.text().catch(() => '')).slice(0, 200)}` }
  const j = await w.json()
  return { text: j?.text ?? null }
}

// ---- Pipeline pós-resposta (dry: roda tudo, não escreve nada) ----------------
async function processarChamada(ch: any, leadId: number, leadAtual: any, dry: boolean): Promise<any> {
  const callId = String(ch._id)
  const log = (...a: unknown[]) => console.log(`[3c ${callId}]`, ...a)
  const diag: any = { dry }
  try {
    if (!dry) await sleep(8000) // a gravação leva alguns segundos pra ficar disponível no 3C

    const { text: transcricao, motivo } = await transcrever(callId)
    diag.transcricao_chars = transcricao?.length ?? 0
    if (!transcricao) { diag.transcricao_motivo = motivo; log('sem transcrição:', motivo) }

    // (a) resumo -> nota no lead
    let resumo = '(transcrição indisponível)'
    if (transcricao) {
      const r = await ai(
        'Você resume ligações de prospecção. Responda SÓ com o resumo, sem preâmbulo.',
        `Resuma essa conversa abaixo em no máximo 3 frases, e se for caixa postal ou voicemail, responda apenas [CAIXA POSTAL]:\n\n${transcricao}`,
        400)
      resumo = r.text ?? '(resumo indisponível)'
      diag.resumo_via = r.via
    } else {
      resumo = `(transcrição indisponível — ${motivo})`
    }
    resumo = resumo.trim()
    diag.resumo = resumo.slice(0, 400)
    const voicemail = resumo.includes('[CAIXA POSTAL]')

    const nota = `LIGAÇÃO\nFeita por: ${ch.agent?.name ?? '?'}\nTabulação: ${ch.qualification?.name ?? '—'}\nResumo: ${resumo}\n\nTelefone do Cliente: ${ch.number ?? ''}\nDuração da chamada: ${ch.billed_time ?? ch.speaking_time ?? '?'} segundos`
    if (!dry) {
      const nr = await fetch(`${KOMMO_BASE}/api/v4/leads/${leadId}/notes`, {
        method: 'POST', headers: KH(),
        body: JSON.stringify([{ note_type: 'common', params: { text: nota } }]),
      })
      diag.nota_status = nr.status
      log('nota', nr.status)
    }

    if (!transcricao || voicemail) { diag.voicemail = voicemail; await ingest(ch, leadId, transcricao, null, dry); return diag }

    // (b) extração BANT -> 11 campos do lead
    const atuais: string[] = []
    for (const f of leadAtual?.custom_fields_values ?? []) {
      const known = BANT_FIELDS.find(([id]) => id === f.field_id)
      if (known) atuais.push(`- ${known[1]}: ${f.values?.[0]?.value ?? ''}`)
    }
    const bantR = await ai(
      `Você é um SDR da V4 Company, uma assessoria de marketing metódica e analítica, especialista na metodologia BANT. Analise a transcrição de ligação de prospecção e preencha um formulário com base nas informações extraídas.
Para cada campo, consolide os detalhes da transcrição com respostas bem detalhadas, priorizando pontos-chave. Caso alguma informação não seja mencionada, marque como 'não informado'.
Você também recebe os dados já preenchidos no CRM sobre esse lead; se houver informação anterior relevante para algum campo, insira-a novamente junto com as novas anotações.
Responda SOMENTE com um JSON válido cujas chaves são exatamente: ${BANT_FIELDS.map(([, k]) => JSON.stringify(k)).join(', ')}.`,
      `TRANSCRIÇÃO:\n${transcricao}\n\nDADOS JÁ NO CRM (lead ${leadId}):\n${atuais.join('\n') || '(nada preenchido)'}`,
      2500)
    const bant = parseJson(bantR.text)
    diag.bant_via = bantR.via
    diag.bant_ok = !!bant
    if (bant) {
      const cfv = BANT_FIELDS
        .map(([id, k]) => ({ id, val: typeof bant[k] === 'string' ? bant[k].trim() : '' }))
        .filter((f) => f.val)
        .map((f) => ({ field_id: f.id, values: [{ value: f.val }] }))
      diag.bant_campos = cfv.length
      if (cfv.length && !dry) {
        const ur = await fetch(`${KOMMO_BASE}/api/v4/leads/${leadId}`, {
          method: 'PATCH', headers: KH(), body: JSON.stringify({ custom_fields_values: cfv }),
        })
        diag.bant_status = ur.status
        log('bant', ur.status, cfv.length, 'campos')
      }
    } else log('extração BANT falhou')

    // (c) auditoria de cold call -> callquality-ingest
    const audR = await ai(
      `Você é um Auditor de Cold Calls sênior e especialista em Inside Sales (SDR/BDR). Analise a transcrição, avalie o desempenho do vendedor com base ESTRITAMENTE nestes critérios:
1. RAPPORT, ENERGIA E SORRISO NA VOZ; 2. QUALIFICAÇÃO BANT; 3. CRIAÇÃO DE URGÊNCIA; 4. CONTORNO DE OBJEÇÕES; 5. FECHAMENTO ALTERNATIVO (propôs duas opções de horários?).
Responda SOMENTE com JSON válido neste formato:
{"NOTA_FINAL": <0.0 a 10.0>, "PONTOS_POSITIVOS": ["...", "..."], "PONTOS_NEGATIVOS_OU_OPORTUNIDADES": ["...", "..."], "ANALISE_POR_CRITERIO": {"Rapport & Energia": "nota - justificativa", "Metodologia BANT": "nota - justificativa", "Urgência & Necessidade": "nota - justificativa", "Quebra de Objeções": "nota - justificativa", "Fechamento Alternativo": "nota - justificativa"}, "FEEDBACK_COACHING": "parágrafo direto ao vendedor"}
Baseie pontos positivos/negativos em trechos reais da ligação.`,
      `Transcrição:\n${transcricao}`,
      2500)
    const analise = parseJson(audR.text)
    diag.auditoria_via = audR.via
    diag.auditoria_ok = !!analise
    diag.nota_final = analise?.NOTA_FINAL ?? null
    if (!analise) log('auditoria falhou')
    await ingest(ch, leadId, transcricao, analise, dry)
    diag.ok = true
    return diag
  } catch (e) {
    console.error(`[3c ${callId}] erro no pipeline`, e)
    diag.erro = String((e as any)?.message ?? e)
    return diag
  }
}

async function ingest(ch: any, leadId: number, transcricao: string | null, analise: any, dry: boolean) {
  if (dry) return
  const r = await fetch(`${SUPABASE_URL}/functions/v1/callquality-ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: '3c', _id: String(ch._id), kommo_lead_id: leadId,
      caller: ch.agent?.name ?? null, called: ch.number ?? null, direction: 'outbound',
      speaking_time: ch.speaking_time ?? null, call_date: ch.call_date ?? null,
      agent: { id: String(ch.agent?.id ?? ''), name: ch.agent?.name ?? '' },
      transcricao, analise: analise ?? undefined,
    }),
  })
  console.log(`[3c ${ch._id}] ingest`, r.status)
}

// ---- Processamento completo de um evento (roda em BACKGROUND no fluxo normal) --
// O 3C DESATIVA o webhook sozinho após 50 envios sem sucesso (timeout conta como
// falha — aconteceu em 10/08, rajada do discador + latência do Kommo). Por isso o
// handler responde na hora e TODO o trabalho (dedup, resolução, moves, transcrição)
// acontece aqui, depois da resposta.
async function processarEvento(ch: any, dry: boolean): Promise<any> {
  const supabase = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

  // dedup: 3C pode reentregar o webhook — se a chamada já foi processada, para aqui
  const { data: dup } = await supabase.from('call_quality').select('id').eq('call_id', String(ch._id)).maybeSingle()
  if (dup && !dry) return { ok: true, skipped: 'chamada já processada', call_id: ch._id }

  // 1) resolve o lead: identifier da lista de discagem = id do lead no Kommo
  let leadId: number | null = null
  let leadAtual: any = null
  const ident = String(ch.mailing_data?.identifier ?? '').replace(/\D/g, '')
  const foneDigits = String(ch.number ?? '').replace(/\D/g, '')
  if (ident && ident !== foneDigits) {
    const lr = await fetch(`${KOMMO_BASE}/api/v4/leads/${ident}`, { headers: KH() })
    if (lr.ok) { leadId = Number(ident); leadAtual = await lr.json() }
  }
  if (!leadId && foneDigits.length >= 8) { // fallback: contato pelos 8 últimos dígitos (como o n8n)
    const cr = await fetch(`${KOMMO_BASE}/api/v4/contacts?query=${foneDigits.slice(-8)}&with=leads&limit=1`, { headers: KH() })
    if (cr.ok) {
      const cj = await cr.json().catch(() => null)
      const lid = cj?._embedded?.contacts?.[0]?._embedded?.leads?.[0]?.id
      if (lid) {
        const lr = await fetch(`${KOMMO_BASE}/api/v4/leads/${lid}`, { headers: KH() })
        if (lr.ok) { leadId = Number(lid); leadAtual = await lr.json() }
      }
    }
  }
  if (!leadId) return { ok: true, skipped: 'lead não encontrado no Kommo', identifier: ch.mailing_data?.identifier ?? null, number: ch.number ?? null }

  // 2) move por tabulação (só 240055 e 240056; o resto não mexe no lead)
  const qualId = Number(ch.qualification?.id ?? NaN)
  let move: any = null
  if (qualId === QUAL_FOLLOW_KOMMO || qualId === QUAL_NAO_LIGAR) {
    const pipeAtual = Number(leadAtual?.pipeline_id)
    const statusAtual = Number(leadAtual?.status_id)
    if (pipeAtual === CLOSER_PIPELINE) {
      move = { blocked: true, reason: 'lead_no_funil_closer' } // negociação em andamento — nunca puxar
    } else if (statusAtual === 142) {
      // GANHO nunca é puxado. PERDIDO fora do Closer PODE: as listas de disparo são de
      // reativação — SDR conectou e tabulou = reabre (caso Piano Tintas/Edric, 10/08);
      // e "não ligar mais" em perdido vai pro OPT OUT pra sair das listas.
      move = { blocked: true, reason: 'lead_ganho' }
    } else if (qualId === QUAL_FOLLOW_KOMMO && pipeAtual === PRE_VENDAS_PIPELINE
               && (statusAtual === PV_REUNIAO_MARCADA || statusAtual === PV_NOSHOW)) {
      move = { blocked: true, reason: 'nao_regride_reuniao_marcada' }
    } else {
      const patch: any = qualId === QUAL_FOLLOW_KOMMO
        ? { pipeline_id: PRE_VENDAS_PIPELINE, status_id: CONEXAO_REALIZADA }
        : { pipeline_id: DISPARO_PIPELINE, status_id: DISPARO_OPT_OUT }
      if (qualId === QUAL_FOLLOW_KOMMO) {
        // 1º team_members.agente_3c_id (tela de equipe); 2º mapa fixo; 3º mantém atual
        const agId = String(ch.agent?.id ?? '')
        let mapped: number | undefined
        if (agId) {
          const { data: tm } = await supabase.from('team_members')
            .select('kommo_user_id').eq('agente_3c_id', agId).eq('active', true).maybeSingle()
          if (tm?.kommo_user_id) mapped = Number(tm.kommo_user_id)
        }
        mapped = mapped ?? AGENTE_3C_KOMMO[agId]
        patch.responsible_user_id = mapped ?? Number(leadAtual?.responsible_user_id) // fallback: mantém atual
      }
      if (dry) {
        move = { would_patch: patch }
      } else {
        const mr = await fetch(`${KOMMO_BASE}/api/v4/leads/${leadId}`, {
          method: 'PATCH', headers: KH(), body: JSON.stringify(patch),
        })
        move = { patch, kommo_status: mr.status }
        if (!mr.ok) move.kommo_body = await mr.text().catch(() => null)
      }
    }
  }

  if (move) console.log(`[3c ${ch._id}] move`, JSON.stringify(move))

  // 3) transcrição/nota/BANT/auditoria (só chamada atendida)
  let background: any = 'pulado (speaking_time = 0)'
  if (Number(ch.speaking_time ?? 0) > 0) {
    background = await processarChamada(ch, leadId, leadAtual, dry)
  }

  return { ok: true, dry, call_id: ch._id, lead_id: leadId, qualification: ch.qualification?.name ?? null, move, background }
}

// ---- Handler: responde NA HORA (3C conta timeout como falha e desativa após 50) --
Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405)
  const url = new URL(req.url)
  const tok = Deno.env.get('THREEC_WEBHOOK_TOKEN')
  if (!tok || url.searchParams.get('t') !== tok) return json({ error: 'unauthorized' }, 401)
  const dry = url.searchParams.get('dry') === '1'

  let body: any
  try { body = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  const ch = body?.body?.['call-history-was-created']?.callHistory
    ?? body?.['call-history-was-created']?.callHistory ?? body?.callHistory
  if (!ch?._id) return json({ ok: true, skipped: 'payload sem callHistory' })

  if (dry) return json(await processarEvento(ch, true))   // teste: síncrono, sem escritas

  EdgeRuntime.waitUntil(
    processarEvento(ch, false)
      .then((r) => console.log(`[3c ${ch._id}] resultado`, JSON.stringify(r).slice(0, 500)))
      .catch((e) => console.error(`[3c ${ch._id}] erro`, e))
  )
  return json({ ok: true, queued: true, call_id: ch._id })
})
