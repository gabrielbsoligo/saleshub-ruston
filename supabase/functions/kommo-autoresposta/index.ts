// kommo-autoresposta — TRIAGEM da 1ª resposta nos funis de disparo (Frente A, 23/10/2026).
//
// Problema: o gatilho "mensagem recebida → RESPONDEU" movia autoresposta (ausência, menu de
// bot, "mensagem automática") para RESPONDEU e a roleta distribuía. Decisão do Gabriel:
// autoresposta FICA NA MESMA ETAPA; só humano vai para RESPONDEU.
//
// Fluxo (Salesbot mínimo, configurado pela tela do Kommo):
//   gatilho "mensagem recebida" nas etapas de disparo →
//   passo 1: gravar campo "Triagem Resposta" = {{message_text}}  (o webhook do bot não manda o texto)
//   passo 2: webhook POST  <edge>/kommo-autoresposta?s=<segredo>  (payload padrão do Kommo traz leads[...][id])
// Aqui: lê o texto do campo, calcula o intervalo desde o último disparo (eventos do Kommo),
// aplica R1 (padrões de texto, tabela kommo.autoresposta_padroes) / R2 (rápida e única) /
// R3 (mesmo texto já veio de ≥N leads), grava em kommo.respostas_triagem e:
//   humano        → PATCH lead.status_id = status RESPONDEU do funil (kommo.autoresposta_config)
//   autoresposta  → só tag "autoresposta" + nota; lead não se move
//   indeterminado (R2: rápida e, até agora, única, sem R1/R3) → só ESPERA: a 2ª chamada (o bot
//                  roda de novo a cada mensagem) resolve como humano; passado `espera_s`, a
//                  varredura (?acao=varrer, cron) reavalia R3 e, sem R3, resolve como HUMANO
//                  (na amostra, 17 de 74 respostas ≤60s e únicas eram humanas — R2 nunca segura sozinha).
// Áudio e cartão de contato (padrões tipo 'humano') são humano sempre.
// Idempotente por (lead, hash do texto, minuto). Nunca derruba: erro vira linha com `erro`.
// Segredo: header x-autoresposta-secret OU ?s= (o bot só consegue query string).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { casaPadrao, classificar, normalizar, resolverIndeterminado, sha1, type Cfg, type Padrao } from './triagem.ts'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const SECRET = Deno.env.get('KOMMO_AUTORESPOSTA_SECRET') ?? ''
const CAMPO_TEXTO = Deno.env.get('KOMMO_AUTORESPOSTA_CAMPO') ?? 'Triagem Resposta'
const TAG_AUTO = 'autoresposta'
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

const sb = () => createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const segredo = req.headers.get('x-autoresposta-secret') ?? url.searchParams.get('s') ?? url.searchParams.get('amp;s')
  if (!SECRET || segredo !== SECRET) return json({ error: 'segredo inválido' }, 401)
  const db = sb()
  const acao = url.searchParams.get('acao') ?? 'triar'
  try {
    const { data: tokRow } = await db.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
    const token = tokRow?.value
    if (!token) return json({ error: 'Kommo sem access_token' }, 500)
    const KH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const kommo = async (m: string, p: string, body?: unknown) => {
      const r = await fetch(KOMMO_BASE + p, { method: m, headers: KH, body: body === undefined ? undefined : JSON.stringify(body) })
      return { ok: r.ok, status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }
    }
    const { data: padroes } = await db.from('autoresposta_padroes').select('id, padrao, descricao, tipo').eq('ativo', true).order('id')
    const { data: cfgs } = await db.from('autoresposta_config').select('*')
    const cfgDe = (pipeline: number) => (cfgs ?? []).find((c: Cfg) => Number(c.pipeline_id) === Number(pipeline)) as Cfg | undefined

    // ── varredura: resolve "indeterminado" que passou da espera sem 2ª mensagem ─────────
    if (acao === 'varrer') {
      const { data: pend } = await db.from('autoresposta_triagem').select('*').eq('classificacao', 'indeterminado').is('resolvido_em', null).limit(200)
      const out: unknown[] = []
      for (const p of pend ?? []) {
        const cfg = cfgDe(p.pipeline_id); if (!cfg) continue
        const limite = new Date(new Date(p.recebido_em).getTime() + cfg.espera_s * 1000)
        if (new Date() < limite) continue
        // 2ª mensagem depois? (eventos do Kommo) → humano. Senão reavalia R3 (o mesmo texto pode
        // ter chegado de outros leads enquanto esperava); sem R3 → HUMANO (R2 nunca segura sozinha).
        const ev = await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${p.kommo_lead_id}&filter[type]=incoming_chat_message&filter[created_at][from]=${Math.floor(new Date(p.recebido_em).getTime() / 1000) + 30}&limit=5`)
        const n = ev.body?._embedded?.events?.length ?? 0
        const { count: rep3 } = await db.from('autoresposta_triagem').select('id', { count: 'exact', head: true }).eq('hash', p.hash).neq('kommo_lead_id', p.kommo_lead_id).gte('recebido_em', new Date(Date.now() - 30 * 86400000).toISOString())
        const { final, motivo } = resolverIndeterminado(n, rep3 ?? 0, cfg.repeticao_min)
        const res = await aplicar(db, kommo, cfg, p, final, [...(p.regras ?? []), motivo])
        out.push({ lead: p.kommo_lead_id, final, ...res })
      }
      return json({ ok: true, resolvidas: out })
    }

    // ── triagem de uma mensagem (chamada pelo Salesbot) ──────────────────────────────
    let payload: Record<string, unknown> = {}
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json')) payload = await req.json().catch(() => ({}))
    else { const txt = await req.text(); payload = Object.fromEntries(new URLSearchParams(txt)) }
    const leadId = Number(url.searchParams.get('lead_id') ?? payload.lead_id ?? payload['leads[add][0][id]'] ?? payload['leads[status][0][id]'] ?? payload['leads[update][0][id]'] ?? (payload as any)?.leads?.add?.[0]?.id ?? (payload as any)?.leads?.status?.[0]?.id ?? 0)
    if (!leadId) return json({ error: 'lead id ausente', recebido: Object.keys(payload).slice(0, 10) }, 400)

    const lead = await kommo('GET', `/api/v4/leads/${leadId}`)
    if (!lead.ok) return json({ error: 'lead não encontrado', status: lead.status }, 404)
    const pipeline = Number(lead.body.pipeline_id), statusAtual = Number(lead.body.status_id)
    const cfg = cfgDe(pipeline)
    if (!cfg || !cfg.ativo) return json({ skipped: true, motivo: 'funil sem triagem ativa', pipeline })

    // texto: query/body (se o bot mandar) ou o campo "Triagem Resposta" que o passo 1 gravou
    let texto = String(url.searchParams.get('t') ?? payload.texto ?? payload.message_text ?? '').trim()
    if (!texto) {
      const campos = await kommo('GET', `/api/v4/leads/custom_fields?limit=250`)
      const campo = (campos.body?._embedded?.custom_fields ?? []).find((f: any) => String(f.name).toLowerCase() === CAMPO_TEXTO.toLowerCase())
      const cf = (lead.body.custom_fields_values ?? []).find((f: any) => campo && Number(f.field_id) === Number(campo.id))
      texto = String(cf?.values?.[0]?.value ?? '').trim()
    }
    const agora = Math.floor(Date.now() / 1000)
    // último disparo (outgoing) e mensagens recebidas depois da 1ª (eventos)
    const evs = await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=outgoing_chat_message&filter[created_at][from]=${agora - 14 * 86400}&limit=50`)
    const outs = (evs.body?._embedded?.events ?? []).map((e: any) => Number(e.created_at)).sort((a: number, b: number) => b - a)
    const ultimoDisparo = outs[0] ?? null
    const ins = await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=incoming_chat_message&filter[created_at][from]=${(ultimoDisparo ?? agora - 86400)}&limit=20`)
    const recebidas = (ins.body?._embedded?.events ?? []).map((e: any) => Number(e.created_at)).sort((a: number, b: number) => a - b)
    const primeira = recebidas[0] ?? agora
    const intervaloS = ultimoDisparo ? primeira - ultimoDisparo : null
    const depois = recebidas.filter((t: number) => t > primeira + 30).length

    const norm = normalizar(texto)
    const hash = await sha1(norm || `vazio:${leadId}`)
    // R3: quantos OUTROS leads já mandaram este mesmo texto (30 dias)
    const { count: rep } = await db.from('autoresposta_triagem').select('id', { count: 'exact', head: true }).eq('hash', hash).neq('kommo_lead_id', leadId).gte('recebido_em', new Date(Date.now() - 30 * 86400000).toISOString())
    const padrao = casaPadrao(texto, (padroes ?? []) as Padrao[])
    const cls = classificar({ intervaloS, repeticoes: rep ?? 0, padrao, cfg, msgsRecebidasDepois: depois })

    // idempotência: mesma mensagem (lead+hash) já triada → só reavalia se estava indeterminada
    const { data: existente } = await db.from('autoresposta_triagem').select('*').eq('kommo_lead_id', leadId).eq('hash', hash).order('created_at', { ascending: false }).limit(1).maybeSingle()
    let linha = existente
    if (!linha) {
      const { data: ins2, error } = await db.from('autoresposta_triagem').insert({
        kommo_lead_id: leadId, pipeline_id: pipeline, status_id_origem: statusAtual, texto: texto.slice(0, 2000), texto_norm: norm.slice(0, 2000), hash,
        recebido_em: new Date(primeira * 1000).toISOString(), ultimo_disparo_em: ultimoDisparo ? new Date(ultimoDisparo * 1000).toISOString() : null,
        intervalo_s: intervaloS, repeticoes: rep ?? 0, padrao_id: padrao?.id ?? null, classificacao: cls.classificacao, regras: cls.regras, modo: cfg.modo,
      }).select('*').single()
      if (error) throw error
      linha = ins2
    } else if (linha.classificacao !== 'indeterminado') {
      return json({ ok: true, repetida: true, classificacao: linha.classificacao })
    }
    // 2ª mensagem do mesmo lead resolve o indeterminado anterior como humano
    let classificacao = cls.classificacao
    if (depois > 0 && classificacao !== 'autoresposta') {
      await db.from('autoresposta_triagem').update({ classificacao: 'humano', regras: [...(linha.regras ?? []), '2a_msg'] }).eq('id', linha.id)
      linha = { ...linha, classificacao: 'humano' }
      classificacao = 'humano'
    }
    if (padrao) await db.rpc('autoresposta_padrao_acerto', { p_id: padrao.id }).then(() => {}, () => {})
    if (classificacao === 'indeterminado') return json({ ok: true, classificacao, regras: cls.regras, aguardando_s: cfg.espera_s })
    const res = await aplicar(db, kommo, cfg, linha, classificacao, cls.regras)
    return json({ ok: true, classificacao, regras: cls.regras, intervalo_s: intervaloS, repeticoes: rep ?? 0, ...res })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})

// Aplica a decisão no Kommo (ou só registra, em modo 'observar') e marca a linha como resolvida.
async function aplicar(db: ReturnType<typeof sb>, kommo: (m: string, p: string, b?: unknown) => Promise<any>, cfg: Cfg, linha: any, final: 'humano' | 'autoresposta', regras: string[]) {
  let movido = false, erro: string | null = null
  if (cfg.modo === 'aplicar') {
    if (final === 'humano' && cfg.status_respondeu) {
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { status_id: cfg.status_respondeu, pipeline_id: cfg.pipeline_id })
      movido = r.ok; if (!r.ok) erro = `PATCH status → HTTP ${r.status}`
    } else if (final === 'autoresposta') {
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { _embedded: { tags: [{ name: TAG_AUTO }] } })
      if (!r.ok) erro = `PATCH tag → HTTP ${r.status}`
      await kommo('POST', `/api/v4/leads/${linha.kommo_lead_id}/notes`, [{ note_type: 'common', params: { text: `Triagem automática: resposta classificada como AUTORESPOSTA (${regras.join(', ')}). Lead mantido na etapa.` } }])
    }
  }
  await db.from('autoresposta_triagem').update({ classificacao: final, regras, movido, movido_para: movido ? cfg.status_respondeu : null, erro, resolvido_em: new Date().toISOString() }).eq('id', linha.id)
  return { movido, erro, modo: cfg.modo }
}
