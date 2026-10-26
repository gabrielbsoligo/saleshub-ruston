import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { consolidar, decidir, metricas, notaFollowup, notaTempo, numeroWa, personaPara, textoDoEvento, type Msg, type Sessao } from './conversa.ts'

const T0 = 1_800_000_000
const sessao = (p: Partial<Sessao> = {}): Sessao => ({ id: 's', empresa: 'Odonto X', nicho: 'odontologia', numero_alvo: '5511999999999', status: 'enviada', iniciada_em: T0, ultima_in_em: null, ultima_out_em: T0, turnos_persona: 1, max_turnos: 4, janela_followup_h: 72, ...p })

Deno.test('persona por nicho: odonto, imobiliária e genérico', () => {
  assert(personaPara('odontologia', 'X').objetivo.includes('convênio'))
  assert(personaPara('Imobiliária', 'X').contexto.includes('imóvel'))
  assert(personaPara(null, 'Loja Y').contexto.includes('Loja Y'))
})

Deno.test('métricas: tempo da 1ª resposta, sem resposta encerra em 72 h, follow-up 24/48/72', () => {
  const h: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 600 }]
  const m = metricas(h, T0 + 1000)
  assertEquals(m.tempo_primeira_resposta_s, 600); assertEquals(m.respondeu, true); assertEquals(m.turnos_empresa, 1)
  const semResp = metricas([{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 73 * 3600)
  assertEquals(semResp.respondeu, false); assertEquals(semResp.encerrou_sem_resposta, true)
  // empresa volta a falar 30 h depois da nossa última fala = follow-up em 48 h (não em 24)
  const fu: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 60 }, { direcao: 'out', texto: 'quanto custa?', ts: T0 + 120 }, { direcao: 'in', texto: 'e aí, conseguiu ver?', ts: T0 + 120 + 30 * 3600 }]
  const mf = metricas(fu, T0 + 80 * 3600)
  assertEquals([mf.followup_24h, mf.followup_48h, mf.followup_72h], [false, true, true])
})

Deno.test('notas: tempo por faixa; follow-up por janela; consolidação com pesos e sem resposta = zeros', () => {
  assertEquals([notaTempo(60), notaTempo(20 * 60), notaTempo(3600), notaTempo(5 * 3600), notaTempo(20 * 3600), notaTempo(48 * 3600), notaTempo(null)], [10, 8, 6, 4, 2, 1, 0])
  const m = metricas([{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 120 }], T0 + 1000)
  const n = consolidar(m, { qualificacao: 8, proposta_preco: 6, tom: 9 })
  assertEquals(n.tempo_resposta, 10); assertEquals(n.followup, 0); assertEquals(n.final, 6.7)   // 3 + 1.6 + 1.2 + 0 + 0.9
  const zero = consolidar(metricas([{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 100), { qualificacao: 9 })
  assertEquals(zero.final, 0); assertEquals(notaFollowup(zero as any), 0)
})

Deno.test('decidir: responde enquanto há turnos; esgotou → aguarda follow-up; janela vencida → conclui; sem resposta 72 h → conclui', () => {
  const h: Msg[] = [{ direcao: 'out', texto: 'oi', ts: T0 }, { direcao: 'in', texto: 'olá', ts: T0 + 60 }]
  assertEquals(decidir(sessao(), h, T0 + 100), { acao: 'responder' })
  assertEquals(decidir(sessao({ status: 'conversando', turnos_persona: 4 }), h, T0 + 100), { acao: 'aguardar_followup' })
  assertEquals(decidir(sessao({ status: 'conversando' }), [...h, { direcao: 'out', texto: 'ok', ts: T0 + 120 }], T0 + 120 + 25 * 3600), { acao: 'aguardar_followup' })
  assertEquals(decidir(sessao({ status: 'aguardando_followup', ultima_out_em: T0 }), h, T0 + 73 * 3600).acao, 'concluir')
  assertEquals(decidir(sessao({ status: 'aguardando_followup', ultima_out_em: T0 }), h, T0 + 10 * 3600), { acao: 'esperar' })
  assertEquals(decidir(sessao(), [{ direcao: 'out', texto: 'oi', ts: T0 }], T0 + 73 * 3600).acao, 'concluir')
  assertEquals(decidir(sessao({ status: 'concluida' }), h, T0), { acao: 'esperar' })
})

Deno.test('numeroWa: normaliza BR (DDI, 9º dígito) e rejeita lixo; textoDoEvento: conversation/extendedText, grupos ignorados', () => {
  assertEquals(numeroWa('(11) 98888-7777'), '5511988887777')
  assertEquals(numeroWa('11 8888-7777'), '5511988887777')
  assertEquals(numeroWa('+55 31 3333-4444'), '553133334444')
  assertEquals(numeroWa('abc'), null)
  const e = textoDoEvento({ key: { remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'ABC' }, pushName: 'Loja', message: { extendedTextMessage: { text: 'Olá! Tudo bem?' } }, messageTimestamp: T0 })
  assertEquals(e, { de: '5511988887777', fromMe: false, id: 'ABC', texto: 'Olá! Tudo bem?', ts: T0 })
  assertEquals(textoDoEvento({ key: { remoteJid: '123@g.us' }, message: { conversation: 'x' } }), null)
  assertEquals(textoDoEvento({ key: { remoteJid: '5511@s.whatsapp.net', fromMe: true }, message: { conversation: 'nossa' }, messageTimestamp: T0 })!.fromMe, true)
})
