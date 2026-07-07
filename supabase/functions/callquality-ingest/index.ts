// callquality-ingest — recebe do n8n a análise de qualidade de ligação e grava em call_quality.
// Payload = { ...payload_4com (com id/call_id, caller...), transcricao: string, analise: {...} | "json string" }
//   analise = { NOTA_FINAL:int, PONTOS_POSITIVOS:[...], PONTOS_NEGATIVOS_OU_OPORTUNIDADES:[...] }
// Amarra por call_id (= payload.id da API4COM). UPSERT idempotente por call_id. CORS liberado.
// Deploy: supabase functions deploy callquality-ingest --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return json({ ok: false, error: 'use POST' }, 405)

  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'JSON inválido no corpo' }, 400) }
  const p = body?.body || body   // n8n às vezes embrulha em .body

  // call_id: API4COM manda `id`; aceitamos também call_id explícito
  const call_id = p?.call_id ?? p?.id ?? null
  if (!call_id) {
    return json({ ok: false, error: 'call_id ausente — envie o payload da API4COM (campo "id" ou "call_id") junto com transcricao e analise' }, 400)
  }

  // analise: objeto OU string JSON
  let analise: any = p?.analise ?? {}
  if (typeof analise === 'string') { try { analise = JSON.parse(analise) } catch { analise = {} } }
  const nota_final = analise?.NOTA_FINAL ?? analise?.nota_final ?? null
  const pontos_positivos = analise?.PONTOS_POSITIVOS ?? analise?.pontos_positivos ?? []
  const pontos_negativos = analise?.PONTOS_NEGATIVOS_OU_OPORTUNIDADES ?? analise?.pontos_negativos ?? []
  const transcricao = p?.transcricao ?? null

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

  // resolve SDR: (1) sdr_kommo_user_id explícito; (2) call_id -> ligacoes_4com.member_id; (3) caller -> ramal_4com
  let sdr_id: string | null = null
  let sdr_kommo_user_id: number | null = p?.sdr_kommo_user_id ?? null
  const { data: lg } = await supabase.from('ligacoes_4com').select('member_id').eq('call_id', call_id).maybeSingle()
  if (lg?.member_id) sdr_id = lg.member_id
  if (!sdr_id && p?.caller) {
    const { data: m } = await supabase.from('team_members').select('id, kommo_user_id').eq('ramal_4com', String(p.caller)).maybeSingle()
    if (m) { sdr_id = m.id; sdr_kommo_user_id = sdr_kommo_user_id ?? m.kommo_user_id }
  }
  if (sdr_id && sdr_kommo_user_id == null) {
    const { data: tm } = await supabase.from('team_members').select('kommo_user_id').eq('id', sdr_id).maybeSingle()
    sdr_kommo_user_id = tm?.kommo_user_id ?? null
  }

  const kommo_lead_id = p?.kommo_lead_id ?? p?.lead_id ?? null

  const { data, error } = await supabase.from('call_quality').upsert({
    call_id: String(call_id),
    kommo_lead_id: kommo_lead_id ? Number(kommo_lead_id) : null,
    sdr_kommo_user_id, sdr_id,
    nota_final: nota_final != null ? Number(nota_final) : null,
    pontos_positivos, pontos_negativos, transcricao,
    analisado_em: new Date().toISOString(),
    raw: body,
  }, { onConflict: 'call_id' }).select('id').single()

  if (error) return json({ ok: false, error: error.message }, 500)
  return json({ ok: true, id: data.id, call_id, sdr_id, nota_final })
})
