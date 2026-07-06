// kommo-cadencia-closer — CADÊNCIA DO CLOSER dirigida pelo SalesHub (Path B, SEM delete).
// Espelha kommo-cadencia (anti-no-show). Chamado pelo trigger de public.deals (UPDATE OF kommo_status_id),
// SÓ quando integracao_config.cadencia_closer_ativa='true' (o gate mora no trigger; aqui é defesa em profundidade).
// Fluxo: cérebro public.cadencia_closer_plan(deal_id) -> executa ações no Kommo:
//   POST /tasks (cria) · PATCH complete_till+text (move/atualiza) · PATCH is_completed (conclui)
// -> grava deals.cadencia_closer_task_ids (slot->id), _balde, _ancora. NUNCA deleta (Kommo 403).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  try {
    const { deal_id } = await req.json()
    if (!deal_id) return json({ error: 'deal_id obrigatório' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

    // GATE (defesa em profundidade): só age se a flag estiver ON.
    const { data: flag } = await supabase.from('integracao_config').select('value').eq('key', 'cadencia_closer_ativa').single()
    if ((flag?.value ?? 'false') !== 'true') return json({ skipped: true, reason: 'flag_off' })

    const { data: cfg } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_access_token').single()
    const token = cfg?.value
    if (!token) return json({ error: 'Kommo sem access_token' }, 400)
    const KH = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

    // cérebro (read-only): retorna mode/current_map/actions
    const { data: plan, error: perr } = await supabase.rpc('cadencia_closer_plan', { p: deal_id })
    if (perr) return json({ error: 'plan falhou', detail: perr.message }, 500)
    if (!plan || plan.mode === 'skip' || plan.erro) return json({ skipped: true, plan })

    const actions: any[] = plan.actions || []
    // parte do mapa atual e vai ajustando: complete remove, patch_move/post gravam.
    const newMap: Record<string, number> = { ...(plan.current_map || {}) }
    const posts = actions.filter(a => a.op === 'post')

    // patch_move (move complete_till + atualiza text) + complete (conclui, remove do mapa)
    for (const a of actions) {
      if (a.op === 'patch_move') {
        await fetch(`${KOMMO_BASE}/api/v4/tasks/${a.task_id}`, {
          method: 'PATCH', headers: KH,
          body: JSON.stringify({ complete_till: a.complete_till, text: a.text }),
        })
        newMap[a.slot] = Number(a.task_id)
      } else if (a.op === 'complete') {
        await fetch(`${KOMMO_BASE}/api/v4/tasks/${a.task_id}`, {
          method: 'PATCH', headers: KH,
          body: JSON.stringify({ is_completed: true, result: { text: 'cadência closer resolvida' } }),
        })
        delete newMap[a.slot]
      }
    }

    // posts em lote (preserva ordem -> mapeia ids de volta pros slots)
    if (posts.length) {
      const payload = posts.map(a => ({ task_type_id: a.task_type_id ?? 1, text: a.text, complete_till: a.complete_till, responsible_user_id: a.responsible_user_id, entity_type: 'leads', entity_id: a.entity_id }))
      const r = await fetch(`${KOMMO_BASE}/api/v4/tasks`, { method: 'POST', headers: KH, body: JSON.stringify(payload) })
      if (!r.ok) return json({ error: 'POST /tasks falhou', status: r.status, detail: (await r.text()).slice(0, 300) }, 502)
      const tasks = (await r.json())?._embedded?.tasks || []
      posts.forEach((a, i) => { if (tasks[i]) newMap[a.slot] = tasks[i].id })
    }

    // grava tracking no deal. AFTER UPDATE OF kommo_status_id não re-dispara (só escrevemos colunas de cadência).
    const patch: Record<string, unknown> = { cadencia_closer_task_ids: newMap }
    if (plan.mode === 'cleanup') {
      patch.cadencia_closer_balde = null
      patch.cadencia_closer_ancora = null
    } else {
      patch.cadencia_closer_balde = plan.balde
      if (plan.anchor_epoch) patch.cadencia_closer_ancora = new Date(plan.anchor_epoch * 1000).toISOString()
    }
    await supabase.from('deals').update(patch).eq('id', deal_id)

    return json({ ok: true, mode: plan.mode, balde: plan.balde, prev_balde: plan.prev_balde, has_plan: plan.has_plan, open_target: plan.open_target, new_map: newMap })
  } catch (e: any) {
    return json({ error: e.message }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
