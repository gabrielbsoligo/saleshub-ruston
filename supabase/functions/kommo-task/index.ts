// kommo-task — cria TAREFAS no Kommo em lote (pg_net não faz POST autenticado no Kommo direto).
// Usada pela rotina diária "leads sem tarefa" (kommo.criar_tarefas_sem_tarefa, 23h BRT via pg_cron).
// Ações: {secret, action:'list_task_types'}  -> tipos de tarefa da conta (descoberta/debug)
//        {secret, tasks:[{entity_id, responsible_user_id, text, task_type_id, complete_till, task_id?}]}
//          -> sem task_id: POST /api/v4/tasks em lotes de 50 (limite da API)
//          -> com task_id: PATCH /api/v4/tasks/{id} (remarcar tarefa existente — ex.: Retorno)
// Auth: mesmo segredo do writeback. Deploy: management API (verify_jwt=false).

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok')
  let b: any
  try { b = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  if (!b?.secret || b.secret !== Deno.env.get('KOMMO_SYNC_SECRET')) return json({ error: 'unauthorized' }, 401)
  const H = { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'Content-Type': 'application/json' }

  if (b.action === 'list_task_types') {
    const r = await fetch(`${KOMMO_BASE}/api/v4/account?with=task_types`, { headers: H })
    const j = await r.json()
    return json({ ok: r.ok, task_types: j?._embedded?.task_types ?? j })
  }

  if (!Array.isArray(b.tasks) || b.tasks.length === 0) return json({ error: 'tasks vazio' }, 400)
  const results: any[] = []
  // PATCH individual para tarefas existentes (remarcação)
  const patches = b.tasks.filter((t: any) => t.task_id)
  for (const t of patches) {
    const r = await fetch(`${KOMMO_BASE}/api/v4/tasks/${t.task_id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ complete_till: t.complete_till, is_completed: false,
        ...(t.text ? { text: t.text } : {}), ...(t.responsible_user_id ? { responsible_user_id: t.responsible_user_id } : {}) }),
    })
    results.push({ task_id: t.task_id, status: r.status, remarcada: r.ok })
  }
  const creates = b.tasks.filter((t: any) => !t.task_id)
  for (let i = 0; i < creates.length; i += 50) {
    const chunk = creates.slice(i, i + 50).map((t: any) => ({
      entity_id: t.entity_id, entity_type: 'leads',
      responsible_user_id: t.responsible_user_id,
      text: t.text, task_type_id: t.task_type_id,
      complete_till: t.complete_till,
    }))
    const r = await fetch(`${KOMMO_BASE}/api/v4/tasks`, { method: 'POST', headers: H, body: JSON.stringify(chunk) })
    const body = await r.text()
    results.push({ status: r.status, criadas: r.ok ? chunk.length : 0, detail: r.ok ? undefined : body.slice(0, 300) })
    if (i + 50 < creates.length) await new Promise((res) => setTimeout(res, 500))  // respeita rate limit
  }
  return json({ ok: results.every(x => x.status < 300), lotes: results, total: b.tasks.length })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
