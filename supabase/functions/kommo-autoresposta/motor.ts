// Motor da triagem com dependências injetadas (repositório + Kommo + relógio), pra ser testado
// com fakes em motor_test.ts. A edge (index.ts) só faz o wiring (Supabase, HTTP, segredo).
//
// Unidades de trabalho:
//   TRABALHO  = um webhook do Salesbot (ou retomada do cron) para um lead. Nasce no banco ANTES de
//               qualquer leitura no Kommo; se algo falha, fica pendente e o cron retoma.
//   MENSAGEM  = um evento incoming_chat_message do Kommo. Toda mensagem nova ganha linha; a mais
//               recente recebe o texto do campo e é decidida; as anteriores sem linha ficam
//               'superado' (texto indisponível) — nunca há mensagem sem registro nem decidida 2x.
//   EFEITO    = claim com token + lease renovável; decisão imutável sob posse; config relida após
//               o claim; fases do efeito gravadas (nota com marcador e reconciliação) — retomada
//               nunca duplica nem aplica em cima de quem reassumiu.
import { casaPadrao, classificar, normalizar, palavras, podeAplicar, resolverIndeterminado, sha1, validarPadroes, type Cfg, type Padrao } from './triagem.ts'

export type Resultado = Record<string, any>
export class LeituraFalhou extends Error { constructor(public etapa: string, msg: string) { super(`${etapa}: ${msg}`) } }
export class Throttled extends Error { constructor(public esperaS: number) { super(`429: esperar ${esperaS}s`) } }

export type KommoResp = { ok: boolean; status: number; body: any }
/** Cliente Kommo. `opts.retries` limita retentativas (POST de nota usa 0: não é idempotente). */
export type KommoFn = (m: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown, opts?: { etapa?: string; retries?: number; pararEm429?: boolean }) => Promise<KommoResp>

export type Trabalho = { id: number; kommo_lead_id: number | null; tentativas: number; mensagem_id?: string | null; texto?: string | null; recebido_em?: string | null; contact_id?: number | null }
/** Mensagem trazida pelo webhook de conta (add_message): identidade, instante e texto direto. */
export type MensagemRecebida = { id: string; ts: number; texto: string }
export type Linha = {
  id: number; kommo_lead_id: number; mensagem_id: string; pipeline_id: number; status_id_origem: number | null
  texto: string | null; hash: string | null; recebido_em: string; ultimo_disparo_em: string | null; intervalo_s: number | null
  classificacao: 'autoresposta' | 'humano' | 'indeterminado'; regras: string[]; decidido_em: string | null
  estado_efeito: 'pendente' | 'em_andamento' | 'aplicado' | 'observado' | 'superado' | 'falhou'
  claim_token: string | null; efeito_fase: string | null; tentativas: number; modo: string
}
export interface Repo {
  padroesAtivos(): Promise<Padrao[]>
  config(pipeline: number): Promise<Cfg | null>              // sempre relê (sem cache)
  // trabalho
  /** idempotente por mensagem_id (reentrega do lote devolve o trabalho já existente) */
  criarTrabalho(leadId: number | null, msg?: MensagemRecebida | null, contactId?: number | null): Promise<Trabalho>
  vincularLead(trabalhoId: number, leadId: number): Promise<void>
  /** enriquece o texto de uma linha ainda NÃO decidida (pendente, sem decisão final); devolve se gravou */
  atualizarTexto(id: number, texto: string): Promise<boolean>
  concluirTrabalho(id: number, estado: 'concluido' | 'pendente' | 'descartado', erro?: string | null): Promise<void>
  trabalhosPendentes(limite: number): Promise<Trabalho[]>
  // mensagens
  linhasDoLead(leadId: number): Promise<Linha[]>
  criarLinhas(linhas: Partial<Linha>[]): Promise<void>       // ignora duplicadas (lead+mensagem)
  linha(leadId: number, mensagemId: string): Promise<Linha>
  /** grava a decisão só se a linha está livre (pendente, sem lease viva E sem decisão final) — devolve a linha após a gravação */
  decidir(id: number, dec: { texto: string; texto_norm: string; hash: string; repeticoes: number; padrao_id: number | null; classificacao: Linha['classificacao']; regras: string[]; decidido_em: string | null; intervalo_s: number | null; ultimo_disparo_em: string | null; modo: string; tentativas?: number }): Promise<Linha | null>
  outrosLeadsComHash(hash: string, leadId: number, desde: string): Promise<number>
  superar(leadId: number, excetoId: number | null, antesDe: string | null, motivo: string, opts?: { somenteSemTexto?: boolean }): Promise<void>
  // efeito
  /** claim atômico: devolve o token E a fotografia da linha como ficou no banco sob a posse (decisão, fase, origem) */
  claim(id: number, leaseS: number): Promise<{ token: string; linha: Linha } | null>
  renovar(id: number, token: string, leaseS: number): Promise<boolean>
  fase(id: number, token: string, fase: string, extra?: Record<string, unknown>): Promise<boolean>
  fim(id: number, token: string, estado: Linha['estado_efeito'], extra: Record<string, unknown>): Promise<boolean>
  acerto(padraoId: number): Promise<void>
  pendentesEfeito(limite: number): Promise<Linha[]>          // pendente/falhou/lease vencida + indeterminados
}
export type Deps = { repo: Repo; kommo: KommoFn; agora: () => number; campoTexto: string; leaseS: number; maxTentativas: number }

// Mensagem recebida no CONTATO (sem lead no payload): lead do contato que esteja ABERTO numa etapa de
// origem de um funil com triagem ativa. Lê TODOS os leads do contato; leitura que falha = LeituraFalhou
// (trabalho fica pendente); 0 candidatos = null (ignora); >1 = ambíguo (null + motivo).
export async function leadPeloContato(deps: Deps, contactId: number): Promise<{ leadId: number | null; motivo: string }> {
  const r = await deps.kommo('GET', `/api/v4/contacts/${contactId}?with=leads`, undefined, { etapa: 'contato', retries: 1 })
  if (r.status === 404 || r.status === 204) return { leadId: null, motivo: 'contato não existe' }
  if (!r.ok) throw new LeituraFalhou('contato', `HTTP ${r.status}`)
  const lista = r.body?._embedded?.leads
  if (!Array.isArray(lista)) throw new LeituraFalhou('contato', 'envelope inesperado')
  const ids = lista.map((l: any) => Number(l?.id)).filter((n: number) => Number.isFinite(n) && n > 0)
  const candidatos: number[] = []
  for (const id of ids) {
    const l = await deps.kommo('GET', `/api/v4/leads/${id}`, undefined, { etapa: 'lead_do_contato', retries: 1 })
    if (l.status === 404 || l.status === 204) continue
    if (!l.ok || !l.body || !Number.isFinite(Number(l.body.pipeline_id))) throw new LeituraFalhou('lead_do_contato', `HTTP ${l.status}`) // leitura incompleta nunca autoriza escolher
    const cfg = await deps.repo.config(Number(l.body.pipeline_id))
    if (!cfg?.ativo) continue
    if (cfg.etapas_origem?.length && !cfg.etapas_origem.map(Number).includes(Number(l.body.status_id))) continue
    candidatos.push(id)
  }
  if (candidatos.length === 1) return { leadId: candidatos[0], motivo: 'único lead aberto em etapa de origem' }
  return { leadId: null, motivo: candidatos.length === 0 ? 'nenhum lead do contato em etapa de origem' : `ambíguo: ${candidatos.length} leads elegíveis` }
}

const TAG_AUTO = 'autoresposta'
// último disparo (outgoing) ANTES da mensagem — independente da ordem em que os eventos vieram
export const ultimoDisparoAte = (outs: number[], ts: number): number | null => {
  let m: number | null = null
  for (const o of outs) if (Number.isFinite(o) && o <= ts && (m === null || o > m)) m = o
  return m
}
const iso = (s: number) => new Date(s * 1000).toISOString()
const marcador = (mensagemId: string) => `[triagem:${mensagemId}]`

// ── validações de formato (resposta 200 com envelope inesperado = leitura falhou, não evidência) ──
function eventos(r: KommoResp, etapa: string): any[] {
  if (r.status === 204) return []
  if (!r.ok) throw new LeituraFalhou(etapa, `HTTP ${r.status}`)
  const ev = r.body?._embedded?.events
  if (!Array.isArray(ev)) throw new LeituraFalhou(etapa, 'envelope inesperado')
  return ev
}
function leadValido(r: KommoResp, etapa: string) {
  if (r.status === 404) return null
  if (!r.ok) throw new LeituraFalhou(etapa, `HTTP ${r.status}`)
  if (!r.body || !Number.isFinite(Number(r.body.id)) || !Number.isFinite(Number(r.body.pipeline_id)) || !Number.isFinite(Number(r.body.status_id))) throw new LeituraFalhou(etapa, 'envelope inesperado')
  return r.body
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// 1) WEBHOOK: cria o trabalho ANTES de ler o Kommo e processa; se falhar, fica pendente pro cron.
// ──────────────────────────────────────────────────────────────────────────────────────────
// ── Correlação canônica webhook × /events (pura, usada no trabalho E na varredura).
// Identidade = id da mensagem. Regras:
//  * evento COM id: é essa mensagem (ids conhecidos e distintos NUNCA se fundem por horário);
//  * evento SEM id (value_after sem message.id): só é alinhado a uma âncora de identidade comprovada
//    (mensagem do webhook ou linha já registrada) se houver EXATAMENTE uma âncora a ≤ 2 s; zero ou
//    mais de uma (ambíguo) → ignorado: nunca vira "outra mensagem" nem cria linha;
//  * a mensagem do webhook (âncora primária) está SEMPRE no resultado, com o próprio id.
export type MsgRef = { id: string; ts: number }
export function correlacionar(eventos: { id: string; ts: number }[], ancoras: MsgRef[], primaria: MsgRef | null): MsgRef[] {
  const todasAncoras: MsgRef[] = primaria ? [primaria, ...ancoras.filter((a) => a.id !== primaria.id)] : ancoras
  const vistos = new Map<string, MsgRef>()
  const por = (r: MsgRef) => { if (!vistos.has(r.id)) vistos.set(r.id, r) }
  if (primaria) por(primaria)
  for (const e of eventos) {
    if (!Number.isFinite(e.ts)) continue
    if (e.id) { por({ id: e.id, ts: e.ts }); continue }
    const perto = todasAncoras.filter((a) => Math.abs(a.ts - e.ts) <= 2)
    if (perto.length === 1) por({ id: perto[0].id, ts: perto[0].ts })
  }
  return [...vistos.values()].sort((a, b) => a.ts - b.ts)
}
const refDaLinha = (l: Linha): MsgRef => ({ id: l.mensagem_id, ts: Math.floor(new Date(l.recebido_em).getTime() / 1000) })
const eventosIn = (body: any, etapa: string) => eventos(body, etapa).map((e: any) => ({ id: String(e.value_after?.[0]?.message?.id ?? ''), ts: Number(e.created_at) }))

export async function receberWebhook(deps: Deps, leadId: number | null, msg: MensagemRecebida | null = null, contactId: number | null = null): Promise<Resultado> {
  const t = await deps.repo.criarTrabalho(leadId, msg, contactId)
  try {
    const r = await processarTrabalho(deps, t)
    return { trabalho: t.id, ...r }
  } catch (e) {
    await deps.repo.concluirTrabalho(t.id, 'pendente', (e as Error).message)
    throw e
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// 2) TRABALHO: descobre mensagens novas do lead, registra todas, decide a mais recente, aplica.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function processarTrabalho(deps: Deps, t: Trabalho): Promise<Resultado> {
  const { repo, kommo } = deps
  // mensagem no contato: resolve o lead AQUI (o trabalho já está durável); falha de leitura lança
  let leadId = t.kommo_lead_id
  if (!leadId) {
    if (!t.contact_id) { await repo.concluirTrabalho(t.id, 'descartado', 'sem lead nem contato'); return { skipped: true, motivo: 'sem lead nem contato' } }
    const r = await leadPeloContato(deps, t.contact_id)
    if (!r.leadId) { await repo.concluirTrabalho(t.id, 'descartado', r.motivo); return { skipped: true, motivo: r.motivo } }
    leadId = r.leadId
    await repo.vincularLead(t.id, leadId)
  }
  const lead = leadValido(await kommo('GET', `/api/v4/leads/${leadId}`, undefined, { etapa: 'lead' }), 'lead')
  if (!lead) { await repo.concluirTrabalho(t.id, 'descartado', 'lead não existe'); return { skipped: true, motivo: 'lead não existe' } }
  const pipeline = Number(lead.pipeline_id), statusAtual = Number(lead.status_id)
  const cfg = await repo.config(pipeline)
  if (!cfg) { await repo.concluirTrabalho(t.id, 'descartado', 'funil sem config'); return { skipped: true, motivo: 'funil sem config', pipeline } }
  if (!cfg.ativo) { await repo.concluirTrabalho(t.id, 'descartado', 'funil desligado'); return { skipped: true, motivo: 'funil com triagem desligada', pipeline } }
  // Elegibilidade de ETAPA só vale pra APLICAR (podeAplicar). Em observar registra-se sempre.

  const agora = deps.agora()
  const de = agora - 14 * 86400
  const ins = eventosIn(await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=incoming_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_in' }), 'eventos_in')
  const outs = eventos(await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=outgoing_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_out' }), 'eventos_out')
    .map((e) => Number(e.created_at)).filter(Number.isFinite).sort((a, b) => a - b)

  // A mensagem do webhook é a fonte primária (id + instante + texto) e SEMPRE ganha linha própria.
  // Correlação com /events em correlacionar(): por id; evento sem id só se alinha a uma âncora única ≤ 2 s.
  const msgWebhook: MensagemRecebida | null = t.mensagem_id ? { id: String(t.mensagem_id), ts: Math.floor(new Date(t.recebido_em ?? Date.now()).getTime() / 1000), texto: String(t.texto ?? '') } : null
  const existentes = await repo.linhasDoLead(leadId)
  const todas = correlacionar(ins, existentes.map(refDaLinha), msgWebhook ? { id: msgWebhook.id, ts: msgWebhook.ts } : null)
  if (!todas.length) {
    const estado = t.tentativas + 1 >= deps.maxTentativas ? 'descartado' : 'pendente'
    await repo.concluirTrabalho(t.id, estado, 'sem mensagem recebida nos eventos')
    return { pendente: estado === 'pendente', motivo: 'sem mensagem recebida nos eventos (ainda)' }
  }

  // registra TODA mensagem sem linha; a linha da mensagem do webhook já nasce com o texto
  const temLinha = new Set(existentes.map((l) => l.mensagem_id))
  const novas = todas.filter((i) => !temLinha.has(i.id))
  if (novas.length) {
    await repo.criarLinhas(novas.map((i) => {
      const disparo = ultimoDisparoAte(outs, i.ts)
      const texto = msgWebhook && i.id === msgWebhook.id && msgWebhook.texto ? msgWebhook.texto.slice(0, 2000) : null
      return { kommo_lead_id: leadId, mensagem_id: i.id, pipeline_id: pipeline, status_id_origem: statusAtual, recebido_em: iso(i.ts), ultimo_disparo_em: disparo ? iso(disparo) : null, intervalo_s: disparo ? i.ts - disparo : null, modo: cfg.modo, classificacao: 'indeterminado', regras: ['nova'], estado_efeito: 'pendente', texto, origem: texto != null ? 'webhook' : 'eventos' }
    }))
  }
  // o trabalho decide a SUA mensagem (webhook) — ou, sem webhook (cron/legado), a mais recente
  const alvoId = msgWebhook ? msgWebhook.id : todas[todas.length - 1].id
  let linha = await repo.linha(leadId, alvoId)
  if (msgWebhook?.texto && !(linha.texto ?? '').trim() && linha.estado_efeito === 'pendente' && !linha.decidido_em) {
    if (await repo.atualizarTexto(linha.id, msgWebhook.texto.slice(0, 2000))) linha = await repo.linha(leadId, alvoId) // linha criada por outro caminho sem texto: enriquece
  }
  // Outras mensagens do lead NÃO são superadas por tabela: cada uma é decidida pelo próprio webhook
  // (o texto pode chegar depois, fora de ordem); linha só de /events sem texto é resolvida pelo cron
  // (após as tentativas vira 'superado', nunca decisão). Conflito de efeito é resolvido na revalidação
  // do lead (quem chega depois de o lead ter saído da etapa fica 'superado').
  const r = await decidirEAplicar(deps, cfg, lead, linha, todas, outs)
  await repo.concluirTrabalho(t.id, 'concluido')
  return r
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// 3) DECISÃO de uma linha (texto do campo, R1/R2/R3) e EFEITO (claim → relê config/lead → aplica)
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function decidirEAplicar(deps: Deps, cfg: Cfg, lead: any, linhaIn: Linha, ins: { id: string; ts: number }[], outs: number[]): Promise<Resultado> {
  const { repo, kommo } = deps
  let linha = linhaIn
  if (['aplicado', 'observado', 'superado'].includes(linha.estado_efeito)) return { ok: true, repetida: true, classificacao: linha.classificacao, estado: linha.estado_efeito }
  const msgTs = Math.floor(new Date(linha.recebido_em).getTime() / 1000)
  const ultimoDisparo = ultimoDisparoAte(outs, msgTs) // não depende da ordem dos eventos (webhook ordena; cron não)
  const intervaloS = ultimoDisparo ? msgTs - ultimoDisparo : null
  // "2ª mensagem" = OUTRA mensagem do lead desde o disparo (antes ou depois desta), exceto as que já
  // foram classificadas como autoresposta (menu + "transferindo" é o bot, não conversa): uma
  // pendência R2 anterior ('ok') seguida de 'quero entender' resolve humano nesta chamada.
  const bots = new Set((await repo.linhasDoLead(linha.kommo_lead_id)).filter((l) => l.classificacao === 'autoresposta').map((l) => l.mensagem_id))
  const depois = ins.filter((i) => i.id !== linha.mensagem_id && i.ts >= (ultimoDisparo ?? 0) && !bots.has(i.id)).length

  // decisão só enquanto a linha está livre (pendente, sem lease): depois do claim ela é imutável
  if (linha.estado_efeito === 'pendente' && (linha.classificacao === 'indeterminado' || !linha.decidido_em)) {
    let texto = (linha.texto ?? '').trim()
    if (!texto && deps.campoTexto) {
      // fallback legado (Salesbot gravando {{message_text}} num campo). Com o webhook de conta o texto
      // já vem na linha; se o campo não existir, segue sem texto (caminho texto_vazio → mídia).
      const campos = await kommo('GET', `/api/v4/leads/custom_fields?limit=250`, undefined, { etapa: 'campos' })
      if (!campos.ok) throw new LeituraFalhou('campos', `HTTP ${campos.status}`)
      const lista = campos.body?._embedded?.custom_fields
      if (!Array.isArray(lista)) throw new LeituraFalhou('campos', 'envelope inesperado')
      const campo = lista.find((f: any) => String(f.name).toLowerCase() === deps.campoTexto.toLowerCase())
      if (campo) {
        const cf = (lead.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === Number(campo.id))
        texto = String(cf?.values?.[0]?.value ?? '').trim()
      }
    }
    if (!texto) {
      const tent = Number(linha.tentativas ?? 0) + 1
      if (tent < deps.maxTentativas) {
        await repo.decidir(linha.id, { texto: '', texto_norm: '', hash: '', repeticoes: 0, padrao_id: null, classificacao: 'indeterminado', regras: ['texto_vazio'], decidido_em: null, intervalo_s: intervaloS, ultimo_disparo_em: ultimoDisparo ? iso(ultimoDisparo) : null, modo: cfg.modo, tentativas: tent })
        return { ok: true, classificacao: 'indeterminado', motivo: 'texto vazio; aguardando releitura' }
      }
      // sem texto depois das tentativas: linha que veio só de /events (o webhook nunca trouxe esta
      // mensagem) não vira decisão — fica superada. Só o webhook sabe dizer "mídia" (parser).
      const posse = await repo.claim(linha.id, deps.leaseS)
      if (posse) await repo.fim(linha.id, posse.token, 'superado', { motivo_efeito: 'texto indisponível (só /events)' })
      return { ok: true, estado: 'superado', motivo: 'texto indisponível' }
    }
    const padroes = await repo.padroesAtivos()
    const invalidos = validarPadroes(padroes)
    if (invalidos.length) throw new LeituraFalhou('padroes', `regex inválida: ${invalidos.join(', ')}`) // fail closed
    const norm = normalizar(texto)
    const hash = await sha1(norm || `vazio:${linha.kommo_lead_id}`)
    const outros = await repo.outrosLeadsComHash(hash, linha.kommo_lead_id, iso(deps.agora() - 30 * 86400))
    const padrao = texto === '[midia]' ? ({ id: 0, padrao: '', tipo: 'humano' } as Padrao) : casaPadrao(texto, padroes)
    let cls = classificar({ texto, intervaloS, outrosLeadsMesmoTexto: outros, padrao, cfg, msgsRecebidasDepois: depois })
    if (cls.classificacao === 'indeterminado' && deps.agora() >= msgTs + cfg.espera_s) {
      const r = resolverIndeterminado(depois, outros, palavras(norm), cfg)
      cls = { classificacao: r.final, regras: [...cls.regras, r.motivo] }
    }
    const gravada = await repo.decidir(linha.id, { texto: texto.slice(0, 2000), texto_norm: norm.slice(0, 2000), hash, repeticoes: outros, padrao_id: padrao && padrao.id > 0 ? padrao.id : null, classificacao: cls.classificacao, regras: cls.regras, decidido_em: cls.classificacao === 'indeterminado' ? null : iso(deps.agora()), intervalo_s: intervaloS, ultimo_disparo_em: ultimoDisparo ? iso(ultimoDisparo) : null, modo: cfg.modo })
    if (!gravada) return { ok: true, motivo: 'linha em posse de outro worker; decisão não alterada' }
    linha = gravada
    if (padrao && padrao.id > 0) await repo.acerto(padrao.id)
    if (linha.classificacao === 'indeterminado') return { ok: true, classificacao: 'indeterminado', regras: linha.regras, aguardando_s: cfg.espera_s }
  }
  if (linha.classificacao === 'indeterminado') return { ok: true, classificacao: 'indeterminado', regras: linha.regras }
  const efeito = await aplicarEfeito(deps, linha)
  return { ok: true, classificacao: linha.classificacao, regras: linha.regras, intervalo_s: intervaloS, ...efeito }
}

export async function aplicarEfeito(deps: Deps, linhaChamador: Linha): Promise<Resultado> {
  const { repo, kommo } = deps
  const posse = await repo.claim(linhaChamador.id, deps.leaseS)
  if (!posse) return { estado: 'em_andamento', motivo: 'outro worker está aplicando' }
  const { token, linha } = posse // fotografia do banco sob a posse: decisão/fase/origem valem daqui, não do chamador
  if (linha.classificacao === 'indeterminado') { await repo.fim(linha.id, token, 'pendente', {}); return { estado: 'pendente', motivo: 'sem decisão final sob a posse' } }
  const faseAnterior = linha.efeito_fase // antes de qualquer gravação de fase (reconciliações)
  const fim = async (estado: Linha['estado_efeito'], extra: Record<string, unknown> = {}) => {
    const ok = await repo.fim(linha.id, token, estado, extra)
    return ok ? { estado, ...extra } : { estado: 'perdeu_posse', motivo: 'lease expirou e outro worker reassumiu; nada gravado' }
  }
  const renova = async () => { if (!(await repo.renovar(linha.id, token, deps.leaseS))) throw new LeituraFalhou('lease', 'posse perdida durante o efeito') }
  try {
    // relê config E lead DEPOIS do claim (fail closed): desligou/mudou de modo/moveu → não aplica
    const cfg = await repo.config(linha.pipeline_id)
    if (!cfg) return await fim('superado', { motivo_efeito: 'config removida' })
    const lead = leadValido(await kommo('GET', `/api/v4/leads/${linha.kommo_lead_id}`, undefined, { etapa: 'lead_revalidar', retries: 1 }), 'lead_revalidar')
    if (!lead) return await fim('superado', { motivo_efeito: 'lead não existe mais' })
    await renova()
    // reconciliação de um PATCH de status ambíguo (aceito, resposta perdida): o destino pretendido
    // foi gravado antes do PATCH; se o lead está lá, foi escrita nossa → aplicado (com movido_para)
    const destino = (linha as any).movido_para
    if (faseAnterior === 'status_enviando' && destino && Number(lead.status_id) === Number(destino) && Number(lead.pipeline_id) === Number(linha.pipeline_id)) {
      return await fim('aplicado', { movido: true, erro: null, efeito_fase: 'concluido', motivo_efeito: 'reconciliado: lead já no destino pretendido' })
    }
    const pode = podeAplicar(cfg, lead, linha.status_id_origem)
    if (!pode.ok) return await fim(cfg.modo === 'observar' && pode.motivo !== 'funil desligado' ? 'observado' : 'superado', { motivo_efeito: pode.motivo })
    if (cfg.modo !== 'aplicar') return await fim('observado', { motivo_efeito: 'modo observar' })

    if (linha.classificacao === 'humano') {
      if (!cfg.status_respondeu) return await fim('observado', { motivo_efeito: 'funil sem status_respondeu' })
      // destino pretendido ANTES do PATCH (jornal): resposta perdida é reconciliada na retomada
      if (!(await repo.fase(linha.id, token, 'status_enviando', { movido_para: cfg.status_respondeu }))) return await fim('falhou', { erro: 'posse perdida' })
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { status_id: cfg.status_respondeu, pipeline_id: cfg.pipeline_id }, { etapa: 'patch_status', retries: 0 })
      if (!r.ok) return await fim('falhou', { erro: r.status === 0 ? 'PATCH status: resposta perdida (reconciliar na retomada)' : `PATCH status → HTTP ${r.status}`, tentativas: Number(linha.tentativas ?? 0) + 1 })
      return await fim('aplicado', { movido: true, movido_para: cfg.status_respondeu, erro: null, efeito_fase: 'concluido' })
    }
    // autoresposta: tag (mesclada) + nota com marcador; nota NÃO se repete (POST não é idempotente):
    // se a fase anterior parou em 'nota_enviando', procura o marcador nas notas antes de postar.
    const tagsAtuais = ((lead?._embedded?.tags ?? []) as { id?: number; name?: string }[])
    if (!tagsAtuais.some((t) => t.name === TAG_AUTO) && faseAnterior !== 'tag_ok' && faseAnterior !== 'nota_enviando') {
      if (!(await repo.fase(linha.id, token, 'tag_enviando'))) return await fim('falhou', { erro: 'posse perdida' })
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { _embedded: { tags: [...tagsAtuais.map((t) => (t.id ? { id: t.id } : { name: t.name })), { name: TAG_AUTO }] } }, { etapa: 'patch_tag', retries: 1 })
      if (!r.ok) return await fim('falhou', { erro: `PATCH tag → HTTP ${r.status}`, tentativas: Number(linha.tentativas ?? 0) + 1 })
      await renova()
    }
    const marca = marcador(linha.mensagem_id)
    let notaExiste = false
    if (faseAnterior === 'nota_enviando') {
      // tentativa anterior ambígua: reconcilia SEM regredir a fase (se a consulta falhar, continua
      // 'nota_enviando' e a próxima retomada reconcilia de novo). Envelope validado; se houver
      // mais páginas e o marcador não apareceu, não se prova ausência → não posta.
      const notas = await kommo('GET', `/api/v4/leads/${linha.kommo_lead_id}/notes?limit=250&order[created_at]=desc`, undefined, { etapa: 'notas', retries: 1 })
      if (notas.status === 204) notaExiste = false
      else {
        if (!notas.ok) throw new LeituraFalhou('notas', `HTTP ${notas.status}`)
        const lista = notas.body?._embedded?.notes
        if (!Array.isArray(lista)) throw new LeituraFalhou('notas', 'envelope inesperado')
        notaExiste = lista.some((n: any) => String(n?.params?.text ?? '').includes(marca))
        if (!notaExiste && notas.body?._links?.next) throw new LeituraFalhou('notas', 'marcador não achado na 1ª página e há mais páginas')
      }
    } else if (!(await repo.fase(linha.id, token, 'tag_ok'))) return await fim('falhou', { erro: 'posse perdida' })
    if (!notaExiste) {
      if (!(await repo.fase(linha.id, token, 'nota_enviando'))) return await fim('falhou', { erro: 'posse perdida' })
      const nota = await kommo('POST', `/api/v4/leads/${linha.kommo_lead_id}/notes`, [{ note_type: 'common', params: { text: `Triagem automática: resposta classificada como AUTORESPOSTA (${linha.regras.join(', ')}). Lead mantido na etapa. ${marca}` } }], { etapa: 'nota', retries: 0 })
      if (!nota.ok) return await fim('falhou', { erro: `POST nota → HTTP ${nota.status} (reconciliar na retomada)`, tentativas: Number(linha.tentativas ?? 0) + 1 })
    }
    return await fim('aplicado', { movido: false, erro: null, efeito_fase: 'concluido' })
  } catch (e) {
    await repo.fim(linha.id, token, 'falhou', { erro: (e as Error).message, tentativas: Number(linha.tentativas ?? 0) + 1 })
    throw e
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────
// 4) VARREDURA (cron): trabalhos pendentes (leitura falhou/evento ainda ausente) e linhas com
//    indeterminado vencido, texto vazio, efeito pendente/falhou ou lease vencida. Para no 1º 429.
// ──────────────────────────────────────────────────────────────────────────────────────────
export async function varrer(deps: Deps, limite = 40): Promise<Resultado> {
  const { repo, kommo } = deps
  const out: unknown[] = []
  const kommoLote: KommoFn = (m, p, b, o) => kommo(m, p, b, { ...o, pararEm429: true })
  const d = { ...deps, kommo: kommoLote }
  try {
    for (const t of await repo.trabalhosPendentes(limite)) {
      try { out.push({ trabalho: t.id, lead: t.kommo_lead_id, ...(await processarTrabalho(d, t)) }) }
      catch (e) { if (e instanceof Throttled) throw e; await repo.concluirTrabalho(t.id, t.tentativas + 1 >= deps.maxTentativas ? 'descartado' : 'pendente', (e as Error).message); out.push({ trabalho: t.id, erro: (e as Error).message }) }
    }
    for (const l of await repo.pendentesEfeito(limite)) {
      const cfg = await repo.config(l.pipeline_id)
      if (!cfg || !cfg.ativo) { const ps = await repo.claim(l.id, deps.leaseS); if (ps) await repo.fim(l.id, ps.token, 'superado', { motivo_efeito: 'funil desligado' }); out.push({ id: l.id, resultado: 'superado (funil desligado)' }); continue }
      const msgTs = Math.floor(new Date(l.recebido_em).getTime() / 1000)
      if (l.classificacao === 'indeterminado' && deps.agora() < msgTs + cfg.espera_s && !(l.regras ?? []).includes('texto_vazio')) continue
      try {
        const lead = leadValido(await kommoLote('GET', `/api/v4/leads/${l.kommo_lead_id}`, undefined, { etapa: 'lead' }), 'lead')
        if (!lead) { const ps = await repo.claim(l.id, deps.leaseS); if (ps) await repo.fim(l.id, ps.token, 'superado', { motivo_efeito: 'lead não existe' }); continue }
        const de = msgTs - 14 * 86400
        // mesma correlação canônica do trabalho, ancorada na linha em análise e nas linhas do lead:
        // o alias (evento sem id) da própria mensagem NÃO conta como 2ª mensagem (não bloqueia R3)
        const linhasLead = await repo.linhasDoLead(l.kommo_lead_id)
        const ins = correlacionar(eventosIn(await kommoLote('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${l.kommo_lead_id}&filter[type]=incoming_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_in' }), 'eventos_in'), [refDaLinha(l), ...linhasLead.map(refDaLinha)], null)
        const outs = eventos(await kommoLote('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${l.kommo_lead_id}&filter[type]=outgoing_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_out' }), 'eventos_out').map((e) => Number(e.created_at))
        out.push({ id: l.id, lead: l.kommo_lead_id, ...(await decidirEAplicar(d, cfg, lead, l, ins, outs)) })
      } catch (e) {
        if (e instanceof Throttled) throw e
        out.push({ id: l.id, lead: l.kommo_lead_id, erro: (e as Error).message })
      }
    }
  } catch (e) {
    if (e instanceof Throttled) return { ok: true, interrompida: `429 (esperar ${e.esperaS}s)`, processadas: out.length, resultados: out }
    throw e
  }
  return { ok: true, processadas: out.length, resultados: out }
}
