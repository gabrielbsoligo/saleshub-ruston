import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { aceitarEvento, classificarEnvio, consolidar, decidir, idDeterministico, identidadeEstavel, metricas, notaFollowup, notaTempo, numeroWa, personaPara, proximoAposFala, textoDoEvento, type Msg, type Sessao } from './conversa.ts'

const T0 = 1_800_000_000
const H = 3600
const sessao = (p: Partial<Sessao> = {}): Sessao => ({ id: 's', empresa: 'Odonto X', nicho: 'odontologia', numero_alvo: '5511999999999', status: 'enviada', fase: 'ocioso', iniciada_em: T0, ultima_in_em: null, ultima_out_em: T0, turnos_persona: 1, max_turnos: 4, janela_followup_h: 72, ...p })

Deno.test('persona por nicho: odonto, imobiliária e genérico', () => {
  assert(personaPara('odontologia', 'X').objetivo.includes('convênio'))
  assert(personaPara('Imobiliária', 'X').contexto.includes('imóvel'))
  assert(personaPara(null, 'Loja Y').contexto.includes('Loja Y'))
})

Deno.test('métricas: 1ª resposta TARDIA (20 h) é resposta, não follow-up; follow-up = nova iniciativa da empresa (in após in), por janela', () => {
  // resposta em 20 h: nenhum follow-up
  const tardia: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá, desculpe a demora', ts: T0 + 20 * H }]
  const mt = metricas(tardia, T0 + 30 * H)
  assertEquals(mt.tempo_primeira_resposta_s, 20 * H); assertEquals([mt.followup_24h, mt.followup_48h, mt.followup_72h, mt.followups], [false, false, false, 0]); assertEquals(notaFollowup(mt), 0)
  // follow-up verdadeiro: empresa responde, nós perguntamos, ela responde, e 30 h depois ELA volta sozinha
  const fu: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 60 }, { direcao: 'out', texto: 'quanto custa?', ts: T0 + 120 }, { direcao: 'in', texto: 'R$ 100', ts: T0 + 180 }, { direcao: 'in', texto: 'e aí, conseguiu ver?', ts: T0 + 180 + 30 * H }]
  const mf = metricas(fu, T0 + 80 * H)
  assertEquals([mf.followup_24h, mf.followup_48h, mf.followup_72h, mf.followups], [false, true, false, 1]); assertEquals(notaFollowup(mf), 7)
  // duas mensagens seguidas da empresa na mesma conversa (minutos) não são follow-up
  const seq: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 60 }, { direcao: 'in', texto: 'posso ajudar?', ts: T0 + 90 }]
  assertEquals(metricas(seq, T0 + H).followups, 0)
  // sem resposta encerra em 72 h
  const semResp = metricas([{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 73 * H)
  assertEquals(semResp.respondeu, false); assertEquals(semResp.encerrou_sem_resposta, true)
})

Deno.test('notas: tempo por faixa; consolidação com pesos; IA ausente com conversa = INCOMPLETA (null), nunca zero; sem resposta = zeros legítimos', () => {
  assertEquals([notaTempo(60), notaTempo(20 * 60), notaTempo(H), notaTempo(5 * H), notaTempo(20 * H), notaTempo(48 * H), notaTempo(null)], [10, 8, 6, 4, 2, 1, 0])
  const m = metricas([{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 120 }], T0 + 1000)
  const n = consolidar(m, { qualificacao: 8, proposta_preco: 6, tom: 9 })
  assertEquals(n.final, 6.7); assertEquals(n.incompleta, false)   // 3 + 1.6 + 1.2 + 0 + 0.9
  const semIa = consolidar(m, null)
  assertEquals(semIa.incompleta, true); assertEquals(semIa.final, null); assertEquals(semIa.qualificacao, null); assertEquals(semIa.tempo_resposta, 10)
  const invalida = consolidar(m, { qualificacao: 'x', proposta_preco: 5, tom: 5 })
  assertEquals(invalida.incompleta, true); assertEquals(invalida.final, null)
  // null/false/''/objeto NÃO viram zero (R3#3)
  for (const ruim of [{ qualificacao: null, proposta_preco: null, tom: null }, { qualificacao: false, proposta_preco: 5, tom: 5 }, { qualificacao: '', proposta_preco: 5, tom: 5 }, { qualificacao: {}, proposta_preco: 5, tom: 5 }]) {
    const r = consolidar(m, ruim as any); assertEquals(r.incompleta, true); assertEquals(r.final, null)
  }
  assertEquals(consolidar(m, { qualificacao: '7', proposta_preco: 6, tom: 9 }).incompleta, false)   // string numérica vale
  const zero = consolidar(metricas([{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 100), null)
  assertEquals(zero.incompleta, false); assertEquals(zero.final, 0); assertEquals(zero.qualificacao, 0)
})

Deno.test('decidir: abrir; responder enquanto há turnos; esgotou → aguarda follow-up com prazo; 24 h de silêncio após nossa fala → aguarda; janela vencida → avaliar; sem resposta 72 h → avaliar; esperar devolve próximo instante', () => {
  const h: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 60 }]
  assertEquals(decidir(sessao({ status: 'pendente' }), [], T0), { acao: 'abrir' })
  assertEquals(decidir(sessao(), h, T0 + 100), { acao: 'responder' })
  assertEquals(decidir(sessao({ status: 'conversando', turnos_persona: 4, ultima_out_em: T0 }), h, T0 + 100), { acao: 'aguardar_followup', proximo_em: T0 + 72 * H })
  const hOut = [...h, { direcao: 'out' as const, texto: 'ok', ts: T0 + 120 }]
  assertEquals(decidir(sessao({ status: 'conversando' }), hOut, T0 + 120 + 25 * H), { acao: 'aguardar_followup', proximo_em: T0 + 120 + 72 * H })
  assertEquals(decidir(sessao({ status: 'conversando' }), hOut, T0 + 120 + 2 * H), { acao: 'esperar', proximo_em: T0 + 120 + 24 * H })
  assertEquals(decidir(sessao({ status: 'aguardando_followup', ultima_out_em: T0 }), h, T0 + 73 * H).acao, 'avaliar')
  assertEquals(decidir(sessao({ status: 'aguardando_followup', ultima_out_em: T0 }), h, T0 + 10 * H), { acao: 'esperar', proximo_em: T0 + 72 * H })
  assertEquals(decidir(sessao(), [{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 73 * H).acao, 'avaliar')
  assertEquals(decidir(sessao(), [{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 10 * H), { acao: 'esperar', proximo_em: T0 + 72 * H })
  assertEquals(decidir(sessao({ status: 'avaliando' }), h, T0).acao, 'avaliar')
  assertEquals(decidir(sessao({ status: 'concluida' }), h, T0), { acao: 'esperar', proximo_em: null })
  assertEquals(proximoAposFala('enviada', T0), T0 + 72 * H); assertEquals(proximoAposFala('conversando', T0), T0 + 24 * H)
})

Deno.test('numeroWa canônico nos DOIS lados: cadastro "11 8888-7777" e remoteJid 551188887777 viram 5511988887777; grupos ignorados; fromMe', () => {
  assertEquals(numeroWa('(11) 98888-7777'), '5511988887777')
  assertEquals(numeroWa('11 8888-7777'), '5511988887777')
  assertEquals(numeroWa('+55 31 3333-4444'), '553133334444')
  assertEquals(numeroWa('abc'), null)
  const e = textoDoEvento({ key: { remoteJid: '551188887777@s.whatsapp.net', fromMe: false, id: 'ABC' }, pushName: 'Loja', message: { extendedTextMessage: { text: 'Olá! Tudo bem?' } }, messageTimestamp: T0 })
  assertEquals(e, { de: '5511988887777', fromMe: false, id: 'ABC', texto: 'Olá! Tudo bem?', ts: T0 })
  assertEquals(e!.de, numeroWa('11 8888-7777'))
  assertEquals(textoDoEvento({ key: { remoteJid: '123@g.us' }, message: { conversation: 'x' } }), null)
  assertEquals(textoDoEvento({ key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: true }, message: { conversation: 'nossa' }, messageTimestamp: T0 })!.fromMe, true)
})

Deno.test('identidade: key.id > determinística (remetente|messageTimestamp|texto) > QUARENTENA (sem id e sem instante: nunca usa a hora de recebimento)', () => {
  const a = idDeterministico('5511988887777', T0, 'oi'), b = idDeterministico('5511988887777', T0, 'oi')
  assertEquals(a, b); assert(a.startsWith(`in-${T0}-`))
  assert(idDeterministico('5511988887777', T0, 'oi!') !== a && idDeterministico('5511988887777', T0 + 1, 'oi') !== a)
  const comTs = textoDoEvento({ key: { remoteJid: '5511988887777@s.whatsapp.net' }, message: { conversation: 'oi' }, messageTimestamp: T0 })!
  assertEquals(identidadeEstavel(comTs), idDeterministico('5511988887777', T0, 'oi'))
  // mesmo payload sem key.id e sem messageTimestamp, "reentregue 10 s depois": ts null nas duas vezes → quarentena nas duas (nenhuma identidade)
  const semNada = { key: { remoteJid: '5511988887777@s.whatsapp.net' }, message: { conversation: 'oi' } }
  const e1 = textoDoEvento(semNada)!, e2 = textoDoEvento(semNada)!
  assertEquals(e1.ts, null); assertEquals(identidadeEstavel(e1), null); assertEquals(identidadeEstavel(e2), null)
  // key.id presente mas SEM messageTimestamp: identidade existe, mas o evento NÃO é aceito (nunca iso(null)/epoch)
  const soId = textoDoEvento({ key: { remoteJid: '5511988887777@s.whatsapp.net', id: 'ABC' }, message: { conversation: 'oi' } })!
  assertEquals(soId.ts, null); assertEquals(identidadeEstavel(soId), 'ABC')
  const ac = aceitarEvento(soId); assertEquals(ac.ok, false); assert(!ac.ok && ac.motivo.includes('key.id sem messageTimestamp'))
  assertEquals(aceitarEvento(e1).ok, false)
  const okEv = aceitarEvento(comTs); assert(okEv.ok && okEv.ts === T0 && okEv.waId === idDeterministico('5511988887777', T0, 'oi'))
  // timestamp em milissegundos também é aceito e normalizado
  assertEquals(textoDoEvento({ key: { remoteJid: '5511988887777@s.whatsapp.net', id: 'X' }, message: { conversation: 'oi' }, messageTimestamp: T0 * 1000 })!.ts, T0)
})

Deno.test('classificarEnvio: aceito = ok; 4xx = definitivo (não reenviar); timeout/rede/5xx/429 = incerto (reconciliar antes de reenviar)', () => {
  assertEquals(classificarEnvio({ ok: true, status: 201 }), 'ok')
  assertEquals(classificarEnvio({ ok: false, status: 400 }), 'definitivo')
  assertEquals(classificarEnvio({ ok: false, status: 0, transporte: true }), 'incerto')
  assertEquals(classificarEnvio({ ok: false, status: 502 }), 'incerto')
  assertEquals(classificarEnvio({ ok: false, status: 429 }), 'incerto')
})
