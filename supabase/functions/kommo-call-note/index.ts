// kommo-call-note — P4: tentativa de ligação (API4COM) NÃO ATENDIDA vira NOTA no lead do
// Kommo (atendida ganha a nota completa pelo n8n), e se existir TAREFA DE LIGAÇÃO ABERTA
// do mesmo agente pro lead, dá BAIXA com o desfecho (atendida ou não).
// NUNCA cria tarefa retroativa (criar retroativo suja o dado de cadência — regra do handoff).
// Idempotente: ligacoes_4com.kommo_note_id — 1 nota por ligação, replays não duplicam.
// Disparo: trigger em ligacoes_4com quando o vínculo (kommo_lead_id) chega, com trava de
// frescor (só ligações recentes — a varredura histórica do P3 não gera spam).
// Auth: mesmo segredo do writeback. Deploy: supabase functions deploy kommo-call-note --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok')
  let b: any
  try { b = await req.json() } catch { return json({ error: 'bad json' }, 400) }
  if (!b?.secret || b.secret !== Deno.env.get('KOMMO_SYNC_SECRET')) return json({ error: 'unauthorized' }, 401)
  // ação de manutenção: reabrir tarefa fechada indevidamente (pg_net não faz PATCH)
  if (b.reopen_task) {
    const r = await fetch(`${KOMMO_BASE}/api/v4/tasks/${b.reopen_task}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_completed: false }),
    })
    return json({ ok: r.ok, status: r.status, task_id: b.reopen_task })
  }
  if (!b.ligacao_id) return json({ error: 'ligacao_id obrigatório' }, 400)

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: lg } = await supabase.from('ligacoes_4com')
    .select('id, call_id, provider, direction, atendida, duration, started_at, ended_at, member_id, kommo_lead_id, kommo_note_id, hangup_cause')
    .eq('id', b.ligacao_id).maybeSingle()
  if (!lg?.kommo_lead_id) return json({ skipped: true, reason: 'sem_vinculo' })
  if (lg.kommo_note_id) return json({ skipped: true, reason: 'nota_ja_postada', note_id: lg.kommo_note_id })
  // API4COM manda evento no INÍCIO da chamada — sem ended_at o desfecho ainda não existe;
  // a nota sai só no hangup (o trigger re-dispara). 3C chega num evento único já final.
  if (lg.provider !== '3c' && !lg.ended_at) return json({ skipped: true, reason: 'ligacao_em_andamento' })

  const { data: agente } = lg.member_id
    ? await supabase.from('team_members').select('name, kommo_user_id').eq('id', lg.member_id).maybeSingle()
    : { data: null }

  const token = Deno.env.get('KOMMO_API_TOKEN')
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const quando = new Date(lg.started_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const dur = lg.duration ? `${Math.floor(lg.duration / 60)}m${String(lg.duration % 60).padStart(2, '0')}s` : '0s'
  const desfecho = lg.atendida ? 'ATENDEU' : (lg.hangup_cause ? `NÃO ATENDEU (${lg.hangup_cause})` : 'NÃO ATENDEU')
  const texto = `📞 Tentativa de ligação — ${desfecho}\n${quando} · ${dur} · ${lg.direction === 'inbound' ? 'receptiva' : 'ativa'} · ${agente?.name ?? 'agente ?'} · via ${lg.provider === '3c' ? '3C' : 'API4COM'} (SalesHub)`

  // nota SÓ quando NÃO ATENDEU (Gabriel, 30/07): ligação atendida já ganha a nota completa
  // pelo fluxo do n8n — a "Tentativa — ATENDEU" daqui era ruído duplicado. E só API4COM
  // (o fluxo 3C do n8n já cuida das notas dele). A baixa de tarefa continua nos dois casos.
  let noteId: number | null = null
  if (lg.provider !== '3c' && !lg.atendida) {
    const r = await fetch(`${KOMMO_BASE}/api/v4/leads/${lg.kommo_lead_id}/notes`, {
      method: 'POST', headers: H,
      body: JSON.stringify([{ note_type: 'common', params: { text: texto } }]),
    })
    if (!r.ok) return json({ error: 'POST nota falhou', status: r.status, detail: (await r.text()).slice(0, 300) }, 502)
    noteId = (await r.json())?._embedded?.notes?.[0]?.id ?? null
    if (noteId) await supabase.from('ligacoes_4com').update({ kommo_note_id: noteId }).eq('id', lg.id)
  }

  // baixa na tarefa de LIGAÇÃO aberta do MESMO agente (se existir; nunca cria retroativa)
  const baixas: number[] = []
  if (agente?.kommo_user_id) {
    const tr = await fetch(`${KOMMO_BASE}/api/v4/tasks?filter[entity_type]=leads&filter[entity_id]=${lg.kommo_lead_id}&filter[is_completed]=0&filter[responsible_user_id]=${agente.kommo_user_id}&limit=50`, { headers: H })
    if (tr.ok) {
      const tasks = (await tr.json())?._embedded?.tasks || []
      for (const t of tasks) {
        const ehLigacao = t.task_type_id === 3732751 || /\bligar\b/i.test(t.text || '')
        if (!ehLigacao) continue
        // só baixa tarefa VENCIDA ou da hora (até +30min) — tocar uma vez não pode
        // fechar os toques FUTUROS da cadência (ex.: R3 de D+3 ficaria órfã)
        if ((t.complete_till ?? 0) * 1000 > Date.now() + 30 * 60 * 1000) continue
        await fetch(`${KOMMO_BASE}/api/v4/tasks/${t.id}`, {
          method: 'PATCH', headers: H,
          body: JSON.stringify({ is_completed: true, result: { text: `Ligação feita — ${desfecho} (${dur})` } }),
        })
        baixas.push(t.id)
      }
    }
  }

  return json({ ok: true, note_id: noteId, tarefas_baixadas: baixas, kommo_id: lg.kommo_lead_id })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
