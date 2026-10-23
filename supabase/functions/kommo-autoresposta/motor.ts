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

export type Trabalho = { id: number; kommo_lead_id: number; tentativas: number }
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
  criarTrabalho(leadId: number): Promise<Trabalho>
  concluirTrabalho(id: number, estado: 'concluido' | 'pendente' | 'descartado', erro?: string | null): Promise<void>
  trabalhosPendentes(limite: number): Promise<Trabalho[]>
  // mensagens
  linhasDoLead(leadId: number): Promise<Linha[]>
  criarLinhas(linhas: Partial<Linha>[]): Promise<void>       // ignora duplicadas (lead+mensagem)
  linha(leadId: number, mensagemId: string): Promise<Linha>
  /** grava a decisão só se a linha está livre (pendente e sem lease viva) — devolve a linha após a gravação */
  decidir(id: number, dec: { texto: string; texto_norm: string; hash: string; repeticoes: number; padrao_id: number | null; classificacao: Linha['classificacao']; regras: string[]; decidido_em: string | null; intervalo_s: number | null; ultimo_disparo_em: string | null; modo: string; tentativas?: number }): Promise<Linha | null>
  outrosLeadsComHash(hash: string, leadId: number, desde: string): Promise<number>
  superar(leadId: number, excetoId: number | null, antesDe: string | null, motivo: string): Promise<void>
  // efeito
  claim(id: number, leaseS: number): Promise<string | null>  // token ou null
  renovar(id: number, token: string, leaseS: number): Promise<boolean>
  fase(id: number, token: string, fase: string): Promise<boolean>
  fim(id: number, token: string, estado: Linha['estado_efeito'], extra: Record<string, unknown>): Promise<boolean>
  acerto(padraoId: number): Promise<void>
  pendentesEfeito(limite: number): Promise<Linha[]>          // pendente/falhou/lease vencida + indeterminados
}
export type Deps = { repo: Repo; kommo: KommoFn; agora: () => number; campoTexto: string; leaseS: number; maxTentativas: number }

const TAG_AUTO = 'autoresposta'
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
export async function receberWebhook(deps: Deps, leadId: number): Promise<Resultado> {
  const t = await deps.repo.criarTrabalho(leadId)
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
  const leadId = t.kommo_lead_id
  const lead = leadValido(await kommo('GET', `/api/v4/leads/${leadId}`, undefined, { etapa: 'lead' }), 'lead')
  if (!lead) { await repo.concluirTrabalho(t.id, 'descartado', 'lead não existe'); return { skipped: true, motivo: 'lead não existe' } }
  const pipeline = Number(lead.pipeline_id), statusAtual = Number(lead.status_id)
  const cfg = await repo.config(pipeline)
  if (!cfg) { await repo.concluirTrabalho(t.id, 'descartado', 'funil sem config'); return { skipped: true, motivo: 'funil sem config', pipeline } }
  if (!cfg.ativo) { await repo.concluirTrabalho(t.id, 'descartado', 'funil desligado'); return { skipped: true, motivo: 'funil com triagem desligada', pipeline } }
  // Elegibilidade de ETAPA só vale pra APLICAR (podeAplicar). Em observar registra-se sempre:
  // se o gatilho antigo já moveu o lead para RESPONDEU, a resposta entra na amostra mesmo assim.

  const agora = deps.agora()
  const de = agora - 14 * 86400
  const ins = eventos(await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=incoming_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_in' }), 'eventos_in')
    .map((e) => ({ id: String(e.value_after?.[0]?.message?.id ?? e.id), ts: Number(e.created_at) })).filter((e) => e.id && Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts)
  const outs = eventos(await kommo('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${leadId}&filter[type]=outgoing_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_out' }), 'eventos_out')
    .map((e) => Number(e.created_at)).filter(Number.isFinite).sort((a, b) => a - b)
  if (!ins.length) {
    // o evento pode ainda não estar visível na API: trabalho continua pendente (cron retoma)
    const estado = t.tentativas + 1 >= deps.maxTentativas ? 'descartado' : 'pendente'
    await repo.concluirTrabalho(t.id, estado, 'sem mensagem recebida nos eventos')
    return { pendente: estado === 'pendente', motivo: 'sem mensagem recebida nos eventos (ainda)' }
  }

  // registra TODA mensagem sem linha (identidade = id do evento); a última é a decidida
  const existentes = await repo.linhasDoLead(leadId)
  const temLinha = new Set(existentes.map((l) => l.mensagem_id))
  const novas = ins.filter((i) => !temLinha.has(i.id))
  const ultima = ins[ins.length - 1]
  if (novas.length) {
    await repo.criarLinhas(novas.map((i) => {
      const disparo = [...outs].reverse().find((o) => o <= i.ts) ?? null
      return { kommo_lead_id: leadId, mensagem_id: i.id, pipeline_id: pipeline, status_id_origem: statusAtual, recebido_em: iso(i.ts), ultimo_disparo_em: disparo ? iso(disparo) : null, intervalo_s: disparo ? i.ts - disparo : null, modo: cfg.modo, classificacao: 'indeterminado', regras: ['nova'], estado_efeito: 'pendente' }
    }))
    // mensagens anteriores à última que acabaram de ganhar linha não têm texto (o campo guarda só o
    // último): ficam superadas pela mais nova — registradas, nunca decididas no escuro
    await repo.superar(leadId, null, iso(ultima.ts), `texto indisponível; superada pela mensagem ${ultima.id}`)
  }
  const linha = await repo.linha(leadId, ultima.id)
  const r = await decidirEAplicar(deps, cfg, lead, linha, ins, outs)
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
  const depois = ins.filter((i) => i.id !== linha.mensagem_id && i.ts >= msgTs).length
  const ultimoDisparo = [...outs].reverse().find((o) => o <= msgTs) ?? null
  const intervaloS = ultimoDisparo ? msgTs - ultimoDisparo : null

  // decisão só enquanto a linha está livre (pendente, sem lease): depois do claim ela é imutável
  if (linha.estado_efeito === 'pendente' && (linha.classificacao === 'indeterminado' || !linha.decidido_em)) {
    let texto = (linha.texto ?? '').trim()
    if (!texto) {
      const campos = await kommo('GET', `/api/v4/leads/custom_fields?limit=250`, undefined, { etapa: 'campos' })
      if (!campos.ok) throw new LeituraFalhou('campos', `HTTP ${campos.status}`)
      const lista = campos.body?._embedded?.custom_fields
      if (!Array.isArray(lista)) throw new LeituraFalhou('campos', 'envelope inesperado')
      const campo = lista.find((f: any) => String(f.name).toLowerCase() === deps.campoTexto.toLowerCase())
      if (!campo) throw new LeituraFalhou('campos', `campo "${deps.campoTexto}" não existe no Kommo`)
      const cf = (lead.custom_fields_values ?? []).find((f: any) => Number(f.field_id) === Number(campo.id))
      texto = String(cf?.values?.[0]?.value ?? '').trim()
    }
    if (!texto) {
      const tent = Number(linha.tentativas ?? 0) + 1
      if (tent < deps.maxTentativas) {
        await repo.decidir(linha.id, { texto: '', texto_norm: '', hash: '', repeticoes: 0, padrao_id: null, classificacao: 'indeterminado', regras: ['texto_vazio'], decidido_em: null, intervalo_s: intervaloS, ultimo_disparo_em: ultimoDisparo ? iso(ultimoDisparo) : null, modo: cfg.modo, tentativas: tent })
        return { ok: true, classificacao: 'indeterminado', motivo: 'texto vazio; aguardando releitura' }
      }
      texto = '[midia]'
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
    // decisões mais novas superam pendências anteriores do mesmo lead
    await repo.superar(linha.kommo_lead_id, linha.id, linha.recebido_em, `superada pela mensagem ${linha.mensagem_id}`)
  }
  if (linha.classificacao === 'indeterminado') return { ok: true, classificacao: 'indeterminado', regras: linha.regras }
  const efeito = await aplicarEfeito(deps, linha)
  return { ok: true, classificacao: linha.classificacao, regras: linha.regras, intervalo_s: intervaloS, ...efeito }
}

export async function aplicarEfeito(deps: Deps, linha: Linha): Promise<Resultado> {
  const { repo, kommo } = deps
  const token = await repo.claim(linha.id, deps.leaseS)
  if (!token) return { estado: 'em_andamento', motivo: 'outro worker está aplicando' }
  const faseAnterior = linha.efeito_fase // antes de qualquer gravação de fase (reconciliação da nota)
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
    const pode = podeAplicar(cfg, lead, linha.status_id_origem)
    if (!pode.ok) return await fim(cfg.modo === 'observar' && pode.motivo !== 'funil desligado' ? 'observado' : 'superado', { motivo_efeito: pode.motivo })
    if (cfg.modo !== 'aplicar') return await fim('observado', { motivo_efeito: 'modo observar' })

    if (linha.classificacao === 'humano') {
      if (!cfg.status_respondeu) return await fim('observado', { motivo_efeito: 'funil sem status_respondeu' })
      if (!(await repo.fase(linha.id, token, 'status_enviando'))) return await fim('falhou', { erro: 'posse perdida' })
      const r = await kommo('PATCH', `/api/v4/leads/${linha.kommo_lead_id}`, { status_id: cfg.status_respondeu, pipeline_id: cfg.pipeline_id }, { etapa: 'patch_status', retries: 1 })
      if (!r.ok) return await fim('falhou', { erro: `PATCH status → HTTP ${r.status}`, tentativas: Number(linha.tentativas ?? 0) + 1 })
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
    if (!(await repo.fase(linha.id, token, 'tag_ok'))) return await fim('falhou', { erro: 'posse perdida' })
    const marca = marcador(linha.mensagem_id)
    let notaExiste = false
    if (faseAnterior === 'nota_enviando') { // tentativa anterior ambígua: reconcilia
      const notas = await kommo('GET', `/api/v4/leads/${linha.kommo_lead_id}/notes?limit=50&order[created_at]=desc`, undefined, { etapa: 'notas', retries: 1 })
      if (!notas.ok && notas.status !== 204) throw new LeituraFalhou('notas', `HTTP ${notas.status}`)
      notaExiste = ((notas.body?._embedded?.notes ?? []) as any[]).some((n) => String(n?.params?.text ?? '').includes(marca))
    }
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
      if (!cfg || !cfg.ativo) { const tk = await repo.claim(l.id, deps.leaseS); if (tk) await repo.fim(l.id, tk, 'superado', { motivo_efeito: 'funil desligado' }); out.push({ id: l.id, resultado: 'superado (funil desligado)' }); continue }
      const msgTs = Math.floor(new Date(l.recebido_em).getTime() / 1000)
      if (l.classificacao === 'indeterminado' && deps.agora() < msgTs + cfg.espera_s && !(l.regras ?? []).includes('texto_vazio')) continue
      try {
        const lead = leadValido(await kommoLote('GET', `/api/v4/leads/${l.kommo_lead_id}`, undefined, { etapa: 'lead' }), 'lead')
        if (!lead) { const tk = await repo.claim(l.id, deps.leaseS); if (tk) await repo.fim(l.id, tk, 'superado', { motivo_efeito: 'lead não existe' }); continue }
        const de = msgTs - 14 * 86400
        const ins = eventos(await kommoLote('GET', `/api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=${l.kommo_lead_id}&filter[type]=incoming_chat_message&filter[created_at][from]=${de}&limit=50`, undefined, { etapa: 'eventos_in' }), 'eventos_in').map((e) => ({ id: String(e.value_after?.[0]?.message?.id ?? e.id), ts: Number(e.created_at) }))
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
