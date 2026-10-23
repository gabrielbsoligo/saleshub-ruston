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
// Este arquivo é só o WIRING: HTTP + segredo, repositório Supabase (service_role) e cliente Kommo
// (timeout, Retry-After, backoff, ritmo COMPARTILHADO por conta via RPC autoresposta_reservar).
// A lógica vive em motor.ts (testada com fakes) e triagem.ts (regras puras).
// Segredo: header x-autoresposta-secret OU ?s= (o bot só consegue query string). Deploy com
// --no-verify-jwt (o bot e o cron não têm JWT do Supabase).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { extrairLeadId, type Cfg, type Padrao } from './triagem.ts'
import { LeituraFalhou, Throttled, receberWebhook, varrer, type Deps, type KommoFn, type Linha, type Repo, type Trabalho } from './motor.ts'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const SECRET = Deno.env.get('KOMMO_AUTORESPOSTA_SECRET') ?? ''
const CAMPO_TEXTO = Deno.env.get('KOMMO_AUTORESPOSTA_CAMPO') ?? 'Triagem Resposta'
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
const sb = () => createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
type Db = ReturnType<typeof sb>
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))
const must = <T,>(r: { data: T | null; error: { message: string } | null }, etapa: string): T => { if (r.error) throw new LeituraFalhou(etapa, r.error.message); return r.data as T }

// ── cliente Kommo: ritmo por CONTA (RPC reserva um slot de 200 ms compartilhado entre webhooks e
//    cron), timeout 15 s, Retry-After respeitado, backoff em 429/5xx/rede; POST só retenta se pedido.
function clienteKommo(db: Db, token: string): KommoFn {
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return async (m, p, body, opts = {}) => {
    const etapa = opts.etapa ?? p
    const maxTent = 1 + (opts.retries ?? (m === 'GET' ? 3 : 1))
    for (let t = 1; t <= maxTent; t++) {
      const slot = await db.rpc('autoresposta_reservar', { p_ms: 200 })
      if (!slot.error && Number(slot.data) > 0) await dormir(Math.min(Number(slot.data), 5000))
      let r: Response
      try {
        r = await fetch(KOMMO_BASE + p, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
      } catch (e) {
        if (m !== 'GET' && !(opts.retries && opts.retries > 0)) return { ok: false, status: 0, body: { erro: `rede: ${(e as Error).message}` } } // POST/PATCH ambíguo: quem chamou reconcilia
        if (t === maxTent) throw new LeituraFalhou(etapa, `rede: ${(e as Error).message}`)
        await dormir(500 * 2 ** t); continue
      }
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after') ?? 0)
        const esperaS = ra > 0 ? ra : 2 ** t
        if (opts.pararEm429) throw new Throttled(esperaS)
        if (t === maxTent) throw new LeituraFalhou(etapa, 'HTTP 429')
        await dormir(Math.min(esperaS, 20) * 1000); continue
      }
      if (r.status >= 500) {
        if (m !== 'GET' && !(opts.retries && opts.retries > 0)) return { ok: false, status: r.status, body: null }
        if (t === maxTent) throw new LeituraFalhou(etapa, `HTTP ${r.status}`)
        await dormir(500 * 2 ** t); continue
      }
      const texto = r.status === 204 ? '' : await r.text()
      let parsed: any = null
      if (texto) { try { parsed = JSON.parse(texto) } catch { if (r.ok) throw new LeituraFalhou(etapa, 'resposta não é JSON') } }
      return { ok: r.ok, status: r.status, body: parsed }
    }
    throw new LeituraFalhou(etapa, 'esgotou retentativas')
  }
}

// ── repositório Supabase (service_role); todo erro vira LeituraFalhou (nunca decisão silenciosa)
function repoSupabase(db: Db): Repo {
  const T = 'autoresposta_triagem'
  const agoraIso = () => new Date().toISOString()
  return {
    async padroesAtivos() { return must(await db.from('autoresposta_padroes').select('id, padrao, descricao, tipo').eq('ativo', true).order('id'), 'padroes') as Padrao[] },
    async config(pipeline) { return (must(await db.from('autoresposta_config').select('*').eq('pipeline_id', pipeline).maybeSingle(), 'config') as Cfg | null) },
    async criarTrabalho(leadId) { return must(await db.from('autoresposta_trabalho').insert({ kommo_lead_id: leadId }).select('id, kommo_lead_id, tentativas').single(), 'trabalho') as Trabalho },
    async concluirTrabalho(id, estado, erro = null) {
      const patch: Record<string, unknown> = { estado, erro, atualizado_em: agoraIso() }
      if (estado === 'pendente') { const t = must(await db.from('autoresposta_trabalho').select('tentativas').eq('id', id).single(), 'trabalho') as { tentativas: number }; patch.tentativas = t.tentativas + 1 }
      must(await db.from('autoresposta_trabalho').update(patch).eq('id', id), 'trabalho')
    },
    async trabalhosPendentes(limite) { return must(await db.from('autoresposta_trabalho').select('id, kommo_lead_id, tentativas').eq('estado', 'pendente').order('criado_em').limit(limite), 'trabalhos') as Trabalho[] },
    async linhasDoLead(leadId) { return must(await db.from(T).select('*').eq('kommo_lead_id', leadId), 'linhas') as Linha[] },
    async criarLinhas(linhas) { must(await db.from(T).upsert(linhas, { onConflict: 'kommo_lead_id,mensagem_id', ignoreDuplicates: true }), 'criar_linhas') },
    async linha(leadId, mensagemId) { return must(await db.from(T).select('*').eq('kommo_lead_id', leadId).eq('mensagem_id', mensagemId).single(), 'linha') as Linha },
    async decidir(id, dec) {
      // só grava se a linha está livre: pendente e sem lease viva (decisão imutável sob posse)
      const r = await db.from(T).update(dec).eq('id', id).eq('estado_efeito', 'pendente').or(`lease_ate.is.null,lease_ate.lt.${agoraIso()}`).select('*').maybeSingle()
      if (r.error) throw new LeituraFalhou('decidir', r.error.message)
      return (r.data as Linha | null) ?? null
    },
    async outrosLeadsComHash(hash, leadId, desde) {
      const rows = must(await db.from(T).select('kommo_lead_id').eq('hash', hash).neq('kommo_lead_id', leadId).gte('recebido_em', desde), 'r3') as { kommo_lead_id: number }[]
      return new Set(rows.map((r) => r.kommo_lead_id)).size
    },
    async superar(leadId, excetoId, antesDe, motivo) {
      let q = db.from(T).update({ estado_efeito: 'superado', motivo_efeito: motivo, resolvido_em: agoraIso() }).eq('kommo_lead_id', leadId).in('estado_efeito', ['pendente', 'falhou'])
      if (excetoId != null) q = q.neq('id', excetoId)
      if (antesDe) q = q.lt('recebido_em', antesDe)
      must(await q, 'superar')
    },
    async claim(id, leaseS) { const r = await db.rpc('autoresposta_claim', { p_id: id, p_lease_s: leaseS }); if (r.error) throw new LeituraFalhou('claim', r.error.message); return (r.data as string | null) || null },
    async renovar(id, token, leaseS) { const r = await db.rpc('autoresposta_renovar', { p_id: id, p_token: token, p_lease_s: leaseS }); if (r.error) throw new LeituraFalhou('renovar', r.error.message); return !!r.data },
    async fase(id, token, fase) { const r = await db.from(T).update({ efeito_fase: fase }).eq('id', id).eq('claim_token', token).select('id'); if (r.error) throw new LeituraFalhou('fase', r.error.message); return (r.data?.length ?? 0) === 1 },
    async fim(id, token, estado, extra) {
      const final = ['aplicado', 'observado', 'superado'].includes(estado)
      const r = await db.from(T).update({ estado_efeito: estado, lease_ate: null, claim_token: final ? null : token, resolvido_em: final ? agoraIso() : null, ...extra }).eq('id', id).eq('claim_token', token).select('id')
      if (r.error) throw new LeituraFalhou('fim', r.error.message)
      return (r.data?.length ?? 0) === 1
    },
    async acerto(padraoId) { await db.rpc('autoresposta_padrao_acerto', { p_id: padraoId }) },
    async pendentesEfeito(limite) {
      return must(await db.from(T).select('*')
        .or(`and(classificacao.eq.indeterminado,resolvido_em.is.null,estado_efeito.eq.pendente),estado_efeito.in.(pendente,falhou),and(estado_efeito.eq.em_andamento,lease_ate.lt.${agoraIso()})`)
        .lt('tentativas', 5).order('recebido_em').limit(limite), 'pendentes') as Linha[]
    },
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const segredo = req.headers.get('x-autoresposta-secret') ?? url.searchParams.get('s') ?? url.searchParams.get('amp;s')
  if (!SECRET || segredo !== SECRET) return json({ error: 'segredo inválido' }, 401)
  const db = sb()
  try {
    const tok = await db.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
    if (tok.error || !tok.data?.value) return json({ error: 'Kommo sem access_token' }, 500)
    const deps: Deps = { repo: repoSupabase(db), kommo: clienteKommo(db, tok.data.value), agora: () => Math.floor(Date.now() / 1000), campoTexto: CAMPO_TEXTO, leaseS: 300, maxTentativas: 5 }
    if ((url.searchParams.get('acao') ?? 'triar') === 'varrer') return json(await varrer(deps))

    let payload: Record<string, unknown> = {}
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json')) payload = await req.json().catch(() => ({}))
    else { const txt = await req.text(); payload = Object.fromEntries(new URLSearchParams(txt)) }
    const leadId = extrairLeadId(payload, url.searchParams)
    if (!leadId) return json({ error: 'lead id ausente', recebido: Object.keys(payload).slice(0, 10) }, 400)
    return json(await receberWebhook(deps, leadId))
  } catch (e) {
    if (e instanceof Throttled) return json({ error: 'Kommo limitou (429)', esperar_s: e.esperaS }, 503)
    if (e instanceof LeituraFalhou) return json({ error: 'leitura falhou; pendência registrada para a varredura', etapa: e.etapa, detalhe: e.message }, 503)
    return json({ error: (e as Error).message }, 500)
  }
})
