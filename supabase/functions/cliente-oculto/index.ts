// cliente-oculto — Cliente oculto automatizado no Enriquecedor (Evolution API + Claude Haiku).
//
// Rotas (POST JSON; segredo no caminho /s/<segredo> para webhook/cron; Bearer de membro ativo para a tela):
//   /s/<segredo>  body = evento da Evolution (messages.upsert / connection.update)   ← webhook
//   /s/<segredo>  {acao:'varrer'}                                                   ← cron */10
//   Bearer        {acao:'iniciar', lead_id, numero?, nicho?}   → cria sessão e manda a abertura (se config.ativo e conectado)
//   Bearer        {acao:'cancelar', sessao_id}
//   Bearer        {acao:'instancia', op:'criar'|'qr'|'estado'} → prepara o número (QR na tela)
// Segredos (edge): EVOLUTION_URL, EVOLUTION_APIKEY, ANTHROPIC_API_KEY. Sem EVOLUTION_* configurado
// nada é enviado: as sessões ficam 'pendente' e a tela avisa "sem número conectado".
// Deploy: --no-verify-jwt.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { consolidar, decidir, metricas, numeroWa, personaPara, promptAbertura, promptAvaliacao, promptProximaFala, textoDoEvento, type Msg, type Sessao } from './conversa.ts'
import { anthropicHaiku, evolution, extrairJson, type Evolution, type Llm } from './adaptadores.ts'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const admin = () => createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
const agoraS = () => Math.floor(Date.now() / 1000)
const iso = (s: number) => new Date(s * 1000).toISOString()
const seg = (t: string | null) => (t ? Math.floor(new Date(t).getTime() / 1000) : null)

type Cfg = { instancia: string; ativo: boolean; conectado: boolean; numero: string | null; max_turnos: number; janela_followup_h: number; modelo: string }
async function config(sb: any): Promise<Cfg> {
  const { data, error } = await sb.from('oculto_config').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`oculto_config: ${error.message}`)
  if (!data) throw new Error('oculto_config ausente (migration_165)')
  return data as Cfg
}
function evo(cfg: Cfg): Evolution | null {
  const url = Deno.env.get('EVOLUTION_URL'), key = Deno.env.get('EVOLUTION_APIKEY')
  return url && key ? evolution(url, key, cfg.instancia) : null
}
function llm(cfg: Cfg): Llm | null { const k = Deno.env.get('ANTHROPIC_API_KEY'); return k ? anthropicHaiku(k, cfg.modelo) : null }

async function autenticarMembro(req: Request, sb: any): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  if (!jwt) return null
  const { data: u } = await sb.auth.getUser(jwt)
  if (!u?.user) return null
  const { data: tm } = await sb.from('team_members').select('id, active').eq('auth_user_id', u.user.id).maybeSingle()
  return tm?.id && tm.active !== false ? tm.id : null
}

function toSessao(r: any): Sessao {
  return { id: r.id, empresa: r.empresa, nicho: r.nicho, numero_alvo: r.numero_alvo, status: r.status, iniciada_em: seg(r.iniciada_em), ultima_in_em: seg(r.ultima_in_em), ultima_out_em: seg(r.ultima_out_em), turnos_persona: r.turnos_persona ?? 0, max_turnos: r.max_turnos ?? 4, janela_followup_h: r.janela_followup_h ?? 72 }
}
async function historico(sb: any, sessaoId: string): Promise<Msg[]> {
  const { data, error } = await sb.from('oculto_mensagens').select('direcao, texto, em').eq('sessao_id', sessaoId).order('em')
  if (error) throw new Error(`oculto_mensagens: ${error.message}`)
  return (data ?? []).map((m: any) => ({ direcao: m.direcao, texto: m.texto, ts: seg(m.em)! }))
}
async function gravar(sb: any, id: string, patch: Record<string, unknown>) {
  const r = await sb.from('oculto_sessoes').update({ ...patch, atualizado_em: new Date().toISOString() }).eq('id', id).select('id')
  if (r.error) throw new Error(`oculto_sessoes: ${r.error.message}`)
  if (!r.data?.length) throw new Error('sessão não encontrada')
}
async function registrarMsg(sb: any, sessaoId: string, direcao: 'in' | 'out', texto: string, ts: number, waId: string | null, bruto?: unknown): Promise<boolean> {
  const r = await sb.from('oculto_mensagens').upsert({ sessao_id: sessaoId, direcao, texto, em: iso(ts), wa_id: waId, bruto: bruto ?? null }, { onConflict: 'sessao_id,wa_id', ignoreDuplicates: true }).select('id')
  if (r.error) throw new Error(`oculto_mensagens: ${r.error.message}`)
  return (r.data?.length ?? 0) > 0
}

/** fala da persona: gera com o LLM, envia pela Evolution, registra; falha de envio deixa a sessão em 'erro' (sem reenviar) */
async function falar(sb: any, cfg: Cfg, s: Sessao, persona: any, hist: Msg[], abertura: boolean) {
  const modelo = llm(cfg), wa = evo(cfg)
  if (!modelo) throw new Error('ANTHROPIC_API_KEY ausente')
  if (!wa) throw new Error('Evolution não configurada (EVOLUTION_URL/APIKEY)')
  const texto = (await modelo(abertura ? promptAbertura(persona, s.empresa) : promptProximaFala(persona, s.empresa, hist), 300)).replace(/^["“]|["”]$/g, '').trim()
  if (!texto) throw new Error('modelo devolveu texto vazio')
  const env = await wa.enviarTexto(s.numero_alvo, texto)
  if (!env.ok) { await gravar(sb, s.id, { status: 'erro', erro: `envio falhou HTTP ${env.status}: ${env.nota ?? ''}` }); return }
  const ts = agoraS()
  await registrarMsg(sb, s.id, 'out', texto, ts, env.id ?? `out-${ts}`)
  await gravar(sb, s.id, { status: abertura ? 'enviada' : 'conversando', iniciada_em: abertura ? iso(ts) : undefined, ultima_out_em: iso(ts), turnos_persona: s.turnos_persona + 1 })
}

/** encerra: métricas + avaliação do LLM (se houve conversa) + notas consolidadas */
async function concluir(sb: any, cfg: Cfg, s: Sessao, hist: Msg[], motivo: string) {
  const m = metricas(hist, agoraS(), s.janela_followup_h)
  let ia: any = null, parecer = m.respondeu ? null : `A empresa não respondeu em ${s.janela_followup_h} h (${motivo}).`
  if (m.respondeu) {
    const modelo = llm(cfg)
    if (modelo) { try { ia = extrairJson(await modelo(promptAvaliacao(s.empresa, hist, m), 700)); parecer = ia?.parecer ?? null } catch (e) { parecer = `avaliação IA indisponível: ${String((e as Error)?.message ?? e).slice(0, 120)}` } }
  }
  const notas = consolidar(m, ia)
  await gravar(sb, s.id, { status: 'concluida', metricas: m, notas, parecer, avaliacao_ia: ia, concluida_em: new Date().toISOString() })
  return { id: s.id, notas, motivo }
}

/** avança uma sessão conforme a máquina de estados */
async function avancar(sb: any, cfg: Cfg, row: any) {
  const s = toSessao(row); const hist = await historico(sb, s.id)
  const d = decidir(s, hist, agoraS())
  if (d.acao === 'esperar') return { id: s.id, acao: 'esperar' }
  if (d.acao === 'responder') { await falar(sb, cfg, s, row.persona ?? personaPara(s.nicho, s.empresa), hist, false); return { id: s.id, acao: 'respondeu' } }
  if (d.acao === 'aguardar_followup') { await gravar(sb, s.id, { status: 'aguardando_followup' }); return { id: s.id, acao: 'aguardando_followup' } }
  return await concluir(sb, cfg, s, hist, d.motivo)
}

async function webhook(sb: any, cfg: Cfg, body: any) {
  const ev = String(body?.event ?? '').toLowerCase().replace(/_/g, '.')
  if (ev === 'connection.update') {
    const estado = String(body?.data?.state ?? body?.data?.status ?? '')
    await sb.from('oculto_config').update({ conectado: estado === 'open', atualizado_em: new Date().toISOString() }).eq('id', 1)
    return { ok: true, conectado: estado === 'open' }
  }
  if (ev !== 'messages.upsert') return { ok: true, ignorado: ev || 'sem evento' }
  const itens: any[] = Array.isArray(body?.data) ? body.data : [body?.data]
  const out: unknown[] = []
  for (const data of itens) {
    const m = textoDoEvento(data)
    if (!m || !m.de) { out.push({ ignorado: 'sem remetente' }); continue }
    const { data: ss, error } = await sb.from('oculto_sessoes').select('*').eq('numero_alvo', m.de).in('status', ['enviada', 'conversando', 'aguardando_followup']).order('criado_em', { ascending: false }).limit(1)
    if (error) throw new Error(`oculto_sessoes: ${error.message}`)
    const row = ss?.[0]
    if (!row) { out.push({ de: m.de, ignorado: 'sem sessão aberta' }); continue }
    if (m.fromMe) { if (m.texto) await registrarMsg(sb, row.id, 'out', m.texto, m.ts, m.id); out.push({ sessao: row.id, nossa: true }); continue }   // eco do nosso envio
    const nova = await registrarMsg(sb, row.id, 'in', m.texto || '[mídia]', m.ts, m.id, data)
    if (!nova) { out.push({ sessao: row.id, duplicada: true }); continue }
    await gravar(sb, row.id, { ultima_in_em: iso(m.ts), status: row.status === 'enviada' ? 'conversando' : row.status })
    out.push(await avancar(sb, cfg, { ...row, status: row.status === 'enviada' ? 'conversando' : row.status, ultima_in_em: iso(m.ts) }))
  }
  return { ok: true, itens: out }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405)
  const sb = admin()
  const url = new URL(req.url)
  const segredoPath = url.pathname.match(/\/s\/([^/]+)\/?$/)?.[1] ?? null
  const body = await req.json().catch(() => ({}))
  let cfg: Cfg
  try { cfg = await config(sb) } catch (e) { return json({ error: String((e as Error).message) }, 500) }
  try {
    if (segredoPath) {
      const { data } = await sb.from('integracao_config').select('value').eq('key', 'oculto_webhook_secret').maybeSingle()
      if (!data?.value || data.value !== segredoPath) return json({ error: 'segredo inválido' }, 401)
      if (body?.acao === 'varrer') {
        const { data: abertas, error } = await sb.from('oculto_sessoes').select('*').in('status', ['pendente', 'enviada', 'conversando', 'aguardando_followup']).order('criado_em').limit(30)
        if (error) throw new Error(error.message)
        const out: unknown[] = []
        for (const row of abertas ?? []) {
          try {
            if (row.status === 'pendente') { if (cfg.ativo && cfg.conectado && evo(cfg)) { await falar(sb, cfg, toSessao(row), row.persona ?? personaPara(row.nicho, row.empresa), [], true); out.push({ id: row.id, acao: 'abertura' }) } else out.push({ id: row.id, acao: 'pendente (sem número/ativo)' }); continue }
            out.push(await avancar(sb, cfg, row))
          } catch (e) { const msg = String((e as Error)?.message ?? e).slice(0, 300); await sb.from('oculto_sessoes').update({ erro: msg, atualizado_em: new Date().toISOString() }).eq('id', row.id); out.push({ id: row.id, erro: msg }) }
        }
        return json({ ok: true, processadas: out.length, resultados: out })
      }
      return json(await webhook(sb, cfg, body))   // Evolution: responde 200 sempre que autenticado
    }
    const membro = await autenticarMembro(req, sb)
    if (!membro) return json({ error: 'não autorizado' }, 401)
    const acao = String(body?.acao ?? '')
    if (acao === 'iniciar') {
      const { data: lead, error } = await sb.from('enriquecedor_leads').select('id, nome_fantasia, razao_social, segmento, phone_raw, google_business, cidade, uf').eq('id', body.lead_id).maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!lead) return json({ error: 'lead não existe' }, 404)
      const numero = numeroWa(String(body.numero ?? lead.phone_raw ?? lead.google_business?.phone ?? ''))
      if (!numero) return json({ error: 'lead sem telefone válido (informe numero)' }, 400)
      const { data: aberta } = await sb.from('oculto_sessoes').select('id').eq('numero_alvo', numero).in('status', ['pendente', 'enviada', 'conversando', 'aguardando_followup']).limit(1)
      if (aberta?.length) return json({ error: 'já existe sessão aberta para este número', sessao_id: aberta[0].id }, 409)
      const empresa = lead.nome_fantasia || lead.razao_social || 'empresa'
      const nicho = body.nicho ?? lead.segmento ?? null
      const persona = personaPara(nicho, empresa)
      const { data: nova, error: ei } = await sb.from('oculto_sessoes').insert({ lead_id: lead.id, empresa, nicho, numero_alvo: numero, persona, max_turnos: cfg.max_turnos, janela_followup_h: cfg.janela_followup_h, pedido_por: membro }).select('*').single()
      if (ei || !nova) return json({ error: ei?.message ?? 'não gravou' }, 500)
      if (cfg.ativo && cfg.conectado && evo(cfg)) {
        try { await falar(sb, cfg, toSessao(nova), persona, [], true) } catch (e) { await gravar(sb, nova.id, { status: 'erro', erro: String((e as Error).message).slice(0, 300) }); return json({ ok: false, sessao_id: nova.id, erro: String((e as Error).message) }, 502) }
        return json({ ok: true, sessao_id: nova.id, status: 'enviada' })
      }
      return json({ ok: true, sessao_id: nova.id, status: 'pendente', aviso: 'sem número conectado/ativo: a abertura sai quando o número estiver pronto' })
    }
    if (acao === 'cancelar') { await gravar(sb, String(body.sessao_id), { status: 'cancelada' }); return json({ ok: true }) }
    if (acao === 'instancia') {
      const wa = evo(cfg); if (!wa) return json({ error: 'Evolution não configurada (EVOLUTION_URL/EVOLUTION_APIKEY nos secrets da edge)' }, 503)
      const { data: sec } = await sb.from('integracao_config').select('value').eq('key', 'oculto_webhook_secret').maybeSingle()
      const webhookUrl = `${SUPABASE_URL}/functions/v1/cliente-oculto/s/${sec?.value ?? ''}`
      if (body.op === 'criar') return json(await wa.criarInstancia(webhookUrl))
      if (body.op === 'qr') return json(await wa.qr())
      const st = await wa.estado()
      if (st.ok) await sb.from('oculto_config').update({ conectado: st.estado === 'open', numero: st.numero ?? null, atualizado_em: new Date().toISOString() }).eq('id', 1)
      return json(st)
    }
    return json({ error: 'acao deve ser iniciar|cancelar|instancia' }, 400)
  } catch (e) {
    console.error('cliente-oculto', e)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
