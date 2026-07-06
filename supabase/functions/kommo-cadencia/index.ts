// kommo-cadencia — RECONCILER da cadência de valor anti-no-show (Path B, SEM delete).
// Chamado pelo trigger de public.reunioes (INSERT marcada / UPDATE data_reuniao / UPDATE realizada|show).
// Fluxo: chama o cérebro public.cadencia_plan(reuniao_id) -> executa as ações no Kommo
// (POST /tasks cria; PATCH /tasks move complete_till OU conclui is_completed) -> grava o mapa slot->id.
// NUNCA deleta tarefa (Kommo recusa: 403 Invalid scope). Só toca kommo/tasks -> sem loop com o write-back.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  try {
    const { reuniao_id } = await req.json()
    if (!reuniao_id) return json({ error: 'reuniao_id obrigatório' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const { data: cfg } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
    const token = cfg?.value
    if (!token) return json({ error: 'Kommo sem access_token' }, 400)
    const KH = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

    // cérebro (read-only): retorna mode/current_map/actions
    const { data: plan, error: perr } = await supabase.rpc('cadencia_plan', { p: reuniao_id })
    if (perr) return json({ error: 'plan falhou', detail: perr.message }, 500)
    if (!plan || plan.mode === 'skip' || plan.erro) return json({ skipped: true, plan })

    const actions: any[] = plan.actions || []
    const newMap: Record<string, number> = {}
    const posts = actions.filter(a => a.op === 'post')

    // patch_move + complete (reuso das mesmas ids)
    for (const a of actions) {
      if (a.op === 'patch_move') {
        await fetch(`${KOMMO_BASE}/api/v4/tasks/${a.task_id}`, { method: 'PATCH', headers: KH, body: JSON.stringify({ complete_till: a.complete_till }) })
        newMap[a.slot] = Number(a.task_id)
      } else if (a.op === 'complete') {
        await fetch(`${KOMMO_BASE}/api/v4/tasks/${a.task_id}`, { method: 'PATCH', headers: KH, body: JSON.stringify({ is_completed: true, result: { text: 'reunião resolvida' } }) })
      }
    }
    // posts em lote (preserva ordem -> mapeia ids de volta pros slots)
    if (posts.length) {
      const payload = posts.map(a => ({ task_type_id: a.task_type_id, text: a.text, complete_till: a.complete_till, responsible_user_id: a.responsible_user_id, entity_type: 'leads', entity_id: a.entity_id }))
      const r = await fetch(`${KOMMO_BASE}/api/v4/tasks`, { method: 'POST', headers: KH, body: JSON.stringify(payload) })
      if (!r.ok) return json({ error: 'POST /tasks falhou', status: r.status, detail: (await r.text()).slice(0, 300) }, 502)
      const tasks = (await r.json())?._embedded?.tasks || []
      posts.forEach((a, i) => { if (tasks[i]) newMap[a.slot] = tasks[i].id })
    }

    // grava o mapa (só slots ABERTOS). NÃO re-dispara o trigger (que só ouve data_reuniao/realizada/show).
    await supabase.from('reunioes').update({ cadencia_task_ids: newMap, cadencia_ancora_dt: new Date(plan.ancora_epoch * 1000).toISOString() }).eq('id', reuniao_id)

    return json({ ok: true, mode: plan.mode, open_target: plan.open_target, new_map: newMap })
  } catch (e: any) {
    return json({ error: e.message }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
