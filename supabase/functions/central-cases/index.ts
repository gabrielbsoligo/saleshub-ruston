// central-cases — Central de Cases da aba "Preparar reunião".
//
// Ações (POST JSON):
//   {acao:'gerar', reuniao_id}                       ← gatilho AFTER INSERT em reunioes (pg_net), segredo no header
//   {acao:'gerar', lead_id, profundidade:'profunda'} ← closer, na aba (Bearer = JWT do usuário logado, membro ATIVO)
//   {acao:'varrer'}                                  ← cron a cada 10 min: retoma pendentes e leases vencidos
// Auth: header x-central-cases-secret == integracao_config.central_cases_secret, OU Bearer de um
// usuário autenticado que seja team_member ativo. Responde 202 e processa em segundo plano (waitUntil).
// Posse: cases_claim (lease + token, tentativas no banco); toda escrita do trabalho é condicionada ao
// token (cases_renovar / UPDATE … WHERE claim_token). Gravações críticas conferem erro E linha afetada.
// Deploy: --no-verify-jwt (a edge valida o JWT sozinha quando vem Bearer de usuário).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { gerarCases, type Candidato } from './motor.ts'
import { depsReais, sessaoMotor } from './cliente.ts'

const MOTOR_URL = (Deno.env.get('ENRIQ_MOTOR_URL') || 'https://saleshub-ruston-production.up.railway.app').replace(/\/$/, '')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const LEASE_S = 300, MAX_TENTATIVAS = 3
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-central-cases-secret, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })
const admin = () => createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })

type Sugestao = { id: string; reuniao_id: string | null; lead_id: string | null; empresa: string; nicho: string | null; profundidade: 'leve' | 'profunda'; status: string; tentativas: number }
const COLS = 'id, reuniao_id, lead_id, empresa, nicho, profundidade, status, tentativas'
class GravacaoFalhou extends Error {}

async function autenticar(req: Request, sb: any): Promise<{ ok: true; via: 'segredo' | 'usuario'; member_id: string | null } | { ok: false; motivo: string }> {
  const seg = req.headers.get('x-central-cases-secret')
  if (seg) {
    const { data, error } = await sb.from('integracao_config').select('value').eq('key', 'central_cases_secret').maybeSingle()
    if (error) return { ok: false, motivo: `config: ${error.message}` }
    return data?.value && seg === data.value ? { ok: true, via: 'segredo', member_id: null } : { ok: false, motivo: 'segredo inválido' }
  }
  const auth = req.headers.get('authorization') ?? ''
  const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  if (!jwt) return { ok: false, motivo: 'sem credencial' }
  const { data: u, error } = await sb.auth.getUser(jwt)
  if (error || !u?.user) return { ok: false, motivo: 'JWT inválido' }
  const { data: tm, error: e2 } = await sb.from('team_members').select('id, active').eq('auth_user_id', u.user.id).maybeSingle()
  if (e2) return { ok: false, motivo: `team_members: ${e2.message}` }
  return tm?.id && tm.active !== false ? { ok: true, via: 'usuario', member_id: tm.id } : { ok: false, motivo: 'não é membro ativo' }
}

/** contexto do lead: RPC cases_contexto_lead (public.leads + custom_fields da réplica Kommo); nicho = briefing.inputs.segmento > leads.segmento_disparos > "Segmento do lead" (réplica) > produto. Falha de leitura LANÇA. */
async function contexto(sb: any, s: Sugestao) {
  let empresa = s.empresa, nicho: string | null = null, uf: string | null = null, cidade: string | null = null
  const pessoas: string[] = []   // nome do contato do lead: não vira termo de busca
  if (s.lead_id) {
    const { data, error } = await sb.rpc('cases_contexto_lead', { p_lead_id: s.lead_id })
    if (error) throw new Error(`cases_contexto_lead: ${error.message}`)
    const l = Array.isArray(data) ? data[0] : data
    if (l) {
      empresa = empresa || l.empresa || ''
      nicho = l.segmento || l.nicho || l.produto || null   // contrato: briefing > leads.segmento_disparos > custom field da réplica > produto
      uf = l.uf && /^[A-Z]{2}$/.test(l.uf) ? l.uf : null
      cidade = l.cidade || null
    }
    const { data: lc, error: elc } = await sb.from('leads').select('nome_contato').eq('id', s.lead_id).maybeSingle()
    if (elc) throw new Error(`leads: ${elc.message}`)
    if (lc?.nome_contato) pessoas.push(String(lc.nome_contato))
    const { data: b, error: e2 } = await sb.from('prep_briefings').select('inputs').eq('lead_id', s.lead_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (e2) throw new Error(`prep_briefings: ${e2.message}`)
    if (b?.inputs?.segmento) nicho = String(b.inputs.segmento)
  }
  return { empresa, nicho, uf, cidade, pessoas }
}

/** escrita sob posse: confere erro E linha afetada (token ainda dono) — senão GravacaoFalhou */
async function gravarSobPosse(sb: any, id: string, token: string, patch: Record<string, unknown>) {
  const r = await sb.from('cases_sugestoes').update({ ...patch, atualizado_em: new Date().toISOString() }).eq('id', id).eq('claim_token', token).select('id')
  if (r.error) throw new GravacaoFalhou(`cases_sugestoes: ${r.error.message}`)
  if (!r.data?.length) throw new GravacaoFalhou('posse perdida (outro worker assumiu ou lease vencido)')
}

async function processar(sb: any, s: Sugestao) {
  const { data: posse, error: ec } = await sb.rpc('cases_claim', { p_id: s.id, p_lease_s: LEASE_S, p_max: MAX_TENTATIVAS })
  if (ec) { console.error('central-cases claim', ec.message); return { id: s.id, erro: `claim: ${ec.message}` } }
  const p = Array.isArray(posse) ? posse[0] : posse
  if (!p?.token) return { id: s.id, pulado: 'sem posse (em andamento, concluída ou tentativas esgotadas)' }
  const token: string = p.token, tentativa: number = Number(p.tentativa)
  try {
    const ctx = await contexto(sb, s)
    if (!ctx.empresa) { await gravarSobPosse(sb, s.id, token, { status: 'erro', erro: 'sem nome de empresa', claim_token: null, lease_ate: null }); return { id: s.id, erro: 'sem empresa' } }
    let tok: string | null = null
    const tokenMotor = async () => (tok ??= await sessaoMotor(SUPABASE_URL, ANON_KEY))
    const deps = depsReais(sb, MOTOR_URL, tokenMotor)
    const finais = await gerarCases(deps, { empresa: ctx.empresa, nicho: ctx.nicho, cidade: ctx.cidade, uf: ctx.uf, pessoas: ctx.pessoas, profundidade: s.profundidade },
      async (etapa, cands: Candidato[]) => {
        // progresso + renovação do lease a cada etapa; perder a posse aborta (GravacaoFalhou)
        await gravarSobPosse(sb, s.id, token, { etapa, candidatos: cands, nicho: [ctx.nicho, ctx.empresa].filter(Boolean).join(' · ') })
        const { data: ok, error } = await sb.rpc('cases_renovar', { p_id: s.id, p_token: token, p_lease_s: LEASE_S })
        if (error || ok !== true) throw new GravacaoFalhou(`renovar: ${error?.message ?? 'posse perdida'}`)
      })
    await gravarSobPosse(sb, s.id, token, { status: 'concluido', etapa: 'pronto', candidatos: finais, erro: null, concluido_em: new Date().toISOString(), claim_token: null, lease_ate: null })
    return { id: s.id, cases: finais.length, tentativa }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500)
    if (e instanceof GravacaoFalhou && /posse perdida/.test(msg)) return { id: s.id, erro: msg }   // outro worker é o dono: não mexe
    // falha de processamento sob posse: libera para nova tentativa (ou encerra na última)
    const r = await sb.from('cases_sugestoes').update({ status: tentativa >= MAX_TENTATIVAS ? 'erro' : 'pendente', erro: msg, claim_token: null, lease_ate: null, atualizado_em: new Date().toISOString() }).eq('id', s.id).eq('claim_token', token).select('id')
    if (r.error || !r.data?.length) console.error('central-cases: não registrou a falha', r.error?.message ?? 'posse perdida', msg)
    return { id: s.id, erro: msg, tentativa }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405)
  const sb = admin()
  const auth = await autenticar(req, sb)
  if (!auth.ok) return json({ error: 'não autorizado', motivo: auth.motivo }, 401)
  const body = await req.json().catch(() => ({}))
  const acao = String(body.acao ?? 'gerar')
  const bg = (p: Promise<unknown>) => { const rt = (globalThis as any).EdgeRuntime; if (rt?.waitUntil) rt.waitUntil(p); else p.catch((e) => console.error(e)) }

  if (acao === 'varrer') {
    if (auth.via !== 'segredo') return json({ error: 'varrer só pelo cron' }, 403)
    const agora = new Date().toISOString()
    // pendentes, ou processando com lease vencido (a posse é decidida no claim; não se reseta nada aqui)
    const { data, error } = await sb.from('cases_sugestoes').select(COLS + ', lease_ate').in('status', ['pendente', 'processando']).or(`status.eq.pendente,lease_ate.is.null,lease_ate.lt.${agora}`).order('criado_em').limit(5)
    if (error) return json({ error: error.message }, 500)
    const lista = (data ?? []) as unknown as Sugestao[]
    bg((async () => { for (const s of lista) await processar(sb, s) })())
    return json({ ok: true, candidatas: lista.length }, 202)
  }
  if (acao !== 'gerar') return json({ error: 'acao deve ser gerar|varrer' }, 400)

  let s: Sugestao | null = null
  if (body.reuniao_id) {
    const { data: ja, error } = await sb.from('cases_sugestoes').select(COLS).eq('reuniao_id', body.reuniao_id).order('criado_em', { ascending: false }).limit(1).maybeSingle()
    if (error) return json({ error: error.message }, 500)
    if (ja && ['pendente', 'processando'].includes(ja.status)) s = ja as Sugestao
    else if (!ja) {
      const { data: r, error: er } = await sb.from('reunioes').select('id, lead_id, empresa, sdr_id').eq('id', body.reuniao_id).maybeSingle()
      if (er) return json({ error: er.message }, 500)
      if (!r) return json({ error: 'reunião não existe' }, 404)
      const { data: nova, error: ei } = await sb.from('cases_sugestoes').insert({ reuniao_id: r.id, lead_id: r.lead_id, empresa: r.empresa ?? '', profundidade: 'profunda', pedido_por: auth.member_id ?? r.sdr_id }).select(COLS).single()
      if (ei || !nova) return json({ error: ei?.message ?? 'não gravou' }, 500)
      s = nova as Sugestao
    } else return json({ ok: true, ja_concluida: ja.id, status: ja.status })
  } else if (body.lead_id) {
    if (auth.via !== 'usuario') return json({ error: 'gerar por lead exige usuário logado' }, 403)
    const { data: l, error: el } = await sb.from('leads').select('id, empresa').eq('id', body.lead_id).maybeSingle()
    if (el) return json({ error: el.message }, 500)
    if (!l) return json({ error: 'lead não existe' }, 404)
    const { data: nova, error: ei } = await sb.from('cases_sugestoes').insert({ lead_id: l.id, empresa: l.empresa ?? '', profundidade: 'profunda', pedido_por: auth.member_id }).select(COLS).single()
    if (ei || !nova) return json({ error: ei?.message ?? 'não gravou' }, 500)
    s = nova as Sugestao
  } else return json({ error: 'informe reuniao_id ou lead_id' }, 400)

  bg(processar(sb, s!))
  return json({ ok: true, sugestao_id: s!.id, status: 'processando' }, 202)
})
