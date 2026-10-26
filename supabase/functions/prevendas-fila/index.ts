// prevendas-fila — fila do SDR para o widget ruston-prevendas.
// POST { forcar? } + header X-Auth-Token (JWT descartável do Kommo, via self.$authorizedAjax).
//
// Desenho (rev. 4, após a revisão do Vedor): a LISTA DE TAREFAS vem AO VIVO do Kommo — é a fonte autoritativa
// (existe, está aberta, é do usuário). Nada da réplica decide o que é emitido. A réplica só fornece dados do
// LEAD (nome, etapa, origem) para classificar/ordenar; leads ausentes nela são buscados na API.
//  1) identidade: JWT HS256 (conta, emissor, integração, expiração) → team_members ATIVO;
//  2) cache 40 s por usuário; TRAVA por usuário com TOKEN de posse (gravar/liberar só valem para o dono; as
//     concorrentes recebem o cache só se ainda válido); prazo total 40 s < trava 60 s; timeout por GET;
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
import { dedupTarefas, esperarFicha, Interrupcao, leadsFaltando, lerPaginado, montarItens, type LeadDados } from '../_shared/prevendas_servidor.ts'
import { chatsSemResposta, itensDeChat, revalidarChats, usarChats, type EventoChat, type LeadChat } from '../_shared/prevendas_chats.ts'

const SUB = 'financeirorustonengenhariacombr'
const KOMMO = `https://${SUB}.kommo.com`
const ORIGEM_FIELD = 975168
const CACHE_S = 40, FORCAR_MIN_S = 5, TRAVA_S = 60, MAX_PAGINAS = 12, MAX_LOTES_LEADS = 6
// prazo total da execução bem abaixo da trava (60 s); cada GET com timeout próprio; espera por ficha limitada
const PRAZO_MS = 40_000, TIMEOUT_GET_MS = 8_000, ESPERA_FICHA_MS = 3_000
// chats sem resposta: leitura da CONTA inteira (eventos de chat), cache compartilhado na linha kommo_user = 0
const CHATS_CACHE_S = 30, CHATS_MAX_IDADE_S = 60, CHATS_MAX_PAGINAS = 10, CHATS_MAX_LOTES = 4, CHATS_MAX_TALKS = 20
const CHATS_DIAS = Math.min(30, Math.max(1, Number(Deno.env.get('PREVENDAS_CHATS_DIAS') ?? '7') || 7))

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
  // reuso de resposta montada: a validade dos chats é conferida de novo AGORA (tarefas ficam; chat vencido sai)
  const reuso = (r: any) => revalidarChats(r, Math.floor(Date.now() / 1000), CHATS_MAX_IDADE_S)
  const idade = cache?.em ? (Date.now() - Date.parse(cache.em)) / 1000 : Infinity
  if (cache?.resposta && idade < CACHE_S && !(body?.forcar && idade >= FORCAR_MIN_S)) return json({ ...reuso(cache.resposta), cache_s: Math.round(idade) }, 200, origin)
  const { data: token, error: eT } = await sb.rpc('prevendas_travar', { p_user: uid, p_seg: TRAVA_S })
  if (eT) return json({ erro: 'falha_banco' }, 503, origin)
  if (!token) {
    // outra execução do mesmo usuário em curso: só devolve cache AINDA VÁLIDO (nunca vencido como autoritativo)
    if (cache?.resposta && idade < CACHE_S) return json({ ...reuso(cache.resposta), cache_s: Math.round(idade), em_andamento: true }, 200, origin)
    return json({ erro: 'em_andamento', retry_after: 3 }, 503, origin)
  }
  const inicio = Date.now()

  // 3) chamadas ao Kommo sempre com ficha do orçamento da conta
  const kommoGet = async (path: string): Promise<any> => {
    // ficha do orçamento da conta: espera a recarga por tempo limitado (garante progresso sob concorrência)
    await esperarFicha(
      async () => { const { data, error } = await sb.rpc('prevendas_consumir', { p_n: 1 }); if (error) throw new Error('falha_banco'); return !!data },
      (ms) => new Promise((ok) => setTimeout(ok, ms)), () => Date.now(), inicio + PRAZO_MS, ESPERA_FICHA_MS)
    const r = await fetch(`${KOMMO}${path}`, { headers: { Authorization: `Bearer ${Deno.env.get('KOMMO_API_TOKEN')}` }, signal: AbortSignal.timeout(TIMEOUT_GET_MS) })
    if (r.status === 204) return null
    if (r.status === 429) {
      // pausa COMPARTILHADA: nenhuma execução (fila, chats, telefone) consome ficha até o Retry-After
      const ra = Number(r.headers.get('Retry-After')) || 60
      await sb.rpc('prevendas_pausar', { p_seg: ra })
      throw new KommoLimite(ra)
    }
    if (!r.ok) throw new Error(`kommo ${path.split('?')[0]} ${r.status}`)
    return r.json()
  }

  // eventos de chat da janela → leads com cliente esperando → dono/etapa do lead e status do talk (ao vivo)
  const lerChatsDaConta = async () => {
    const lidoEmC = Math.floor(Date.now() / 1000)          // idade real = início da leitura
    const desde = lidoEmC - CHATS_DIAS * 86400
    const lidas = await lerPaginado<EventoChat>(async (n) => {
      const j = await kommoGet(`/api/v4/events?filter[type]=incoming_chat_message,outgoing_chat_message&filter[created_at][from]=${desde}&limit=100&page=${n}`)
      const itens = j?._embedded?.events ?? []
      return { itens, temProxima: itens.length === 100 && !!j?._links?.next }
    }, CHATS_MAX_PAGINAS)
    let parcial = lidas.motivos.length > 0
    const chats = chatsSemResposta(lidas.tarefas)
    const leadsC: Record<string, LeadChat> = {}, talks: Record<string, string> = {}
    const ids = chats.map((c) => c.lead_id)
    for (let i = 0, lotes = 0; i < ids.length; i += 50, lotes++) {
      if (lotes >= CHATS_MAX_LOTES) { parcial = true; break }
      const j = await kommoGet(`/api/v4/leads?${ids.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join('&')}&limit=50`)
      for (const l of j?._embedded?.leads ?? []) leadsC[String(l.id)] = { responsavel: l.responsible_user_id ?? null, status_id: l.status_id ?? null, nome: l.name ?? null }
    }
    let nTalks = 0
    for (const c of chats) {
      if (c.talk_id == null || talks[String(c.talk_id)]) continue
      const l = leadsC[String(c.lead_id)]
      if (!l || l.status_id === 142 || l.status_id === 143) continue
      if (++nTalks > CHATS_MAX_TALKS) { parcial = true; break }
      try {
        const t = await kommoGet(`/api/v4/talks/${c.talk_id}`)
        if (t?.status) talks[String(c.talk_id)] = String(t.status)
      } catch (e) {
        if (e instanceof KommoLimite || e instanceof Interrupcao) throw e
        parcial = true                                     // talk sem status conhecido: o chat entra (não esconde cliente esperando)
      }
    }
    return { chats, leads: leadsC, talks, parcial, dias: CHATS_DIAS, gerado_em: lidoEmC }
  }

  const motivos: string[] = []
  try {
    // 4a) lista VIVA, paginada (interrupção depois da 1ª página = parcial com motivo)
    const lidas = await lerPaginado(async (n) => {
      const j = await kommoGet(`/api/v4/tasks?filter[responsible_user_id]=${uid}&filter[is_completed]=0&order[complete_till]=asc&limit=250&page=${n}`)
      const itens = j?._embedded?.tasks ?? []
      return { itens, temProxima: itens.length === 250 && !!j?._links?.next }
    }, MAX_PAGINAS)
    const tarefas = lidas.tarefas
    motivos.push(...lidas.motivos)

    const lidoEm = Math.floor(inicio / 1000)               // início da leitura viva (idade real e conservadora dos dados)
    const tarefasUnicas = dedupTarefas(tarefas)             // paginação por offset pode repetir ids
    // 4b) leads: réplica para todos; faltantes pela API em lotes de 50 (com orçamento)
    const ids = [...new Set(tarefasUnicas.filter((t) => t.entity_type === 'leads' && t.entity_id).map((t) => Number(t.entity_id)))]
    const rl = ids.length ? await sb.rpc('prevendas_leads', { p_ids: ids }) : { data: {}, error: null }
    if (rl.error) throw new Error('falha_banco')
    const leads = { ...((rl.data ?? {}) as Record<string, LeadDados>) }
    const faltam = leadsFaltando(tarefasUnicas, leads)
    for (let i = 0, lotes = 0; i < faltam.length; i += 50, lotes++) {
      if (lotes >= MAX_LOTES_LEADS) { motivos.push('leads_nao_consultados'); break }
      let j: any
      try { j = await kommoGet(`/api/v4/leads?${faltam.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join('&')}&limit=50`) }
      catch (e) {
        if (e instanceof Interrupcao) { motivos.push(e.tipo === 'ficha' ? 'vazao_leads' : 'tempo_leads'); break }
        throw e
      }
      for (const l of j?._embedded?.leads ?? []) {
        const cf = (l.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === ORIGEM_FIELD)
        leads[String(l.id)] = { nome: l.name ?? null, etapa: null, origem: cf?.values?.[0]?.value ?? null }
      }
    }

    // 4c) slots + classificação com dados vivos
    const rs = tarefasUnicas.length ? await sb.rpc('prevendas_slots', { p_ids: tarefasUnicas.map((t) => Number(t.id)) }) : { data: {}, error: null }
    if (rs.error) throw new Error('falha_banco')
    let tiposMomento: Record<number, Momento> = {}
    try { tiposMomento = JSON.parse(Deno.env.get('PREVENDAS_TIPOS_MOMENTO') ?? '{}') } catch { tiposMomento = {} }
    const itens = montarItens(tarefasUnicas, uid, leads, (rs.data ?? {}) as Record<string, string>, tiposMomento)

    // 4d) chats sem resposta (nível 0). Cache da conta (linha kommo_user = 0) renovado a cada CHATS_CACHE_S.
    //     Falha aqui NUNCA derruba a fila de tarefas (vira motivo); leitura com mais de CHATS_MAX_IDADE_S não é
    //     publicada (não rejuvenesce); 429 vira chats_limite + retry_after, com a pausa compartilhada já gravada.
    let chatsEm: number | null = null, retryAfter = 0
    try {
      const { data: cc, error: eCC } = await sb.from('prevendas_cache').select('resposta').eq('kommo_user', 0).maybeSingle()
      if (eCC) throw new Error('falha_banco')
      let conta = (cc?.resposta ?? null) as any
      const agoraS = () => Math.floor(Date.now() / 1000)
      if (!conta?.gerado_em || agoraS() - Number(conta.gerado_em) >= CHATS_CACHE_S) {
        const { data: tk, error: eTk } = await sb.rpc('prevendas_travar', { p_user: 0, p_seg: TRAVA_S })
        if (eTk) throw new Error('falha_banco')
        if (tk) {
          let novo
          try { novo = await lerChatsDaConta() }
          catch (e) { await sb.rpc('prevendas_liberar', { p_user: 0, p_token: tk }); throw e }
          conta = novo                                       // leitura própria e fresca: vale mesmo se a gravação falhar
          const { data: gravou, error: eGv } = await sb.rpc('prevendas_gravar', { p_user: 0, p_token: tk, p_resposta: novo })
          if (eGv || gravou !== true) {
            console.error('[prevendas-fila] cache chats', eGv?.message ?? 'posse perdida')
            await sb.rpc('prevendas_liberar', { p_user: 0, p_token: tk })
          }
        }
      }
      const uso = usarChats(conta, agoraS(), CHATS_MAX_IDADE_S)
      if (!uso.ok) motivos.push(uso.motivo)
      else {
        itens.unshift(...itensDeChat(conta.chats, uid, conta.leads ?? {}, conta.talks ?? {}))
        chatsEm = Number(conta.gerado_em)
        if (conta.parcial) motivos.push('chats_parcial')
      }
    } catch (e) {
      if (e instanceof KommoLimite) { motivos.push('chats_limite'); retryAfter = e.retryAfter }
      else { console.error('[prevendas-fila] chats', (e as Error).message); motivos.push('chats_indisponiveis') }
    }

    const fres = await sb.rpc('prevendas_fila_frescor')
    const resposta = {
      ok: true, itens, total: itens.length,
      parcial: motivos.length > 0, motivos_parcial: motivos,
      origem_pendente: itens.filter((i) => i.origem_pendente).length,
      frescor_leads: fres.error ? null : fres.data,
      gerado_em: lidoEm, chats_em: chatsEm,
      ...(retryAfter ? { retry_after: retryAfter } : {}),
    }
    // grava só se ainda for o dono da trava (uma execução lenta cuja trava venceu não sobrescreve a mais nova)
    const { error: eG } = await sb.rpc('prevendas_gravar', { p_user: uid, p_token: token, p_resposta: resposta })
    if (eG) { console.error('[prevendas-fila] cache', eG.message); await sb.rpc('prevendas_liberar', { p_user: uid, p_token: token }) }
    return json(resposta, 200, origin)
  } catch (e) {
    await sb.rpc('prevendas_liberar', { p_user: uid, p_token: token })
    if (e instanceof KommoLimite) return json({ erro: 'kommo_429', retry_after: e.retryAfter }, 503, origin)
    if (e instanceof Interrupcao) return json({ erro: 'ocupado', retry_after: e.tipo === 'tempo' ? 5 : 3 }, 503, origin)
    console.error('[prevendas-fila]', (e as Error).message)
    return json({ erro: (e as Error).message === 'falha_banco' ? 'falha_banco' : 'kommo_indisponivel' }, 503, origin)
  }
})
