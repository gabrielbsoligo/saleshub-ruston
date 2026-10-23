// prevendas-fila — fila do SDR para o widget ruston-prevendas. O SERVIDOR é a autoridade do que é emitido.
// POST { antecedencia_min, outbound_apos, grupos, forcar? } + header X-Auth-Token (JWT descartável do Kommo).
//
// Fluxo (falha fechada):
//  1) identidade: JWT HS256 (conta, emissor, integração, expiração) → team_members ATIVO.
//  2) cache/vazão: resposta < 40 s para o mesmo usuário e config é reaproveitada (forcar só após 5 s).
//  3) candidatas: réplica do Kommo (prevendas_fila) + DESCOBERTA ao vivo das tarefas do usuário alteradas nas
//     últimas 3 h (pega o que um sync falho não gravou, ex.: "Ligar AGORA"), classificadas no servidor.
//  4) ordem com a config do widget; o LOTE emitido (K primeiras + a próxima futura) é CONFERIDO no Kommo:
//     existe, aberta, responsável = usuário, mesma entidade. Inválidas saem e o que sobe é conferido (≤ 2 rodadas).
//  5) emite SÓ o confirmado; o resto vira contagem "pendentes". Kommo indisponível/429 → 503 (nada emitido).
// Limite remanescente: tarefas criadas há mais de 3 h que o sync perdeu e nunca mais mudaram não são
// descobertas (dependem da correção do kommo-sync, reportada).
// Env: KOMMO_API_TOKEN, KOMMO_WIDGET_SECRET, KOMMO_WIDGET_CLIENT_ID, KOMMO_ACCOUNT_ID, PREVENDAS_TIPOS_MOMENTO?
// Deploy: verify_jwt=false (a autenticação é o JWT do Kommo).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { classificar, type Momento } from '../_shared/prevendas_classificar.ts'
import { verificarJwtKommo } from '../_shared/kommo_jwt.ts'
import { emitir, juntar, type Item, type TarefaKommo } from '../_shared/prevendas_servidor.ts'

const SUB = 'financeirorustonengenhariacombr'
const KOMMO = `https://${SUB}.kommo.com`
const ORIGEM_FIELD = 975168
const K = 25, RODADAS = 2, CACHE_S = 40, FORCAR_MIN_S = 5, DESCOBERTA_H = 3

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin === KOMMO ? KOMMO : 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Auth-Token, Content-Type, X-Requested-With',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
})
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } })

class KommoLimite extends Error { constructor(public retryAfter: number) { super('kommo_429') } }
async function kommoGet(path: string): Promise<any> {
  const r = await fetch(`${KOMMO}${path}`, { headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}` } })
  if (r.status === 204) return null
  if (r.status === 429) throw new KommoLimite(Number(r.headers.get('Retry-After')) || 60)
  if (!r.ok) throw new Error(`kommo ${path.split('?')[0]} ${r.status}`)
  return r.json()
}
const idsQ = (ids: number[]) => ids.map((id) => `filter[id][]=${id}`).join('&')

function cfgDo(body: any) {
  const n = (v: unknown, d: number, min: number, max: number) => { const x = parseInt(String(v), 10); return Number.isFinite(x) && x >= min ? Math.min(x, max) : d }
  const hhmm = /^\d{1,2}:\d{2}$/.test(String(body?.outbound_apos ?? '')) ? String(body.outbound_apos) : '16:00'
  const grupos = Array.isArray(body?.grupos) ? body.grupos.map((g: unknown) => String(g).toUpperCase()).filter((g: string) => /^G[0-9]$/.test(g)).slice(0, 10) : []
  return { antecedencia_min: n(body?.antecedencia_min, 10, 0, 240), outbound_apos: hhmm, grupos: grupos.length ? grupos : ['G1', 'G2', 'G3', 'G4', 'G5', 'G9'] }
}
const minutoBRT = () => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':')
  return Number(p[0]) * 60 + Number(p[1])
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405, origin)

  // 1) identidade
  const secret = Deno.env.get('KOMMO_WIDGET_SECRET'), clientId = Deno.env.get('KOMMO_WIDGET_CLIENT_ID'), contaId = Deno.env.get('KOMMO_ACCOUNT_ID')
  if (!secret || !clientId || !contaId || !Deno.env.get('KOMMO_API_TOKEN')) return json({ erro: 'nao_configurado' }, 503, origin)
  const v = await verificarJwtKommo(req.headers.get('X-Auth-Token') ?? '', { secret, contaId, host: `${SUB}.kommo.com`, clientId })
  if (!v.ok) return json({ erro: v.erro }, 401, origin)
  const uid = v.userId
  const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: membro, error: eM } = await sb.from('team_members').select('id,active').eq('kommo_user_id', uid).maybeSingle()
  if (eM) return json({ erro: 'falha_banco' }, 503, origin)
  if (!membro?.active) return json({ erro: 'usuario_inativo' }, 403, origin)

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const cfg = cfgDo(body)
  const chave = JSON.stringify(cfg)

  // 2) cache/vazão
  const { data: cache } = await sb.from('prevendas_cache').select('chave,resposta,em').eq('kommo_user', uid).maybeSingle()
  if (cache && cache.chave === chave) {
    const idade = (Date.now() - Date.parse(cache.em)) / 1000
    if (idade < CACHE_S && !(body?.forcar && idade >= FORCAR_MIN_S)) return json({ ...cache.resposta, cache_s: Math.round(idade) }, 200, origin)
  }

  try {
    // 3) candidatas: réplica + descoberta ao vivo
    const [rep, fres] = await Promise.all([sb.rpc('prevendas_fila', { p_kommo_user: uid, p_limite: 3000 }), sb.rpc('prevendas_fila_frescor')])
    if (rep.error || fres.error || !Array.isArray((rep.data as any)?.itens)) return json({ erro: 'falha_banco' }, 503, origin)
    let tiposMomento: Record<number, Momento> = {}
    try { tiposMomento = JSON.parse(Deno.env.get('PREVENDAS_TIPOS_MOMENTO') ?? '{}') } catch { tiposMomento = {} }

    const paraItem = (r: any): Item => {
      const lead = r.entity_type === 'leads' ? { etapa: r.etapa ?? null, origem: r.origem ?? null } : null
      const c = classificar({ id: Number(r.task_id), task_type_id: r.task_type_id == null ? null : Number(r.task_type_id), text: r.texto }, r.slot ?? null, lead, tiposMomento)
      return { id: Number(r.task_id), entity_type: r.entity_type, entity_id: Number(r.entity_id), due: Number(r.due) || 0, texto: r.texto ?? '', lead_nome: r.lead_nome ?? null, etapa: r.etapa ?? null, ...c }
    }
    const replica = ((rep.data as any).itens as any[]).map(paraItem)
    const naReplica = new Set(replica.map((i) => i.id))

    const desde = Math.floor(Date.now() / 1000) - DESCOBERTA_H * 3600
    const desc = await kommoGet(`/api/v4/tasks?filter[responsible_user_id]=${uid}&filter[is_completed]=0&filter[updated_at][from]=${desde}&limit=250`)
    const descobertas: any[] = desc?._embedded?.tasks ?? []
    const novas = descobertas.filter((t) => !naReplica.has(Number(t.id)))
    let extras: Item[] = []
    if (novas.length) {
      const [slots, leadsResp] = await Promise.all([
        sb.rpc('prevendas_slots', { p_ids: novas.map((t) => Number(t.id)) }),
        (async () => {
          const ids = [...new Set(novas.filter((t) => t.entity_type === 'leads').map((t) => Number(t.entity_id)))].slice(0, 50)
          return ids.length ? kommoGet(`/api/v4/leads?${idsQ(ids)}&limit=50`) : null
        })(),
      ])
      if (slots.error) return json({ erro: 'falha_banco' }, 503, origin)
      const slotDe = (slots.data ?? {}) as Record<string, string>
      const leads = new Map<number, any>((leadsResp?._embedded?.leads ?? []).map((l: any) => [Number(l.id), l]))
      extras = novas.map((t) => {
        const l = t.entity_type === 'leads' ? leads.get(Number(t.entity_id)) : null
        const origem = l ? ((l.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === ORIGEM_FIELD)?.values?.[0]?.value ?? null) : null
        return paraItem({ task_id: t.id, entity_type: t.entity_type, entity_id: t.entity_id, task_type_id: t.task_type_id, texto: t.text, due: t.complete_till, lead_nome: l?.name ?? null, etapa: null, origem, slot: slotDe[String(t.id)] ?? null })
      })
    }
    // descobertas também atualizam prazo/texto das que já estão na réplica
    const vivasDesc = new Map(descobertas.map((t) => [Number(t.id), t]))
    const base = juntar(replica.map((i) => { const t = vivasDesc.get(i.id); return t ? { ...i, due: Number(t.complete_till) || 0, texto: t.text ?? i.texto } : i }), extras)

    // 4–5) ordena, confere o lote no Kommo e emite só o confirmado
    const verificar = async (ids: number[]): Promise<TarefaKommo[]> => {
      const j = await kommoGet(`/api/v4/tasks?${idsQ(ids)}&limit=50`)
      return j?._embedded?.tasks ?? []
    }
    const r = await emitir(base, cfg, Math.floor(Date.now() / 1000), minutoBRT(), uid, K, RODADAS, verificar)
    const f = (fres.data && typeof fres.data === 'object' && 'status' in (fres.data as any)) ? fres.data as any : null
    const resposta = {
      ok: true, itens: r.fila, futura: r.futura, pendentes: r.pendentes, total: r.total,
      descobertas_fora_da_replica: novas.length,
      frescor: f ? { atraso_s: Number(f.atraso_s), status: f.status, erro: f.erro ? 'sync_com_erro' : null } : null,
      gerado_em: Math.floor(Date.now() / 1000),
    }
    await sb.from('prevendas_cache').upsert({ kommo_user: uid, chave, resposta, em: new Date().toISOString() })
    return json(resposta, 200, origin)
  } catch (e) {
    if (e instanceof KommoLimite) return json({ erro: 'kommo_429', retry_after: e.retryAfter }, 503, origin)
    console.error('[prevendas-fila]', (e as Error).message)
    return json({ erro: 'kommo_indisponivel' }, 503, origin)
  }
})
