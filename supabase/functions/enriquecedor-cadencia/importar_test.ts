// deno test supabase/functions/enriquecedor-cadencia/importar_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { importarCorpo, volume24h } from './importar.ts'

const CAMPOS = new Map<number, string>([[1044481, 'CAD Nome decisor'], [1044483, 'CAD SDR'], [1044485, 'CAD Fantasia'], [1046761, 'CAD Pontos diagnostico'], [9, 'Telefone']])
const CHAVE: Record<string, string> = { 'CAD Nome decisor': 'nome1', 'CAD SDR': 'sdr', 'CAD Fantasia': 'fantasia', 'CAD Pontos diagnostico': 'pontos' }

Deno.test('converte o corpo do Kommo (66825, sem SDR) em posicional + chaves_vars', () => {
  const content = 'Oi {{lead.cf.1044481}}, aqui é da V4 Ruston.\n\nA {{lead.cf.1044485}} foi uma delas.\n\nSó pra adiantar: {{lead.cf.1046761}}.\n'
  const r = importarCorpo(content, [{ text: 'Pode ligar agora' }, { text: ' ' }, { text: 'Não quero receber' }], CAMPOS, CHAVE)
  assertEquals(r, { ok: true, modelo: {
    corpo: 'Oi {{1}}, aqui é da V4 Ruston.\n\nA {{2}} foi uma delas.\n\nSó pra adiantar: {{3}}.',
    chaves_vars: ['nome1', 'fantasia', 'pontos'],
    variaveis: ['CAD Nome decisor', 'CAD Fantasia', 'CAD Pontos diagnostico'],
    botoes: ['Pode ligar agora', 'Não quero receber'],
  } })
})

Deno.test('mesmo campo repetido reaproveita a posição', () => {
  const r = importarCorpo('{{lead.cf.1044481}} e {{ lead.cf.1044485 }} e {{lead.cf.1044481}}', null, CAMPOS, CHAVE)
  assertEquals(r.ok && r.modelo.corpo, '{{1}} e {{2}} e {{1}}')
})

Deno.test('placeholder fora dos campos CAD = erro (não importa pela metade)', () => {
  assertEquals(importarCorpo('Oi {{contact.name}} {{lead.cf.9}} {{lead.cf.777}}', [], CAMPOS, CHAVE),
    { ok: false, erro: 'variáveis que o hub não sabe preencher: contact.name, lead.cf.9 (Telefone), lead.cf.777' })
  assertEquals(importarCorpo('  ', [], CAMPOS, CHAVE), { ok: false, erro: 'modelo sem corpo' })
})

Deno.test('volume24h: cards distintos por canal, só enviados nas últimas 24 h', () => {
  const agora = Date.parse('2026-10-29T18:00:00Z')
  const e = (source_id: number | null, card: string, h: number | null) => ({ source_id, kommo_lead_id: card, enviado_em: h == null ? null : new Date(agora - h * 3600_000).toISOString() })
  assertEquals(volume24h([e(70787, 'a', 1), e(70787, 'a', 2), e(70787, 'b', 23), e(70787, 'c', 25), e(null, 'd', 3), e(70787, 'e', null)], agora), { '70787': 2, sem_canal: 1 })
})
