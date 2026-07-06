// kommo-writeback — ponte de ESCRITA SalesHub->Kommo (pg_net não faz PATCH).
// Recebe {secret, kommo_id, patch?, reuniao_id?, tasks_owner?} e faz PATCH /api/v4/leads/{kommo_id}.
// tasks_owner (kommo_user_id): se presente, reatribui TODAS as tarefas ABERTAS do lead p/ esse dono
// (usado quando a roleta atribuiu antes do lead sincronizar no Kommo -> corrige dono do lead + tarefas).
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
  if (!b.kommo_id || (!b.patch && !b.tasks_owner)) {
    return new Response(JSON.stringify({ error: 'missing kommo_id/patch' }), { status: 400 })
  }
  const token = Deno.env.get('KOMMO_API_TOKEN')
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  try {
    let leadStatus: number | null = null, leadBody = ''
    if (b.patch) {
      const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${b.kommo_id}`, { method: 'PATCH', headers: H, body: JSON.stringify(b.patch) })
      leadStatus = r.status; leadBody = (await r.text()).slice(0, 400)
    }

    // reatribui tarefas ABERTAS do lead (opcional) — corrige a tarefa do salesbot ("LEAD NOVO! MOVER")
    const tasksReassigned: number[] = []
    if (b.tasks_owner) {
      const tr = await fetch(`${KOMMO_BASE}/api/v4/tasks?filter[entity_type]=leads&filter[entity_id]=${b.kommo_id}&filter[is_completed]=0&limit=100`, { headers: H })
      if (tr.ok) {
        const tasks = (await tr.json())?._embedded?.tasks || []
        for (const t of tasks) {
          if (t.responsible_user_id !== b.tasks_owner) {
            await fetch(`${KOMMO_BASE}/api/v4/tasks/${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ responsible_user_id: b.tasks_owner }) })
            tasksReassigned.push(t.id)
          }
        }
      }
    }
    // A resposta fica registrada no net._http_response (pg_net) p/ auditoria/process_kommo_responses.
    return new Response(
      JSON.stringify({ kommo_id: b.kommo_id, reuniao_id: b.reuniao_id ?? null, kommo_status: leadStatus, kommo_body: leadBody, tasks_reassigned: tasksReassigned }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    return new Response(JSON.stringify({ kommo_id: b.kommo_id, error: String(e) }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }
})
