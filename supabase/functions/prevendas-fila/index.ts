// prevendas-fila — fila classificada do SDR para o widget ruston-prevendas.
// POST (sem corpo) com header X-Auth-Token (JWT descartável do Kommo via self.$authorizedAjax).
// Resposta: { ok, tarefas: [...classificadas], parcial, frescor: {atraso_s, status} }
//
// Desenho (rev. após revisão do Vedor): o servidor NÃO recebe ids do navegador nem chama a API do Kommo.
// Lê da RÉPLICA (kommo.tasks/leads/stages, sincronizada a cada ~1–2 min) as tarefas ABERTAS do PRÓPRIO
// usuário autenticado (função SQL public.prevendas_fila, migration_160), e classifica com o módulo puro.
//  - autorização: só o que é do usuário do JWT sai; nada de outro usuário é lido para ele;
//  - vazão: zero chamadas à API do Kommo por SDR (o limite de 7 req/s da conta não é tocado);
//  - frescor: devolve o atraso da última rodada do kommo-sync; o widget avisa/degrada se passar do limite.
// Env: KOMMO_WIDGET_SECRET, KOMMO_WIDGET_CLIENT_ID, KOMMO_ACCOUNT_ID, PREVENDAS_TIPOS_MOMENTO (json, opcional).
// Deploy: verify_jwt=false (a autenticação é o JWT do Kommo, não o do Supabase).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { classificar, type Momento } from '../_shared/prevendas_classificar.ts'
import { verificarJwtKommo } from '../_shared/kommo_jwt.ts'

const SUB = 'financeirorustonengenhariacombr'
const ORIGEM_OK = `https://${SUB}.kommo.com`
const LIMITE = 3000

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin === ORIGEM_OK ? ORIGEM_OK : 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Auth-Token, Content-Type, X-Requested-With',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
})
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } })

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405, origin)

  // 1) identidade (falha fechada)
  const secret = Deno.env.get('KOMMO_WIDGET_SECRET'), clientId = Deno.env.get('KOMMO_WIDGET_CLIENT_ID'), contaId = Deno.env.get('KOMMO_ACCOUNT_ID')
  if (!secret || !clientId || !contaId) return json({ erro: 'nao_configurado' }, 503, origin)
  const v = await verificarJwtKommo(req.headers.get('X-Auth-Token') ?? '', { secret, contaId, host: `${SUB}.kommo.com`, clientId })
  if (!v.ok) return json({ erro: v.erro }, 401, origin)

  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: membro, error: eMembro } = await sb.from('team_members').select('id,active').eq('kommo_user_id', v.userId).maybeSingle()
  if (eMembro) return json({ erro: 'falha_banco' }, 503, origin)
  if (!membro?.active) return json({ erro: 'usuario_inativo' }, 403, origin)

  // 2) fila do próprio usuário (réplica) + frescor — erro de banco = indisponível, nunca "ok vazio"
  const [fila, fres] = await Promise.all([
    sb.rpc('prevendas_fila', { p_kommo_user: v.userId, p_limite: LIMITE }),
    sb.rpc('prevendas_fila_frescor'),
  ])
  if (fila.error || fres.error) {
    console.error('[prevendas-fila]', fila.error?.message ?? fres.error?.message)
    return json({ erro: 'falha_banco' }, 503, origin)
  }

  let tiposMomento: Record<number, Momento> = {}
  try { tiposMomento = JSON.parse(Deno.env.get('PREVENDAS_TIPOS_MOMENTO') ?? '{}') } catch { tiposMomento = {} }

  const linhas = (fila.data ?? []) as any[]
  const tarefas = linhas.map((r) => {
    const lead = r.entity_type === 'leads' ? { etapa: r.etapa ?? null, origem: r.origem ?? null } : null
    const c = classificar({ id: Number(r.task_id), task_type_id: r.task_type_id == null ? null : Number(r.task_type_id), text: r.texto }, r.slot ?? null, lead, tiposMomento)
    return {
      id: Number(r.task_id), entity_type: r.entity_type, entity_id: Number(r.entity_id),
      due: Number(r.due) || 0, criada: Number(r.criada) || 0, atualizada: Number(r.atualizada) || 0,
      texto: r.texto ?? '', lead_nome: r.lead_nome ?? null, etapa: r.etapa ?? null,
      ...c,
    }
  })
  const f = (fres.data ?? [])[0] ?? null
  return json({
    ok: true,
    tarefas,
    parcial: linhas.length >= LIMITE,
    frescor: f ? { atraso_s: Number(f.atraso_s), status: f.status, erro: f.erro ? 'sync_com_erro' : null } : { atraso_s: null, status: 'desconhecido', erro: null },
  }, 200, origin)
})
