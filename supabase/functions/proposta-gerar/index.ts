// =============================================================
// Edge proposta-gerar — Gerador de Propostas para Closers (teste)
// =============================================================
// Ações:
//   gerar               (closer do deal ou gestor; JWT do SalesHub)
//                       { deal_id, reuniao_id?, transcricao_texto? } → cria a
//                       proposta 'manual' e processa na hora.
//   reprocessar         (closer do deal ou gestor) { proposta_id } → nova tentativa
//                       de uma proposta em 'erro'.
//   preparar_template   (só gestor) { template_id } → troca os preços literais
//                       da CÓPIA do deck por {{placeholders}} com o Google do gestor.
//   processar_pendentes (interno: service_role; chamado pela google-drive no tick
//                       do cron que já existe) → processa 1 proposta 'auto'.
// Nunca envia nada ao cliente: o envio é clique manual do closer na UI.
// Deploy: supabase functions deploy proposta-gerar --no-verify-jwt
// =============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'
import { destravar, prepararTemplateComMembro, processarProposta } from '../_shared/propostas/pipeline.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function membroDoJwt(sb: any, jwt: string) {
  const { data: u } = await sb.auth.getUser(jwt)
  if (!u?.user) return null
  const { data: tm } = await sb.from('team_members').select('id, role, active').eq('auth_user_id', u.user.id).maybeSingle()
  return tm?.active === false ? null : tm
}

async function podeNoDeal(sb: any, membro: any, dealId: string) {
  if (membro.role === 'gestor') return true
  const { data: d } = await sb.from('deals').select('closer_id').eq('id', dealId).maybeSingle()
  return !!d && d.closer_id === membro.id
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405)

  const sb = createClient(SUPABASE_URL, SERVICE_KEY)
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  let body: any = {}
  try { body = await req.json() } catch { /* corpo vazio */ }
  const { action } = body

  try {
    if (action === 'processar_pendentes') {
      if (!jwt || jwt !== SERVICE_KEY) return json({ error: 'interno' }, 401)
      await destravar(sb)
      const { data: cfg } = await sb.from('propostas_config').select('auto_ativo').eq('id', true).single()
      if (!cfg?.auto_ativo) return json({ ok: true, auto_ativo: false, processadas: 0 })
      const { data: fila } = await sb.from('propostas').select('id')
        .eq('status', 'pendente').eq('origem', 'auto').order('created_at').limit(1)
      const resultados = []
      for (const p of fila || []) resultados.push(await processarProposta(sb, p.id))
      return json({ ok: true, processadas: resultados.length, resultados })
    }

    if (!jwt) return json({ error: 'sem sessão' }, 401)
    const membro = await membroDoJwt(sb, jwt)
    if (!membro) return json({ error: 'usuário sem cadastro ativo no SalesHub' }, 403)

    if (action === 'gerar') {
      const { deal_id, reuniao_id = null, transcricao_texto = null } = body
      if (!deal_id) return json({ error: 'deal_id obrigatório' }, 400)
      if (!(await podeNoDeal(sb, membro, deal_id))) return json({ error: 'só o closer do deal ou gestor' }, 403)
      const { data: em, error: eAtiva } = await sb.from('propostas').select('id')
        .eq('deal_id', deal_id).in('status', ['pendente', 'analisando', 'gerando']).limit(1)
      if (eAtiva) throw eAtiva
      if (em?.length) return json({ error: 'já há uma proposta sendo gerada para este deal' }, 409)
      const { data: nova, error } = await sb.from('propostas').insert({
        deal_id, reuniao_id, origem: 'manual', status: 'pendente', solicitado_por: membro.id,
        transcricao_manual: typeof transcricao_texto === 'string' && transcricao_texto.trim() ? transcricao_texto : null,
      }).select('id').single()
      if (error) throw error
      return json({ ok: true, ...(await processarProposta(sb, nova.id)) })
    }

    if (action === 'reprocessar') {
      const { proposta_id } = body
      const { data: p } = await sb.from('propostas').select('id, deal_id, status').eq('id', proposta_id).maybeSingle()
      if (!p) return json({ error: 'proposta não encontrada' }, 404)
      if (!(await podeNoDeal(sb, membro, p.deal_id))) return json({ error: 'só o closer do deal ou gestor' }, 403)
      if (p.status !== 'erro') return json({ error: `só proposta em erro pode ser reprocessada (está ${p.status})` }, 409)
      await sb.from('propostas').update({ status: 'pendente' }).eq('id', p.id).eq('status', 'erro')
      return json({ ok: true, ...(await processarProposta(sb, p.id)) })
    }

    if (action === 'preparar_template') {
      if (membro.role !== 'gestor') return json({ error: 'só gestor' }, 403)
      const { template_id } = body
      if (!template_id) return json({ error: 'template_id obrigatório' }, 400)
      const r = await prepararTemplateComMembro(sb, membro.id, template_id)
      return json({ ok: true, ...r })
    }

    return json({ error: 'ação desconhecida' }, 400)
  } catch (e) {
    console.error('proposta-gerar:', (e as Error).message)
    return json({ error: (e as Error).message }, 500)
  }
})
