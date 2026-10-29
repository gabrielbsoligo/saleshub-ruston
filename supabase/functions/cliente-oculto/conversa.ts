// cliente-oculto/conversa.ts — lógica PURA do cliente oculto (testável sem rede).
//
// Ciclo de uma sessão (1 empresa-alvo, 1 número anônimo):
//   sondagem → (empresa responde?) → cronômetro da 1ª resposta → conversa curta como "cliente"
//   (persona por nicho, até N turnos) → janela de follow-up (72 h) → avaliação por critério →
//   nota final 0–10 e parecer. O LLM (Haiku) só escreve as falas da persona e o parecer final; tudo
//   que é regra (quando parar, prazos, notas por critério, próximo instante devido) é determinístico aqui.
export type Direcao = 'out' | 'in'
export type Msg = { direcao: Direcao; texto: string; ts: number }   // ts em segundos (epoch)
export type Persona = { nome: string; contexto: string; objetivo: string; tom: string }
export type Status = 'pendente' | 'enviada' | 'conversando' | 'aguardando_followup' | 'avaliando' | 'concluida' | 'erro' | 'cancelada'
export type Sessao = {
  id: string; empresa: string; nicho: string | null; numero_alvo: string; status: Status
  fase: 'ocioso' | 'enviando' | 'envio_incerto'
  iniciada_em: number | null; ultima_in_em: number | null; ultima_out_em: number | null
  turnos_persona: number; max_turnos: number; janela_followup_h: number
}
export const PADRAO = { max_turnos: 4, janela_followup_h: 72, sem_resposta_encerrar_h: 72, silencio_apos_nossa_fala_h: 24, max_tentativas_avaliacao: 3 }

// ── persona por nicho (determinística; o LLM a encarna) ─────────────────────
export function personaPara(nicho: string | null, empresa: string): Persona {
  const n = (nicho ?? '').toLowerCase()
  const base = { nome: 'Cliente', tom: 'natural, curto, informal como no WhatsApp, sem jargão; 1–2 frases por mensagem; nunca se identifica como teste/IA' }
  if (/imob|imóve|imove|construtor|incorpor|empreend/.test(n)) return { ...base, contexto: 'quer comprar um imóvel para morar, viu um anúncio da empresa', objetivo: 'saber se tem unidade disponível, faixa de preço e como agendar visita' }
  if (/odonto|dent|clínic|clinic|estét|estet|saúde|saude|médic|medic/.test(n)) return { ...base, contexto: 'quer marcar uma avaliação/consulta', objetivo: 'saber valores, se atende convênio, horários e como agendar' }
  if (/advoc|jurí|juri|contab|contáb/.test(n)) return { ...base, contexto: 'precisa de um serviço profissional e está comparando escritórios', objetivo: 'entender como funciona o atendimento, prazo e faixa de honorários' }
  if (/escola|colég|coleg|curso|educa|ensino/.test(n)) return { ...base, contexto: 'quer matricular (ou se matricular) e pediu informações', objetivo: 'saber mensalidade, vagas e como visitar' }
  if (/academ|fitness|cross/.test(n)) return { ...base, contexto: 'quer começar a treinar', objetivo: 'saber planos, valores e se tem aula experimental' }
  if (/restaur|gastr|pizz|hamb|bar\b/.test(n)) return { ...base, contexto: 'quer fazer uma reserva ou encomenda para um grupo', objetivo: 'saber disponibilidade, cardápio e valores' }
  if (/móve|move|planej|marcen/.test(n)) return { ...base, contexto: 'quer orçar móveis planejados para a cozinha', objetivo: 'saber prazo, como funciona o projeto e faixa de preço' }
  if (/veíc|veic|auto|concess|motors/.test(n)) return { ...base, contexto: 'viu um veículo anunciado e quer saber mais', objetivo: 'saber disponibilidade, preço e condições' }
  if (/solar|energ/.test(n)) return { ...base, contexto: 'quer reduzir a conta de luz da casa', objetivo: 'saber como funciona, custo médio e prazo' }
  return { ...base, contexto: `tem interesse nos produtos/serviços de ${empresa} e pediu informações`, objetivo: 'entender o que oferecem, valores e próximo passo' }
}

// ── prompts ──────────────────────────────────────────────────────────────────
export function promptAbertura(p: Persona, empresa: string): string {
  return `Você é ${p.nome}, uma pessoa real escrevendo no WhatsApp para a empresa "${empresa}". Contexto: ${p.contexto}. Objetivo: ${p.objetivo}. Tom: ${p.tom}.
Escreva SOMENTE a primeira mensagem (abertura), como um cliente comum faria: cumprimento curto + uma pergunta concreta. Sem assinatura, sem aspas, sem explicações.`
}
export function promptProximaFala(p: Persona, empresa: string, historico: Msg[]): string {
  const h = historico.map((m) => `${m.direcao === 'out' ? p.nome : 'Empresa'}: ${m.texto}`).join('\n')
  return `Você é ${p.nome}, uma pessoa real no WhatsApp conversando com a empresa "${empresa}". Contexto: ${p.contexto}. Objetivo: ${p.objetivo}. Tom: ${p.tom}.
Conversa até agora:
${h}
Escreva SOMENTE a próxima mensagem de ${p.nome}. Se a empresa fez uma pergunta, responda de forma plausível e curta e avance no objetivo (preço, disponibilidade, próximo passo). Se a empresa pediu algo que exige se identificar (CPF, documento, pagamento), diga que vai ver e pergunte o próximo passo. Nunca diga que é um teste. Sem aspas, sem explicações.`
}
export function promptAvaliacao(empresa: string, historico: Msg[], metricas: Metricas): string {
  const h = historico.map((m) => `[${new Date(m.ts * 1000).toISOString()}] ${m.direcao === 'out' ? 'Cliente' : 'Empresa'}: ${m.texto}`).join('\n')
  return `Avalie o atendimento da empresa "${empresa}" nesta conversa de WhatsApp com um cliente oculto. Métricas já medidas: ${JSON.stringify(metricas)}.
Conversa:
${h}
Responda APENAS um JSON: {"qualificacao": 0-10, "proposta_preco": 0-10, "tom": 0-10, "parecer": "2–4 frases objetivas sobre o atendimento, em português", "pontos_fortes": [..], "pontos_fracos": [..]}.
qualificacao = perguntou necessidade/contexto do cliente antes de empurrar; proposta_preco = apresentou preço/condições/próximo passo com clareza; tom = cordialidade e profissionalismo.`
}

// ── métricas determinísticas ──────────────────────────────────────────────────
// FOLLOW-UP = iniciativa NOVA da empresa: uma mensagem 'in' cuja mensagem anterior no histórico também
// é 'in' (a empresa voltou a escrever sem que a persona tivesse falado no meio). Resposta a uma fala
// nossa — mesmo tardia — é "resposta", nunca follow-up. A janela conta a partir da mensagem 'in' anterior.
export type Metricas = { tempo_primeira_resposta_s: number | null; respondeu: boolean; turnos_empresa: number; followups: number; followup_24h: boolean; followup_48h: boolean; followup_72h: boolean; encerrou_sem_resposta: boolean }
export function metricas(hist: Msg[], agora: number, janelaH = PADRAO.janela_followup_h): Metricas {
  const ord = [...hist].sort((a, b) => a.ts - b.ts)
  const outs = ord.filter((m) => m.direcao === 'out'), ins = ord.filter((m) => m.direcao === 'in')
  const primeiraOut = outs[0]?.ts ?? null
  const primeiraIn = primeiraOut != null ? ins.find((m) => m.ts >= primeiraOut)?.ts ?? null : null
  let fu24 = false, fu48 = false, fu72 = false, followups = 0
  for (let i = 1; i < ord.length; i++) {
    if (ord[i].direcao !== 'in' || ord[i - 1].direcao !== 'in') continue
    const dt = ord[i].ts - ord[i - 1].ts
    if (dt < 2 * 3600) continue   // mensagens em sequência na mesma conversa não são follow-up
    followups++
    if (dt <= 24 * 3600) fu24 = true; else if (dt <= 48 * 3600) fu48 = true; else if (dt <= 72 * 3600) fu72 = true
  }
  return {
    tempo_primeira_resposta_s: primeiraOut != null && primeiraIn != null ? primeiraIn - primeiraOut : null,
    respondeu: primeiraIn != null,
    turnos_empresa: ins.length,
    followups, followup_24h: fu24, followup_48h: fu48, followup_72h: fu72,
    encerrou_sem_resposta: primeiraIn == null && primeiraOut != null && agora - primeiraOut >= janelaH * 3600,
  }
}

// ── notas por critério (0–10) ─────────────────────────────────────────────────
export type Notas = { tempo_resposta: number; qualificacao: number | null; proposta_preco: number | null; followup: number; tom: number | null; final: number | null; incompleta: boolean }
export function notaTempo(s: number | null): number {
  if (s == null) return 0
  if (s <= 5 * 60) return 10
  if (s <= 30 * 60) return 8
  if (s <= 2 * 3600) return 6
  if (s <= 8 * 3600) return 4
  if (s <= 24 * 3600) return 2
  return 1
}
export function notaFollowup(m: Metricas): number {
  if (!m.respondeu) return 0
  if (m.followup_24h) return 10
  if (m.followup_48h) return 7
  if (m.followup_72h) return 4
  return 0
}
/** ia = avaliação do LLM (null = indisponível). Sem resposta da empresa, os critérios de IA são 0 (não há
 *  atendimento a avaliar). Com resposta e IA ausente/inválida, os critérios ficam NULL e a nota final
 *  NULL (incompleta=true) — nunca atribuímos zero por falha nossa. */
export function consolidar(m: Metricas, ia: { qualificacao?: unknown; proposta_preco?: unknown; tom?: unknown } | null): Notas {
  // só número finito ou string numérica não vazia; null/false/''/objeto = NÃO medido (incompleta)
  const num = (x: unknown) => {
    if (typeof x === 'number') return Number.isFinite(x) ? Math.max(0, Math.min(10, x)) : null
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Math.max(0, Math.min(10, Number(x)))
    return null
  }
  const tempo = notaTempo(m.tempo_primeira_resposta_s), followup = notaFollowup(m)
  if (!m.respondeu) return { tempo_resposta: tempo, qualificacao: 0, proposta_preco: 0, followup, tom: 0, final: Math.round(tempo * 0.3 * 10) / 10, incompleta: false }
  const q = num(ia?.qualificacao), p = num(ia?.proposta_preco), t = num(ia?.tom)
  const incompleta = q == null || p == null || t == null
  const final = incompleta ? null : Math.round((tempo * 0.3 + q! * 0.2 + p! * 0.2 + followup * 0.2 + t! * 0.1) * 10) / 10
  return { tempo_resposta: tempo, qualificacao: q, proposta_preco: p, followup, tom: t, final, incompleta }
}

// ── máquina de estados: o que fazer agora e quando voltar ─────────────────────
export type Decisao =
  | { acao: 'esperar'; proximo_em: number | null }
  | { acao: 'abrir' }
  | { acao: 'responder' }
  | { acao: 'aguardar_followup'; proximo_em: number }
  | { acao: 'avaliar'; motivo: string }
export function decidir(s: Sessao, hist: Msg[], agora: number): Decisao {
  if (['concluida', 'erro', 'cancelada'].includes(s.status)) return { acao: 'esperar', proximo_em: null }
  if (s.status === 'avaliando') return { acao: 'avaliar', motivo: 'reavaliação' }
  if (s.status === 'pendente') return { acao: 'abrir' }
  const ultima = hist[hist.length - 1]
  if (s.status === 'enviada' || s.status === 'conversando') {
    if (ultima?.direcao === 'in') {
      if (s.turnos_persona < s.max_turnos) return { acao: 'responder' }
      return { acao: 'aguardar_followup', proximo_em: (s.ultima_out_em ?? agora) + s.janela_followup_h * 3600 }
    }
    const ref = ultima?.ts ?? s.iniciada_em ?? agora
    if (s.status === 'enviada' && agora - ref >= PADRAO.sem_resposta_encerrar_h * 3600) return { acao: 'avaliar', motivo: 'sem resposta da empresa em 72 h' }
    if (s.status === 'conversando' && agora - ref >= PADRAO.silencio_apos_nossa_fala_h * 3600) return { acao: 'aguardar_followup', proximo_em: ref + s.janela_followup_h * 3600 }
    return { acao: 'esperar', proximo_em: ref + (s.status === 'enviada' ? PADRAO.sem_resposta_encerrar_h : PADRAO.silencio_apos_nossa_fala_h) * 3600 }
  }
  if (s.status === 'aguardando_followup') {
    const ref = s.ultima_out_em ?? s.iniciada_em ?? agora
    if (agora - ref >= s.janela_followup_h * 3600) return { acao: 'avaliar', motivo: 'janela de follow-up encerrada' }
    return { acao: 'esperar', proximo_em: ref + s.janela_followup_h * 3600 }
  }
  return { acao: 'esperar', proximo_em: null }
}
/** próximo instante devido depois de a persona FALAR (abertura ou resposta) */
export function proximoAposFala(status: 'enviada' | 'conversando', ts: number): number {
  return ts + (status === 'enviada' ? PADRAO.sem_resposta_encerrar_h : PADRAO.silencio_apos_nossa_fala_h) * 3600
}

// ── normalização de número (BR) e extração do texto do webhook da Evolution ──
export function numeroWa(n: string): string | null {
  const d = (n ?? '').replace(/\D/g, '')
  if (!d) return null
  let x = d.startsWith('55') && d.length >= 12 ? d : `55${d.replace(/^0+/, '')}`
  // celular BR sem o 9: 55 + DDD(2) + 8 dígitos começando em 6–9 → insere o 9 (mesma regra nos dois lados)
  if (x.length === 12 && /^55\d{2}[6-9]/.test(x)) x = `${x.slice(0, 4)}9${x.slice(4)}`
  return /^55\d{10,11}$/.test(x) ? x : null
}
// ts = messageTimestamp do WhatsApp; AUSENTE/zero → ts null (sem instante estável). Um evento sem key.id E sem
// instante estável não tem identidade de reentrega: vai para QUARENTENA (ignorado com nota), nunca recebe
// um id composto pela hora de recebimento.
export function textoDoEvento(data: any): { de: string | null; fromMe: boolean; id: string | null; texto: string; ts: number | null } | null {
  const key = data?.key ?? {}
  const remote = String(key.remoteJid ?? '')
  if (!remote || /@g\.us$/.test(remote)) return null   // grupos não contam
  const m = data?.message ?? {}
  const bruto = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? (m.audioMessage ? '[áudio]' : (m.documentMessage ? '[documento]' : ''))
  const texto = String(bruto ?? '').trim()
  const tsBruto = Number(data?.messageTimestamp ?? 0)
  const ts = Number.isFinite(tsBruto) && tsBruto > 0 ? Math.floor(tsBruto > 1e12 ? tsBruto / 1000 : tsBruto) : null
  // remetente CANÔNICO pela mesma regra do cadastro (numeroWa) — '551188887777' casa com '5511988887777'
  const de = numeroWa(remote.replace(/@.*$/, ''))
  return { de, fromMe: !!key.fromMe, id: key.id ? String(key.id) : null, texto, ts }
}
/** identidade DETERMINÍSTICA para evento sem key.id: mesma entrega reprocessada = mesmo id (idempotente);
 *  FNV-1a de remetente|instante|texto — nunca aleatória */
export function identidadeEstavel(m: { id: string | null; ts: number | null; de: string | null; texto: string }): string | null {
  if (m.id) return m.id
  if (m.ts != null && m.de) return idDeterministico(m.de, m.ts, m.texto)
  return null   // quarentena
}
/** política de aceitação de um evento de mensagem: precisa de identidade estável E instante real (messageTimestamp).
 *  Sem instante não há cronômetro nem ordem no histórico — vai para quarentena mesmo com key.id (nunca iso(null)). */
export function aceitarEvento(m: { id: string | null; ts: number | null; de: string | null; texto: string }): { ok: true; waId: string; ts: number } | { ok: false; motivo: string } {
  if (!m.de) return { ok: false, motivo: 'sem remetente' }
  if (m.ts == null) return { ok: false, motivo: m.id ? 'quarentena: key.id sem messageTimestamp' : 'quarentena: sem identidade estável (sem key.id e sem messageTimestamp)' }
  const waId = identidadeEstavel(m)
  if (!waId) return { ok: false, motivo: 'quarentena: sem identidade estável' }
  return { ok: true, waId, ts: m.ts }
}
export function idDeterministico(de: string, ts: number, texto: string): string {
  let h = 0x811c9dc5
  for (const ch of `${de}|${ts}|${texto}`) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0 }
  return `in-${ts}-${h.toString(16).padStart(8, '0')}`
}
/** classifica o resultado de um envio: 'ok' (aceito), 'definitivo' (4xx: não reenviar, erro), 'incerto' (timeout/rede/5xx: pode ter saído) */
export function classificarEnvio(r: { ok: boolean; status: number; transporte?: boolean }): 'ok' | 'definitivo' | 'incerto' {
  if (r.ok) return 'ok'
  if (r.transporte || r.status === 0 || r.status >= 500 || r.status === 408 || r.status === 429) return 'incerto'
  return 'definitivo'
}

/** ações da decisão que mandam mensagem ao WhatsApp (precisam de envios ligados e número conectado) */
export const exigeEnvio = (acao: string) => acao === 'abrir' || acao === 'responder'
/** número do chip conectado a partir do que a Evolution informa ("5511...@s.whatsapp.net", "5511...:12@..."); null se não houver */
export function numeroDoDono(v: unknown): string | null {
  const d = String(v ?? '').split('@')[0].split(':')[0].replace(/\D/g, '')
  return d.length >= 10 && d.length <= 15 ? d : null
}

// ── ritmo humano: quando a persona responde (atraso de "ler + pensar" e janela de horário: só não de madrugada) ──
// Puro e determinístico: o mesmo histórico dá o mesmo horário a cada varredura (a semente vem da sessão + instante
// da última mensagem da empresa), então não precisa guardar estado. O "digitando..." sai pela Evolution (delay do sendText).
export interface Ritmo {
  min_s: number; max_s: number                 // faixa de atraso base (aleatória dentro dela)
  dias: number[]                               // dias ativos (0=dom … 6=sáb)
  inicio_min: number; fim_min: number          // janela em minutos do dia (ex.: 420 = 07:00), a mesma em todos os dias ativos
  fuso: string
}
// padrão (pedido do Gabriel, 29/10): cliente normal responde a qualquer hora, só não de madrugada → todos os dias 07:00–22:00
export const RITMO_PADRAO: Ritmo = { min_s: 40, max_s: 240, dias: [0, 1, 2, 3, 4, 5, 6], inicio_min: 7 * 60, fim_min: 22 * 60, fuso: 'America/Sao_Paulo' }
/** dias ativos de "0,1,…" ou [0,1,…]; inválido/vazio = todos */
function diasValidos(v: unknown): number[] {
  const xs = (Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => String(x).trim()).filter(x => x !== '')
  if (!xs.length || xs.some(x => !/^[0-6]$/.test(x))) return RITMO_PADRAO.dias
  return [...new Set(xs.map(Number))].sort((a, b) => a - b)
}
const hhmm = (v: unknown): number | null => { const m = String(v ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
/** lê o ritmo de oculto_config com padrões seguros (valor inválido = padrão) */
export function ritmoDaConfig(c: any): Ritmo {
  const min = Number(c?.resposta_min_s), max = Number(c?.resposta_max_s)
  const okMin = Number.isFinite(min) && min >= 0 && min <= 3600 ? min : RITMO_PADRAO.min_s
  const okMax = Number.isFinite(max) && max >= okMin && max <= 7200 ? max : Math.max(okMin, RITMO_PADRAO.max_s)
  const ini = hhmm(c?.janela_inicio) ?? RITMO_PADRAO.inicio_min, fim = hhmm(c?.janela_fim) ?? RITMO_PADRAO.fim_min
  const janelaOk = fim > ini
  return {
    min_s: okMin, max_s: okMax,
    dias: diasValidos(c?.janela_dias),
    inicio_min: janelaOk ? ini : RITMO_PADRAO.inicio_min, fim_min: janelaOk ? fim : RITMO_PADRAO.fim_min,
    fuso: fusoValido(c?.fuso) ? c.fuso : RITMO_PADRAO.fuso,
  }
}
function fusoValido(f: unknown): f is string { if (typeof f !== 'string' || !f) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: f }); return true } catch { return false } }
/** semente em [0,1) a partir de um texto (FNV-1a) */
export function semente(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h / 0x100000000
}
/** atraso de "ler + pensar" em segundos: base aleatória [min,max] + leitura (1 s a cada 12 caracteres, até +120 s) */
export function atrasoResposta(charsEntrada: number, seed: number, r: Ritmo): number {
  const base = r.min_s + seed * (r.max_s - r.min_s)
  const leitura = Math.min(120, Math.max(0, charsEntrada) / 12)
  return Math.round(base + leitura)
}
/** tempo de "digitando..." mostrado antes do envio (ms): ~5 caracteres/s, entre 2 e 20 s */
export const digitarMs = (charsSaida: number) => Math.round(Math.min(20, Math.max(2, Math.max(0, charsSaida) / 5)) * 1000)
// partes locais (dia da semana e minuto do dia) de um instante no fuso
function local(ts: number, fuso: string): { dow: number; min: number; segDia: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: fuso, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts * 1000)).map(x => [x.type, x.value]))
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(p.weekday))
  return { dow, min: Number(p.hour) * 60 + Number(p.minute), segDia: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) }
}
/** primeiro instante >= ts dentro da janela; fora dela, abertura da próxima janela + folga de 0–15 min (pela semente) */
export function proximaJanela(ts: number, r: Ritmo, seed = 0): number {
  for (let d = 0; d < 8; d++) {
    const t = ts + d * 86400
    const l = local(t, r.fuso)
    if (!r.dias.includes(l.dow)) continue
    const fim = r.fim_min
    const inicioDia = t - l.segDia   // meia-noite local desse dia
    const abre = inicioDia + r.inicio_min * 60, fecha = inicioDia + fim * 60
    if (d === 0 && ts >= abre && ts < fecha) return ts
    const alvo = Math.max(abre, d === 0 ? ts : abre) + Math.round(seed * 900)
    if (alvo < fecha && alvo >= ts) return alvo
  }
  return ts   // configuração sem nenhum dia válido: não segura
}
/** instante em que a persona pode responder: última mensagem da empresa + atraso, empurrado para a janela */
export function quandoResponder(sessaoId: string, hist: Msg[], r: Ritmo): number | null {
  let i = hist.length - 1
  if (i < 0 || hist[i].direcao !== 'in') return null
  const ultimaIn = hist[i].ts
  let chars = 0
  for (; i >= 0 && hist[i].direcao === 'in'; i--) chars += (hist[i].texto ?? '').length   // todas as mensagens ainda sem resposta
  const seed = semente(`${sessaoId}:${ultimaIn}`)
  return proximaJanela(ultimaIn + atrasoResposta(chars, seed, r), r, seed)
}
