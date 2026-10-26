// central-cases — Central de Cases da aba "Preparar reunião".
//
// Ações (POST JSON):
//   {acao:'gerar', reuniao_id}                       ← gatilho AFTER INSERT em reunioes (pg_net), segredo no header
//   {acao:'gerar', lead_id, profundidade:'profunda'} ← closer, na aba (Bearer = JWT do usuário logado)
//   {acao:'varrer'}                                  ← cron a cada 10 min: retoma pendentes/travados
// Auth: header x-central-cases-secret == integracao_config.central_cases_secret, OU Bearer de um
// usuário autenticado que seja team_member. Responde 202 e processa em segundo plano (waitUntil).
// Deploy: --no-verify-jwt (a edge valida o JWT sozinha quando vem Bearer de usuário).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { gerarCases, type Candidato } from './motor.ts'
import { depsReais, sessaoMotor } from './cliente.ts'

const MOTOR_URL = (Deno.env.get('ENRIQ_MOTOR_URL') || 'https://saleshub-ruston-production.up.railway.app').replace(/\/$/, '')
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-central-cases-secret' } })
const admin = () => createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } })

type Sugestao = { id: string; reuniao_id: string | null; lead_id: string | null; empresa: string; nicho: string | null; profundidade: 'leve' | 'profunda'; status: string; tentativas: number }

async function autenticar(req: Request, sb: any): Promise<{ ok: true; via: 'segredo' | 'usuario'; member_id: string | null } | { ok: false }> {
  const seg = req.headers.get('x-central-cases-secret')
  if (seg) {
    const { data } = await sb.from('integracao_config').select('value').eq('key', 'central_cases_secret').maybeSingle()
    return data?.value && seg === data.value ? { ok: true, via: 'segredo', member_id: null } : { ok: false }
  }
  const auth = req.headers.get('authorization') ?? ''
  const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  if (!jwt) return { ok: false }
  const { data: u, error } = await sb.auth.getUser(jwt)
  if (error || !u?.user) return { ok: false }
  const { data: tm } = await sb.from('team_members').select('id').eq('auth_user_id', u.user.id).maybeSingle()
  return tm?.id ? { ok: true, via: 'usuario', member_id: tm.id } : { ok: false }
}

/** contexto do lead/reunião: empresa, nicho (briefing.inputs.segmento > lead.segmento_disparos > lead.produto), UF/cidade (custom_fields do Kommo, se houver) */
async function contexto(sb: any, s: Sugestao) {
  let empresa = s.empresa, nicho: string | null = null, uf: string | null = null, cidade: string | null = null
  if (s.lead_id) {
    const { data: l } = await sb.from('leads').select('empresa, segmento_disparos, produto, custom_fields').eq('id', s.lead_id).maybeSingle()
    if (l) {
      empresa = empresa || l.empresa
      nicho = l.segmento_disparos || null
      const cf = l.custom_fields ?? {}
      const pega = (re: RegExp) => { for (const [k, v] of Object.entries(cf)) if (re.test(k) && typeof v === 'string' && v.trim()) return v.trim(); return null }
      uf = (pega(/^(uf|estado)$/i) ?? '').toUpperCase().slice(0, 2) || null
      cidade = pega(/cidade|munic/i)
      if (!nicho) nicho = pega(/nicho|segmento|ramo|setor/i)
    }
    const { data: b } = await sb.from('prep_briefings').select('inputs').eq('lead_id', s.lead_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (b?.inputs?.segmento) nicho = String(b.inputs.segmento)
  }
  return { empresa, nicho, uf, cidade }
}

async function processar(sb: any, s: Sugestao) {
  const marcar = async (patch: Record<string, unknown>) => { await sb.from('cases_sugestoes').update({ ...patch, atualizado_em: new Date().toISOString() }).eq('id', s.id) }
  // posse: só processa se ainda pendente (ou processando travado > 5 min — a varredura decide)
  const { data: posse } = await sb.from('cases_sugestoes').update({ status: 'processando', tentativas: s.tentativas + 1, atualizado_em: new Date().toISOString() }).eq('id', s.id).in('status', ['pendente', 'processando']).select('id').maybeSingle()
  if (!posse) return { id: s.id, pulado: 'sem posse' }
  try {
    const ctx = await contexto(sb, s)
    if (!ctx.empresa) { await marcar({ status: 'erro', erro: 'sem nome de empresa' }); return { id: s.id, erro: 'sem empresa' } }
    let tok: string | null = null
    const token = async () => (tok ??= await sessaoMotor(sb))
    const deps = depsReais(sb, MOTOR_URL, token)
    const finais = await gerarCases(deps, { empresa: ctx.empresa, nicho: ctx.nicho, cidade: ctx.cidade, uf: ctx.uf, profundidade: s.profundidade },
      async (etapa, cands: Candidato[]) => { await marcar({ etapa, candidatos: cands, nicho: [ctx.nicho, ctx.empresa].filter(Boolean).join(' · ') }) })
    await marcar({ status: 'concluido', etapa: 'pronto', candidatos: finais, erro: null, concluido_em: new Date().toISOString() })
    return { id: s.id, cases: finais.length }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500)
    await marcar({ status: s.tentativas + 1 >= 3 ? 'erro' : 'pendente', erro: msg })
    return { id: s.id, erro: msg }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true })
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405)
  const sb = admin()
  const auth = await autenticar(req, sb)
  if (!auth.ok) return json({ error: 'não autorizado' }, 401)
  const body = await req.json().catch(() => ({}))
  const acao = String(body.acao ?? 'gerar')
  const bg = (p: Promise<unknown>) => { try { (globalThis as any).EdgeRuntime?.waitUntil?.(p) ?? p } catch { /* fora do edge runtime */ } }

  if (acao === 'varrer') {
    if (auth.via !== 'segredo') return json({ error: 'varrer só pelo cron' }, 403)
    const corte = new Date(Date.now() - 5 * 60_000).toISOString()
    const { data } = await sb.from('cases_sugestoes').select('id, reuniao_id, lead_id, empresa, nicho, profundidade, status, tentativas').in('status', ['pendente', 'processando']).lt('atualizado_em', corte).lt('tentativas', 3).order('criado_em').limit(5)
    const lista = (data ?? []) as Sugestao[]
    bg((async () => { for (const s of lista) { if (s.status === 'processando') await sb.from('cases_sugestoes').update({ status: 'pendente' }).eq('id', s.id); await processar(sb, { ...s, status: 'pendente' }) } })())
    return json({ ok: true, retomadas: lista.length }, 202)
  }
  if (acao !== 'gerar') return json({ error: 'acao deve ser gerar|varrer' }, 400)

  let s: Sugestao | null = null
  if (body.reuniao_id) {
    // gatilho: a linha já foi criada pelo trigger; se não (chamada manual), cria agora
    const { data: ja } = await sb.from('cases_sugestoes').select('id, reuniao_id, lead_id, empresa, nicho, profundidade, status, tentativas').eq('reuniao_id', body.reuniao_id).order('criado_em', { ascending: false }).limit(1).maybeSingle()
    if (ja && ['pendente', 'processando'].includes(ja.status)) s = ja as Sugestao
    else if (!ja) {
      const { data: r } = await sb.from('reunioes').select('id, lead_id, empresa, sdr_id').eq('id', body.reuniao_id).maybeSingle()
      if (!r) return json({ error: 'reunião não existe' }, 404)
      const { data: nova, error } = await sb.from('cases_sugestoes').insert({ reuniao_id: r.id, lead_id: r.lead_id, empresa: r.empresa ?? '', profundidade: 'leve', pedido_por: auth.member_id ?? r.sdr_id }).select('id, reuniao_id, lead_id, empresa, nicho, profundidade, status, tentativas').single()
      if (error) return json({ error: error.message }, 500)
      s = nova as Sugestao
    } else return json({ ok: true, ja_concluida: ja.id, status: ja.status })
  } else if (body.lead_id) {
    if (auth.via !== 'usuario') return json({ error: 'gerar por lead exige usuário logado' }, 403)
    const { data: l } = await sb.from('leads').select('id, empresa').eq('id', body.lead_id).maybeSingle()
    if (!l) return json({ error: 'lead não existe' }, 404)
    const { data: nova, error } = await sb.from('cases_sugestoes').insert({ lead_id: l.id, empresa: l.empresa ?? '', profundidade: body.profundidade === 'profunda' ? 'profunda' : 'leve', pedido_por: auth.member_id }).select('id, reuniao_id, lead_id, empresa, nicho, profundidade, status, tentativas').single()
    if (error) return json({ error: error.message }, 500)
    s = nova as Sugestao
  } else return json({ error: 'informe reuniao_id ou lead_id' }, 400)

  bg(processar(sb, s!))
  return json({ ok: true, sugestao_id: s!.id, status: 'processando' }, 202)
})
