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
// Este arquivo é só o WIRING: HTTP + segredo, repositório Supabase (service_role) e o cliente Kommo
// (cliente.ts: ritmo por conta, Retry-After, backoff, fail closed). A lógica vive em motor.ts
// (testada com fakes) e triagem.ts (regras puras).
// Segredo: header x-autoresposta-secret OU ?s= (o bot só consegue query string). Deploy com
// --no-verify-jwt (o bot e o cron não têm JWT do Supabase).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { extrairLeadId, type Cfg, type Padrao } from './triagem.ts'
import { LeituraFalhou, Throttled, processarTrabalho, receberWebhook, varrer, type Deps, type Linha, type MensagemRecebida, type Repo, type Trabalho } from './motor.ts'
import { clienteKommo } from './cliente.ts'
import { desdobrar, extrairMensagens, resumo } from './webhook.ts'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const SECRET = Deno.env.get('KOMMO_AUTORESPOSTA_SECRET') ?? ''
// Fonte do texto: webhook de CONTA do Kommo (evento add_message) — o texto vem no payload. O campo
// 'Triagem Resposta' (Salesbot) ficou como fallback opcional: só é lido se KOMMO_AUTORESPOSTA_CAMPO estiver definido.
const CAMPO_TEXTO = Deno.env.get('KOMMO_AUTORESPOSTA_CAMPO') ?? ''
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
const sb = () => createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
type Db = ReturnType<typeof sb>
const must = <T,>(r: { data: T | null; error: { message: string } | null }, etapa: string): T => { if (r.error) throw new LeituraFalhou(etapa, r.error.message); return r.data as T }

// ── repositório Supabase (service_role); todo erro vira LeituraFalhou (nunca decisão silenciosa)
function repoSupabase(db: Db): Repo {
  const T = 'autoresposta_triagem'
  const agoraIso = () => new Date().toISOString()
  return {
    async padroesAtivos() { return must(await db.from('autoresposta_padroes').select('id, padrao, descricao, tipo').eq('ativo', true).order('id'), 'padroes') as Padrao[] },
    async config(pipeline) { return (must(await db.from('autoresposta_config').select('*').eq('pipeline_id', pipeline).maybeSingle(), 'config') as Cfg | null) },
    async criarTrabalho(leadId, msg = null, contactId = null) {
      const row = { kommo_lead_id: leadId, contact_id: contactId, mensagem_id: msg?.id ?? null, texto: msg?.texto?.slice(0, 2000) ?? null, recebido_em: msg ? new Date(msg.ts * 1000).toISOString() : null }
      const cols = 'id, kommo_lead_id, tentativas, mensagem_id, texto, recebido_em, contact_id'
      if (msg?.id) { // idempotente por mensagem: reentrega do lote devolve o trabalho existente
        const ins = await db.from('autoresposta_trabalho').upsert(row, { onConflict: 'mensagem_id', ignoreDuplicates: true }).select(cols).maybeSingle()
        if (ins.error) throw new LeituraFalhou('trabalho', ins.error.message)
        if (ins.data) return ins.data as Trabalho
        return must(await db.from('autoresposta_trabalho').select(cols).eq('mensagem_id', msg.id).single(), 'trabalho') as Trabalho
      }
      return must(await db.from('autoresposta_trabalho').insert(row).select(cols).single(), 'trabalho') as Trabalho
    },
    async vincularLead(id, leadId) { must(await db.from('autoresposta_trabalho').update({ kommo_lead_id: leadId, atualizado_em: agoraIso() }).eq('id', id), 'trabalho') },
    async atualizarTexto(id, texto) {
      const r = await db.from(T).update({ texto, origem: 'webhook' }).eq('id', id).eq('estado_efeito', 'pendente').is('decidido_em', null).select('id')
      if (r.error) throw new LeituraFalhou('texto', r.error.message)
      return (r.data?.length ?? 0) === 1
    },
    async concluirTrabalho(id, estado, erro = null) {
      const patch: Record<string, unknown> = { estado, erro, atualizado_em: agoraIso() }
      if (estado === 'pendente') { const t = must(await db.from('autoresposta_trabalho').select('tentativas').eq('id', id).single(), 'trabalho') as { tentativas: number }; patch.tentativas = t.tentativas + 1 }
      must(await db.from('autoresposta_trabalho').update(patch).eq('id', id), 'trabalho')
    },
    async trabalhosPendentes(limite) { return must(await db.from('autoresposta_trabalho').select('id, kommo_lead_id, tentativas, mensagem_id, texto, recebido_em, contact_id').eq('estado', 'pendente').order('criado_em').limit(limite), 'trabalhos') as Trabalho[] },
    async linhasDoLead(leadId) { return must(await db.from(T).select('*').eq('kommo_lead_id', leadId), 'linhas') as Linha[] },
    async criarLinhas(linhas) { must(await db.from(T).upsert(linhas, { onConflict: 'kommo_lead_id,mensagem_id', ignoreDuplicates: true }), 'criar_linhas') },
    async linha(leadId, mensagemId) { return must(await db.from(T).select('*').eq('kommo_lead_id', leadId).eq('mensagem_id', mensagemId).single(), 'linha') as Linha },
    async decidir(id, dec) {
      // só grava se a linha está livre: pendente, sem lease viva e SEM decisão final (imutável depois)
      const r = await db.from(T).update(dec).eq('id', id).eq('estado_efeito', 'pendente').is('decidido_em', null).or(`lease_ate.is.null,lease_ate.lt.${agoraIso()}`).select('*').maybeSingle()
      if (r.error) throw new LeituraFalhou('decidir', r.error.message)
      return (r.data as Linha | null) ?? null
    },
    async outrosLeadsComHash(hash, leadId, desde) {
      const rows = must(await db.from(T).select('kommo_lead_id').eq('hash', hash).neq('kommo_lead_id', leadId).gte('recebido_em', desde), 'r3') as { kommo_lead_id: number }[]
      return new Set(rows.map((r) => r.kommo_lead_id)).size
    },
    async superar(leadId, excetoId, antesDe, motivo, opts = {}) {
      let q = db.from(T).update({ estado_efeito: 'superado', motivo_efeito: motivo, resolvido_em: agoraIso() }).eq('kommo_lead_id', leadId).in('estado_efeito', ['pendente', 'falhou'])
      if (excetoId != null) q = q.neq('id', excetoId)
      if (antesDe) q = q.lt('recebido_em', antesDe)
      if (opts.somenteSemTexto) q = q.or('texto.is.null,texto.eq.')
      must(await q, 'superar')
    },
    async claim(id, leaseS) {
      const r = await db.rpc('autoresposta_claim', { p_id: id, p_lease_s: leaseS })
      if (r.error) throw new LeituraFalhou('claim', r.error.message)
      const linha = r.data as Linha | null
      if (!linha || !linha.claim_token) return null
      return { token: linha.claim_token, linha }
    },
    async renovar(id, token, leaseS) { const r = await db.rpc('autoresposta_renovar', { p_id: id, p_token: token, p_lease_s: leaseS }); if (r.error) throw new LeituraFalhou('renovar', r.error.message); return !!r.data },
    async fase(id, token, fase, extra = {}) { const r = await db.from(T).update({ efeito_fase: fase, ...extra }).eq('id', id).eq('claim_token', token).select('id'); if (r.error) throw new LeituraFalhou('fase', r.error.message); return (r.data?.length ?? 0) === 1 },
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
    const kommo = clienteKommo({
      base: KOMMO_BASE, token: tok.data.value,
      fetch: (u, init) => fetch(u, init),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      reservar: async (ms) => { const r = await db.rpc('autoresposta_reservar', { p_ms: ms }); if (r.error) throw new Error(r.error.message); return Number(r.data ?? 0) },
    })
    const deps: Deps = { repo: repoSupabase(db), kommo, agora: () => Math.floor(Date.now() / 1000), campoTexto: CAMPO_TEXTO, leaseS: 300, maxTentativas: 5 }
    if ((url.searchParams.get('acao') ?? 'triar') === 'varrer') return json(await varrer(deps))

    let payload: Record<string, any> = {}
    const ct = req.headers.get('content-type') ?? ''
    if (ct.includes('json')) payload = await req.json().catch(() => ({}))
    else { const txt = await req.text(); payload = desdobrar(new URLSearchParams(txt)) }

    // ── webhook de CONTA (add_message): o Kommo desativa destino que falha muito → responde 200 rápido
    //    e processa em segundo plano (o trabalho fica durável no banco antes de responder).
    const mensagens = extrairMensagens(payload)
    if (mensagens.length) {
      // 1) persiste TODAS as entradas (lead ou só contato) ANTES de qualquer leitura no Kommo —
      //    idempotente por mensagem (reentrega do lote não duplica); 2) responde 200; 3) worker.
      const aceitas: unknown[] = [], ignoradas: unknown[] = [], trabalhos: Trabalho[] = []
      for (const m of mensagens) {
        if (m.tipo !== 'incoming') { ignoradas.push({ ...resumo(m), motivo: m.tipo }); continue } // outgoing: /events já traz o disparo
        if (!m.leadId && !m.contactId) { ignoradas.push({ ...resumo(m), motivo: 'sem lead nem contato' }); continue }
        const msg: MensagemRecebida = { id: m.id, ts: m.createdAt ?? Math.floor(Date.now() / 1000), texto: m.texto }
        const t = await deps.repo.criarTrabalho(m.leadId, msg, m.contactId)
        trabalhos.push(t); aceitas.push({ trabalho: t.id, lead: m.leadId, contato: m.contactId, mensagem: m.id })
      }
      const tarefa = (async () => {
        for (const t of trabalhos) {
          try { await processarTrabalho(deps, t) }
          catch (e) { try { await deps.repo.concluirTrabalho(t.id, 'pendente', (e as Error).message) } catch { /* fica para a varredura */ } }
        }
      })()
      const rt = (globalThis as any).EdgeRuntime
      if (rt?.waitUntil) rt.waitUntil(tarefa); else await tarefa
      return json({ ok: true, aceitas, ignoradas })
    }

    // ── chamada direta/legado (Salesbot/teste): lead id no payload ou na query
    const leadId = extrairLeadId(payload, url.searchParams)
    if (!leadId) return json({ error: 'lead id ausente', recebido: Object.keys(payload).slice(0, 10) }, 400)
    return json(await receberWebhook(deps, leadId))
  } catch (e) {
    if (e instanceof Throttled) return json({ error: 'Kommo limitou (429) ou ritmo saturado; trabalho fica para a varredura', esperar_s: e.esperaS }, 503)
    if (e instanceof LeituraFalhou) return json({ error: 'leitura falhou; pendência registrada para a varredura', etapa: e.etapa, detalhe: e.message }, 503)
    return json({ error: (e as Error).message }, 500)
  }
})
