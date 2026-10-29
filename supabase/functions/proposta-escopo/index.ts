// =============================================================
// Edge proposta-escopo — transcrição → escopo (sem gerar Slides)
// =============================================================
// Para testar a análise isolada (ex.: transcrições antigas anonimizadas).
// Acesso: gestor (JWT do SalesHub) ou interno (service_role).
// Body: { transcricao, empresa, modelo_venda? } → { escopo, provedor }
// Deploy: supabase functions deploy proposta-escopo --no-verify-jwt
// =============================================================
import { createClient } from 'npm:@supabase/supabase-js@2'
import { redigir } from '../_shared/propostas/redigir.mjs'
import { ehChaveDeServico as verificarServico } from '../_shared/propostas/servico.mjs'
import { analisarTranscricao, MIN_TRANSCRICAO_CHARS } from '../_shared/propostas/pipeline.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const ehChaveDeServico = (b: string) =>
  verificarServico(b, { url: Deno.env.get('SUPABASE_URL') ?? '', chaveEnv: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405)

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return json({ error: 'sem sessão' }, 401)
  if (!(await ehChaveDeServico(jwt))) {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY)
    const { data: u } = await sb.auth.getUser(jwt)
    const { data: tm } = u?.user
      ? await sb.from('team_members').select('role').eq('auth_user_id', u.user.id).maybeSingle()
      : { data: null }
    if (tm?.role !== 'gestor') return json({ error: 'só gestor' }, 403)
  }

  try {
    const { transcricao, empresa, modelo_venda = null } = await req.json()
    if (typeof transcricao !== 'string' || transcricao.trim().length < MIN_TRANSCRICAO_CHARS) {
      return json({ error: `transcrição curta demais (mínimo ${MIN_TRANSCRICAO_CHARS} caracteres)` }, 400)
    }
    if (typeof empresa !== 'string' || !empresa.trim()) return json({ error: 'empresa obrigatória' }, 400)
    const r = await analisarTranscricao(transcricao, empresa.trim(), modelo_venda)
    return json({ ok: true, ...r })
  } catch (e) {
    console.error('proposta-escopo:', redigir((e as Error).message))
    return json({ error: redigir((e as Error).message) }, 500)
  }
})
