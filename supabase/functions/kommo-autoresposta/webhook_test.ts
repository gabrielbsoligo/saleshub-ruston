// deno test supabase/functions/kommo-autoresposta/webhook_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { desdobrar, extrairMensagens } from './webhook.ts'

const form = (pares: Record<string, string>) => new URLSearchParams(pares)

Deno.test('add_message incoming de lead: id, texto, lead, created_at', () => {
  const p = desdobrar(form({
    'account[id]': '34424367', 'message[add][0][id]': '5555284b-0bb0-42f2-abdc-71154f20ca3f', 'message[add][0][chat_id]': 'abc',
    'message[add][0][talk_id]': '19392', 'message[add][0][contact_id]': '32969357', 'message[add][0][text]': 'Oi, pode falar',
    'message[add][0][created_at]': '1792789049', 'message[add][0][element_type]': '2', 'message[add][0][element_id]': '25048949',
    'message[add][0][entity_type]': 'lead', 'message[add][0][type]': 'incoming', 'message[add][0][author][id]': 'x', 'message[add][0][author][name]': 'Fulano',
  }))
  const [m] = extrairMensagens(p)
  assertEquals(m.id, '5555284b-0bb0-42f2-abdc-71154f20ca3f'); assertEquals(m.tipo, 'incoming'); assertEquals(m.texto, 'Oi, pode falar')
  assertEquals(m.leadId, 25048949); assertEquals(m.contactId, 32969357); assertEquals(m.talkId, 19392); assertEquals(m.createdAt, 1792789049); assertEquals(m.anexo, null)
})

Deno.test('outgoing é reconhecido (para ignorar); element_type != 2 não vira lead', () => {
  const p = desdobrar(form({ 'message[add][0][id]': 'm2', 'message[add][0][type]': 'outgoing', 'message[add][0][element_type]': '1', 'message[add][0][element_id]': '77', 'message[add][0][text]': 'disparo' }))
  const [m] = extrairMensagens(p)
  assertEquals(m.tipo, 'outgoing'); assertEquals(m.leadId, null); assertEquals(m.elementType, 1)
})

Deno.test('áudio sem texto vira [audio]; outro anexo vira [midia]; anexo com legenda mantém o texto', () => {
  const a = extrairMensagens(desdobrar(form({ 'message[add][0][id]': 'a', 'message[add][0][type]': 'incoming', 'message[add][0][attachment][type]': 'voice', 'message[add][0][attachment][link]': 'https://x' })))[0]
  assertEquals(a.texto, '[audio]'); assertEquals(a.anexo, 'voice')
  const b = extrairMensagens(desdobrar(form({ 'message[add][0][id]': 'b', 'message[add][0][type]': 'incoming', 'message[add][0][attachment][type]': 'picture' })))[0]
  assertEquals(b.texto, '[midia]')
  const c = extrairMensagens(desdobrar(form({ 'message[add][0][id]': 'c', 'message[add][0][type]': 'incoming', 'message[add][0][text]': 'segue a foto', 'message[add][0][attachment][type]': 'picture' })))[0]
  assertEquals(c.texto, 'segue a foto')
})

Deno.test('várias mensagens no mesmo payload saem em ordem; sem message[add] → lista vazia; JSON equivalente também funciona', () => {
  const p = desdobrar(form({ 'message[add][1][id]': 'b', 'message[add][1][type]': 'incoming', 'message[add][0][id]': 'a', 'message[add][0][type]': 'incoming' }))
  assertEquals(extrairMensagens(p).map((m) => m.id), ['a', 'b'])
  assertEquals(extrairMensagens(desdobrar(form({ 'leads[add][0][id]': '1' }))), [])
  assertEquals(extrairMensagens({ message: { add: [{ id: 'j', type: 'incoming', text: 'oi', element_type: 2, element_id: 5 }] } })[0].leadId, 5)
})
