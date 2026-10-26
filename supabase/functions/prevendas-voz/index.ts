// prevendas-voz — telefone do widget ruston-prevendas (webphone WebRTC no próprio Kommo, provedor 4com).
// POST + header X-Auth-Token (JWT descartável do Kommo, via self.$authorizedAjax). Ações:
//   { acao: 'credencial' }                                  → credencial SIP do PRÓPRIO ramal (HA1, nunca a senha)
//   { acao: 'telefones', entity_type, entity_id }           → telefones dos contatos da entidade (se autorizado)
//   { acao: 'discar', entity_type, entity_id, telefone }    → POST /calls da 4com: liga para o ramal do usuário
//                                                             (o widget atende sozinho) e depois para o telefone
// Segurança (fail-closed em todos os passos):
//  - JWT HS256 do Kommo (conta, emissor, integração, validade) → team_members ATIVO;
//  - lista de usuários liberados no SERVIDOR (PREVENDAS_VOZ_USUARIOS; vazia = ninguém);
//  - credencial só do ramal do próprio usuário (team_members.ramal_4com); senha buscada na 4com na hora, HA1
//    calculado aqui, resposta com Cache-Control: no-store; nada sensível em log;
//  - discar: entidade autorizada (gestor, dono ou tarefa aberta própria, conferidos AO VIVO) e telefone que
//    pertence a um contato da entidade (ou à lista de teste PREVENDAS_VOZ_TELEFONES_TESTE);
//  - limite por usuário no banco (prevendas_voz_reservar) e log de auditoria (prevendas_voz_eventos).
// Env: KOMMO_WIDGET_SECRET, KOMMO_WIDGET_CLIENT_ID, KOMMO_ACCOUNT_ID, KOMMO_API_TOKEN, API4COM_TOKEN,
//      API4COM_DOMAIN, API4COM_WSS, PREVENDAS_VOZ_USUARIOS, PREVENDAS_VOZ_TELEFONES_TESTE?
// Deploy: verify_jwt=false (a autenticação é o JWT do Kommo).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verificarJwtKommo } from '../_shared/kommo_jwt.ts'
import {
  finalTelefone, ha1, interpretar4com, motivoAutorizacao, telefoneE164, telefonesDosContatos, usuarioLiberado,
  type ContatoKommo,
} from '../_shared/prevendas_voz.ts'

const SUB = 'financeirorustonengenhariacombr'
const KOMMO = `https://${SUB}.kommo.com`
const API4COM = 'https://api.api4com.com/api/v1'
const TIMEOUT_MS = 8_000, TIMEOUT_DISCAR_MS = 45_000   // o POST /calls da 4com só responde quando a chamada conecta
const MAX_CONTATOS = 10

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

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
  if (req.method !== 'POST') return json({ erro: 'metodo' }, 405, origin)

  const env = (k: string) => Deno.env.get(k) ?? ''
  const secret = env('KOMMO_WIDGET_SECRET'), clientId = env('KOMMO_WIDGET_CLIENT_ID'), contaId = env('KOMMO_ACCOUNT_ID')
  const token4com = env('API4COM_TOKEN'), dominio = env('API4COM_DOMAIN'), wss = env('API4COM_WSS')
  if (!secret || !clientId || !contaId || !env('KOMMO_API_TOKEN') || !token4com || !dominio || !wss) return json({ erro: 'nao_configurado' }, 503, origin)

  // 1) identidade
  const v = await verificarJwtKommo(req.headers.get('X-Auth-Token') ?? '', { secret, contaId, host: `${SUB}.kommo.com`, clientId })
  if (!v.ok) return json({ erro: v.erro }, 401, origin)
  const uid = v.userId
  if (!usuarioLiberado(env('PREVENDAS_VOZ_USUARIOS'), uid)) return json({ erro: 'voz_nao_liberada' }, 403, origin)
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: membro, error: eM } = await sb.from('team_members').select('name,role,active,ramal_4com').eq('kommo_user_id', uid).maybeSingle()
  if (eM) return json({ erro: 'falha_banco' }, 503, origin)
  if (!membro?.active) return json({ erro: 'usuario_inativo' }, 403, origin)
  const ramal = String(membro.ramal_4com ?? '').trim()
  if (!/^\d{2,8}$/.test(ramal)) return json({ erro: 'sem_ramal' }, 403, origin)

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const acao = String(body?.acao ?? '')

  const reservar = async (a: 'credencial' | 'discar', max: number, janela: number, intervalo: number, entidade?: string, tel?: string) => {
    const { data, error } = await sb.rpc('prevendas_voz_reservar', {
      p_user: uid, p_acao: a, p_max: max, p_janela_s: janela, p_intervalo_s: intervalo, p_entidade: entidade ?? null, p_telefone: tel ?? null,
    })
    if (error) throw new Error('falha_banco')
    return data as number | null
  }
  const registrar = (id: number, resultado: string, detalhe?: string) =>
    sb.rpc('prevendas_voz_registrar', { p_id: id, p_resultado: resultado, p_detalhe: detalhe ?? null })

  try {
    // ---------------- credencial SIP do próprio ramal ----------------
    if (acao === 'credencial') {
      const ev = await reservar('credencial', 12, 600, 0)
      if (!ev) return json({ erro: 'limite', retry_after: 60 }, 429, origin)
      const filtro = encodeURIComponent(JSON.stringify({ where: { ramal }, fields: { ramal: true, senha: true, domain: true } }))
      const r = await fetch(`${API4COM}/extensions?filter=${filtro}`, { headers: { Authorization: token4com }, signal: AbortSignal.timeout(TIMEOUT_MS) })
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

    // ---------------- entidade: autorização ao vivo ----------------
    const etype = body?.entity_type === 'contacts' ? 'contacts' : body?.entity_type === 'leads' ? 'leads' : null
    const eid = Number(body?.entity_id)
    if (!etype || !Number.isInteger(eid) || eid <= 0) return json({ erro: 'entidade' }, 400, origin)
    const kommo = async (path: string, init?: RequestInit) => {
      const r = await fetch(`${KOMMO}${path}`, { ...init, headers: { Authorization: `Bearer ${env('KOMMO_API_TOKEN')}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (r.status === 204) return null
      if (r.status === 404) return null
      if (r.status === 429) throw new Error('kommo_429')
      if (!r.ok) throw new Error(`kommo ${r.status}`)
      return r.json()
    }
    const ent = await kommo(`/api/v4/${etype}/${eid}${etype === 'leads' ? '?with=contacts' : ''}`)
    if (!ent) return json({ erro: 'entidade_inexistente' }, 404, origin)
    let temTarefa = false
    const motivo0 = motivoAutorizacao({ papel: membro.role ?? null, uid, donoEntidade: ent.responsible_user_id ?? null, temTarefaPropria: false })
    if (!motivo0) {
      const t = await kommo(`/api/v4/tasks?filter[responsible_user_id]=${uid}&filter[is_completed]=0&filter[entity_type]=${etype}&filter[entity_id][]=${eid}&limit=1`)
      temTarefa = (t?._embedded?.tasks ?? []).length > 0
    }
    const motivo = motivo0 ?? motivoAutorizacao({ papel: membro.role ?? null, uid, donoEntidade: ent.responsible_user_id ?? null, temTarefaPropria: temTarefa })
    if (!motivo) return json({ erro: 'sem_permissao' }, 403, origin)

    // contatos (do lead) ou o próprio contato
    let contatos: ContatoKommo[] = []
    if (etype === 'contacts') contatos = [ent]
    else {
      const ids = (ent?._embedded?.contacts ?? []).map((c: any) => Number(c.id)).filter(Boolean).slice(0, MAX_CONTATOS)
      if (ids.length) {
        const j = await kommo(`/api/v4/contacts?${ids.map((id: number) => `filter[id][]=${id}`).join('&')}&limit=${MAX_CONTATOS}`)
        contatos = j?._embedded?.contacts ?? []
      }
    }
    const lista = telefonesDosContatos(contatos)
    if (acao === 'telefones') return json({ ok: true, contatos: lista, autorizado_por: motivo }, 200, origin)

    // ---------------- discar ----------------
    const destino = telefoneE164(String(body?.telefone ?? ''))
    if (!destino) return json({ erro: 'telefone_invalido' }, 400, origin)
    const daEntidade = lista.some((c) => c.telefones.some((t) => t.e164 === destino))
    const deTeste = String(env('PREVENDAS_VOZ_TELEFONES_TESTE')).split(',').map((x) => telefoneE164(x.trim())).includes(destino)
    if (!daEntidade && !deTeste) return json({ erro: 'telefone_fora_da_entidade' }, 403, origin)

    // 4com: 15 por minuto por ramal; aqui 1 a cada 20 s e 15 por 10 min por usuário
    const ev = await reservar('discar', 15, 600, 20, `${etype}:${eid}`, finalTelefone(destino))
    if (!ev) return json({ erro: 'ja_discando', retry_after: 20 }, 409, origin)
    let r: Response | null = null, corpo: unknown = null
    try {
      r = await fetch(`${API4COM}/calls`, {
        method: 'POST', headers: { Authorization: token4com, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_DISCAR_MS),
        body: JSON.stringify({ extension: ramal, caller: ramal, called: destino, metadata: { origem: 'kommo-widget', kommo_user: uid, entity_type: etype, entity_id: eid } }),
      })
      try { corpo = await r.json() } catch { corpo = null }
    } catch { r = null }
    const res = interpretar4com(r?.status ?? 0, corpo)
    if (!res.ok) {
      await registrar(ev, res.incerto ? 'incerto' : 'recusado', `${res.erro}: ${res.mensagem}`)
      return json({ erro: res.erro, mensagem: res.mensagem, incerto: !!res.incerto }, res.incerto ? 504 : 502, origin)
    }
    await registrar(ev, 'ok', res.chamada_id ? `chamada ${res.chamada_id}` : undefined)
    // nota no Kommo (melhor esforço: a ligação já aconteceu)
    let nota = true
    try {
      await kommo(`/api/v4/${etype}/notes`, { method: 'POST', body: JSON.stringify([{ entity_id: eid, note_type: 'common',
        params: { text: `📞 Ligação 4com iniciada pelo widget por ${membro.name ?? uid} (ramal ${ramal}) para ${finalTelefone(destino)}${res.chamada_id ? ` · id ${res.chamada_id}` : ''}` } }]) })
    } catch { nota = false }
    return json({ ok: true, chamada_id: res.chamada_id, ramal, nota }, 200, origin)
  } catch (e) {
    const m = (e as Error).message
    console.error('[prevendas-voz]', acao, m)
    if (m === 'kommo_429') return json({ erro: 'kommo_429', retry_after: 60 }, 503, origin)
    return json({ erro: m === 'falha_banco' ? 'falha_banco' : 'indisponivel' }, 503, origin)
  }
})
