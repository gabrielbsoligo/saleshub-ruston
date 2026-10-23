// deno test supabase/functions/kommo-autoresposta/triagem_test.ts
// Casos sintéticos no formato dos textos reais da amostra de 23/10 (sem dados pessoais).
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { casaPadrao, classificar, normalizar, resolverIndeterminado, type Padrao } from './triagem.ts'

// Mesmos padrões semeados na migration_157 (mantidos em sincronia à mão; a tabela é a fonte em produção).
const PADROES: Padrao[] = [
  { id: 1, padrao: '^\\[audio\\]$', tipo: 'humano' },
  { id: 2, padrao: 'nome: .*telefone \\(celular\\)', tipo: 'humano' },
  { id: 3, padrao: 'agradec\\w* (sua mensagem|seu contato|o seu contato|pela mensagem|pelo contato|pelo seu contato)', tipo: 'autoresposta' },
  { id: 4, padrao: '(nao estamos disponiveis|nao estou disponivel|estamos indisponiveis|estou indisponivel)', tipo: 'autoresposta' },
  { id: 5, padrao: '(responder\\w*|retornar\\w*|entrar\\w* em contato|responderei|retornarei)\\s*(o\\s*)?(assim que|o mais (rapido|breve)|em breve|logo|dentro desse)', tipo: 'autoresposta' },
  { id: 7, padrao: 'mensagem automatica|resposta automatica|atendimento automatico', tipo: 'autoresposta' },
  { id: 8, padrao: 'horario de (atendimento|funcionamento)|fora do horario|atendemos de segunda|de segunda a sexta', tipo: 'autoresposta' },
  { id: 9, padrao: 'seja (muito )?bem ?vind|bem ?vindo \\(?a\\)? (a|ao|à)', tipo: 'autoresposta' },
  { id: 10, padrao: 'como pod(emos|o) (te )?ajudar|em que posso (te )?ajudar|como posso (te )?ajudar|posso te ajudar|podemos ajudar', tipo: 'autoresposta' },
  { id: 11, padrao: 'escolha uma (das )?opc|opcoes abaixo|digite (o numero|a opcao|#|o setor)|para falar com (o setor|vendas|um atendente)|(^|\\s)# ?- ?[a-z]|1️⃣|setor especifico', tipo: 'autoresposta' },
  { id: 12, padrao: 'assistente virtual|sou (a|o) [a-z ]{0,30}(assistente|secretari)|aqui para te atender|estou aqui para te ajudar', tipo: 'autoresposta' },
  { id: 13, padrao: 'recebemos sua (mensagem|solicitacao)|voce entrou em contato com|sua mensagem foi recebida', tipo: 'autoresposta' },
]
const CFG = { janela_rapida_s: 60, repeticao_min: 3 }

Deno.test('normalizar: minúsculas, sem acento, dígitos viram #, pontuação some', () => {
  assertEquals(normalizar('Olá! Atendemos de Segunda a Sexta, das 9 às 18h.'), 'ola atendemos de segunda a sexta das # as #h')
})

Deno.test('R1: saudação padrão do WhatsApp Business', () => {
  const p = casaPadrao('‎Empresa Tal agradece seu contato. Como podemos ajudar?', PADROES)
  assertEquals(p?.tipo, 'autoresposta')
  assertEquals(classificar({ intervaloS: 4, repeticoes: 0, padrao: p, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'autoresposta')
})

Deno.test('R1: ausência, horário, menu de bot, assistente virtual, declara-se automática', () => {
  for (const t of [
    'Agradecemos sua mensagem. Não estamos disponíveis no momento, mas responderemos assim que possível.',
    'Olá! Nosso horário de atendimento é de segunda à sexta das 9h às 18h, vou te responder assim que possível.',
    'Seja bem vindo! Para agilizar seu atendimento, escolha uma das opções abaixo: 1 - Comercial 2 - Financeiro',
    'Olá! Sou a 🤖 *Mara*, assistente virtual de atendimento.',
    'Olá, esta é uma mensagem automática, pois estamos fora do horário de atendimento comercial.',
    'Você entrou em contato com a área de Vendas. Aguarde que em breve entraremos em contato.',
  ]) assertEquals(casaPadrao(t, PADROES)?.tipo, 'autoresposta', t)
})

Deno.test('humano: respostas curtas/reais NÃO casam padrão', () => {
  for (const t of ['Oi, boa tarde!', 'Quero entender', 'não tenho interesse', 'Pode ser amanhã às 9?', 'Okk', 'Boa tarde Laryssa !! Agora estou ocupado. Sobre o que seria ???', 'Olá, boa tarde. Aqui quem fala é a Giovanna do setor comercial'])
    assertEquals(casaPadrao(t, PADROES), null, t)
})

Deno.test('humano forte: áudio e cartão de contato vencem mesmo que rápidos', () => {
  const audio = casaPadrao('[audio]', PADROES)
  assertEquals(classificar({ intervaloS: 3, repeticoes: 5, padrao: audio, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano')
  const card = casaPadrao('Fulano / Nome: Fulano / Sobrenome: Tal / Telefone (Celular): +55 11 99999-0000', PADROES)
  assertEquals(card?.tipo, 'humano')
})

Deno.test('R2 sozinha só espera (indeterminado); com 2ª mensagem vira humano; lenta vira humano', () => {
  assertEquals(classificar({ intervaloS: 8, repeticoes: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'indeterminado')
  assertEquals(classificar({ intervaloS: 8, repeticoes: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 1 }).classificacao, 'humano')
  assertEquals(classificar({ intervaloS: 900, repeticoes: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano')
  assertEquals(classificar({ intervaloS: null, repeticoes: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano')
})

Deno.test('R3: texto repetido em ≥3 leads é autoresposta mesmo sem padrão', () => {
  const r = classificar({ intervaloS: 400, repeticoes: 3, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 })
  assertEquals(r.classificacao, 'autoresposta')
  assertEquals(r.regras, ['R3:3'])
})

Deno.test('varredura: sem 2ª mensagem e sem R3 → humano (R2 nunca segura sozinha)', () => {
  assertEquals(resolverIndeterminado(0, 0, 3).final, 'humano')
  assertEquals(resolverIndeterminado(0, 3, 3).final, 'autoresposta')
  assertEquals(resolverIndeterminado(1, 3, 3).final, 'humano')
})
