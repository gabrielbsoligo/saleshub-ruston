// kommo-webhook (Fase 3) — recebe eventos do Kommo em tempo real e aplica na réplica `kommo`.
// Idempotente + à prova de fora-de-ordem (as funções kommo.apply_* rejeitam update mais
// antigo que o dado atual). SEGURANÇA: valida segredo (?secret=) e subdomínio antes de aplicar.
//
// Captura: leads/contacts/companies (add/update/status/responsible/delete), tasks (add/update),
// notes (add) e os 5 toques de chat/DM (message/talk) -> kommo.events (mantém last_activity_at).
//
// Configurar no Kommo: webhook URL = https://<ref>.supabase.co/functions/v1/kommo-webhook?secret=<SEGREDO>
// Secret no ambiente: supabase secrets set KOMMO_WEBHOOK_SECRET=<SEGREDO>
// (deploy com --no-verify-jwt, pois o Kommo não manda JWT; a autenticação é o ?secret=)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const EXPECTED_SUBDOMAIN = 'financeirorustonengenhariacombr'
const TOUCH_TYPES = new Set([
  'outgoing_chat_message', 'incoming_chat_message', 'talk_created',
  'conversation_answered', 'entity_direct_message',
])

// Parser do form-urlencoded aninhado do Kommo: "leads[status][0][id]=1" -> {leads:{status:{0:{id:'1'}}}}
function parseNested(body: string): any {
  const root: any = {}
  for (const [key, val] of new URLSearchParams(body)) {
    const parts = key.replace(/\]/g, '').split('[')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] ?? {}
      node = node[parts[i]]
    }
    node[parts[parts.length - 1]] = val
  }
  return root
}
const list = (obj: any) => (obj && typeof obj === 'object' ? Object.values(obj) : [])
const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok')
  try {
    // --- SEGURANÇA: segredo antes de qualquer aplicação ---
    const url = new URL(req.url)
    const secret = url.searchParams.get('secret')
    const expected = Deno.env.get('KOMMO_WEBHOOK_SECRET')
    if (!expected || secret !== expected) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 })
    }
    const raw = await req.text()
    const p = parseNested(raw)
    // valida origem (subdomínio da conta)
    const sub = p?.account?.subdomain
    if (sub && sub !== EXPECTED_SUBDOMAIN) {
      return new Response(JSON.stringify({ ok: false, error: 'wrong_account' }), { status: 401 })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    // schema `kommo` não é exposto no PostgREST -> chama os wrappers public.kommo_*
    const applied: string[] = []
    const rpc = async (fn: string, args: Record<string, unknown>) => {
      const { error } = await supabase.rpc('kommo_' + fn, args)
      if (error) console.error(fn, error.message); else applied.push(fn)
    }

    // LEADS: add/update/status -> apply_lead ; delete -> soft_delete
    for (const kind of ['add', 'update', 'status']) {
      for (const l of list(p?.leads?.[kind]) as any[]) {
        if (!l?.id) continue
        await rpc('apply_lead', {
          p_id: num(l.id), p_name: l.name ?? null, p_pipeline: num(l.pipeline_id),
          p_status: num(l.status_id), p_resp: num(l.responsible_user_id),
          p_price: num(l.price), p_updated: num(l.updated_at) ?? Math.floor(Date.now() / 1000),
        })
      }
    }
    for (const l of list(p?.leads?.delete) as any[]) if (l?.id) await rpc('soft_delete', { p_table: 'leads', p_id: num(l.id) })

    // CONTACTS
    for (const kind of ['add', 'update']) for (const c of list(p?.contacts?.[kind]) as any[]) {
      if (!c?.id) continue
      await rpc('apply_contact', { p_id: num(c.id), p_name: c.name ?? null, p_resp: num(c.responsible_user_id), p_cf: null, p_updated: num(c.updated_at) ?? Math.floor(Date.now() / 1000) })
    }
    for (const c of list(p?.contacts?.delete) as any[]) if (c?.id) await rpc('soft_delete', { p_table: 'contacts', p_id: num(c.id) })

    // COMPANIES
    for (const kind of ['add', 'update']) for (const c of list(p?.companies?.[kind]) as any[]) {
      if (!c?.id) continue
      await rpc('apply_company', { p_id: num(c.id), p_name: c.name ?? null, p_resp: num(c.responsible_user_id), p_updated: num(c.updated_at) ?? Math.floor(Date.now() / 1000) })
    }
    for (const c of list(p?.companies?.delete) as any[]) if (c?.id) await rpc('soft_delete', { p_table: 'companies', p_id: num(c.id) })

    // TASKS (add/update) — Kommo manda em 'task'
    for (const kind of ['add', 'update']) for (const t of list(p?.task?.[kind]) as any[]) {
      if (!t?.id) continue
      await rpc('apply_task', {
        p_id: num(t.id), p_entity_type: t.element_type === '2' ? 'leads' : (t.entity_type ?? 'leads'),
        p_entity_id: num(t.element_id ?? t.entity_id), p_resp: num(t.responsible_user_id),
        p_completed: (t.status === '1' || t.is_completed === '1'), p_text: t.text ?? null,
        p_complete_till: num(t.complete_till) ?? 0, p_updated: num(t.updated_at) ?? Math.floor(Date.now() / 1000),
      })
    }

    // NOTES (add) — 'note'
    for (const n of list(p?.note?.add) as any[]) if (n?.id && n?.element_id) {
      await rpc('apply_note', { p_id: num(n.id), p_entity_id: num(n.element_id), p_note_type: n.note_type ?? null, p_created_by: num(n.created_by), p_created: num(n.created_at) ?? Math.floor(Date.now() / 1000) })
    }

    // TOQUES de chat/DM (message/talk) -> kommo.events (mantém last_activity_at vivo)
    const touches = [...list(p?.message?.add), ...list(p?.talk?.add), ...list(p?.message?.update)] as any[]
    for (const m of touches) {
      const eid = m?.id ?? m?.chat_id ?? m?.talk_id
      const lead = num(m?.element_id ?? m?.entity_id)
      const t = m?.type && TOUCH_TYPES.has(m.type) ? m.type : (m?.talk_id ? 'talk_created' : 'incoming_chat_message')
      if (eid && lead) await rpc('apply_touch_event', { p_id: `wh:${t}:${eid}`, p_type: t, p_entity_id: lead, p_created_by: num(m?.created_by), p_created: num(m?.created_at) ?? Math.floor(Date.now() / 1000) })
    }

    return new Response(JSON.stringify({ ok: true, applied_count: applied.length }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('kommo-webhook error', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 })
  }
})
