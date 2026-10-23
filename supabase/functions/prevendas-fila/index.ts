// prevendas-fila — fila do SDR para o widget ruston-prevendas.
// POST { forcar? } + header X-Auth-Token (JWT descartável do Kommo, via self.$authorizedAjax).
//
// Desenho (rev. 4, após a revisão do Vedor): a LISTA DE TAREFAS vem AO VIVO do Kommo — é a fonte autoritativa
// (existe, está aberta, é do usuário). Nada da réplica decide o que é emitido. A réplica só fornece dados do
// LEAD (nome, etapa, origem) para classificar/ordenar; leads ausentes nela são buscados na API.
//  1) identidade: JWT HS256 (conta, emissor, integração, expiração) → team_members ATIVO;
//  2) cache 40 s por usuário; TRAVA atômica por usuário (execuções concorrentes recebem o cache);
//  3) ORÇAMENTO de vazão da conta (balde no banco, compartilhado por todas as execuções) antes de cada GET;
//  4) lista viva paginada (até 12 páginas = 3000 tarefas) → leads (réplica; faltantes pela API em lotes de 50)
//     → slots → classificação com texto/tipo vivos;
//  5) incompletude é sinalizada (parcial + motivos), nunca silenciosa. Kommo 429/indisponível → 503.
// O widget ordena (momento → origem → vencimento) e age só sobre esta lista.
// Env: KOMMO_API_TOKEN, KOMMO_WIDGET_SECRET, KOMMO_WIDGET_CLIENT_ID, KOMMO_ACCOUNT_ID, PREVENDAS_TIPOS_MOMENTO?
// Deploy: verify_jwt=false (a autenticação é o JWT do Kommo).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { type Momento } from '../_shared/prevendas_classificar.ts'
import { verificarJwtKommo } from '../_shared/kommo_jwt.ts'
import { leadsFaltando, montarItens, type LeadDados, type TarefaKommo } from '../_shared/prevendas_servidor.ts'

const SUB = 'financeirorustonengenhariacombr'
const KOMMO = `https://${SUB}.kommo.com`
const ORIGEM_FIELD = 975168
const CACHE_S = 40, FORCAR_MIN_S = 5, TRAVA_S = 60, MAX_PAGINAS = 12, MAX_LOTES_LEADS = 6

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
class SemFicha extends Error { constructor() { super('sem_ficha') } }

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

  // 2) cache + trava
  const { data: cache, error: eC } = await sb.from('prevendas_cache').select('resposta,em').eq('kommo_user', uid).maybeSingle()
  if (eC) return json({ erro: 'falha_banco' }, 503, origin)
  const idade = cache?.em ? (Date.now() - Date.parse(cache.em)) / 1000 : Infinity
  if (cache?.resposta && idade < CACHE_S && !(body?.forcar && idade >= FORCAR_MIN_S)) return json({ ...cache.resposta, cache_s: Math.round(idade) }, 200, origin)
  const { data: travou, error: eT } = await sb.rpc('prevendas_travar', { p_user: uid, p_seg: TRAVA_S })
  if (eT) return json({ erro: 'falha_banco' }, 503, origin)
  if (!travou) {
    // outra execução do mesmo usuário em curso: devolve o último resultado (marcado) ou pede nova tentativa
    if (cache?.resposta) return json({ ...cache.resposta, cache_s: Math.round(idade), em_andamento: true }, 200, origin)
    return json({ erro: 'em_andamento', retry_after: 3 }, 503, origin)
  }

  // 3) chamadas ao Kommo sempre com ficha do orçamento da conta
  const kommoGet = async (path: string): Promise<any> => {
    const { data: ficha, error } = await sb.rpc('prevendas_consumir', { p_n: 1 })
    if (error) throw new Error('falha_banco')
    if (!ficha) throw new SemFicha()
    const r = await fetch(`${KOMMO}${path}`, { headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}` } })
    if (r.status === 204) return null
    if (r.status === 429) throw new KommoLimite(Number(r.headers.get('Retry-After')) || 60)
    if (!r.ok) throw new Error(`kommo ${path.split('?')[0]} ${r.status}`)
    return r.json()
  }

  const motivos: string[] = []
  try {
    // 4a) lista VIVA, paginada
    const tarefas: TarefaKommo[] = []
    let pagina = 1
    for (; pagina <= MAX_PAGINAS; pagina++) {
      let j: any
      try { j = await kommoGet(`/api/v4/tasks?filter[responsible_user_id]=${uid}&filter[is_completed]=0&order[complete_till]=asc&limit=250&page=${pagina}`) }
      catch (e) { if (e instanceof SemFicha && tarefas.length) { motivos.push('vazao_tarefas'); break } throw e }
      const lote = j?._embedded?.tasks ?? []
      tarefas.push(...lote)
      if (lote.length < 250 || !j?._links?.next) break
      if (pagina === MAX_PAGINAS) motivos.push('limite_paginas')
    }

    // 4b) leads: réplica para todos; faltantes pela API em lotes de 50 (com orçamento)
    const ids = [...new Set(tarefas.filter((t) => t.entity_type === 'leads' && t.entity_id).map((t) => Number(t.entity_id)))]
    const rl = ids.length ? await sb.rpc('prevendas_leads', { p_ids: ids }) : { data: {}, error: null }
    if (rl.error) throw new Error('falha_banco')
    const leads = { ...((rl.data ?? {}) as Record<string, LeadDados>) }
    const faltam = leadsFaltando(tarefas, leads)
    for (let i = 0, lotes = 0; i < faltam.length; i += 50, lotes++) {
      if (lotes >= MAX_LOTES_LEADS) { motivos.push('leads_nao_consultados'); break }
      let j: any
      try { j = await kommoGet(`/api/v4/leads?${faltam.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join('&')}&limit=50`) }
      catch (e) { if (e instanceof SemFicha) { motivos.push('vazao_leads'); break } throw e }
      for (const l of j?._embedded?.leads ?? []) {
        const cf = (l.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === ORIGEM_FIELD)
        leads[String(l.id)] = { nome: l.name ?? null, etapa: null, origem: cf?.values?.[0]?.value ?? null }
      }
    }

    // 4c) slots + classificação com dados vivos
    const rs = tarefas.length ? await sb.rpc('prevendas_slots', { p_ids: tarefas.map((t) => Number(t.id)) }) : { data: {}, error: null }
    if (rs.error) throw new Error('falha_banco')
    let tiposMomento: Record<number, Momento> = {}
    try { tiposMomento = JSON.parse(Deno.env.get('PREVENDAS_TIPOS_MOMENTO') ?? '{}') } catch { tiposMomento = {} }
    const itens = montarItens(tarefas, uid, leads, (rs.data ?? {}) as Record<string, string>, tiposMomento)

    const fres = await sb.rpc('prevendas_fila_frescor')
    const resposta = {
      ok: true, itens, total: itens.length,
      parcial: motivos.length > 0, motivos_parcial: motivos,
      origem_pendente: itens.filter((i) => i.origem_pendente).length,
      frescor_leads: fres.error ? null : fres.data,
      gerado_em: Math.floor(Date.now() / 1000),
    }
    const { error: eG } = await sb.rpc('prevendas_gravar', { p_user: uid, p_chave: 'v4', p_resposta: resposta })
    if (eG) { console.error('[prevendas-fila] cache', eG.message); await sb.rpc('prevendas_liberar', { p_user: uid }) }   // resposta segue válida; trava liberada
    return json(resposta, 200, origin)
  } catch (e) {
    await sb.rpc('prevendas_liberar', { p_user: uid })
    if (e instanceof KommoLimite) return json({ erro: 'kommo_429', retry_after: e.retryAfter }, 503, origin)
    if (e instanceof SemFicha) return json({ erro: 'ocupado', retry_after: 3 }, 503, origin)
    console.error('[prevendas-fila]', (e as Error).message)
    return json({ erro: (e as Error).message === 'falha_banco' ? 'falha_banco' : 'kommo_indisponivel' }, 503, origin)
  }
})
