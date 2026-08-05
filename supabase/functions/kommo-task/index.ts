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

  // Verificação diária: pré-entrada (etapa type=1) com conversa duplicada de lead existente.
  // Busca o telefone do contato na API do Kommo (o espelho não vincula contato antes do aceite),
  // casa contra a base (RPC match_lead_por_fone) e cria tarefa ALERTA no lead REAL.
  if (b.action === 'verificar_preentrada') {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2')
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const { data: pres } = await supabase.rpc('get_preentrada_leads')
    const out: any[] = []
    for (const pre of (pres ?? []).slice(0, 120)) {
      const lr = await fetch(`${KOMMO_BASE}/api/v4/leads/${pre.kid}?with=contacts`, { headers: H })
      if (!lr.ok) { out.push({ pre: pre.kid, skip: 'lead_' + lr.status }); continue }
      const lead = await lr.json()
      const contactId = lead?._embedded?.contacts?.[0]?.id
      if (!contactId) { out.push({ pre: pre.kid, skip: 'sem_contato' }); continue }
      await new Promise((res) => setTimeout(res, 120))
      const cr = await fetch(`${KOMMO_BASE}/api/v4/contacts/${contactId}`, { headers: H })
      if (!cr.ok) { out.push({ pre: pre.kid, skip: 'contato_' + cr.status }); continue }
      const contact = await cr.json()
      const phones = (contact?.custom_fields_values ?? [])
        .filter((f: any) => f.field_code === 'PHONE')
        .flatMap((f: any) => (f.values ?? []).map((v: any) => String(v.value ?? '')))
      const fone = phones.find((x: string) => x.replace(/\D/g, '').length >= 10)
      if (!fone) { out.push({ pre: pre.kid, skip: 'sem_fone' }); continue }
      const { data: matches } = await supabase.rpc('match_lead_por_fone', { p_fone: fone, p_pre_id: pre.kid })
      const m = (matches ?? [])[0]
      if (!m) { out.push({ pre: pre.kid, fone, match: null }); continue }
      if (m.ja_alertado) { out.push({ pre: pre.kid, match: m.kid, skip: 'ja_alertado' }); continue }
      const due = Math.floor(Date.now() / 1000) + 8 * 3600
      const tr = await fetch(`${KOMMO_BASE}/api/v4/tasks`, {
        method: 'POST', headers: H,
        body: JSON.stringify([{ entity_id: m.kid, entity_type: 'leads',
          responsible_user_id: m.responsible_user_id,
          task_type_id: 3928475,
          text: `Conversa duplicada na pré-entrada #${pre.kid} (${pre.nome || ''}) — vincular o chat neste lead`,
          complete_till: due }]),
      })
      out.push({ pre: pre.kid, match: m.kid, alerta: tr.status })
      await new Promise((res) => setTimeout(res, 200))
    }
    return json({ ok: true, verificados: (pres ?? []).length, resultados: out })
  }

  if (!Array.isArray(b.tasks) || b.tasks.length === 0) return json({ error: 'tasks vazio' }, 400)
  const results: any[] = []
  // PATCH individual para tarefas existentes (remarcação)
  const patches = b.tasks.filter((t: any) => t.task_id)
  for (const t of patches) {
    const body: any = t.is_completed === true
      ? { is_completed: true, result: { text: t.result_text || 'Fechada automaticamente (SalesHub)' } }
      : { complete_till: t.complete_till, is_completed: false,
          ...(t.text ? { text: t.text } : {}), ...(t.responsible_user_id ? { responsible_user_id: t.responsible_user_id } : {}) }
    const r = await fetch(`${KOMMO_BASE}/api/v4/tasks/${t.task_id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) })
    results.push({ task_id: t.task_id, status: r.status, remarcada: r.ok })
    await new Promise((res) => setTimeout(res, 120))
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
