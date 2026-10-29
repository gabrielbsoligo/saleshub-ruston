// =============================================================
// Gerador de Propostas — pipeline server-side (Deno)
// =============================================================
// processarProposta(id): transcrição → análise (LLM) → escopo validado →
// Slides gerado com o token Google do closer (ou da conta reserva) →
// status 'revisao'. Nunca envia nada ao cliente.
// =============================================================
import catalogo from './catalogo-v0.json' with { type: 'json' }
import { criarCliente, ErroGoogle } from './google.mjs'
import { gerarProposta, prepararTemplate } from './gerar.mjs'
import { extrairJson, montarPrompt, normalizarEscopo } from './analise.mjs'
import { validarEscopo } from './slides.mjs'
import { chamarLLM } from './llm.ts'
import { redigir } from './redigir.mjs'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
export const MIN_TRANSCRICAO_CHARS = 200

// Mesmo refresh da edge google-drive. O token nunca sai desta função.
export async function tokenValido(sb: any, memberId: string): Promise<string | null> {
  const { data: m } = await sb.from('team_members')
    .select('google_access_token, google_refresh_token, google_token_expiry')
    .eq('id', memberId).maybeSingle()
  if (!m?.google_access_token) return null
  const expira = m.google_token_expiry ? new Date(m.google_token_expiry).getTime() : 0
  if (expira - Date.now() > 60_000) return m.google_access_token
  if (!m.google_refresh_token) return null
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: m.google_refresh_token, grant_type: 'refresh_token',
    }),
  })
  if (!r.ok) return null
  const t = await r.json()
  await sb.from('team_members').update({
    google_access_token: t.access_token,
    google_token_expiry: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  }).eq('id', memberId)
  return t.access_token
}

async function transcricaoDaReuniao(sb: any, reuniaoId: string): Promise<string> {
  const { data: sess } = await sb.from('reuniao_transcricoes')
    .select('transcript_text, sessao').eq('reuniao_id', reuniaoId).order('sessao', { ascending: true })
  const texto = (sess || []).map((s: any) => (s.transcript_text || '').trim()).filter(Boolean).join('\n\n')
  if (texto.length >= MIN_TRANSCRICAO_CHARS) return texto
  const { data: auto } = await sb.from('post_meeting_automations')
    .select('transcript_text').eq('reuniao_id', reuniaoId).not('transcript_text', 'is', null)
    .order('created_at', { ascending: false }).limit(1)
  return (auto?.[0]?.transcript_text || '').trim()
}

// A reunião só serve se for do deal (mesmo deal, a reunião de origem do deal ou do mesmo lead).
export async function reuniaoDoDeal(sb: any, deal: any, reuniaoId: string): Promise<boolean> {
  const { data: r } = await sb.from('reunioes').select('id, deal_id, lead_id').eq('id', reuniaoId).maybeSingle()
  if (!r) return false
  return r.deal_id === deal.id || r.id === deal.reuniao_id || (!!deal.lead_id && r.lead_id === deal.lead_id)
}

// Reunião informada (validada contra o deal); senão a mais recente do deal com transcrição.
export async function carregarTranscricao(sb: any, deal: any, reuniaoId: string | null) {
  if (reuniaoId) {
    if (!(await reuniaoDoDeal(sb, deal, reuniaoId))) throw new Error('a reunião informada não é deste deal')
    return { reuniao_id: reuniaoId, texto: await transcricaoDaReuniao(sb, reuniaoId) }
  }
  const filtros = [`deal_id.eq.${deal.id}`]
  if (deal.reuniao_id) filtros.push(`id.eq.${deal.reuniao_id}`)
  if (deal.lead_id) filtros.push(`lead_id.eq.${deal.lead_id}`)
  const { data: reunioes } = await sb.from('reunioes').select('id, data_reuniao, show')
    .or(filtros.join(',')).order('data_reuniao', { ascending: false, nullsFirst: false }).limit(10)
  for (const r of reunioes || []) {
    const texto = await transcricaoDaReuniao(sb, r.id)
    if (texto.length >= MIN_TRANSCRICAO_CHARS) return { reuniao_id: r.id, texto }
  }
  return { reuniao_id: null, texto: '' }
}

export async function analisarTranscricao(texto: string, empresa: string, modeloVenda: string | null = null) {
  const prompt = montarPrompt({ transcricao: texto, catalogo, empresa, modeloVenda })
  const { texto: resposta, provedor } = await chamarLLM(prompt)
  const escopo = normalizarEscopo(extrairJson(resposta), { catalogo, empresa, transcricao: texto, modeloVenda })
  const erros = validarEscopo(escopo)
  if (erros.length) throw new Error(`escopo da análise inválido: ${erros.join('; ')}`)
  return { escopo, provedor }
}

async function config(sb: any) {
  const { data } = await sb.from('propostas_config').select('*').eq('id', true).single()
  return data
}

async function atualizar(sb: any, id: string, campos: Record<string, unknown>) {
  const { error } = await sb.from('propostas').update(campos).eq('id', id)
  if (error) throw new Error(`falha ao atualizar proposta: ${error.message}`)
}

// Reivindica a proposta (pendente → analisando) de forma atômica.
async function reivindicar(sb: any, id: string): Promise<any | null> {
  const { data } = await sb.from('propostas').update({ status: 'analisando', erro: null })
    .eq('id', id).eq('status', 'pendente').select('*').maybeSingle()
  return data
}

export async function processarProposta(sb: any, id: string) {
  const p = await reivindicar(sb, id)
  if (!p) return { id, pulada: true }
  try {
    const cfg = await config(sb)
    if (!cfg?.template_id) throw new Error('template não configurado (propostas_config.template_id)')
    const { data: deal } = await sb.from('deals').select('id, empresa, closer_id, lead_id, reuniao_id').eq('id', p.deal_id).single()
    if (!deal) throw new Error('deal não encontrado')

    if (p.reuniao_id && !(await reuniaoDoDeal(sb, deal, p.reuniao_id))) throw new Error('a reunião informada não é deste deal')
    let reuniaoId = p.reuniao_id
    let texto = (p.transcricao_manual || '').trim()
    if (texto.length < MIN_TRANSCRICAO_CHARS) {
      const t = await carregarTranscricao(sb, deal, p.reuniao_id)
      texto = t.texto
      reuniaoId = reuniaoId || t.reuniao_id
    }
    if (texto.length < MIN_TRANSCRICAO_CHARS) {
      throw new Error('sem transcrição da reunião (busque no Meet ou cole o texto)')
    }

    const { escopo, provedor } = await analisarTranscricao(texto, deal.empresa)
    await atualizar(sb, id, { status: 'gerando', escopo, reuniao_id: reuniaoId, provedor_llm: provedor })

    // Conta Google: closer do deal; se não tiver conexão/permissão, a conta reserva.
    const contas = [deal.closer_id, cfg.conta_reserva_member_id].filter((v, i, a) => v && a.indexOf(v) === i)
    const { data: membros } = await sb.from('team_members').select('id, email').in('id', contas.length ? contas : ['00000000-0000-0000-0000-000000000000'])
    const emailDe = (mid: string) => (membros || []).find((m: any) => m.id === mid)?.email || null
    const closerEmail = deal.closer_id ? emailDe(deal.closer_id) : null

    let resultado: any = null
    let usado: string | null = null
    const falhas: string[] = []
    for (const mid of contas) {
      const token = await tokenValido(sb, mid)
      if (!token) { falhas.push(`${emailDe(mid) || mid}: sem conexão Google válida`); continue }
      try {
        const editores = closerEmail && closerEmail !== emailDe(mid) ? [closerEmail] : []
        resultado = await gerarProposta(criarCliente(token), {
          templateId: cfg.template_id, escopo, pastaId: cfg.pasta_id || undefined,
          editores, dominio: cfg.dominio || null,
        })
        usado = mid
        break
      } catch (e: any) {
        // Cópia criada e não apagada: parar (não criar outra com a reserva).
        if (e?.limpeza && e.limpeza.apagada === false) throw e
        // Permissão/escopo (401/403/404) com cópia inexistente ou já apagada → próxima conta.
        if (e instanceof ErroGoogle && [401, 403, 404].includes(e.status)) { falhas.push(`${emailDe(mid) || mid}: ${e.message}`); continue }
        throw e
      }
    }
    if (!resultado) throw new Error(`nenhuma conta Google conseguiu gerar: ${falhas.join(' | ')}`)

    await atualizar(sb, id, {
      status: 'revisao',
      presentation_id: resultado.id,
      url: resultado.url,
      pendencias: resultado.pendencias,
      gerado_com_member_id: usado,
      erro: falhas.length ? `gerada com a conta reserva (${falhas.join(' | ')})` : null,
    })
    return { id, status: 'revisao', url: resultado.url, pendencias: resultado.pendencias }
  } catch (e) {
    const msg = redigir((e as Error).message || 'erro desconhecido')
    await atualizar(sb, id, { status: 'erro', erro: msg.slice(0, 2000) }).catch(() => {})
    return { id, status: 'erro', erro: msg }
  }
}

// Proposta presa em analisando/gerando há mais de 15 min → erro (edge morreu no meio).
export async function destravar(sb: any) {
  const limite = new Date(Date.now() - 15 * 60_000).toISOString()
  await sb.from('propostas').update({ status: 'erro', erro: 'processamento interrompido (tente gerar de novo)' })
    .in('status', ['analisando', 'gerando']).lt('updated_at', limite)
}

export async function prepararTemplateComMembro(sb: any, memberId: string, templateId: string) {
  const token = await tokenValido(sb, memberId)
  if (!token) throw new Error('sua conta não tem conexão Google válida (reconecte no SalesHub)')
  return prepararTemplate(criarCliente(token), templateId)
}
