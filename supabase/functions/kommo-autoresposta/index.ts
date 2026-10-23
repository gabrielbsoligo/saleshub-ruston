// kommo-autoresposta — TRIAGEM da 1ª resposta nos funis de disparo (Frente A, 23/10/2026).
//
// Problema: o gatilho "mensagem recebida → RESPONDEU" movia autoresposta (ausência, menu de
// bot, saudação padrão do WhatsApp Business) para RESPONDEU e a roleta distribuía. Decisão do
// Gabriel: autoresposta FICA NA MESMA ETAPA; só humano vai para RESPONDEU.
//
// Fluxo (Salesbot mínimo, configurado pela tela do Kommo):
//   gatilho "mensagem recebida" nas etapas de disparo →
//   passo 1: gravar campo "Triagem Resposta" = {{message_text}}  (o webhook do bot não manda o texto)
//   passo 2: webhook POST  <edge>/kommo-autoresposta?s=<segredo>  (payload padrão do Kommo: leads[...][id])
//
// Modelo: uma linha em autoresposta_triagem por MENSAGEM (identidade = id do evento
// incoming_chat_message mais recente do lead no Kommo, não o texto). Duas fases separadas:
//   DECISÃO  classificacao: autoresposta | humano | indeterminado  (regras puras em triagem.ts)
//   EFEITO   estado_efeito: pendente → em_andamento (claim com lease) → aplicado | observado |
//            superado | falhou (retomado pela varredura, até N tentativas)
// Antes de QUALQUER efeito: claim atômico (RPC autoresposta_claim) + releitura do lead no Kommo
// (funil ativo, mesma etapa de origem, etapa elegível) — pendência superada por humano/outro
// fluxo nunca move o lead. Leitura que falha (campo, eventos, padrões, config) NUNCA vira decisão:
// vira pendência (indeterminado/leitura) que a varredura retoma. Chamadas ao Kommo com timeout,
// retentativa/backoff em 429/5xx e ritmo (≤ ~5 req/s).
//   humano        → PATCH status_id = status_respondeu (modo aplicar)
//   autoresposta  → tag 'autoresposta' (mesclada às existentes) + nota; lead não se move
//   indeterminado → só espera (R2 nunca segura sozinha): 2ª mensagem → humano; após espera_s a
//                   varredura reavalia R3; sem R3 → humano.
// Segredo: header x-autoresposta-secret OU ?s= (o bot só consegue query string). Deploy com
// --no-verify-jwt (o bot e o cron não têm JWT do Supabase).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { casaPadrao, classificar, extrairLeadId, normalizar, palavras, podeAplicar, resolverIndeterminado, sha1, type Cfg, type Padrao } from './triagem.ts'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const SECRET = Deno.env.get('KOMMO_AUTORESPOSTA_SECRET') ?? ''
const CAMPO_TEXTO = Deno.env.get('KOMMO_AUTORESPOSTA_CAMPO') ?? 'Triagem Resposta'
const TAG_AUTO = 'autoresposta'
const LEASE_S = 90
const MAX_TENTATIVAS = 5
const LOTE_VARREDURA = 40
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
const sb = () => createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
type Db = ReturnType<typeof sb>

class LeituraFalhou extends Error { constructor(public etapa: string, msg: string) { super(`${etapa}: ${msg}`) } }
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Cliente Kommo com timeout, retentativa/backoff (429/5xx/rede) e ritmo. Falha definitiva lança LeituraFalhou.
function clienteKommo(token: string) {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  let ultimo = 0
  return async (m: string, p: string, body?: unknown, etapa = p) => {
    for (let t = 1; t <= 4; t++) {
      const espera = 200 - (Date.now() - ultimo)
      if (espera > 0) await dormir(espera)
      ultimo = Date.now()
      let r: Response
      try {
        r = await fetch(KOMMO_BASE + p, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
      } catch (e) { if (t === 4) throw new LeituraFalhou(etapa, `rede: ${(e as Error).message}`); await dormir(500 * 2 ** t); continue }
      if (r.status === 429 || r.status >= 500) { if (t === 4) throw new LeituraFalhou(etapa, `HTTP ${r.status}`); await dormir(500 * 2 ** t); continue }
      const texto = r.status === 204 ? '' : await r.text()
      let parsed: any = null
      try { parsed = texto ? JSON.parse(texto) : null } catch { parsed = null }
      return { ok: r.ok, status: r.status, body: parsed }
    }
    throw new LeituraFalhou(etapa, 'esgotou retentativas')
  }
}
type Kommo = ReturnType<typeof clienteKommo>

const must = <T,>(r: { data: T | null; error: { message: string } | null }, etapa: string): T => {
  if (r.error) throw new LeituraFalhou(etapa, r.error.message)
  return r.data as T
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const segredo = req.headers.get('x-autoresposta-secret') ?? url.searchParams.get('s') ?? url.searchParams.get('amp;s')
  if (!SECRET || segredo !== SECRET) return json({ error: 'segredo inválido' }, 401)
  const db = sb()
  const acao = url.searchParams.get('acao') ?? 'triar'
  try {
    const tok = await db.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
    if (tok.error || !tok.data?.value) return json({ error: 'Kommo sem access_token' }, 500)
    const kommo = clienteKommo(tok.data.value)
    const ctx: Ctx = {
      db, kommo,
      padroes: must(await db.from('autoresposta_padroes').select('id, padrao, descricao, tipo').eq('ativo', true).order('id'), 'padroes') as Padrao[],
      cfgs: must(await db.from('autoresposta_config').select('*'), 'config') as Cfg[],
    }

    if (acao === 'varrer') return json(await varrer(ctx))

    // ── chamada do Salesbot: identifica o lead e triagem da mensagem mais recente ─────────
    let payload: Record<string, unknown> = {}
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json')) payload = await req.json().catch(() => ({}))
    else { const txt = await req.text(); payload = Object.fromEntries(new URLSearchParams(txt)) }
    const leadId = extrairLeadId(payload, url.searchParams)
    if (!leadId) return json({ error: 'lead id ausente', recebido: Object.keys(payload).slice(0, 10) }, 400)
    return json(await triar(ctx, leadId, null))
  } catch (e) {
    if (e instanceof LeituraFalhou) return json({ error: 'leitura falhou', etapa: e.etapa, detalhe: e.message }, 503)
    return json({ error: (e as Error).message }, 500)
  }
})

type Ctx = { db: Db; kommo: Kommo; padroes: Padrao[]; cfgs: Cfg[] }
const cfgDe = (ctx: Ctx, pipeline: number) => ctx.cfgs.find((c) => Number(c.pipeline_id) === Number(pipeline))

// ──────────────────────────────────────────────────────────────────────────────────────────
// TRIAGEM de um lead: decide a mensagem mais recente (ou a linha pendente informada) e aplica.
// ──────────────────────────────────────────────────────────────────────────────────────────
async function triar(ctx: Ctx, leadId: number, linhaPendente: any | null) {
  const { db, kommo } = ctx
  const lead = await kommo('GET', `/api/v4/leads/${leadId}`, undefined, 'lead')
  if (lead.status === 404) return { skipped: true, motivo: 'lead não existe' }
  if (!lead.ok) throw new LeituraFalhou('lead', `HTTP ${lead.status}`)
  const pipeline = Number(lead.body.pipeline_id), statusAtual = Number(lead.body.status_id)
  const cfg = cfgDe(ctx, pipeline)
  if (!cfg) return { skipped: true, motivo: 'funil sem config', pipeline }
  if (!linhaPendente) {
    if (!cfg.ativo) return { skipped: true, motivo: 'funil com triagem desligada', pipeline }
    if (cfg.etapas_origem?.length && !cfg.etapas_origem.map(Number).includes(statusAtual)) return { skipped: true, motivo: 'etapa fora das elegíveis', status: statusAtual }
  }

  // eventos de chat do lead (14 dias): identidade da mensagem = evento incoming mais recente
  const agora = Math.floor(Date.now() / 1000)
  const de = agora - 14 * 86400
  const inR = await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=incoming_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, 'eventos_in')
  const outR = await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=outgoing_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, 'eventos_out')
  if (!inR.ok && inR.status !== 204) throw new LeituraFalhou('eventos_in', `HTTP ${inR.status}`)
  if (!outR.ok && outR.status !== 204) throw new LeituraFalhou('eventos_out', `HTTP ${outR.status}`)
  const ins = ((inR.body?._embedded?.events ?? []) as any[]).map((e) => ({ id: String(e.value_after?.[0]?.message?.id ?? e.id), ts: Number(e.created_at) })).sort((a, b) => a.ts - b.ts)
  const outs = ((outR.body?._embedded?.events ?? []) as any[]).map((e) => Number(e.created_at)).sort((a, b) => a - b)
  if (!ins.length) return { skipped: true, motivo: 'sem mensagem recebida nos eventos' }

  // a mensagem desta triagem: a pendente (varredura) ou a mais recente (webhook)
  const msg = linhaPendente ? ins.find((i) => i.id === linhaPendente.mensagem_id) ?? { id: linhaPendente.mensagem_id, ts: Math.floor(new Date(linhaPendente.recebido_em).getTime() / 1000) } : ins[ins.length - 1]
  const ultimoDisparo = [...outs].reverse().find((t) => t <= msg.ts) ?? null
  const intervaloS = ultimoDisparo ? msg.ts - ultimoDisparo : null
  const depois = ins.filter((i) => i.id !== msg.id && i.ts >= msg.ts).length // 2ª mensagem distinta, mesmo no mesmo segundo

  // texto: o campo que o passo 1 do bot gravou (último valor; se houver mensagem mais nova, ela é
  // que será triada na próxima chamada — a identidade é o evento, não o texto)
  let texto = String(linhaPendente?.texto ?? '').trim()
  if (!texto) {
    const campos = await kommo('GET', `/api/v4/leads/custom_fields?limit=250`, undefined, 'campos')
    if (!campos.ok) throw new LeituraFalhou('campos', `HTTP ${campos.status}`)
    const campo = (campos.body?._embedded?.custom_fields ?? []).find((f: any) => String(f.name).toLowerCase() === CAMPO_TEXTO.toLowerCase())
    if (!campo) throw new LeituraFalhou('campos', `campo "${CAMPO_TEXTO}" não existe no Kommo`)
    const cf = (lead.body.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === Number(campo.id))
    texto = String(cf?.values?.[0]?.value ?? '').trim()
  }

  // linha da mensagem (identidade = lead + id do evento). Conflito = já existe: relê.
  const base = {
    kommo_lead_id: leadId, mensagem_id: msg.id, pipeline_id: pipeline, status_id_origem: statusAtual,
    recebido_em: new Date(msg.ts * 1000).toISOString(), ultimo_disparo_em: ultimoDisparo ? new Date(ultimoDisparo * 1000).toISOString() : null,
    intervalo_s: intervaloS, modo: cfg.modo,
  }
  let linha: any = linhaPendente
  if (!linha) {
    const ins1 = await db.from('autoresposta_triagem').upsert({ ...base, classificacao: 'indeterminado', regras: ['nova'], estado_efeito: 'pendente' }, { onConflict: 'kommo_lead_id,mensagem_id', ignoreDuplicates: true }).select('*').maybeSingle()
    if (ins1.error) throw new LeituraFalhou('gravar', ins1.error.message)
    linha = ins1.data ?? must(await db.from('autoresposta_triagem').select('*').eq('kommo_lead_id', leadId).eq('mensagem_id', msg.id).single(), 'reler')
  }
  if (['aplicado', 'observado', 'superado'].includes(linha.estado_efeito)) return { ok: true, repetida: true, classificacao: linha.classificacao, estado: linha.estado_efeito }

  // texto vazio (mídia sem legenda ou campo ainda não gravado): fica pendente; a varredura
  // tenta reler até MAX_TENTATIVAS e só então trata como mídia (= humano).
  if (!texto) {
    const tent = Number(linha.tentativas ?? 0) + 1
    if (tent < MAX_TENTATIVAS) {
      must(await db.from('autoresposta_triagem').update({ tentativas: tent, regras: ['texto_vazio'], classificacao: 'indeterminado' }).eq('id', linha.id), 'gravar')
      return { ok: true, classificacao: 'indeterminado', motivo: 'texto vazio; aguardando releitura' }
    }
    texto = '[midia]'
  }

  // decisão
  const norm = normalizar(texto)
  const hash = await sha1(norm || `vazio:${leadId}`)
  const rep = must(await db.from('autoresposta_triagem').select('kommo_lead_id').eq('hash', hash).neq('kommo_lead_id', leadId).gte('recebido_em', new Date(Date.now() - 30 * 86400000).toISOString()), 'r3') as { kommo_lead_id: number }[]
  const outrosLeads = new Set(rep.map((r) => r.kommo_lead_id)).size
  const padrao = texto === '[midia]' ? ({ id: 0, padrao: '', tipo: 'humano' } as Padrao) : casaPadrao(texto, ctx.padroes)
  let cls = classificar({ texto, intervaloS, outrosLeadsMesmoTexto: outrosLeads, padrao, cfg, msgsRecebidasDepois: depois })
  // pendência que passou da espera: resolve (2ª msg → humano; R3 → autoresposta; senão humano)
  const passouEspera = Date.now() >= msg.ts * 1000 + cfg.espera_s * 1000
  if (cls.classificacao === 'indeterminado' && passouEspera) {
    const r = resolverIndeterminado(depois, outrosLeads, palavras(norm), cfg)
    cls = { classificacao: r.final, regras: [...cls.regras, r.motivo] }
  }
  must(await db.from('autoresposta_triagem').update({
    texto: texto.slice(0, 2000), texto_norm: norm.slice(0, 2000), hash, repeticoes: outrosLeads, padrao_id: padrao && padrao.id > 0 ? padrao.id : null,
    classificacao: cls.classificacao, regras: cls.regras, decidido_em: cls.classificacao === 'indeterminado' ? null : new Date().toISOString(),
    intervalo_s: intervaloS, ultimo_disparo_em: base.ultimo_disparo_em, modo: cfg.modo,
  }).eq('id', linha.id), 'gravar')
  if (padrao && padrao.id > 0) await db.rpc('autoresposta_padrao_acerto', { p_id: padrao.id })
  if (cls.classificacao === 'indeterminado') return { ok: true, classificacao: 'indeterminado', regras: cls.regras, aguardando_s: cfg.espera_s }

  // mensagens anteriores do mesmo lead ainda pendentes ficam superadas por esta decisão
  must(await db.from('autoresposta_triagem').update({ estado_efeito: 'superado', motivo_efeito: `superada pela mensagem ${msg.id}`, resolvido_em: new Date().toISOString() })
    .eq('kommo_lead_id', leadId).neq('id', linha.id).in('estado_efeito', ['pendente', 'falhou']).lt('recebido_em', base.recebido_em), 'superar')

  const efeito = await aplicar(ctx, cfg, { ...linha, ...base, texto }, cls.classificacao, cls.regras)
  return { ok: true, classificacao: cls.classificacao, regras: cls.regras, intervalo_s: intervaloS, outros_leads_mesmo_texto: outrosLeads, ...efeito }
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// EFEITO: claim atômico → releitura do lead → aplica (ou só observa) → estado final.
// ──────────────────────────────────────────────────────────────────────────────────────────
async function aplicar(ctx: Ctx, cfg: Cfg, linha: any, final: 'humano' | 'autoresposta', regras: string[]) {
  const { db, kommo } = ctx
  const claim = await db.rpc('autoresposta_claim', { p_id: linha.id, p_lease_s: LEASE_S })
  if (claim.error) throw new LeituraFalhou('claim', claim.error.message)
  if (!claim.data) return { estado: 'em_andamento', motivo: 'outro worker está aplicando' }
  const fim = async (estado: string, extra: Record<string, unknown> = {}) => {
    const up = await db.from('autoresposta_triagem').update({ estado_efeito: estado, lease_ate: null, resolvido_em: ['aplicado', 'observado', 'superado'].includes(estado) ? new Date().toISOString() : null, ...extra }).eq('id', linha.id)
    if (up.error) throw new LeituraFalhou('gravar_estado', up.error.message)
    return { estado, ...extra }
  }
  try {
    // revalida AGORA: funil ligado, lead no mesmo lugar, etapa elegível
    const cfgAgora = cfgDe(ctx, cfg.pipeline_id) ?? cfg
    const lead = await kommo('GET', `/api/v4/leads/${linha.kommo_lead_id}`, undefined, 'lead_revalidar')
    if (!lead.ok) throw new LeituraFalhou('lead_revalidar', `HTTP ${lead.status}`)
    const pode = podeAplicar(cfgAgora, lead.body, linha.status_id_origem)
    if (!pode.ok) return await fim('superado', { motivo_efeito: pode.motivo })
    if (cfgAgora.modo !== 'aplicar') return await fim('observado', { motivo_efeito: 'modo observar' })

    if (final === 'humano') {
      if (!cfgAgora.status_respondeu) return await fim('observado', { motivo_efeito: 'funil sem status_respondeu' })
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { status_id: cfgAgora.status_respondeu, pipeline_id: cfgAgora.pipeline_id }, 'patch_status')
      if (!r.ok) return await fim('falhou', { erro: `PATCH status → HTTP ${r.status}`, tentativas: Number(linha.tentativas ?? 0) + 1 })
      return await fim('aplicado', { movido: true, movido_para: cfgAgora.status_respondeu, erro: null })
    }
    // autoresposta: tag mesclada às existentes + nota; o lead não se move
    const tagsAtuais = ((lead.body?._embedded?.tags ?? []) as { id?: number; name?: string }[]).map((t) => (t.id ? { id: t.id } : { name: t.name }))
    const jaTem = ((lead.body?._embedded?.tags ?? []) as { name?: string }[]).some((t) => t.name === TAG_AUTO)
    if (!jaTem) {
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { _embedded: { tags: [...tagsAtuais, { name: TAG_AUTO }] } }, 'patch_tag')
      if (!r.ok) return await fim('falhou', { erro: `PATCH tag → HTTP ${r.status}`, tentativas: Number(linha.tentativas ?? 0) + 1 })
    }
    const nota = await kommo('POST', `/api/v4/leads/${linha.kommo_lead_id}/notes`, [{ note_type: 'common', params: { text: `Triagem automática: resposta classificada como AUTORESPOSTA (${regras.join(', ')}). Lead mantido na etapa.` } }], 'nota')
    if (!nota.ok) return await fim('falhou', { erro: `POST nota → HTTP ${nota.status}`, tentativas: Number(linha.tentativas ?? 0) + 1 })
    return await fim('aplicado', { movido: false, erro: null })
  } catch (e) {
    if (e instanceof LeituraFalhou) { await fim('falhou', { erro: e.message, tentativas: Number(linha.tentativas ?? 0) + 1 }); throw e }
    throw e
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// VARREDURA (cron): retoma indeterminados vencidos, texto vazio, efeitos pendentes/falhos e
// leases expirados. Só funis ATIVOS; os desligados têm as pendências marcadas como superadas.
// ──────────────────────────────────────────────────────────────────────────────────────────
async function varrer(ctx: Ctx) {
  const { db } = ctx
  const pend = must(await db.from('autoresposta_triagem').select('*')
    .or(`and(classificacao.eq.indeterminado,resolvido_em.is.null),estado_efeito.in.(pendente,falhou),and(estado_efeito.eq.em_andamento,lease_ate.lt.${new Date().toISOString()})`)
    .lt('tentativas', MAX_TENTATIVAS).order('recebido_em').limit(LOTE_VARREDURA), 'pendentes') as any[]
  const out: unknown[] = []
  for (const p of pend) {
    const cfg = cfgDe(ctx, p.pipeline_id)
    if (!cfg || !cfg.ativo) {
      await db.from('autoresposta_triagem').update({ estado_efeito: 'superado', motivo_efeito: 'funil desligado', resolvido_em: new Date().toISOString() }).eq('id', p.id)
      out.push({ id: p.id, lead: p.kommo_lead_id, resultado: 'superado (funil desligado)' }); continue
    }
    if (p.classificacao === 'indeterminado' && Date.now() < new Date(p.recebido_em).getTime() + cfg.espera_s * 1000 && !(p.regras ?? []).includes('texto_vazio')) continue
    try {
      const r = await triar(ctx, Number(p.kommo_lead_id), p)
      out.push({ id: p.id, lead: p.kommo_lead_id, ...r })
    } catch (e) {
      const tent = Number(p.tentativas ?? 0) + 1
      await db.from('autoresposta_triagem').update({ tentativas: tent, erro: (e as Error).message, lease_ate: null }).eq('id', p.id)
      out.push({ id: p.id, lead: p.kommo_lead_id, erro: (e as Error).message, tentativas: tent })
      if (e instanceof LeituraFalhou && /HTTP 429/.test(e.message)) break // conta sob limite: para o lote
    }
  }
  return { ok: true, processadas: out.length, resultados: out }
}
