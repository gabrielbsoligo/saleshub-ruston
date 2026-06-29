// kommo-enrich-lemit — enriquece leads marcados (enriquecer_lemit) consultando a Lemit:
// CNPJ -> sócios; por sócio -> /pessoa -> celulares whatsapp=true + emails; cada sócio vira
// um CONTATO no Kommo vinculado ao lead. Paced (Lemit 10/s, Kommo 7/s). Cron-driven.
//
// Cria contato SEMPRE (mesmo sem whatsapp — aproveita e-mails). Só números whatsapp=true.
// Auth por segredo (KOMMO_ENRICH_SECRET). Deploy --no-verify-jwt.
// Modo dry_run: faz as consultas Lemit e devolve os contatos planejados SEM escrever no Kommo.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const LEMIT_BASE = 'https://api.lemit.com.br/api/v1/consulta'
const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com/api/v4'
const FIELD_PHONE = 399272   // custom field telefone (contato)
const FIELD_EMAIL = 399274   // custom field email (contato)
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }

class RL {
  private q: number[] = []
  constructor(private max: number, private win = 1000) {}
  async acquire() { for (;;) { const n = Date.now(); this.q = this.q.filter((t) => n - t < this.win); if (this.q.length < this.max) { this.q.push(n); return } await new Promise((r) => setTimeout(r, this.win / this.max)) } }
}
const lemitRL = new RL(10), kommoRL = new RL(7)
const onlyDigits = (s: any) => String(s ?? '').replace(/\D/g, '')

async function lemit(path: string, doc: string) {
  await lemitRL.acquire()
  const r = await fetch(`${LEMIT_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('LEMIT_API_TOKEN')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `documento=${doc}` })
  const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}
async function kommo(method: string, path: string, body: any) {
  await kommoRL.acquire()
  const r = await fetch(`${KOMMO_BASE}${path}`, { method, headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const t = await r.text(); let b; try { b = JSON.parse(t) } catch { b = t }
  return { status: r.status, body: b }
}

// monta os contatos planejados (sócios) p/ um CNPJ — sem escrever
async function planContacts(cnpj: string) {
  const emp = await lemit('/empresa', onlyDigits(cnpj))
  if (emp.status !== 200 || !emp.body?.empresa) return { erro: `empresa status ${emp.status}`, socios: [] }
  const socios = emp.body.empresa.socios ?? []
  const out: any[] = []
  for (const s of socios) {
    const cpf = onlyDigits(s.cpf)
    let whats: string[] = [], emails: string[] = []
    if (cpf.length === 11) {
      const pes = await lemit('/pessoa', cpf)
      const p = pes.status === 200 ? (pes.body?.pessoa ?? {}) : {}
      whats = (p.celulares ?? []).filter((c: any) => c.whatsapp).map((c: any) => `+55${c.ddd}${onlyDigits(c.numero)}`)
      emails = (p.emails ?? []).map((e: any) => e.email).filter(Boolean)
    }
    out.push({ nome: s.nome, cpf, whatsapps: whats, emails })
  }
  return { razao: emp.body.empresa.razao_social, socios: out }
}

function contactPayload(s: any) {
  const cfs: any[] = []
  if (s.whatsapps.length) cfs.push({ field_id: FIELD_PHONE, values: s.whatsapps.map((v: string) => ({ value: v, enum_code: 'WORK' })) })
  if (s.emails.length) cfs.push({ field_id: FIELD_EMAIL, values: s.emails.map((v: string) => ({ value: v, enum_code: 'WORK' })) })
  const c: any = { first_name: s.nome }
  if (cfs.length) c.custom_fields_values = cfs
  return c
}

// cria contatos no Kommo e vincula ao lead
async function applyContacts(kommoLeadId: number, socios: any[]) {
  let criados = 0
  for (const s of socios) {
    const c = await kommo('POST', '/contacts', [contactPayload(s)])
    const cid = c.body?._embedded?.contacts?.[0]?.id
    if (!cid) continue
    await kommo('POST', `/leads/${kommoLeadId}/link`, [{ to_entity_id: cid, to_entity_type: 'contacts' }])
    criados++
  }
  return criados
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  const auth = req.headers.get('authorization') || ''
  const secret = (auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '') || url.searchParams.get('secret') || ''
  if (secret !== Deno.env.get('KOMMO_ENRICH_SECRET')) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    // DRY-RUN p/ validação: só consulta a Lemit e devolve o plano (sem escrever)
    if (body.dry_run && body.cnpj) {
      const plan = await planContacts(body.cnpj)
      return new Response(JSON.stringify({ ok: true, dry_run: true, ...plan }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const limit = Math.min(body.limit ?? 3, 10)  // poucos leads por invocação (cada um = vários calls)
    const { data: leads } = await sb.from('leads').select('id, cnpj, kommo_id')
      .eq('enriquecer_lemit', true).is('lemit_enriched_at', null)
      .not('cnpj', 'is', null).not('kommo_id', 'is', null).limit(limit)
    const results: any[] = []
    for (const lead of leads ?? []) {
      try {
        const plan = await planContacts(lead.cnpj)
        const criados = await applyContacts(Number(lead.kommo_id), plan.socios ?? [])
        await sb.from('leads').update({ lemit_enriched_at: new Date().toISOString(), lemit_socios_count: criados, lemit_erro: plan.erro ?? null }).eq('id', lead.id)
        results.push({ lead_id: lead.id, socios: plan.socios?.length ?? 0, contatos_criados: criados })
      } catch (e) {
        await sb.from('leads').update({ lemit_enriched_at: new Date().toISOString(), lemit_erro: String(e) }).eq('id', lead.id)
        results.push({ lead_id: lead.id, erro: String(e) })
      }
    }
    return new Response(JSON.stringify({ ok: true, processados: results.length, results }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('kommo-enrich-lemit', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: cors })
  }
})
