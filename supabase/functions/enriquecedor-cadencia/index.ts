// enriquecedor-cadencia — o "carteiro" da cadência outbound SDNA.
//
// O SalesHub cria a infra no Kommo via API e orquestra os disparos de template
// WABA; os Salesbots (criados 1x na UI, 1 por template) fazem o envio em si e
// devolvem a resposta do lead pra cá via passo "enviar webhook".
//
// Ações (POST, header x-enriq-secret; webhook aceita ?s=<secret> na query):
//   {acao:'setup', etapas?:['campos','funil','templates'], apenas?:nomeTemplate, dry_run?}
//       cria campos custom, funil e templates WABA no Kommo (idempotente)
//   {acao:'submeter', apenas?}        envia os templates criados pra revisão da Meta
//   {acao:'sync-review'}              atualiza review_status a partir do Kommo
//   {acao:'vincular-bot', template, bot_id}  liga um Salesbot da UI a um template
//   {acao:'disparar', dry_run?, limite?}     um ciclo do carteiro (P1 + P2 48h + P3 96h)
//   {acao:'status'}                   resumo da fila/envios
//   ?acao=webhook&s=<secret>          retorno dos Salesbots (quick reply / texto livre)
//
// Secrets: ENRIQ_KOMMO_SECRET, KOMMO_API_TOKEN, ENRIQ_INTEG_EMAIL, ENRIQ_INTEG_SENHA.
// Opcionais: KOMMO_SUBDOMAIN, ENRIQ_MOTOR_URL, ENRIQ_APP_URL. Deploy --no-verify-jwt.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-enriq-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

const KOMMO_SUB = Deno.env.get('KOMMO_SUBDOMAIN') || 'financeirorustonengenhariacombr'
const BASE = `https://${KOMMO_SUB}.kommo.com`
const MOTOR_URL = (Deno.env.get('ENRIQ_MOTOR_URL') || 'https://saleshub-ruston-production.up.railway.app').replace(/\/$/, '')
const APP_URL = (Deno.env.get('ENRIQ_APP_URL') || 'https://gestao-comercial-rosy.vercel.app').replace(/\/$/, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Kommo com espaçamento (~7 req/s de teto; mantém folga) ───────────────────
let ultima = 0
async function kommo(method: string, path: string, body?: unknown) {
  const espera = 160 - (Date.now() - ultima)
  if (espera > 0) await sleep(espera)
  ultima = Date.now()
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const txt = await r.text()
  let parsed: unknown = null
  try { parsed = txt ? JSON.parse(txt) : null } catch { parsed = txt }
  return { status: r.status, ok: r.ok, body: parsed as any }
}

const sb = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// Login do usuário de integração → JWT aceito pelo motor e pelas RLS.
async function tokenIntegracao(): Promise<string | null> {
  const { data, error } = await sb().auth.signInWithPassword({
    email: Deno.env.get('ENRIQ_INTEG_EMAIL')!,
    password: Deno.env.get('ENRIQ_INTEG_SENHA')!,
  })
  if (error || !data.session) return null
  return data.session.access_token
}

// ── Infra no Kommo: campos custom, funil, placeholders ───────────────────────
// Nomes fixos — o lookup é por nome (idempotência sem guardar ids de config).
const CAMPOS = [
  { name: 'CAD Nome decisor', type: 'text' },
  { name: 'CAD SDR', type: 'text' },
  { name: 'CAD Fantasia', type: 'text' },
  { name: 'CAD Frase falha', type: 'text' },
  { name: 'CAD Frase impacto', type: 'text' },
  { name: 'CAD Rotulo 2a falha', type: 'text' },
  { name: 'CAD Template', type: 'text' },
  { name: 'CAD Passo', type: 'numeric' },
  { name: 'CAD Falha primaria', type: 'text' },
  { name: 'CAD Optout', type: 'checkbox' },
  { name: 'Enriquecedor URL', type: 'url' },
] as const

const FUNIL_NOME = 'Outbound Cadência SDNA'
const ETAPAS_FUNIL = [
  'Fila',
  'Passo 1 enviado',
  'Passo 2 enviado',
  'Passo 3 enviado',
  'Respondeu - interesse',
  'Respondeu - objeção',
  'Sem resposta',
  'Opt-out',
]

// Ordem posicional das variáveis de cada template ({{1}}..{{n}} → campo custom).
const VARS_POR_TEMPLATE: Record<string, string[]> = {
  sdna_p1_auditoria_v1: ['CAD Nome decisor', 'CAD SDR', 'CAD Fantasia', 'CAD Frase falha', 'CAD Frase impacto'],
  sdna_p1_auditoria_v2: ['CAD Nome decisor', 'CAD SDR', 'CAD Fantasia', 'CAD Frase falha', 'CAD Frase impacto'],
  sdna_p2_segunda_falha_v1: ['CAD Nome decisor', 'CAD Fantasia', 'CAD Rotulo 2a falha'],
  sdna_p2_aprofunda_v1: ['CAD Nome decisor', 'CAD Fantasia'],
  sdna_p3_breakup_v1: ['CAD Nome decisor', 'CAD Fantasia'],
  sdna_p3_breakup_v2: ['CAD Nome decisor', 'CAD Fantasia'],
}

// Exemplos pro review da Meta — par da falha 4 (semanuncio), o mais longo do catálogo.
const EXEMPLOS: Record<string, string> = {
  'CAD Nome decisor': 'Jorge',
  'CAD SDR': 'Lary',
  'CAD Fantasia': 'Alumitec',
  'CAD Frase falha': 'não encontrei nenhum anúncio ativo de vocês nas plataformas nos últimos 30 dias',
  'CAD Frase impacto': 'hoje vocês só aparecem pra quem já conhece a marca e foi procurar — quem está descobrindo o serviço agora não passa por vocês',
  'CAD Rotulo 2a falha': 'o perfil do Google sem avaliações',
}

async function listarCamposCustom(): Promise<Map<string, { id: number; type: string }>> {
  const map = new Map<string, { id: number; type: string }>()
  for (let page = 1; page <= 5; page++) {
    const r = await kommo('GET', `/api/v4/leads/custom_fields?limit=250&page=${page}`)
    if (r.status === 204 || !r.ok) break
    const items = r.body?._embedded?.custom_fields ?? []
    for (const f of items) map.set(String(f.name), { id: Number(f.id), type: String(f.type) })
    if (items.length < 250) break
  }
  return map
}

async function acharFunil(): Promise<{ id: number; etapas: Map<string, number> } | null> {
  const r = await kommo('GET', '/api/v4/leads/pipelines')
  const pipes = r.body?._embedded?.pipelines ?? []
  const p = pipes.find((x: any) => String(x.name).trim() === FUNIL_NOME)
  if (!p) return null
  const etapas = new Map<string, number>()
  for (const s of p._embedded?.statuses ?? []) etapas.set(String(s.name).trim(), Number(s.id))
  return { id: Number(p.id), etapas }
}

// Placeholder do Kommo pra campo custom de lead no corpo do template.
// Validar no primeiro template criado (ver docs/ENRIQUECEDOR.md); se o formato
// da conta divergir, ajustar só aqui.
const placeholderDe = (fieldId: number) => `{{lead.cf.${fieldId}}}`

function contentKommo(corpo: string, tplNome: string, campos: Map<string, { id: number }>) {
  const ordem = VARS_POR_TEMPLATE[tplNome] ?? []
  return corpo.replace(/\{\{(\d)\}\}/g, (_m, i) => {
    const nomeCampo = ordem[Number(i) - 1]
    const f = nomeCampo ? campos.get(nomeCampo) : null
    return f ? placeholderDe(f.id) : `{{${i}}}`
  })
}

// ── setup ─────────────────────────────────────────────────────────────────────
async function acaoSetup(b: Record<string, any>) {
  const etapas: string[] = b.etapas ?? ['campos', 'funil', 'templates']
  const dryRun = b.dry_run !== false
  const out: Record<string, unknown> = { dry_run: dryRun }

  let campos = await listarCamposCustom()
  if (etapas.includes('campos')) {
    const faltam = CAMPOS.filter((c) => !campos.has(c.name))
    out.campos = { existentes: CAMPOS.length - faltam.length, a_criar: faltam.map((c) => c.name) }
    if (!dryRun && faltam.length) {
      const r = await kommo('POST', '/api/v4/leads/custom_fields', faltam.map((c) => ({ name: c.name, type: c.type })))
      out.campos_criados = { status: r.status, erro: r.ok ? null : JSON.stringify(r.body).slice(0, 300) }
      campos = await listarCamposCustom()
    }
  }

  if (etapas.includes('funil')) {
    const funil = await acharFunil()
    out.funil = funil ? { id: funil.id, existente: true } : { a_criar: FUNIL_NOME, etapas: ETAPAS_FUNIL }
    if (!dryRun && !funil) {
      const r = await kommo('POST', '/api/v4/leads/pipelines', [{
        name: FUNIL_NOME,
        sort: 100,
        is_main: false,
        is_unsorted_on: false,
        _embedded: { statuses: ETAPAS_FUNIL.map((nome, i) => ({ name: nome, sort: (i + 1) * 10 })) },
      }])
      out.funil_criado = { status: r.status, id: r.body?._embedded?.pipelines?.[0]?.id ?? null, erro: r.ok ? null : JSON.stringify(r.body).slice(0, 300) }
    }
  }

  if (etapas.includes('templates')) {
    const db = sb()
    let q = db.from('enriquecedor_cadencia_templates').select('*').eq('canal', 'whatsapp').eq('ativo', true)
    if (b.apenas) q = q.eq('nome', String(b.apenas))
    const { data: tpls } = await q
    const resultados: unknown[] = []
    for (const t of tpls ?? []) {
      if (t.kommo_template_id) { resultados.push({ nome: t.nome, ja_criado: t.kommo_template_id }); continue }
      const content = contentKommo(String(t.corpo), String(t.nome), campos)
      const exemplos: Record<string, string> = {}
      for (const nomeCampo of VARS_POR_TEMPLATE[t.nome] ?? []) {
        const f = campos.get(nomeCampo)
        if (f) exemplos[placeholderDe(f.id)] = EXEMPLOS[nomeCampo] ?? nomeCampo
      }
      const payload = [{
        name: t.nome,
        content,
        type: 'waba',
        external_id: t.id,
        is_editable: true,
        buttons: (t.botoes ?? []).map((texto: string) => ({ type: 'inline', text: texto })),
        waba_category: 'MARKETING',
        waba_language: 'pt_BR',
        waba_examples: exemplos,
      }]
      if (dryRun) { resultados.push({ nome: t.nome, payload }); continue }
      const r = await kommo('POST', '/api/v4/chats/templates', payload)
      const criado = r.body?._embedded?.chat_templates?.[0] ?? r.body?._embedded?.templates?.[0] ?? null
      if (r.ok && criado?.id) {
        await db.from('enriquecedor_cadencia_templates')
          .update({ kommo_template_id: String(criado.id), review_status: 'nao_submetido' })
          .eq('id', t.id)
      }
      resultados.push({ nome: t.nome, status: r.status, kommo_id: criado?.id ?? null, erro: r.ok ? null : JSON.stringify(r.body).slice(0, 400) })
    }
    out.templates = resultados
  }
  return json(200, { ok: true, ...out })
}

// ── revisão da Meta ──────────────────────────────────────────────────────────
// O status verdadeiro vem em _embedded.reviews[].status (review|approved|rejected|
// paused) por source (número WABA). Resposta SEM reviews = a submissão não pegou
// (em geral, número WABA não vinculado ao template) — reportar, não mascarar.
const MAPA_REVIEW: Record<string, string> = {
  approved: 'aprovado', rejected: 'rejeitado', review: 'em_revisao', pending: 'em_revisao', paused: 'rejeitado',
}
function statusDeReviews(reviews: any[]): { status: string | null; detalhe: any[] } {
  const detalhe = (reviews ?? []).map((x) => ({ source_id: x.source_id, status: x.status, reject_reason: x.reject_reason || null }))
  if (!detalhe.length) return { status: null, detalhe }
  // Pior status manda: rejeitado > em_revisao > aprovado (só aprovado se TODOS aprovados).
  const mapeados = detalhe.map((d) => MAPA_REVIEW[String(d.status).toLowerCase()] ?? 'em_revisao')
  const status = mapeados.includes('rejeitado') ? 'rejeitado' : mapeados.includes('em_revisao') ? 'em_revisao' : 'aprovado'
  return { status, detalhe }
}

async function acaoSubmeter(b: Record<string, any>) {
  const db = sb()
  let q = db.from('enriquecedor_cadencia_templates').select('*').eq('canal', 'whatsapp').not('kommo_template_id', 'is', null)
  if (b.apenas) q = q.eq('nome', String(b.apenas))
  const { data: tpls } = await q
  const resultados: unknown[] = []
  for (const t of tpls ?? []) {
    const r = await kommo('POST', `/api/v4/chats/templates/${t.kommo_template_id}/review`, {})
    const { status, detalhe } = statusDeReviews(r.body?._embedded?.reviews ?? [])
    if (r.ok && status) await db.from('enriquecedor_cadencia_templates').update({ review_status: status }).eq('id', t.id)
    resultados.push({
      nome: t.nome,
      http: r.status,
      review: status,
      reviews: detalhe,
      aviso: r.ok && !status ? 'submissão aceita mas SEM registro de revisão — checar vínculo do número WABA' : null,
      erro: r.ok ? null : JSON.stringify(r.body).slice(0, 300),
    })
  }
  return json(200, { ok: true, templates: resultados })
}

async function acaoSyncReview() {
  const db = sb()
  const { data: tpls } = await db.from('enriquecedor_cadencia_templates').select('*').not('kommo_template_id', 'is', null)
  const r = await kommo('GET', '/api/v4/chats/templates?limit=250&with=reviews')
  const remotos = r.body?._embedded?.chat_templates ?? []
  const porId = new Map(remotos.map((x: any) => [String(x.id), x]))
  const resultados: unknown[] = []
  for (const t of tpls ?? []) {
    const remoto = porId.get(String(t.kommo_template_id))
    const { status, detalhe } = statusDeReviews(remoto?._embedded?.reviews ?? [])
    if (status && status !== t.review_status) {
      await db.from('enriquecedor_cadencia_templates').update({ review_status: status }).eq('id', t.id)
    }
    resultados.push({ nome: t.nome, kommo_id: t.kommo_template_id, status: status ?? t.review_status, reviews: detalhe })
  }
  return json(200, { ok: true, templates: resultados })
}

async function acaoVincularBot(b: Record<string, any>) {
  if (!b.template || !b.bot_id) return json(400, { error: 'template e bot_id obrigatórios' })
  const { error } = await sb().from('enriquecedor_cadencia_templates')
    .update({ kommo_bot_id: Number(b.bot_id) })
    .eq('nome', String(b.template))
  return json(error ? 500 : 200, { ok: !error, erro: error?.message ?? null })
}

// ── disparar: um ciclo do carteiro ───────────────────────────────────────────
async function runBot(botId: number, kommoLeadId: number) {
  // Endpoint atual (v4) de disparo de Salesbot num lead.
  const r = await kommo('POST', `/api/v4/bots/${botId}/run`, { entity_id: kommoLeadId, entity_type: 'leads' })
  return r
}

async function nomeResponsavel(kommoLeadId: string, cacheUsers: Map<number, string>) {
  const r = await kommo('GET', `/api/v4/leads/${kommoLeadId}`)
  const uid = Number(r.body?.responsible_user_id ?? 0)
  if (!uid) return { sdrNome: null, uid: null }
  if (!cacheUsers.size) {
    const ru = await kommo('GET', '/api/v4/users?limit=250')
    for (const u of ru.body?._embedded?.users ?? []) cacheUsers.set(Number(u.id), String(u.name ?? ''))
  }
  const nome = (cacheUsers.get(uid) ?? '').split(/\s+/)[0] || null
  return { sdrNome: nome, uid }
}

// Contexto compartilhado de disparo (carregado uma vez por requisição).
async function contextoDisparo() {
  const db = sb()
  const { data: tpls } = await db.from('enriquecedor_cadencia_templates').select('*').eq('canal', 'whatsapp')
  const tplPorNome = new Map((tpls ?? []).map((t) => [String(t.nome), t]))
  const campos = await listarCamposCustom()
  const funil = await acharFunil()
  const token = await tokenIntegracao()
  const cacheUsers = new Map<number, string>()
  return { db, tplPorNome, campos, funil, token, cacheUsers }
}

// Dispara UM passo pra UM lead: prepara no motor, registra o envio ANTES de
// mexer no Kommo (dedupe do webhook e de retries), grava os campos CAD, move
// o card (se `mover`) e roda o Salesbot do template.
async function dispararLeadPasso(ctx: any, lead: any, passo: number, opts: { mover: boolean; dryRun: boolean; envioId?: string }) {
  const { db, tplPorNome, campos, funil, token, cacheUsers } = ctx
  const finaliza = async (patch: Record<string, unknown>) => {
    if (opts.envioId) await db.from('enriquecedor_cadencia_envios').update(patch).eq('id', opts.envioId)
  }

  const { sdrNome } = await nomeResponsavel(String(lead.kommo_lead_id), cacheUsers)
  const rp = await fetch(`${MOTOR_URL}/api/cadencia/preparar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ leadId: lead.id, sdrNome, persistir: true }),
  })
  const pac = await rp.json().catch(() => null)
  if (!rp.ok || !pac?.aptoCadencia) {
    const motivo = pac?.motivo ?? pac?.error ?? `motor HTTP ${rp.status}`
    await finaliza({ status: 'falhou', erro: String(motivo).slice(0, 300) })
    return { lead: lead.razao_social ?? lead.nome_fantasia, passo, pulado: motivo }
  }
  const msg = pac.whatsapp?.[`p${passo}`]
  const tpl = msg ? tplPorNome.get(String(msg.template)) : null
  if (!msg || !tpl) {
    await finaliza({ status: 'falhou', erro: 'template do passo indisponível' })
    return { lead: lead.razao_social, passo, pulado: 'template do passo indisponível' }
  }

  const valores: Record<string, string> = {}
  const ordem = VARS_POR_TEMPLATE[String(msg.template)] ?? []
  ordem.forEach((nomeCampo: string, i: number) => { valores[nomeCampo] = String(msg.variaveis[i] ?? '') })
  valores['CAD Template'] = String(msg.template)
  valores['CAD Passo'] = String(passo)
  valores['CAD Falha primaria'] = String(pac.falhaPrimaria?.codigo ?? '')
  valores['Enriquecedor URL'] = `${APP_URL}/enriquecedor/#lead=${lead.id}`

  const linha: any = {
    lead: lead.razao_social ?? lead.nome_fantasia,
    kommo_lead_id: lead.kommo_lead_id,
    passo,
    template: msg.template,
    variaveis: msg.variaveis,
    bot_id: tpl.kommo_bot_id ?? null,
    review: tpl.review_status,
  }
  if (opts.dryRun) return linha

  if (tpl.review_status !== 'aprovado' || !tpl.kommo_bot_id) {
    await finaliza({ status: 'falhou', erro: 'template sem aprovação/bot' })
    return { ...linha, pulado: 'template sem aprovação da Meta ou sem bot vinculado' }
  }

  // Registro do envio ANTES do Kommo (se ainda não existe placeholder).
  let envioId = opts.envioId
  if (!envioId) {
    const { data: env } = await db.from('enriquecedor_cadencia_envios').insert({
      lead_id: lead.id,
      kommo_lead_id: String(lead.kommo_lead_id),
      canal: 'whatsapp',
      passo,
      status: 'processando',
    }).select('id').single()
    envioId = env?.id
  }

  const cfv = Object.entries(valores)
    .map(([nomeCampo, valor]) => {
      const f = campos.get(nomeCampo)
      if (!f) return null
      return { field_id: f.id, values: [{ value: f.type === 'numeric' ? Number(valor) : valor }] }
    })
    .filter(Boolean)
  const patch: Record<string, unknown> = { custom_fields_values: cfv }
  if (opts.mover) {
    const statusId = funil?.etapas.get(`Passo ${passo} enviado`)
    if (statusId) { patch.status_id = statusId; patch.pipeline_id = funil.id }
  }
  const rl = await kommo('PATCH', `/api/v4/leads/${lead.kommo_lead_id}`, patch)
  if (!rl.ok) {
    await db.from('enriquecedor_cadencia_envios').update({ status: 'falhou', erro: `PATCH lead HTTP ${rl.status}` }).eq('id', envioId)
    return { ...linha, erro: `PATCH lead HTTP ${rl.status}` }
  }

  const rb = await runBot(Number(tpl.kommo_bot_id), Number(lead.kommo_lead_id))
  const okBot = rb.ok || rb.status === 202
  await db.from('enriquecedor_cadencia_envios').update({
    template_id: tpl.id,
    falha_codigo: pac.falhaPrimaria?.codigo ?? null,
    sdr_nome: sdrNome,
    variaveis_enviadas: msg.variaveis,
    kommo_campos: valores,
    status: okBot ? 'enviado' : 'falhou',
    enviado_em: okBot ? new Date().toISOString() : null,
    erro: okBot ? null : `bot run HTTP ${rb.status}: ${JSON.stringify(rb.body).slice(0, 200)}`,
  }).eq('id', envioId)
  return { ...linha, envio_id: envioId ?? null, bot_ok: okBot }
}

// disparar = SÓ follow-ups automáticos (P2 48h / P3 96h sem resposta).
// O P1 é decisão humana: mover o card de "Fila" pra "Passo 1 enviado" no Kommo
// (o kommo-webhook capta a mudança e dispara). Sem cap — o volume é do operador.
async function acaoDisparar(b: Record<string, any>) {
  const dryRun = b.dry_run !== false
  const limite = Math.min(Number(b.limite ?? 200), 500)
  const ctx = await contextoDisparo()
  if (!ctx.token) return json(500, { error: 'auth do usuário de integração falhou' })
  if (!dryRun && !ctx.funil) return json(422, { error: `funil "${FUNIL_NOME}" não existe — rode setup` })

  const { db } = ctx
  const { data: aptos } = await db.from('enriquecedor_leads')
    .select('id, kommo_lead_id, nome_fantasia, razao_social, optout')
    .eq('optout', false).not('kommo_lead_id', 'is', null).limit(1000)
  const porId = new Map((aptos ?? []).map((l) => [l.id, l]))
  const { data: envios } = await db.from('enriquecedor_cadencia_envios')
    .select('id, lead_id, passo, enviado_em, status, respondido_em').eq('canal', 'whatsapp')
  const enviosPorLead = new Map<string, any[]>()
  for (const e of envios ?? []) {
    const arr = enviosPorLead.get(e.lead_id) ?? []
    arr.push(e)
    enviosPorLead.set(e.lead_id, arr)
  }
  const horas = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3_600_000
  const plano: any[] = []
  for (const [leadId, arr] of enviosPorLead) {
    if (plano.length >= limite) break
    const lead = porId.get(leadId)
    if (!lead) continue
    if (arr.some((e) => e.respondido_em || e.status === 'respondido')) continue
    const p1 = arr.find((e) => e.passo === 1 && e.status === 'enviado')
    const p2 = arr.find((e) => e.passo === 2)
    const p3 = arr.find((e) => e.passo === 3)
    let passo: number | null = null
    if (p1 && !p2 && p1.enviado_em && horas(p1.enviado_em) >= 48) passo = 2
    else if (p2 && !p3 && p2.status === 'enviado' && p2.enviado_em && horas(p2.enviado_em) >= 96) passo = 3
    if (!passo) continue
    plano.push({ lead, passo })
  }

  const resultados: any[] = []
  for (const item of plano) {
    resultados.push(await dispararLeadPasso(ctx, item.lead, item.passo, { mover: true, dryRun }))
  }
  return json(200, {
    ok: true,
    dry_run: dryRun,
    total_plano: plano.length,
    por_passo: [2, 3].map((p) => ({ passo: p, leads: plano.filter((x) => x.passo === p).length })),
    resultados,
  })
}

// Webhook de mudança de etapa do Kommo (form-encoded): mover um card do funil
// da cadência pra "Passo N enviado" dispara o passo N — o gatilho HUMANO do P1.
async function acaoKommoWebhook(body: Record<string, any>) {
  const eventos: { id: string; status_id: number; pipeline_id: number }[] = []
  for (let i = 0; i < 60; i++) {
    const id = body[`leads[status][${i}][id]`]
    if (!id) break
    eventos.push({
      id: String(id),
      status_id: Number(body[`leads[status][${i}][status_id]`] ?? 0),
      pipeline_id: Number(body[`leads[status][${i}][pipeline_id]`] ?? 0),
    })
  }
  if (!eventos.length) return json(200, { ok: true, ignorado: 'sem eventos de status' })

  const funil = await acharFunil()
  if (!funil) return json(200, { ok: true, ignorado: 'funil da cadência não existe' })
  const passoDaEtapa = new Map<number, number>()
  for (const p of [1, 2, 3]) {
    const sid = funil.etapas.get(`Passo ${p} enviado`)
    if (sid) passoDaEtapa.set(sid, p)
  }
  const relevantes = eventos.filter((e) => e.pipeline_id === funil.id && passoDaEtapa.has(e.status_id))
  if (!relevantes.length) return json(200, { ok: true, ignorado: 'fora do funil/etapas da cadência' })

  const ctx = await contextoDisparo()
  if (!ctx.token) return json(200, { ok: false, erro: 'auth integração falhou' })
  const { db } = ctx
  const resultados: any[] = []
  for (const ev of relevantes) {
    const passo = passoDaEtapa.get(ev.status_id)!
    const { data: lead } = await db.from('enriquecedor_leads')
      .select('id, kommo_lead_id, nome_fantasia, razao_social, optout')
      .eq('kommo_lead_id', ev.id).maybeSingle()
    if (!lead) { resultados.push({ kommo_lead_id: ev.id, ignorado: 'card não é do enriquecedor' }); continue }
    if (lead.optout) { resultados.push({ kommo_lead_id: ev.id, ignorado: 'optout' }); continue }
    // Dedupe: se o passo já tem envio (inclusive 'processando' de outro worker), não repete.
    const { data: ja } = await db.from('enriquecedor_cadencia_envios')
      .select('id, status').eq('lead_id', lead.id).eq('canal', 'whatsapp').eq('passo', passo)
      .in('status', ['processando', 'enviado', 'respondido']).limit(1)
    if (ja?.length) { resultados.push({ kommo_lead_id: ev.id, passo, ignorado: `passo ${passo} já disparado` }); continue }
    // Placeholder de envio JÁ AQUI — trava retries do webhook durante o processamento.
    const { data: env } = await db.from('enriquecedor_cadencia_envios').insert({
      lead_id: lead.id, kommo_lead_id: String(lead.kommo_lead_id), canal: 'whatsapp', passo, status: 'processando',
    }).select('id').single()
    resultados.push(await dispararLeadPasso(ctx, lead, passo, { mover: false, dryRun: false, envioId: env?.id }))
  }
  return json(200, { ok: true, disparos: resultados })
}

// ── webhook: retorno dos Salesbots ───────────────────────────────────────────
const BOTOES_CLASSE: Record<string, string> = {
  'pode ligar agora': 'interesse',
  'pode ligar': 'interesse',
  'fala comigo depois': 'objecao_momento',
  'ligar mais tarde': 'objecao_momento',
  'não é o momento': 'objecao_momento',
  'nao e o momento': 'objecao_momento',
  'prefiro por aqui': 'pedido_info',
  'não quero receber': 'optout',
  'nao quero receber': 'optout',
  'tira da lista': 'optout',
}

async function acaoWebhook(body: Record<string, any>) {
  const db = sb()
  const kommoLeadId = String(body.kommo_lead_id ?? body.lead_id ?? body.lead ?? '').replace(/\D/g, '')
  const texto = String(body.texto ?? body.message ?? body.button ?? body.text ?? '').trim()
  if (!kommoLeadId || !texto) return json(400, { error: 'lead_id e texto obrigatórios', recebido: body })

  const { data: lead } = await db.from('enriquecedor_leads').select('id, optout').eq('kommo_lead_id', kommoLeadId).maybeSingle()
  if (!lead) return json(404, { error: `lead kommo ${kommoLeadId} não encontrado no enriquecedor` })

  const { data: envio } = await db.from('enriquecedor_cadencia_envios')
    .select('id, passo').eq('lead_id', lead.id).eq('canal', 'whatsapp')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()

  // Quick reply = determinístico; texto livre = motor (regex opt-out + IA).
  const chave = texto.toLowerCase()
  let classificacao = BOTOES_CLASSE[chave] ?? null
  let confianca = classificacao ? 1.0 : null
  let classificadoPor = classificacao ? 'botao' : 'ia'
  if (!classificacao) {
    const token = await tokenIntegracao()
    if (token) {
      const r = await fetch(`${MOTOR_URL}/api/cadencia/classificar`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ texto }),
      })
      const j = await r.json().catch(() => null)
      if (j?.ok) { classificacao = j.classificacao; confianca = j.confianca; classificadoPor = j.classificado_por ?? 'ia' }
    }
  }

  await db.from('enriquecedor_cadencia_respostas').insert({
    envio_id: envio?.id ?? null,
    lead_id: lead.id,
    canal: 'whatsapp',
    tipo_retorno: classificadoPor === 'botao' ? 'quick_reply' : 'texto_livre',
    payload_bruto: texto.slice(0, 4000),
    classificacao,
    confianca,
    classificado_por: classificadoPor,
  })
  if (envio?.id) {
    await db.from('enriquecedor_cadencia_envios')
      .update({ status: 'respondido', respondido_em: new Date().toISOString() })
      .eq('id', envio.id)
  }

  const funil = await acharFunil()
  const mover = async (etapa: string) => {
    const sId = funil?.etapas.get(etapa)
    if (sId) await kommo('PATCH', `/api/v4/leads/${kommoLeadId}`, { status_id: sId, pipeline_id: funil!.id })
  }

  if (classificacao === 'optout') {
    await db.from('enriquecedor_leads').update({ optout: true, apto_cadencia: false }).eq('id', lead.id)
    const campos = await listarCamposCustom()
    const f = campos.get('CAD Optout')
    if (f) await kommo('PATCH', `/api/v4/leads/${kommoLeadId}`, { custom_fields_values: [{ field_id: f.id, values: [{ value: true }] }] })
    await mover('Opt-out')
  } else if (classificacao === 'interesse') {
    await mover('Respondeu - interesse')
    const rlead = await kommo('GET', `/api/v4/leads/${kommoLeadId}`)
    await kommo('POST', '/api/v4/tasks', [{
      entity_id: Number(kommoLeadId),
      entity_type: 'leads',
      text: `CADENCIA: lead respondeu com interesse ("${texto.slice(0, 120)}"). Ligar AGORA — CTA prometia retorno em minutos.`,
      task_type_id: 1,
      complete_till: Math.floor(Date.now() / 1000) + 2 * 3600,
      responsible_user_id: Number(rlead.body?.responsible_user_id ?? 0) || undefined,
    }])
  } else if (classificacao && confianca != null && confianca < 0.7) {
    const rlead = await kommo('GET', `/api/v4/leads/${kommoLeadId}`)
    await kommo('POST', '/api/v4/tasks', [{
      entity_id: Number(kommoLeadId),
      entity_type: 'leads',
      text: `CADENCIA: classificar manualmente a resposta do lead: "${texto.slice(0, 300)}" (IA em dúvida: ${classificacao}, ${confianca})`,
      task_type_id: 1,
      complete_till: Math.floor(Date.now() / 1000) + 24 * 3600,
      responsible_user_id: Number(rlead.body?.responsible_user_id ?? 0) || undefined,
    }])
  } else if (classificacao) {
    await mover('Respondeu - objeção')
  }

  return json(200, { ok: true, classificacao, confianca, classificado_por: classificadoPor })
}

// ── coletar-respostas: polling de eventos de chat ────────────────────────────
// O widget_request importado não roda sem widget, então a captura é: os bots
// gravam a resposta no campo "CAD Resposta" (branch de botão = rótulo fixo;
// else = {{message_text}}), e aqui a gente varre os eventos incoming_chat_message
// desde o último cursor, lê o campo, classifica via acaoWebhook e limpa o campo.
async function acaoColetarRespostas() {
  const db = sb()
  const { data: estadoRow } = await db.from('enriquecedor_cadencia_estado').select('valor').eq('chave', 'coletor').maybeSingle()
  const agora = Math.floor(Date.now() / 1000)
  const cursor = Number(estadoRow?.valor?.cursor ?? agora - 24 * 3600)
  const vistos: string[] = Array.isArray(estadoRow?.valor?.vistos) ? estadoRow.valor.vistos : []

  // eventos novos (com 60s de sobreposição pra não perder borda; dedupe por id de mensagem)
  const eventos: any[] = []
  for (let page = 1; page <= 4; page++) {
    const r = await kommo('GET', `/api/v4/events?filter[type]=incoming_chat_message&filter[created_at][from]=${cursor - 60}&limit=100&page=${page}`)
    if (r.status === 204 || !r.ok) break
    const items = r.body?._embedded?.events ?? []
    eventos.push(...items)
    if (items.length < 100) break
  }

  const campos = await listarCamposCustom()
  const campoResposta = campos.get('CAD Resposta')
  const resultados: any[] = []
  let maxTs = cursor
  const novosVistos = [...vistos]

  for (const ev of eventos) {
    maxTs = Math.max(maxTs, Number(ev.created_at ?? 0))
    const msgId = String(ev.value_after?.[0]?.message?.id ?? ev.id)
    if (novosVistos.includes(msgId)) continue
    novosVistos.push(msgId)

    const kommoLeadId = String(ev.entity_id ?? '')
    if (!kommoLeadId) continue
    const { data: lead } = await db.from('enriquecedor_leads').select('id').eq('kommo_lead_id', kommoLeadId).maybeSingle()
    if (!lead) continue // mensagem de lead fora da cadência

    // resposta que o bot gravou no campo
    let texto = ''
    if (campoResposta) {
      const rl = await kommo('GET', `/api/v4/leads/${kommoLeadId}`)
      const cf = (rl.body?.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === campoResposta.id)
      texto = String(cf?.values?.[0]?.value ?? '').trim()
    }

    if (texto) {
      const resp = await acaoWebhook({ kommo_lead_id: kommoLeadId, texto })
      const jr = await resp.json().catch(() => null)
      resultados.push({ kommo_lead_id: kommoLeadId, texto: texto.slice(0, 80), classificacao: jr?.classificacao ?? null })
      // limpa o campo pra próxima resposta não reaproveitar valor velho
      await kommo('PATCH', `/api/v4/leads/${kommoLeadId}`, {
        custom_fields_values: [{ field_id: campoResposta!.id, values: [{ value: '' }] }],
      })
    } else {
      // Sem texto no campo: se o último envio JÁ foi respondido, é só a conversa
      // seguindo com o SDR (o bot encerra após a 1ª resposta) — ignora. Só vira
      // registro de auditoria quando ainda esperávamos a resposta da cadência.
      const { data: ultimoEnvio } = await db.from('enriquecedor_cadencia_envios')
        .select('status').eq('lead_id', lead.id).eq('canal', 'whatsapp')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (ultimoEnvio && ultimoEnvio.status !== 'respondido') {
        await db.from('enriquecedor_cadencia_respostas').insert({
          lead_id: lead.id, canal: 'whatsapp', tipo_retorno: 'texto_livre',
          payload_bruto: null, classificacao: null, classificado_por: 'coletor_sem_texto',
        })
        resultados.push({ kommo_lead_id: kommoLeadId, texto: null, aviso: 'resposta sem texto no campo CAD Resposta' })
      } else {
        resultados.push({ kommo_lead_id: kommoLeadId, ignorado: 'conversa em andamento pós-resposta' })
      }
    }
  }

  await db.from('enriquecedor_cadencia_estado').upsert({
    chave: 'coletor',
    valor: { cursor: maxTs, vistos: novosVistos.slice(-200) },
    updated_at: new Date().toISOString(),
  })
  return json(200, { ok: true, eventos_lidos: eventos.length, respostas_processadas: resultados.length, resultados })
}

async function acaoStatus() {
  const db = sb()
  const { count: aptos } = await db.from('enriquecedor_leads').select('id', { count: 'exact', head: true })
    .eq('apto_cadencia', true).eq('optout', false).not('kommo_lead_id', 'is', null)
  const { data: tpls } = await db.from('enriquecedor_cadencia_templates')
    .select('nome, review_status, kommo_template_id, kommo_bot_id').eq('canal', 'whatsapp')
  const { data: envios } = await db.from('enriquecedor_cadencia_envios').select('passo, status')
  const porPasso: Record<string, Record<string, number>> = {}
  for (const e of envios ?? []) {
    porPasso[`p${e.passo}`] = porPasso[`p${e.passo}`] ?? {}
    porPasso[`p${e.passo}`][e.status] = (porPasso[`p${e.passo}`][e.status] ?? 0) + 1
  }
  const { count: respostas } = await db.from('enriquecedor_cadencia_respostas').select('id', { count: 'exact', head: true })
  return json(200, { ok: true, aptos_na_fila: aptos, templates: tpls, envios_por_passo: porPasso, respostas })
}

// ── servidor ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json(405, { error: 'método não suportado' })

  const url = new URL(req.url)
  const secret = Deno.env.get('ENRIQ_KOMMO_SECRET')
  const viaHeader = req.headers.get('x-enriq-secret') === secret
  // O Kommo às vezes armazena o destino com '&' virando '&amp;' — aceita os dois.
  const viaQuery = url.searchParams.get('s') === secret || url.searchParams.get('amp;s') === secret

  // Kommo manda webhooks form-encoded; nossas ações usam JSON. Aceita os dois.
  const raw = await req.text()
  let body: Record<string, any> = {}
  try {
    body = raw ? JSON.parse(raw) : {}
  } catch {
    body = Object.fromEntries(new URLSearchParams(raw).entries())
  }
  const acao = String(body.acao ?? url.searchParams.get('acao') ?? '')

  // Webhooks (Salesbot e Kommo) não mandam header custom — autenticam pelo ?s=.
  // Todas as outras ações exigem o header.
  if (acao === 'webhook') {
    if (!viaQuery && !viaHeader) return json(401, { error: 'segredo inválido' })
    return await acaoWebhook(body)
  }
  if (acao === 'kommo-webhook') {
    if (!viaQuery && !viaHeader) return json(401, { error: 'segredo inválido' })
    return await acaoKommoWebhook(body)
  }
  if (!viaHeader) return json(401, { error: 'segredo inválido' })

  try {
    if (acao === 'setup') return await acaoSetup(body)
    if (acao === 'submeter') return await acaoSubmeter(body)
    if (acao === 'sync-review') return await acaoSyncReview()
    if (acao === 'vincular-bot') return await acaoVincularBot(body)
    if (acao === 'disparar') {
      // colhe respostas pendentes ANTES de decidir P2/P3 (gating "sem resposta")
      try { await acaoColetarRespostas() } catch { /* coleta não trava o disparo */ }
      return await acaoDisparar(body)
    }
    if (acao === 'coletar-respostas') return await acaoColetarRespostas()
    if (acao === 'status') return await acaoStatus()
    return json(400, { error: "acao deve ser setup|submeter|sync-review|vincular-bot|disparar|coletar-respostas|status|webhook" })
  } catch (e) {
    return json(500, { error: String((e as Error)?.message ?? e) })
  }
})
