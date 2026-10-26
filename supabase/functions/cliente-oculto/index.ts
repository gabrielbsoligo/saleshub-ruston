// cliente-oculto — Cliente oculto automatizado no Enriquecedor (Evolution API + Claude Haiku).
//
// Rotas (POST JSON; segredo no caminho /s/<segredo> para webhook/cron; Bearer de membro ativo para a tela):
//   /s/<segredo>  body = evento da Evolution (messages.upsert / connection.update)   ← webhook
//   /s/<segredo>  {acao:'varrer'}                                                   ← cron */10 (trabalhos DEVIDOS)
//   Bearer        {acao:'iniciar', lead_id, numero?, nicho?}   → cria sessão (pendente) e tenta a abertura
//   Bearer        {acao:'cancelar', sessao_id}                 → cancela (invalida qualquer envio em curso)
//   Bearer        {acao:'instancia', op:'criar'|'qr'|'estado'} → prepara o número (QR na tela)
// Concorrência e efeitos (ver migration_165): posse por sessão (oculto_claim/oculto_renovar) em TODO
// avanço; config (ativo && conectado) revalidada ANTES de cada envio, já com o texto do LLM na mão;
// intenção de envio persistida antes do POST (fase 'enviando' + envio_pendente); resultado aceito →
// oculto_envio_registrar (atômico, sob posse); falha definitiva → erro; incerto → fase 'envio_incerto'
// e reconciliação (findMessages / eco do webhook) antes de qualquer reenvio.
// Deploy: --no-verify-jwt.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { PADRAO, aceitarEvento, classificarEnvio, consolidar, decidir, metricas, numeroWa, personaPara, promptAbertura, promptAvaliacao, promptProximaFala, proximoAposFala, textoDoEvento, type Msg, type Sessao } from './conversa.ts'
import { anthropicHaiku, evolution, extrairJson, type Evolution, type Llm } from './adaptadores.ts'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const admin = () => createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
const LEASE_S = 180, ORCAMENTO_VARRER = 15, ABERTAS = ['pendente', 'enviada', 'conversando', 'aguardando_followup', 'avaliando']
const agoraS = () => Math.floor(Date.now() / 1000)
const iso = (s: number) => new Date(s * 1000).toISOString()
const seg = (t: string | null) => (t ? Math.floor(new Date(t).getTime() / 1000) : null)
class PossePerdida extends Error {}

type Cfg = { instancia: string; ativo: boolean; conectado: boolean; numero: string | null; max_turnos: number; janela_followup_h: number; modelo: string }
async function config(sb: any): Promise<Cfg> {
  const { data, error } = await sb.from('oculto_config').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`oculto_config: ${error.message}`)
  if (!data) throw new Error('oculto_config ausente (migration_165)')
  return data as Cfg
}
const podeEnviar = (cfg: Cfg) => cfg.ativo && cfg.conectado && !!Deno.env.get('EVOLUTION_URL') && !!Deno.env.get('EVOLUTION_APIKEY')
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
  return { id: r.id, empresa: r.empresa, nicho: r.nicho, numero_alvo: r.numero_alvo, status: r.status, fase: r.fase ?? 'ocioso', iniciada_em: seg(r.iniciada_em), ultima_in_em: seg(r.ultima_in_em), ultima_out_em: seg(r.ultima_out_em), turnos_persona: r.turnos_persona ?? 0, max_turnos: r.max_turnos ?? 4, janela_followup_h: r.janela_followup_h ?? 72 }
}
async function historico(sb: any, sessaoId: string): Promise<Msg[]> {
  const { data, error } = await sb.from('oculto_mensagens').select('direcao, texto, em').eq('sessao_id', sessaoId).order('em')
  if (error) throw new Error(`oculto_mensagens: ${error.message}`)
  return (data ?? []).map((m: any) => ({ direcao: m.direcao, texto: m.texto, ts: seg(m.em)! }))
}
/** escrita SOB POSSE: só grava se o token ainda é o dono; senão PossePerdida */
async function gravar(sb: any, id: string, token: string, patch: Record<string, unknown>) {
  const r = await sb.from('oculto_sessoes').update({ ...patch, atualizado_em: new Date().toISOString() }).eq('id', id).eq('claim_token', token).select('id')
  if (r.error) throw new Error(`oculto_sessoes: ${r.error.message}`)
  if (!r.data?.length) throw new PossePerdida('posse perdida (cancelada ou outro worker)')
}
async function renovar(sb: any, id: string, token: string) {
  const { data, error } = await sb.rpc('oculto_renovar', { p_id: id, p_token: token, p_lease_s: LEASE_S })
  if (error) throw new Error(`oculto_renovar: ${error.message}`)
  if (data !== true) throw new PossePerdida('posse perdida (cancelada ou outro worker)')
}

/** fala da persona sob posse: LLM → revalida config e posse → intenção persistida → POST → registro atômico / erro / incerto */
async function falar(sb: any, cfg0: Cfg, s: Sessao, token: string, rev: number, persona: any, hist: Msg[], abertura: boolean) {
  const modelo = llm(cfg0)
  if (!modelo) throw new Error('ANTHROPIC_API_KEY ausente')
  const texto = (await modelo(abertura ? promptAbertura(persona, s.empresa) : promptProximaFala(persona, s.empresa, hist), 300)).replace(/^["“]|["”]$/g, '').trim()
  if (!texto) throw new Error('modelo devolveu texto vazio')
  // revalidação ANTES do efeito: posse ainda nossa (não cancelada) e config ainda permite enviar
  await renovar(sb, s.id, token)
  const cfg = await config(sb)
  const wa = evo(cfg)
  if (!podeEnviar(cfg) || !wa) { await gravar(sb, s.id, token, { proximo_em: iso(agoraS() + 600) }); return { adiado: 'envios desligados/número desconectado' } }
  // intenção persistida ANTES do POST — com as saídas JÁ conhecidas (wa_id) para a reconciliação não confundir
  const { data: antes, error: ea } = await sb.from('oculto_mensagens').select('wa_id').eq('sessao_id', s.id).eq('direcao', 'out')
  if (ea) throw new Error(`oculto_mensagens: ${ea.message}`)
  await gravar(sb, s.id, token, { fase: 'enviando', envio_pendente: { texto, abertura, iniciado_em: new Date().toISOString(), conhecidas: (antes ?? []).map((m: any) => m.wa_id).filter(Boolean) } })
  const env = await wa.enviarTexto(s.numero_alvo, texto)
  const cls = classificarEnvio(env)
  const ts = agoraS()
  if (cls === 'ok') {
    const status = abertura ? 'enviada' : 'conversando'
    const { data: ok, error } = await sb.rpc('oculto_envio_registrar', { p_id: s.id, p_token: token, p_texto: texto, p_wa_id: env.id ?? `out-${ts}`, p_em: iso(ts), p_abertura: abertura, p_proximo_em: iso(proximoAposFala(status, ts)), p_entrada_rev: rev })
    if (error) throw new Error(`oculto_envio_registrar: ${error.message}`)   // enviado mas não gravado: fase segue 'enviando' → reconciliação encontra pelo eco/findMessages
    if (ok !== true) throw new PossePerdida('posse perdida ao registrar envio')
    return { enviado: true, status }
  }
  if (cls === 'definitivo') { await gravar(sb, s.id, token, { status: 'erro', fase: 'ocioso', envio_pendente: null, erro: `envio recusado HTTP ${env.status}: ${env.nota ?? ''}`.slice(0, 300) }); return { erro: 'definitivo' } }
  // incerto: pode ter saído. NÃO reenvia; a varredura reconcilia.
  await gravar(sb, s.id, token, { fase: 'envio_incerto', erro: `envio incerto: ${env.nota ?? `HTTP ${env.status}`}`.slice(0, 300), proximo_em: iso(ts + 300) })
  return { incerto: true }
}

/** reconcilia envio incerto/enviando interrompido: procura o texto entre as mensagens recentes (fromMe) do número */
async function reconciliar(sb: any, cfg: Cfg, row: any, token: string, rev: number) {
  const pend = row.envio_pendente ?? {}
  const texto = String(pend.texto ?? ''), abertura = !!pend.abertura
  const ini = pend.iniciado_em ? Math.floor(new Date(pend.iniciado_em).getTime() / 1000) : agoraS()
  const conhecidas = new Set<string>(Array.isArray(pend.conhecidas) ? pend.conhecidas.map(String) : [])
  const wa = evo(cfg)
  if (!wa || !texto) { await gravar(sb, row.id, token, { status: 'erro', fase: 'ocioso', envio_pendente: null, erro: 'envio incerto sem como reconciliar' }); return { id: row.id, erro: 'sem reconciliação' } }
  // candidato = saída NOVA (wa_id não conhecido antes da intenção), com o mesmo texto, NÃO anterior à intenção
  // (tolerância de 5 s de relógio) — um "Obrigado" enviado antes nunca confirma esta tentativa
  const { data: ecos, error: ee } = await sb.from('oculto_mensagens').select('wa_id, em').eq('sessao_id', row.id).eq('direcao', 'out').eq('texto', texto).gte('em', iso(ini - 5)).order('em')
  if (ee) throw new Error(`oculto_mensagens: ${ee.message}`)
  // evidências unidas por wa_id (eco local ∪ provedor); a ambiguidade, uma vez comprovada, não se desfaz
  const evid = new Map<string, number>()
  for (const m of ecos ?? []) if (m.wa_id && !conhecidas.has(String(m.wa_id))) evid.set(String(m.wa_id), seg(m.em)!)
  const ambiguo = async (nota: string) => { await gravar(sb, row.id, token, { status: 'erro', fase: 'ocioso', envio_pendente: null, erro: `envio incerto: ${nota} — não reenviado` }); return { id: row.id, erro: 'ambíguo' } }
  if (evid.size > 1) return await ambiguo('mais de uma saída nova igual no histórico')
  if (evid.size === 0) {
    const r = await wa.buscarMensagens(row.numero_alvo, 30)
    if (!r.ok) {
      if (agoraS() - ini < 1800) { await gravar(sb, row.id, token, { proximo_em: iso(agoraS() + 300) }); return { id: row.id, adiado: 'provedor indisponível para reconciliar' } }
    } else {
      for (const x of r.mensagens) if (x.fromMe && x.texto === texto && x.id && !conhecidas.has(String(x.id)) && x.ts >= ini - 5) evid.set(String(x.id), x.ts || ini)
      if (evid.size > 1) return await ambiguo('mais de uma saída igual no provedor')
    }
  }
  let achou: { id: string; ts: number } | null = null
  if (evid.size === 1) { const [id, ts] = [...evid.entries()][0]; achou = { id, ts } }
  if (achou) {
    const status = abertura ? 'enviada' : 'conversando'
    const { data: ok, error } = await sb.rpc('oculto_envio_registrar', { p_id: row.id, p_token: token, p_texto: texto, p_wa_id: achou.id, p_em: iso(achou.ts), p_abertura: abertura, p_proximo_em: iso(proximoAposFala(status, achou.ts)), p_entrada_rev: rev })
    if (error) throw new Error(`oculto_envio_registrar: ${error.message}`)
    if (ok !== true) throw new PossePerdida('posse perdida ao reconciliar')
    return { id: row.id, reconciliado: 'enviado' }
  }
  // não encontrado: NÃO reenvia automaticamente (risco de duplicar); encerra com erro visível para o operador
  await gravar(sb, row.id, token, { status: 'erro', fase: 'ocioso', envio_pendente: null, erro: 'envio incerto não confirmado pelo provedor — não reenviado (cancele e inicie de novo se quiser)' })
  return { id: row.id, erro: 'incerto não confirmado' }
}

/** encerra: métricas + avaliação do LLM (se houve conversa) + notas; avaliação indisponível = 'avaliando' (retoma), nunca zero */
async function avaliar(sb: any, cfg: Cfg, row: any, token: string, hist: Msg[], motivo: string) {
  const s = toSessao(row)
  const m = metricas(hist, agoraS(), s.janela_followup_h)
  let ia: any = null, parecer: string | null = null
  if (!m.respondeu) {
    parecer = `A empresa não respondeu em ${s.janela_followup_h} h (${motivo}).`
  } else {
    const modelo = llm(cfg)
    if (modelo) { try { ia = extrairJson(await modelo(promptAvaliacao(s.empresa, hist, m), 700)); parecer = ia?.parecer ?? null } catch { ia = null } }
  }
  const notas = consolidar(m, ia)
  const tent = Number(row.tentativas_avaliacao ?? 0) + 1
  if (notas.incompleta && tent < PADRAO.max_tentativas_avaliacao) {
    await gravar(sb, s.id, token, { status: 'avaliando', metricas: m, notas, tentativas_avaliacao: tent, proximo_em: iso(agoraS() + 1800), erro: 'avaliação IA indisponível — nova tentativa em 30 min' })
    return { id: s.id, avaliando: true, tentativa: tent }
  }
  await gravar(sb, s.id, token, { status: 'concluida', metricas: m, notas, parecer: parecer ?? (notas.incompleta ? 'Avaliação IA indisponível após 3 tentativas: critérios de qualificação/proposta/tom ficaram sem nota (medidos: tempo de resposta e follow-up).' : null), avaliacao_ia: ia, tentativas_avaliacao: tent, erro: null, concluida_em: new Date().toISOString(), claim_token: null, lease_ate: null })
  return { id: s.id, concluida: true, incompleta: notas.incompleta, final: notas.final }
}

/** avança UMA sessão sob posse (claim → ação → libera) */
async function avancar(sb: any, cfg: Cfg, row: any) {
  const { data: token, error } = await sb.rpc('oculto_claim', { p_id: row.id, p_lease_s: LEASE_S })
  if (error) throw new Error(`oculto_claim: ${error.message}`)
  if (!token) return { id: row.id, pulado: 'sem posse' }
  let rev: number | null = null
  try {
    const { data: atual, error: e2 } = await sb.from('oculto_sessoes').select('*').eq('id', row.id).maybeSingle()   // relê sob posse
    if (e2 || !atual) throw new Error(`oculto_sessoes: ${e2?.message ?? 'sumiu'}`)
    rev = Number(atual.entrada_rev ?? 0)   // watermark de entrada no snapshot: registrar/liberar comparam com ela
    if (atual.fase === 'enviando' || atual.fase === 'envio_incerto') return await reconciliar(sb, cfg, atual, token, rev)
    const s = toSessao(atual); const hist = await historico(sb, s.id)
    const d = decidir(s, hist, agoraS())
    const persona = atual.persona && Object.keys(atual.persona).length ? atual.persona : personaPara(s.nicho, s.empresa)
    if (d.acao === 'abrir') { if (!podeEnviar(cfg)) { await gravar(sb, s.id, token, { proximo_em: iso(agoraS() + 1800) }); return { id: s.id, pendente: 'sem número/ativo' } } return { id: s.id, ...(await falar(sb, cfg, s, token, rev, persona, [], true)) } }
    if (d.acao === 'responder') return { id: s.id, ...(await falar(sb, cfg, s, token, rev, persona, hist, false)) }
    if (d.acao === 'aguardar_followup') { await gravar(sb, s.id, token, { status: 'aguardando_followup', proximo_em: iso(d.proximo_em) }); return { id: s.id, acao: 'aguardando_followup' } }
    if (d.acao === 'avaliar') return await avaliar(sb, cfg, atual, token, hist, d.motivo)
    await gravar(sb, s.id, token, { proximo_em: d.proximo_em != null ? iso(d.proximo_em) : iso(agoraS() + 3600) })
    return { id: s.id, acao: 'esperar' }
  } catch (e) {
    if (e instanceof PossePerdida) return { id: row.id, pulado: e.message }
    const msg = String((e as Error)?.message ?? e).slice(0, 300)
    await sb.from('oculto_sessoes').update({ erro: msg, proximo_em: iso(agoraS() + 600), atualizado_em: new Date().toISOString() }).eq('id', row.id).eq('claim_token', token)
    return { id: row.id, erro: msg }
  } finally {
    // libera a posse; se a empresa escreveu durante o avanço (watermark mudou), o próximo instante vira AGORA
    const { error: el } = await sb.rpc('oculto_liberar', { p_id: row.id, p_token: token, p_entrada_rev: rev })
    if (el) console.error('cliente-oculto liberar', el.message)
  }
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
    const ac = aceitarEvento(m)   // identidade estável E instante real; senão quarentena (vale para entrada e eco)
    if (!ac.ok) { console.warn('cliente-oculto:', ac.motivo, String(m.de)); out.push({ de: m.de, ignorado: ac.motivo }); continue }
    const { waId, ts } = ac
    const { data: ss, error } = await sb.from('oculto_sessoes').select('*').eq('numero_alvo', m.de).in('status', ABERTAS).order('criado_em', { ascending: false }).limit(1)
    if (error) throw new Error(`oculto_sessoes: ${error.message}`)
    const row = ss?.[0]
    if (!row) { out.push({ de: m.de, ignorado: 'sem sessão aberta' }); continue }
    if (m.fromMe) {   // eco do nosso envio: registra (dedupe por wa_id) — serve de reconciliação; só com id real
      if (m.texto && m.id) { const r = await sb.from('oculto_mensagens').upsert({ sessao_id: row.id, direcao: 'out', texto: m.texto, em: iso(ts), wa_id: waId, bruto: null }, { onConflict: 'sessao_id,wa_id', ignoreDuplicates: true }); if (r.error) throw new Error(`oculto_mensagens: ${r.error.message}`) }
      out.push({ sessao: row.id, nossa: true }); continue
    }
    // entrada em UMA transação idempotente: mensagem + watermark + agendamento (cobre 'pendente' durante a abertura)
    const { data: ent, error: een } = await sb.rpc('oculto_entrada', { p_id: row.id, p_wa_id: waId, p_texto: m.texto || '[mídia]', p_em: iso(ts), p_bruto: data })
    if (een) throw new Error(`oculto_entrada: ${een.message}`)
    const e0 = Array.isArray(ent) ? ent[0] : ent
    if (!e0 || typeof e0.nova !== 'boolean') throw new Error('oculto_entrada: resultado inesperado')
    if (!e0.nova) { out.push({ sessao: row.id, duplicada: true }); continue }
    out.push(await avancar(sb, cfg, row))   // se a posse estiver ocupada, quem a tem verá a watermark mudar e reagenda para agora
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
        // só trabalhos DEVIDOS, mais antigos primeiro, com orçamento — sessões que só esperam não entram
        const { data: devidas, error } = await sb.from('oculto_sessoes').select('*').in('status', ABERTAS).lte('proximo_em', new Date().toISOString()).order('proximo_em').limit(ORCAMENTO_VARRER)
        if (error) throw new Error(error.message)
        const out: unknown[] = []
        for (const row of devidas ?? []) out.push(await avancar(sb, cfg, row))
        return json({ ok: true, processadas: out.length, resultados: out })
      }
      return json(await webhook(sb, cfg, body))
    }
    const membro = await autenticarMembro(req, sb)
    if (!membro) return json({ error: 'não autorizado' }, 401)
    const acao = String(body?.acao ?? '')
    if (acao === 'iniciar') {
      const { data: lead, error } = await sb.from('enriquecedor_leads').select('id, nome_fantasia, razao_social, segmento, phone_raw, google_business').eq('id', body.lead_id).maybeSingle()
      if (error) return json({ error: error.message }, 500)
      if (!lead) return json({ error: 'lead não existe' }, 404)
      const numero = numeroWa(String(body.numero ?? lead.phone_raw ?? lead.google_business?.phone ?? ''))
      if (!numero) return json({ error: 'lead sem telefone válido (informe numero)' }, 400)
      const empresa = lead.nome_fantasia || lead.razao_social || 'empresa'
      const nicho = body.nicho ?? lead.segmento ?? null
      const persona = personaPara(nicho, empresa)
      const { data: nova, error: ei } = await sb.from('oculto_sessoes').insert({ lead_id: lead.id, empresa, nicho, numero_alvo: numero, persona, max_turnos: cfg.max_turnos, janela_followup_h: cfg.janela_followup_h, pedido_por: membro }).select('*').single()
      if (ei) { if (String(ei.code) === '23505') return json({ error: 'já existe sessão aberta para este número' }, 409); return json({ error: ei.message }, 500) }
      if (!nova) return json({ error: 'não gravou' }, 500)
      const r = podeEnviar(cfg) ? await avancar(sb, cfg, nova) : { pendente: 'sem número/ativo' }
      return json({ ok: true, sessao_id: nova.id, status: (r as any).enviado ? 'enviada' : (r as any).erro ? 'erro' : 'pendente', detalhe: r, aviso: podeEnviar(cfg) ? undefined : 'sem número conectado/ativo: a abertura sai quando o número estiver pronto' })
    }
    if (acao === 'cancelar') {
      // cancelar invalida a posse (token limpo + status fora de ABERTAS): qualquer envio em curso falha na revalidação
      const r = await sb.from('oculto_sessoes').update({ status: 'cancelada', claim_token: null, lease_ate: null, fase: 'ocioso', envio_pendente: null, atualizado_em: new Date().toISOString() }).eq('id', String(body.sessao_id)).in('status', ABERTAS).select('id')
      if (r.error) return json({ error: r.error.message }, 500)
      return json({ ok: true, cancelada: (r.data?.length ?? 0) > 0 })
    }
    if (acao === 'instancia') {
      const wa = evo(cfg); if (!wa) return json({ error: 'Evolution não configurada (EVOLUTION_URL/EVOLUTION_APIKEY nos secrets da edge)' }, 503)
      const { data: sec } = await sb.from('integracao_config').select('value').eq('key', 'oculto_webhook_secret').maybeSingle()
      const webhookUrl = `${SUPABASE_URL}/functions/v1/cliente-oculto/s/${sec?.value ?? ''}`
      if (body.op === 'criar') return json(await wa.criarInstancia(webhookUrl))
      if (body.op === 'qr') return json(await wa.qr())
      const st = await wa.estado()
      if (st.ok) await sb.from('oculto_config').update({ conectado: st.estado === 'open', numero: st.numero ? numeroWa(st.numero) : null, atualizado_em: new Date().toISOString() }).eq('id', 1)
      return json(st)
    }
    return json({ error: 'acao deve ser iniciar|cancelar|instancia' }, 400)
  } catch (e) {
    console.error('cliente-oculto', e)
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
