// =============================================================
// Edge Function: kommo-lookup  (READ-ONLY)
// =============================================================
// Busca leads no Kommo para a tela de trabalho manual do 3C.
// SÓ LEITURA — nunca escreve/PATCH. Lê o token de integracao_config
// igual às outras funções (kommo-pipelines / kommo-users).
//
// Body (POST):
//   { kommo_id?: string, telefone?: string, query?: string, limit?: number }
//
// Resposta:
//   {
//     byId:       KommoLeadState | null,
//     byIdStatus: 'found' | 'not_found' | 'skipped' | 'error',
//     byPhone:    KommoLeadState[],   // casa pelo telefone (query)
//     byQuery:    KommoLeadState[],   // busca manual por nome/empresa
//   }
//
// KommoLeadState traz o ESTADO VIVO (funil atual, etapa, tags, perdido/
// deletado, responsável) — que a tabela local não reflete pós-migração.
// =============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const digits = (s: string) => (s || '').replace(/\D/g, '')

interface KommoLeadState {
  id: number
  name: string
  pipeline_id: number | null
  status_id: number | null
  pipeline_name: string
  status_name: string
  tags: string[]
  responsible_user_id: number | null
  is_lost: boolean
  is_deleted: boolean
  contact_name: string | null
  phones: string[]
  updated_at: number | null
}

type NameMaps = {
  pipeline: Record<number, string>
  status: Record<number, string>
}

async function getToken(supabase: any): Promise<string | null> {
  const { data } = await supabase
    .from('integracao_config')
    .select('value')
    .eq('key', 'kommo_access_token')
    .maybeSingle()
  return data?.value || null
}

// Mapa id→nome de funis e etapas, pra traduzir o estado do lead.
async function loadNameMaps(token: string): Promise<NameMaps> {
  const maps: NameMaps = { pipeline: {}, status: {} }
  try {
    const r = await fetch(`${KOMMO_BASE}/api/v4/leads/pipelines`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return maps
    const data = await r.json()
    for (const p of data?._embedded?.pipelines || []) {
      maps.pipeline[p.id] = p.name
      for (const s of p?._embedded?.statuses || []) {
        maps.status[s.id] = s.name
      }
    }
  } catch { /* nomes são best-effort */ }
  return maps
}

// Extrai telefones dos contatos embutidos (campo 399272 = phone).
function extractPhones(lead: any): { phones: string[]; contactName: string | null } {
  const phones: string[] = []
  let contactName: string | null = null
  const contacts = lead?._embedded?.contacts || []
  for (const c of contacts) {
    if (!contactName && c?.name) contactName = c.name
    for (const cf of c?.custom_fields_values || []) {
      const code = (cf?.field_code || '').toUpperCase()
      if (code === 'PHONE' || cf?.field_id === 399272) {
        for (const v of cf?.values || []) {
          if (v?.value) phones.push(String(v.value))
        }
      }
    }
  }
  return { phones, contactName }
}

function toState(lead: any, maps: NameMaps, opts?: { deleted?: boolean }): KommoLeadState {
  const { phones, contactName } = extractPhones(lead)
  const tags = (lead?._embedded?.tags || []).map((t: any) => t?.name).filter(Boolean)
  const statusId = lead?.status_id ?? null
  return {
    id: lead?.id,
    name: lead?.name || '',
    pipeline_id: lead?.pipeline_id ?? null,
    status_id: statusId,
    pipeline_name: (lead?.pipeline_id != null && maps.pipeline[lead.pipeline_id]) || '',
    status_name: (statusId != null && maps.status[statusId]) || '',
    tags,
    responsible_user_id: lead?.responsible_user_id ?? null,
    is_lost: statusId === 143,
    is_deleted: !!opts?.deleted,
    contact_name: contactName,
    phones,
    updated_at: lead?.updated_at ?? null,
  }
}

async function fetchById(id: string, token: string, maps: NameMaps): Promise<{ state: KommoLeadState | null; status: string }> {
  const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${id}?with=contacts`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (r.status === 404 || r.status === 204) {
    // Não existe mais / deletado — devolve marcador de deletado.
    return {
      state: {
        id: Number(id), name: '', pipeline_id: null, status_id: null,
        pipeline_name: '', status_name: '', tags: [], responsible_user_id: null,
        is_lost: false, is_deleted: true, contact_name: null, phones: [], updated_at: null,
      },
      status: 'not_found',
    }
  }
  if (!r.ok) return { state: null, status: 'error' }
  const lead = await r.json()
  return { state: toState(lead, maps), status: 'found' }
}

async function searchQuery(q: string, token: string, maps: NameMaps, limit: number): Promise<KommoLeadState[]> {
  const url = `${KOMMO_BASE}/api/v4/leads?query=${encodeURIComponent(q)}&with=contacts&limit=${limit}`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 204) return []
  if (!r.ok) return []
  const data = await r.json()
  return (data?._embedded?.leads || []).map((l: any) => toState(l, maps))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    )
    const token = await getToken(supabase)
    if (!token) {
      return new Response(JSON.stringify({ error: 'Kommo não conectado (sem access_token).' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json().catch(() => ({}))
    const kommoId: string = (body?.kommo_id || '').toString().trim()
    const telefone: string = (body?.telefone || '').toString().trim()
    const query: string = (body?.query || '').toString().trim()
    const limit: number = Math.min(Number(body?.limit) || 10, 50)

    const maps = await loadNameMaps(token)

    let byId: KommoLeadState | null = null
    let byIdStatus = 'skipped'
    let byPhone: KommoLeadState[] = []
    let byQuery: KommoLeadState[] = []

    if (kommoId) {
      const res = await fetchById(kommoId, token, maps)
      byId = res.state
      byIdStatus = res.status
    }

    if (telefone) {
      const d = digits(telefone)
      const found = await searchQuery(d, token, maps, limit)
      // Filtra pelos últimos 8 dígitos, casando com os telefones dos contatos
      // OU com o próprio nome do lead (query do Kommo é ampla).
      const tail = d.slice(-8)
      byPhone = found.filter((l) =>
        l.phones.some((p) => digits(p).slice(-8) === tail)
      )
      // Se o filtro por sufixo zerou mas a query trouxe algo, devolve tudo
      // (contato pode não estar embutido) — a tela ainda deixa o SDR conferir.
      if (byPhone.length === 0 && found.length > 0) byPhone = found
    }

    if (query) {
      byQuery = await searchQuery(query, token, maps, limit)
    }

    return new Response(JSON.stringify({ byId, byIdStatus, byPhone, byQuery }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
