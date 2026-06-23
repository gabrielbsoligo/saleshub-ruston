// =============================================================
// Edge Function: kommo-reconcile
// =============================================================
// Roda 1x/dia (via pg_cron). Pega leads que tem dados de contato
// no SalesHub mas ainda nao foram sincronizados com o Kommo
// (kommo_contact_synced_at IS NULL).
//
// Pra cada um:
//  1. GET Kommo /api/v4/leads/{kommo_id}?with=contacts
//  2. Se 0 contatos -> POST /api/v4/contacts pra criar + linkar
//  3. Se >=1 contato -> marca synced_at agora (ja tava ok)
//
// Tudo logado em kommo_sync_log com action='reconcile'.
//
// Tambem aceita POST com body { lead_ids: [...] } pra rerodar
// um conjunto especifico (uso manual via UI ou script).
// =============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const BATCH_SIZE = 50

function getSupabaseAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  )
}

interface Lead {
  id: string
  kommo_id: string
  empresa: string
  nome_contato: string | null
  telefone: string | null
  email: string | null
}

async function getKommoToken(supabase: any): Promise<string | null> {
  const { data } = await supabase
    .from('integracao_config')
    .select('value')
    .eq('key', 'kommo_access_token')
    .maybeSingle()
  return data?.value || null
}

async function fetchKommoLead(kommoId: string, token: string) {
  const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${kommoId}?with=contacts`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) throw new Error(`GET lead ${kommoId} -> ${r.status}`)
  return r.json()
}

async function createKommoContact(lead: Lead, token: string) {
  // Kommo NAO linka contato a lead via _embedded.leads no POST /contacts.
  // Sempre cria contato orfao. Caminho correto: 2 chamadas:
  //   1) POST /contacts -> cria contato + retorna id
  //   2) POST /leads/{lead_id}/link -> linka contato ao lead
  const customFields: any[] = []
  if (lead.telefone) {
    customFields.push({
      field_id: 399272,
      values: [{ value: lead.telefone, enum_code: 'WORK' }],
    })
  }
  if (lead.email) {
    customFields.push({
      field_id: 399274,
      values: [{ value: lead.email, enum_code: 'WORK' }],
    })
  }
  const payloadContact = [{
    // sem nome de pessoa, usa a empresa como nome do contato
    first_name: lead.nome_contato || lead.empresa,
    custom_fields_values: customFields.length ? customFields : undefined,
  }]

  // 1. Cria contato
  const rc = await fetch(`${KOMMO_BASE}/api/v4/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadContact),
  })
  const bodyContact = await rc.json().catch(() => null)
  if (!rc.ok) return { status: rc.status, body: bodyContact, payload: payloadContact, step: 'create_contact' }

  const contactId = bodyContact?._embedded?.contacts?.[0]?.id
  if (!contactId) return { status: 500, body: bodyContact, payload: payloadContact, step: 'no_contact_id' }

  // 2. Linka ao lead
  const linkPayload = [{ to_entity_id: contactId, to_entity_type: 'contacts' }]
  const rl = await fetch(`${KOMMO_BASE}/api/v4/leads/${lead.kommo_id}/link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(linkPayload),
  })
  const bodyLink = await rl.json().catch(() => null)

  return {
    status: rl.status,
    body: { contact_created: bodyContact, link_result: bodyLink, contact_id: contactId },
    payload: { contact: payloadContact, link: linkPayload },
    step: 'link',
  }
}

async function logSync(supabase: any, leadId: string, action: string, payload: any, status: number, body: any, error?: string) {
  await supabase.from('kommo_sync_log').insert({
    lead_id: leadId,
    action,
    request_payload: payload,
    response_status: status,
    response_body: body,
    error_message: error,
    completed_at: new Date().toISOString(),
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const supabase = getSupabaseAdmin()
  const token = await getKommoToken(supabase)
  if (!token) {
    return new Response(JSON.stringify({ error: 'Sem access token Kommo' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Body opcional pra rerun manual
  let manualIds: string[] | null = null
  try {
    if (req.method === 'POST' && req.headers.get('content-length') !== '0') {
      const body = await req.json()
      if (Array.isArray(body?.lead_ids)) manualIds = body.lead_ids
    }
  } catch { /* sem body — segue cron mode */ }

  // Pega candidatos: lead com kommo_id, ainda sem contato sincronizado,
  // e com ALGUM dado de contato (telefone OU e-mail). O nome não é exigido —
  // sem pessoa, o contato é criado com o nome da empresa.
  let query = supabase
    .from('leads')
    .select('id, kommo_id, empresa, nome_contato, telefone, email')
    .not('kommo_id', 'is', null)
    .neq('kommo_id', '')
    .is('kommo_contact_synced_at', null)
    .or('telefone.not.is.null,email.not.is.null')
    .limit(BATCH_SIZE)

  if (manualIds) query = query.in('id', manualIds).limit(manualIds.length)

  const { data: leads, error } = await query
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const result = { total: leads?.length || 0, ja_ok: 0, criou_contato: 0, falhou: 0, ids_processados: [] as string[] }

  for (const lead of (leads || []) as Lead[]) {
    result.ids_processados.push(lead.id)
    try {
      const kommoLead = await fetchKommoLead(lead.kommo_id, token)
      const existingContacts = kommoLead?._embedded?.contacts || []

      if (existingContacts.length > 0) {
        // ja tem contato, so marca synced
        await supabase.from('leads').update({ kommo_contact_synced_at: new Date().toISOString() }).eq('id', lead.id)
        await logSync(supabase, lead.id, 'reconcile', { check_only: true }, 200, { existing_contacts: existingContacts.length })
        result.ja_ok++
      } else {
        // sem contato, cria + linka
        const { status, body, payload } = await createKommoContact(lead, token)
        if (status >= 200 && status < 300) {
          await supabase.from('leads').update({ kommo_contact_synced_at: new Date().toISOString() }).eq('id', lead.id)
          await logSync(supabase, lead.id, 'reconcile', payload, status, body)
          result.criou_contato++
        } else {
          await logSync(supabase, lead.id, 'reconcile', payload, status, body, `HTTP ${status}`)
          result.falhou++
        }
      }
    } catch (e: any) {
      await logSync(supabase, lead.id, 'reconcile', null, 0, null, e.message || String(e))
      result.falhou++
    }
    // pequeno delay pra nao estourar rate limit
    await new Promise(r => setTimeout(r, 200))
  }

  return new Response(JSON.stringify(result), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
