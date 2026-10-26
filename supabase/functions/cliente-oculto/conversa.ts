// cliente-oculto/conversa.ts — lógica PURA do cliente oculto (testável sem rede).
//
// Ciclo de uma sessão (1 empresa-alvo, 1 número anônimo):
//   sondagem → (empresa responde?) → cronômetro da 1ª resposta → conversa curta como "cliente"
//   (persona por nicho, até N turnos) → janela de follow-up (24/48/72 h sem a empresa escrever = sem
//   follow-up) → avaliação por critério (tempo de resposta, qualificação, proposta/preço, follow-up)
//   → nota final 0–10 e parecer. O LLM (Haiku) só escreve as falas da persona e o parecer final;
//   tudo que é regra (quando parar, prazos, notas por critério) é determinístico aqui.
export type Direcao = 'out' | 'in'
export type Msg = { direcao: Direcao; texto: string; ts: number }   // ts em segundos (epoch)
export type Persona = { nome: string; contexto: string; objetivo: string; tom: string }
export type Sessao = {
  id: string; empresa: string; nicho: string | null; numero_alvo: string
  status: 'pendente' | 'enviada' | 'conversando' | 'aguardando_followup' | 'concluida' | 'erro' | 'cancelada'
  iniciada_em: number | null; ultima_in_em: number | null; ultima_out_em: number | null
  turnos_persona: number; max_turnos: number
  janela_followup_h: number   // 72 por padrão
}
export const PADRAO = { max_turnos: 4, janela_followup_h: 72, espera_resposta_persona_s: 90, sem_resposta_encerrar_h: 72 }

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

// ── prompts (o LLM recebe isto; a resposta é só o texto da próxima fala) ────
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
export type Metricas = { tempo_primeira_resposta_s: number | null; respondeu: boolean; turnos_empresa: number; followup_24h: boolean; followup_48h: boolean; followup_72h: boolean; encerrou_sem_resposta: boolean }
export function metricas(hist: Msg[], agora: number, janelaH = PADRAO.janela_followup_h): Metricas {
  const outs = hist.filter((m) => m.direcao === 'out'), ins = hist.filter((m) => m.direcao === 'in')
  const primeiraOut = outs[0]?.ts ?? null
  const primeiraIn = primeiraOut != null ? ins.find((m) => m.ts >= primeiraOut)?.ts ?? null : null
  // follow-up = a EMPRESA escreveu de novo depois que a última fala foi dela própria OU após ≥ 20 h de silêncio nosso
  const ultimaOut = outs[outs.length - 1]?.ts ?? null
  const fu = (h: number) => ultimaOut != null && ins.some((m) => m.ts > ultimaOut && m.ts - ultimaOut >= 0 && m.ts - ultimaOut <= h * 3600 && m.ts - ultimaOut >= Math.min(h, 20) * 3600 - 3600)
  return {
    tempo_primeira_resposta_s: primeiraOut != null && primeiraIn != null ? primeiraIn - primeiraOut : null,
    respondeu: primeiraIn != null,
    turnos_empresa: ins.length,
    followup_24h: fu(24), followup_48h: fu(48), followup_72h: fu(72),
    encerrou_sem_resposta: primeiraIn == null && primeiraOut != null && agora - primeiraOut >= janelaH * 3600,
  }
}

// ── notas por critério (0–10, determinísticas onde dá) ───────────────────────
export type Notas = { tempo_resposta: number; qualificacao: number; proposta_preco: number; followup: number; tom: number; final: number }
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
export function consolidar(m: Metricas, ia: { qualificacao?: number; proposta_preco?: number; tom?: number } | null): Notas {
  const clamp = (x: unknown) => Math.max(0, Math.min(10, Number(x ?? 0) || 0))
  const n: Notas = { tempo_resposta: notaTempo(m.tempo_primeira_resposta_s), qualificacao: m.respondeu ? clamp(ia?.qualificacao) : 0, proposta_preco: m.respondeu ? clamp(ia?.proposta_preco) : 0, followup: notaFollowup(m), tom: m.respondeu ? clamp(ia?.tom) : 0, final: 0 }
  // pesos: tempo 30%, qualificação 20%, proposta/preço 20%, follow-up 20%, tom 10%
  n.final = Math.round((n.tempo_resposta * 0.3 + n.qualificacao * 0.2 + n.proposta_preco * 0.2 + n.followup * 0.2 + n.tom * 0.1) * 10) / 10
  return n
}

// ── máquina de estados: o que fazer agora ────────────────────────────────────
export type Decisao =
  | { acao: 'responder' }                       // empresa falou e ainda temos turnos: persona responde
  | { acao: 'esperar' }                         // nada a fazer agora
  | { acao: 'aguardar_followup' }               // conversa chegou ao fim dos turnos: entra na janela de follow-up
  | { acao: 'concluir'; motivo: string }        // janela vencida ou sem resposta: avalia e encerra
export function decidir(s: Sessao, hist: Msg[], agora: number): Decisao {
  if (['concluida', 'erro', 'cancelada', 'pendente'].includes(s.status)) return { acao: 'esperar' }
  const ultima = hist[hist.length - 1]
  if (s.status === 'enviada') {
    if (ultima?.direcao === 'in') return s.turnos_persona < s.max_turnos ? { acao: 'responder' } : { acao: 'aguardar_followup' }
    if (s.iniciada_em != null && agora - s.iniciada_em >= PADRAO.sem_resposta_encerrar_h * 3600) return { acao: 'concluir', motivo: 'sem resposta da empresa em 72 h' }
    return { acao: 'esperar' }
  }
  if (s.status === 'conversando') {
    if (ultima?.direcao === 'in') return s.turnos_persona < s.max_turnos ? { acao: 'responder' } : { acao: 'aguardar_followup' }
    // nossa última fala sem resposta: depois de 24 h sem retorno, entra na janela de follow-up
    if (ultima?.direcao === 'out' && agora - ultima.ts >= 24 * 3600) return { acao: 'aguardar_followup' }
    return { acao: 'esperar' }
  }
  if (s.status === 'aguardando_followup') {
    const ref = s.ultima_out_em ?? s.iniciada_em ?? agora
    if (agora - ref >= s.janela_followup_h * 3600) return { acao: 'concluir', motivo: 'janela de follow-up encerrada' }
    return { acao: 'esperar' }
  }
  return { acao: 'esperar' }
}

// ── normalização de número (BR) e extração do texto do webhook da Evolution ──
export function numeroWa(n: string): string | null {
  const d = (n ?? '').replace(/\D/g, '')
  if (!d) return null
  let x = d.startsWith('55') && d.length >= 12 ? d : `55${d.replace(/^0+/, '')}`
  // celular BR sem o 9: 55 + DDD(2) + 8 dígitos → insere o 9
  if (x.length === 12 && /^55\d{2}[6-9]/.test(x)) x = `${x.slice(0, 4)}9${x.slice(4)}`
  return /^55\d{10,11}$/.test(x) ? x : null
}
export function textoDoEvento(data: any): { de: string | null; fromMe: boolean; id: string | null; texto: string; ts: number } | null {
  const key = data?.key ?? {}
  const remote = String(key.remoteJid ?? '')
  if (!remote || /@g\.us$/.test(remote)) return null   // grupos não contam
  const m = data?.message ?? {}
  const bruto = m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? (m.audioMessage ? '[áudio]' : (m.documentMessage ? '[documento]' : ''))
  const texto = String(bruto ?? '').trim()
  const ts = Number(data?.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000)
  return { de: remote.replace(/@.*$/, '').replace(/\D/g, '') || null, fromMe: !!key.fromMe, id: key.id ? String(key.id) : null, texto, ts }
}
