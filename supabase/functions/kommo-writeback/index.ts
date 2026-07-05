// kommo-writeback — ponte de ESCRITA SalesHub->Kommo (pg_net não faz PATCH).
// Recebe {secret, kommo_id, patch, reuniao_id?} e faz PATCH /api/v4/leads/{kommo_id}.
// Auth por segredo (KOMMO_SYNC_SECRET). Token do Kommo via secret KOMMO_API_TOKEN.
// Deploy: supabase functions deploy kommo-writeback --no-verify-jwt
const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok')
  let b: any
  try { b = await req.json() } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400 }) }
  if (!b?.secret || b.secret !== Deno.env.get('KOMMO_SYNC_SECRET')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }
  if (!b.kommo_id || !b.patch) {
    return new Response(JSON.stringify({ error: 'missing kommo_id/patch' }), { status: 400 })
  }
  const token = Deno.env.get('KOMMO_API_TOKEN')
  try {
    const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${b.kommo_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(b.patch),
    })
    const txt = await r.text()
    // A resposta fica registrada no net._http_response (pg_net) p/ auditoria/process_kommo_responses.
    return new Response(
      JSON.stringify({ kommo_id: b.kommo_id, reuniao_id: b.reuniao_id ?? null, kommo_status: r.status, kommo_body: txt.slice(0, 400) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    return new Response(JSON.stringify({ kommo_id: b.kommo_id, error: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
})
