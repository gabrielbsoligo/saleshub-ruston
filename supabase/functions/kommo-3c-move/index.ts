// =============================================================
// Edge Function: kommo-3c-move
// =============================================================
// Ponte de ESCRITA da tela de trabalho manual do 3C, chamável pelo
// navegador (verify_jwt ON — recebe o anon key, igual kommo-lookup).
//
// Não expõe o KOMMO_SYNC_SECRET ao browser: recebe { kommo_id,
// responsible_user_id }, monta o patch FIXO de Conexão Realizada e
// repassa pra edge kommo-writeback (a mesma do write-back de reunião),
// injetando o segredo no servidor.
//
// Move: pipeline 14062096 / status 108545100 (Novo-Pré Vendas ·
// Conexão Realizada) + responsible_user_id escolhido. Nada além disso —
// o destino é hardcoded pra limitar o alcance de quem tem o JWT.
// =============================================================

const TARGET_PIPELINE_ID = 14062096
const TARGET_STATUS_ID = 108545100

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  let b: any
  try {
    b = await req.json()
  } catch {
    return json({ error: 'bad json' }, 400)
  }

  const kommoId = (b?.kommo_id ?? '').toString().trim()
  const responsibleUserId = Number(b?.responsible_user_id)
  if (!kommoId) return json({ error: 'missing kommo_id' }, 400)
  if (!Number.isFinite(responsibleUserId) || responsibleUserId <= 0) {
    return json({ error: 'missing/invalid responsible_user_id' }, 400)
  }

  const secret = Deno.env.get('KOMMO_SYNC_SECRET')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!secret || !supabaseUrl) {
    return json({ error: 'server misconfigured (secret/url)' }, 500)
  }

  const patch = {
    pipeline_id: TARGET_PIPELINE_ID,
    status_id: TARGET_STATUS_ID,
    responsible_user_id: responsibleUserId,
  }

  try {
    // Reusa a ponte de escrita já auditada (kommo-writeback), server-side.
    const r = await fetch(`${supabaseUrl}/functions/v1/kommo-writeback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, kommo_id: kommoId, patch }),
    })
    const data = await r.json().catch(() => null)
    // kommo-writeback devolve kommo_status = HTTP do PATCH no Kommo.
    const kommoStatus = data?.kommo_status ?? r.status
    const ok = r.ok && typeof kommoStatus === 'number' && kommoStatus >= 200 && kommoStatus < 300
    if (!ok) {
      return json({ ok: false, kommo_id: kommoId, patch, bridge_status: r.status, kommo_status: kommoStatus, kommo_body: data?.kommo_body ?? data }, 502)
    }
    return json({ ok: true, kommo_id: kommoId, patch, kommo_status: kommoStatus, kommo_body: data?.kommo_body ?? null })
  } catch (e: any) {
    return json({ ok: false, kommo_id: kommoId, patch, error: String(e?.message || e) }, 502)
  }
})
