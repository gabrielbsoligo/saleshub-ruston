// prevendas-voz — telefone do widget ruston-prevendas (webphone WebRTC no próprio Kommo, provedor 4com).
// POST + header X-Auth-Token (JWT descartável do Kommo, via self.$authorizedAjax). Ações:
//   { acao: 'credencial' }                                  → credencial SIP do PRÓPRIO ramal (HA1, nunca a senha)
//   { acao: 'telefones', entity_type, entity_id }           → telefones dos contatos VINCULADOS (se autorizado)
//   { acao: 'discar', entity_type, entity_id, telefone }    → POST /calls da 4com: liga para o ramal do usuário
//                                                             (atendimento MANUAL no widget) e depois para o telefone
// Segurança (fail-closed em todos os passos):
//  - JWT HS256 do Kommo (conta, emissor, integração, validade) → team_members ATIVO;
//  - lista de usuários liberados no SERVIDOR (PREVENDAS_VOZ_USUARIOS; vazia = ninguém);
//  - credencial só do ramal do próprio usuário (team_members.ramal_4com); senha buscada na 4com na hora, HA1
//    calculado aqui, resposta no-store; nada sensível em log;
//  - entidade: decisão com os objetos DEVOLVIDOS (id confere; tarefa própria conferida tarefa a tarefa; telefones
//    só de contatos vinculados) — decidirEntidade, testada; envelope inesperado nega;
//  - discar: telefone de contato vinculado (ou lista de teste PREVENDAS_VOZ_TELEFONES_TESTE no servidor);
//  - limites por usuário no banco contando TODAS as tentativas (prevendas_voz_reservar) + 429 da 4com bloqueia;
//    GETs ao Kommo no orçamento compartilhado da conta (prevendas_consumir; 429 → prevendas_pausar).
// Env: KOMMO_WIDGET_SECRET, KOMMO_WIDGET_CLIENT_ID, KOMMO_ACCOUNT_ID, KOMMO_API_TOKEN, API4COM_TOKEN,
//      API4COM_DOMAIN, API4COM_WSS, PREVENDAS_VOZ_USUARIOS, PREVENDAS_VOZ_TELEFONES_TESTE?
// Deploy: verify_jwt=false (a autenticação é o JWT do Kommo).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verificarJwtKommo } from '../_shared/kommo_jwt.ts'
import { esperarFicha, Interrupcao } from '../_shared/prevendas_servidor.ts'
import {
  credencial3c, decidirEntidade, prepararAgente3c, decidirProvedor, finalTelefone, ha1, interpretar3c, interpretar4com, motivoAutorizacao, telefone3c,
  telefoneE164, usuarioLiberado,
} from '../_shared/prevendas_voz.ts'

const SUB = 'financeirorustonengenhariacombr'
const KOMMO = `https://${SUB}.kommo.com`
const API4COM = 'https://api.api4com.com/api/v1'
const API3C = 'https://app.3c.plus/api/v1'
const TIMEOUT_MS = 8_000, TIMEOUT_DISCAR_MS = 45_000   // o POST /calls da 4com só responde quando a chamada conecta
const PRAZO_MS = 30_000, PRAZO_NOTA_MS = 12_000, ESPERA_FICHA_MS = 3_000, MAX_CONTATOS = 10

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin === KOMMO ? KOMMO : 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'X-Auth-Token, Content-Type, X-Requested-With',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
})
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...cors(origin) },
  })
class KommoLimite extends Error { retryAfter: number; constructor(ra: number) { super('kommo_429'); this.retryAfter = ra } }

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405, origin)

  const env = (k: string) => Deno.env.get(k) ?? ''
  const secret = env('KOMMO_WIDGET_SECRET'), clientId = env('KOMMO_WIDGET_CLIENT_ID'), contaId = env('KOMMO_ACCOUNT_ID')
  const token4com = env('API4COM_TOKEN'), dominio = env('API4COM_DOMAIN'), wss = env('API4COM_WSS'), token3c = env('THREEC_API_TOKEN')
  if (!secret || !clientId || !contaId || !env('KOMMO_API_TOKEN')) return json({ erro: 'nao_configurado' }, 503, origin)

  // 1) identidade
  const v = await verificarJwtKommo(req.headers.get('X-Auth-Token') ?? '', { secret, contaId, host: `${SUB}.kommo.com`, clientId })
  if (!v.ok) {
    if (v.detalhe) console.warn('[' + (new URL(req.url).pathname.split('/').pop()) + '] jwt', v.erro, v.detalhe)
    return json(v.detalhe ? { erro: v.erro, detalhe: v.detalhe } : { erro: v.erro }, 401, origin)
  }
  const uid = v.userId
  if (!usuarioLiberado(env('PREVENDAS_VOZ_USUARIOS'), uid)) return json({ erro: 'voz_nao_liberada' }, 403, origin)
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: membro, error: eM } = await sb.from('team_members').select('name,role,active,ramal_4com,agente_3c_id').eq('kommo_user_id', uid).maybeSingle()
  if (eM) return json({ erro: 'falha_banco' }, 503, origin)
  if (!membro?.active) return json({ erro: 'usuario_inativo' }, 403, origin)
  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  // provedor: o pedido pelo widget (setting provedor_voz) ou o padrão do servidor, se o usuário tiver o dado dele
  const provedor = decidirProvedor(body?.provedor, membro, env('PREVENDAS_VOZ_PROVEDOR_PADRAO'))
  if (!provedor) return json({ erro: 'sem_ramal' }, 403, origin)
  if (provedor === '4com' && (!token4com || !dominio || !wss)) return json({ erro: 'nao_configurado' }, 503, origin)
  if (provedor === '3c' && !token3c) return json({ erro: 'nao_configurado' }, 503, origin)
  const ramal = String(membro.ramal_4com ?? '').trim(), agente3c = String(membro.agente_3c_id ?? '').trim()
  // usuário do agente no 3C (com ramal e senha SIP): só no servidor, nunca vai para log
  const usuario3c = async () => {
    const r = await fetch(`${API3C}/users/${encodeURIComponent(agente3c)}?include=extension,company`, { headers: { Authorization: `Bearer ${token3c}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    return { r, u: r.ok ? (await r.json())?.data ?? null : null }
  }
  const acao = String(body?.acao ?? '')
  const inicio = Date.now()

  const reservar = async (a: 'credencial' | 'telefones' | 'discar', max: number, janela: number, intervalo: number, extra: { entidade?: string; tel?: string } = {}) => {
    const { data, error } = await sb.rpc('prevendas_voz_reservar', {
      p_user: uid, p_acao: a, p_max: max, p_janela_s: janela, p_intervalo_s: intervalo,
      p_entidade: extra.entidade ?? null, p_telefone: extra.tel ?? null,
    })
    if (error) throw new Error('falha_banco')
    return data as number | null
  }
  const registrar = (id: number, resultado: string, detalhe?: string) =>
    sb.rpc('prevendas_voz_registrar', { p_id: id, p_resultado: resultado, p_detalhe: detalhe ?? null })
  // 429 do provedor: bloqueio a partir de AGORA (instante da resposta) pelo Retry-After efetivo; erro é logado
  const bloquear = async (a: 'credencial' | 'discar', r: Response | number) => {
    const ra = Math.min(3600, Math.max(1, (typeof r === 'number' ? r : Number(r.headers.get('Retry-After'))) || 60))
    const { error } = await sb.rpc('prevendas_voz_bloquear', { p_user: uid, p_acao: a, p_seg: ra })
    if (error) console.error('[prevendas-voz] bloqueio', error.message)
    return ra
  }

  // GET ao Kommo SEMPRE com ficha do orçamento da conta (compartilhado com prevendas-fila); 429 pausa a conta
  // prazoFinal: o padrão vale para a autorização; a nota pós-ligação ganha prazo próprio (a 4com pode demorar 45 s)
  const kommo = async (path: string, init?: RequestInit, prazoFinal = inicio + PRAZO_MS) => {
    await esperarFicha(
      async () => { const { data, error } = await sb.rpc('prevendas_consumir', { p_n: 1 }); if (error) throw new Error('falha_banco'); return !!data },
      (ms) => new Promise((ok) => setTimeout(ok, ms)), () => Date.now(), prazoFinal, ESPERA_FICHA_MS)
    const r = await fetch(`${KOMMO}${path}`, { ...init, headers: { Authorization: `Bearer ${env('KOMMO_API_TOKEN')}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (r.status === 204 || r.status === 404) return null
    if (r.status === 429) { const ra = Number(r.headers.get('Retry-After')) || 60; await sb.rpc('prevendas_pausar', { p_seg: ra }); throw new KommoLimite(ra) }
    if (!r.ok) throw new Error(`kommo ${r.status}`)
    return r.json()
  }

  try {
    // ---------------- credencial SIP do próprio ramal ----------------
    if (acao === 'credencial') {
      const ev = await reservar('credencial', 12, 600, 0)
      if (!ev) return json({ erro: 'limite', retry_after: 60 }, 429, origin)
      if (provedor === '3c') {
        const { r, u } = await usuario3c()
        if (r.status === 429) { const ra = await bloquear('credencial', r); await registrar(ev, 'limite', `3c 429 (${ra}s)`); return json({ erro: 'provedor_limite', retry_after: ra }, 503, origin) }
        if (!r.ok) { await registrar(ev, 'incerto', `3c ${r.status}`); return json({ erro: 'provedor_indisponivel' }, 503, origin) }
        const c = credencial3c(u)
        if (!c) { await registrar(ev, 'negado', 'agente 3c sem ramal'); return json({ erro: 'sem_ramal' }, 403, origin) }
        await registrar(ev, 'ok', '3c')
        return json({ ok: true, provedor: '3c', wss: c.wss, dominio: c.dominio, ramal: c.usuario, realm: c.realm, ha1: c.ha1, uri: c.uri, nome: membro.name ?? c.ramal, exibir_ramal: c.ramal }, 200, origin)
      }
      const filtro = encodeURIComponent(JSON.stringify({ where: { ramal }, fields: { ramal: true, senha: true, domain: true } }))
      const r = await fetch(`${API4COM}/extensions?filter=${filtro}`, { headers: { Authorization: token4com }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (r.status === 429) { const ra = await bloquear('credencial', r); await registrar(ev, 'limite', `4com 429 (${ra}s)`); return json({ erro: 'provedor_limite', retry_after: ra }, 503, origin) }
      if (!r.ok) { await registrar(ev, 'incerto', `4com ${r.status}`); return json({ erro: 'provedor_indisponivel' }, 503, origin) }
      const lista = await r.json()
      const ext = Array.isArray(lista) ? lista.find((x: any) => String(x?.ramal) === ramal) : null
      if (!ext?.senha || String(ext.domain ?? dominio) !== dominio) { await registrar(ev, 'negado', 'ramal nao encontrado'); return json({ erro: 'sem_ramal' }, 403, origin) }
      await registrar(ev, 'ok')
      return json({
        ok: true, provedor: '4com', wss, dominio, ramal, realm: dominio, ha1: ha1(ramal, dominio, String(ext.senha)),
        uri: `sip:${ramal}@${dominio}`, nome: membro.name ?? ramal,
      }, 200, origin)
    }

    if (acao !== 'telefones' && acao !== 'discar') return json({ erro: 'acao' }, 400, origin)
    // discagem MANUAL (pedido do Gabriel): número digitado no widget; o lead é opcional e só serve para a nota
    const manual = acao === 'discar' && body?.manual === true
    let etype: 'leads' | 'contacts' | null = body?.entity_type === 'contacts' ? 'contacts' : body?.entity_type === 'leads' ? 'leads' : null
    const eid = Number(body?.entity_id)
    if (!etype || !Number.isInteger(eid) || eid <= 0) {
      if (!manual) return json({ erro: 'entidade' }, 400, origin)
      etype = null
    }
    const destino = acao === 'discar' ? telefoneE164(String(body?.telefone ?? '')) : null
    if (acao === 'discar' && !destino) return json({ erro: 'telefone_invalido' }, 400, origin)

    // limite ANTES de qualquer GET (telefones: 30 por 10 min; discar: 15 por 10 min e 2 s entre pedidos — só contra
    // duplo clique; um 429 do provedor bloqueia pelo Retry-After)
    const alvo = etype ? `${etype}:${eid}` : 'manual'
    const ev = acao === 'telefones'
      ? await reservar('telefones', 30, 600, 0, { entidade: alvo })
      : await reservar('discar', 15, 600, 2, { entidade: manual ? `manual${etype ? ' ' + alvo : ''}` : alvo, tel: finalTelefone(destino!) })
    if (!ev) return json({ erro: acao === 'discar' ? 'ja_discando' : 'limite', retry_after: acao === 'discar' ? 2 : 60 }, acao === 'discar' ? 409 : 429, origin)

    // ---------------- entidade: autorização com os objetos devolvidos ----------------
    // manual: a entidade é só para a nota; se não houver ou não for autorizada, liga sem nota
    let d: ReturnType<typeof decidirEntidade> | null = null
    // lookup da entidade: obrigatório no fluxo normal; no MANUAL é auxiliar (só para a nota) — qualquer falha nele
    // (Kommo, orçamento, 429) só suprime a nota; a discagem já foi autorizada por usuário/ramal/limites
    const resolverEntidade = async () => {
      const ent = await kommo(`/api/v4/${etype}/${eid}${etype === 'leads' ? '?with=contacts' : ''}`)
      let dec: ReturnType<typeof decidirEntidade> | null = null
      if (ent) {
        let tarefas: unknown = []
        if (!motivoAutorizacao({ papel: membro.role ?? null, uid, donoEntidade: ent?.responsible_user_id ?? null, temTarefaPropria: false })) {
          const t = await kommo(`/api/v4/tasks?filter[responsible_user_id]=${uid}&filter[is_completed]=0&filter[entity_type]=${etype}&filter[entity_id][]=${eid}&limit=50`)
          tarefas = t?._embedded?.tasks ?? []
        }
        let devolvidos: unknown = []
        if (etype === 'leads') {
          const ids = (Array.isArray(ent?._embedded?.contacts) ? ent._embedded.contacts : []).map((c: any) => Number(c?.id)).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, MAX_CONTATOS)
          if (ids.length) devolvidos = (await kommo(`/api/v4/contacts?${ids.map((id: number) => `filter[id][]=${id}`).join('&')}&limit=${MAX_CONTATOS}`))?._embedded?.contacts ?? []
        }
        dec = decidirEntidade({ uid, papel: membro.role ?? null, etype: etype!, eid, entidade: ent, tarefas, contatosDevolvidos: devolvidos })
      }
      return { ent, dec }
    }
    if (etype) {
      if (manual) { try { d = (await resolverEntidade()).dec } catch (e) { console.warn('[prevendas-voz] manual sem nota:', (e as Error).message); d = null } }
      else { const r0 = await resolverEntidade(); d = r0.dec; if (!r0.ent) { await registrar(ev, 'negado', 'entidade inexistente'); return json({ erro: 'entidade_inexistente' }, 404, origin) } }
      if (!manual && (!d || !d.ok)) { const er = d && !d.ok ? d.erro : 'entidade_inconsistente'; await registrar(ev, 'negado', er); return json({ erro: er }, er === 'sem_permissao' ? 403 : 409, origin) }
    }
    if (acao === 'telefones') {
      await registrar(ev, 'ok')
      // números da lista de TESTE do servidor (só existem durante o teste; a discagem os aceita para esta entidade)
      const teste = [...new Set(String(env('PREVENDAS_VOZ_TELEFONES_TESTE')).split(',').map((x) => telefoneE164(x.trim())).filter(Boolean))]
      return json({ ok: true, contatos: d && d.ok ? d.contatos : [], teste, autorizado_por: d && d.ok ? d.motivo : null }, 200, origin)
    }
    const notaOk = !!(etype && d && d.ok)                               // nota só em entidade autorizada

    // ---------------- discar ----------------
    if (!manual) {
      const daEntidade = !!(d && d.ok) && d.contatos.some((c) => c.telefones.some((t) => t.e164 === destino))
      const deTeste = String(env('PREVENDAS_VOZ_TELEFONES_TESTE')).split(',').map((x) => telefoneE164(x.trim())).includes(destino)
      if (!daEntidade && !deTeste) { await registrar(ev, 'negado', 'telefone fora da entidade'); return json({ erro: 'telefone_fora_da_entidade' }, 403, origin) }
    }

    let r: Response | null = null, corpo: unknown = null, ramalUsado = ramal, t0Post = Date.now()
    if (provedor === '3c') {
      // PREPARAÇÃO (ramal do agente) — prepararAgente3c, testada: falha aqui NUNCA é "incerto" (o /click2call não foi chamado)
      const prep = await prepararAgente3c(async () => { const { r, u } = await usuario3c(); return { status: r.status, retryAfter: r.headers.get('Retry-After'), u } })
      if (prep.tipo === 'limite') {
        const ra = await bloquear('discar', prep.retryAfter)
        await registrar(ev, 'limite', `agente 3c 429 (${ra}s)`)
        return json({ erro: 'provedor_limite', retry_after: ra }, 503, origin)
      }
      if (prep.tipo !== 'ok') {
        await registrar(ev, prep.tipo === 'sem_ramal' ? 'negado' : 'recusado', `agente 3c: ${prep.tipo}`)
        return prep.tipo === 'sem_ramal'
          ? json({ erro: 'sem_ramal' }, 403, origin)
          : json({ erro: 'provedor_indisponivel', mensagem: 'O 3C não respondeu (nenhuma ligação foi feita).' }, 503, origin)
      }
      const c = prep.c
      ramalUsado = c.ramal
      // ENVIO: daqui em diante, falha de rede = incerto (a ligação pode ter saído)
      try {
        t0Post = Date.now()
        r = await fetch(`${API3C}/click2call`, {
          method: 'POST', headers: { Authorization: `Bearer ${token3c}`, 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_DISCAR_MS),
          body: JSON.stringify({ extension: c.ramal, phone: telefone3c(destino!) }),
        })
        try { corpo = await r.json() } catch { corpo = null }
      } catch { r = null }
    } else try {
      t0Post = Date.now()
      r = await fetch(`${API4COM}/calls`, {
        method: 'POST', headers: { Authorization: token4com, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_DISCAR_MS),
        body: JSON.stringify({ extension: ramal, caller: ramal, called: destino, metadata: { origem: 'kommo-widget', kommo_user: uid, entity_type: etype, entity_id: eid } }),
      })
      try { corpo = await r.json() } catch { corpo = null }
    } catch { r = null }
    const msPost = Date.now() - t0Post                                   // quanto o provedor levou para responder
    const res = provedor === '3c' ? interpretar3c(r?.status ?? 0, corpo) : interpretar4com(r?.status ?? 0, corpo)
    if (!res.ok) {
      const ra = r && r.status === 429 ? await bloquear('discar', r) : 0
      await registrar(ev, ra ? 'limite' : res.incerto ? 'incerto' : 'recusado', `${res.erro}: ${res.mensagem} (${msPost} ms)`)
      return json({ erro: res.erro, mensagem: res.mensagem, incerto: !!res.incerto, ...(ra ? { retry_after: ra } : {}) }, res.incerto ? 504 : 502, origin)
    }
    // nota no Kommo (melhor esforço, com prazo PRÓPRIO a partir de agora; a ligação já aconteceu e nunca é repetida)
    let nota = notaOk
    if (notaOk) try {
      await kommo(`/api/v4/${etype}/notes`, { method: 'POST', body: JSON.stringify([{ entity_id: eid, note_type: 'common',
        params: { text: `📞 Ligação ${provedor === '3c' ? '3C' : '4com'} iniciada pelo widget por ${membro.name ?? uid} (ramal ${ramalUsado}) para ${finalTelefone(destino!)}${res.chamada_id ? ` · id ${res.chamada_id}` : ''}` } }]) }, Date.now() + PRAZO_NOTA_MS)
    } catch (e) { nota = false; console.error('[prevendas-voz] nota', (e as Error).message) }
    // auditoria registra a ligação e, se for o caso, a nota pendente (para retomada manual)
    await registrar(ev, 'ok', `${res.chamada_id ? `chamada ${res.chamada_id}` : 'chamada sem id'}${manual ? '; manual' : ''}${notaOk && !nota ? '; NOTA PENDENTE' : ''} (${msPost} ms)`)
    return json({ ok: true, provedor, chamada_id: res.chamada_id, ramal: ramalUsado, nota }, 200, origin)
  } catch (e) {
    const m = (e as Error).message
    console.error('[prevendas-voz]', acao, m)
    if (e instanceof KommoLimite) return json({ erro: 'kommo_429', retry_after: e.retryAfter }, 503, origin)
    if (e instanceof Interrupcao) return json({ erro: 'ocupado', retry_after: 3 }, 503, origin)
    return json({ erro: m === 'falha_banco' ? 'falha_banco' : 'indisponivel' }, 503, origin)
  }
})
