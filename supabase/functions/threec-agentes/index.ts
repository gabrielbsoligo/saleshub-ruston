// =============================================================
// Edge Function: threec-agentes — lista os AGENTES do 3C Plus para o seletor da tela de Equipe
// (MemberDrawer → "Agente no 3C Plus"), para ninguém digitar o ID do agente na mão.
// Só leitura no 3C (THREEC_API_TOKEN, como parâmetro api_token — o 3C recusa Bearer).
// Só gestor: JWT do SalesHub (verify_jwt) + team_members.role = 'gestor'.
// O token do 3C cai a cada login do admin no portal: com 401 a resposta diz isso e a tela
// cai na digitação manual (com a lista dos agentes já vistos nas tabulações sem cadastro).
// =============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const API3C = 'https://app.3c.plus/api/v1'
const ROTAS = ['/agents', '/company/agents'] // a 1ª que responder 200

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

export function normalizarAgentes(body: any): Array<{ id: string; nome: string; ramal: string | null }> {
  const lista = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
  return lista
    .map((a: any) => ({
      id: a?.id != null ? String(a.id) : '',
      nome: String(a?.name ?? a?.nome ?? '').trim(),
      ramal: a?.extension?.extension_number != null ? String(a.extension.extension_number)
        : a?.extension_number != null ? String(a.extension_number)
        : typeof a?.extension === 'string' || typeof a?.extension === 'number' ? String(a.extension) : null,
    }))
    .filter((a: { id: string }) => /^\d+$/.test(a.id))
    .sort((a: { nome: string }, b: { nome: string }) => a.nome.localeCompare(b.nome))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors })
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: u } = await sb.auth.getUser(jwt)
  if (!u?.user) return json({ error: 'não autenticado' }, 401)
  const { data: tm } = await sb.from('team_members').select('role').eq('auth_user_id', u.user.id).maybeSingle()
  if (tm?.role !== 'gestor') return json({ error: 'só gestor' }, 403)

  const t = Deno.env.get('THREEC_API_TOKEN')
  if (!t) return json({ ok: false, erro: 'THREEC_API_TOKEN ausente' }, 200)
  const tentativas: Array<{ rota: string; status: number }> = []
  for (const rota of ROTAS) {
    const agentes: Array<{ id: string; nome: string; ramal: string | null }> = []
    let status = 0
    let incompleta: string | null = null
    const MAX_PAGINAS = 10
    for (let page = 1; page <= MAX_PAGINAS; page++) {
      const r = await fetch(`${API3C}${rota}?per_page=200&page=${page}&api_token=${encodeURIComponent(t)}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
      if (page === 1) status = r?.status ?? 0
      if (!r?.ok) {
        // falha numa página seguinte: devolve o que veio, mas marcado como INCOMPLETO
        if (page > 1) incompleta = `página ${page} do 3C falhou (HTTP ${r?.status ?? 'rede'})`
        break
      }
      const body = await r.json().catch(() => null)
      const lote = normalizarAgentes(body)
      agentes.push(...lote)
      const ultima = Number(body?.meta?.pagination?.total_pages ?? body?.meta?.last_page ?? body?.last_page ?? 1)
      if (!lote.length || page >= ultima) break
      if (page === MAX_PAGINAS) incompleta = `mais de ${MAX_PAGINAS} páginas no 3C`
    }
    tentativas.push({ rota, status })
    if (status === 200) return json({ ok: true, rota, agentes, incompleta: !!incompleta, erro: incompleta })
    if (status === 401) return json({ ok: false, erro: 'token do 3C expirado (alguém logou no portal com o admin) — atualize THREEC_API_TOKEN', tentativas })
  }
  return json({ ok: false, erro: '3C não respondeu à listagem de agentes', tentativas })
})
