// deno test --allow-read supabase/functions/kommo-autoresposta/triagem_test.ts
// Casos sintéticos no formato dos textos reais da amostra de 23/10 (sem dados pessoais).
// Os padrões vêm do PRÓPRIO SQL da migration_157 (paridade: o que está semeado é o que roda).
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { casaPadrao, classificar, compilar, extrairLeadId, normalizar, palavras, podeAplicar, resolverIndeterminado, type Cfg, type Padrao } from './triagem.ts'

// ── lê os seeds do SQL: linhas ('regex', 'descrição', 'tipo') dentro do INSERT de autoresposta_padroes
const sql = await Deno.readTextFile(new URL('../../migration_157_autoresposta_triagem.sql', import.meta.url))
const bloco = sql.slice(sql.indexOf('INSERT INTO public.autoresposta_padroes'), sql.indexOf('ON CONFLICT (padrao) DO NOTHING'))
const PADROES: Padrao[] = []
const re = /\(\s*'((?:[^']|'')*)'\s*,\s*'(?:[^']|'')*'\s*,\s*'(autoresposta|humano)'\s*\)/g
let m: RegExpExecArray | null, id = 0
while ((m = re.exec(bloco))) PADROES.push({ id: ++id, padrao: m[1].replace(/''/g, "'"), tipo: m[2] as Padrao['tipo'] })
const CFG: Pick<Cfg, 'janela_rapida_s' | 'repeticao_min' | 'r3_min_palavras'> = { janela_rapida_s: 60, repeticao_min: 3, r3_min_palavras: 6 }

Deno.test('seeds: 24 padrões lidos do SQL, todos compilam em JavaScript e nenhum usa \\y', () => {
  assertEquals(PADROES.length, 24)
  for (const p of PADROES) {
    assert(compilar(p) !== null, `regex inválida em JS: ${p.padrao}`)
    assert(!p.padrao.includes('\\y'), `\\y é do Postgres, não do JS: ${p.padrao}`)
  }
})

Deno.test('normalizar: minúsculas, sem acento, dígitos viram #, pontuação some', () => {
  assertEquals(normalizar('Olá! Atendemos de Segunda a Sexta, das 9 às 18h.'), 'ola atendemos de segunda a sexta das # as #h')
  assertEquals(palavras(normalizar('Oi, boa tarde!')), 3)
})

Deno.test('R1: saudação padrão do WhatsApp Business e demais templates reais', () => {
  for (const t of [
    '‎Empresa Tal agradece seu contato. Como podemos ajudar?',
    'Agradecemos sua mensagem. Não estamos disponíveis no momento, mas responderemos assim que possível.',
    'Olá! Nosso horário de atendimento é de segunda à sexta das 9h às 18h, vou te responder assim que possível.',
    'Seja bem vindo! Para agilizar seu atendimento, escolha uma das opções abaixo: 1 - Comercial 2 - Financeiro',
    'Olá! Sou a 🤖 *Mara*, assistente virtual de atendimento.',
    'Olá, esta é uma mensagem automática, pois estamos fora do horário de atendimento comercial.',
    'Você entrou em contato com a área de Vendas. Aguarde que em breve entraremos em contato.',
    'Olá eu sou a Jéssica da New Aquecedores, em que posso ajudar?',
    'Olá! 👋 Seja bem-vindo(a)! Em breve, iniciaremos seu atendimento. 📌 Este número não recebe ligações.',
    'Somos especialistas atuantes em projetos com atendimento personalizado e soluções completas.',
  ]) assertEquals(casaPadrao(t, PADROES)?.tipo, 'autoresposta', t)
})

Deno.test('humano: respostas curtas/reais NÃO casam padrão de autoresposta', () => {
  for (const t of ['Oi, boa tarde!', 'Quero entender', 'Okk', 'Boa tarde Laryssa !! Agora estou ocupado. Sobre o que seria ???', 'Olá, boa tarde. Aqui quem fala é a Giovanna do setor comercial', 'Olá! No momento estou em reunião, mas posso responder mensagens', 'Sim', '🫡🫡'])
    assertEquals(casaPadrao(t, PADROES)?.tipo ?? null, null, t)
})

Deno.test('humano forte vence R1: pedido de proposta/valor, aceite/recusa, "pode me ligar", novo número, áudio, cartão', () => {
  for (const t of [
    'Como posso te ajudar? Sou o João, pode me explicar o serviço?',
    'Meu novo número é esse, pode enviar a proposta aqui.',
    'Olá! Seja bem-vindo. Qual o valor do serviço?',
    'não tenho interesse',
    'Pode ser amanhã às 10? Me manda a proposta antes.',
    '[audio]', '[midia]',
    'Fulano / Nome: Fulano / Sobrenome: Tal / Telefone (Celular): +55 11 99999-0000',
  ]) {
    const p = casaPadrao(t, PADROES)
    assertEquals(p?.tipo, 'humano', t)
    assertEquals(classificar({ texto: t, intervaloS: 3, outrosLeadsMesmoTexto: 9, padrao: p, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano', t)
  }
})

Deno.test('R2 sozinha só espera (indeterminado); com 2ª mensagem vira humano; lenta vira humano; sem disparo conhecido vira humano', () => {
  const t = 'Boa tarde'
  assertEquals(classificar({ texto: t, intervaloS: 8, outrosLeadsMesmoTexto: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'indeterminado')
  assertEquals(classificar({ texto: t, intervaloS: 8, outrosLeadsMesmoTexto: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 1 }).classificacao, 'humano')
  assertEquals(classificar({ texto: t, intervaloS: 900, outrosLeadsMesmoTexto: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano')
  assertEquals(classificar({ texto: t, intervaloS: null, outrosLeadsMesmoTexto: 0, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano')
})

Deno.test('R3: conta o lead atual (2 outros + este = 3), só texto longo e só sem 2ª mensagem', () => {
  const longo = 'Nossa equipe recebeu a sua solicitação e vai analisar o pedido com carinho hoje'
  assertEquals(classificar({ texto: longo, intervaloS: 400, outrosLeadsMesmoTexto: 2, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).regras, ['R3:3'])
  assertEquals(classificar({ texto: longo, intervaloS: 400, outrosLeadsMesmoTexto: 1, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano') // só 2 leads
  assertEquals(classificar({ texto: 'ok', intervaloS: 400, outrosLeadsMesmoTexto: 20, padrao: null, cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano') // curto: nunca R3
  assertEquals(classificar({ texto: 'não tenho interesse por enquanto obrigado', intervaloS: 400, outrosLeadsMesmoTexto: 20, padrao: casaPadrao('não tenho interesse por enquanto obrigado', PADROES), cfg: CFG, msgsRecebidasDepois: 0 }).classificacao, 'humano')
  assertEquals(classificar({ texto: longo, intervaloS: 400, outrosLeadsMesmoTexto: 5, padrao: null, cfg: CFG, msgsRecebidasDepois: 1 }).classificacao, 'humano') // conversou: humano
})

Deno.test('varredura: sem 2ª mensagem e sem R3 → humano; R3 só com texto longo', () => {
  assertEquals(resolverIndeterminado(0, 0, 10, CFG).final, 'humano')
  assertEquals(resolverIndeterminado(0, 2, 10, CFG).final, 'autoresposta')
  assertEquals(resolverIndeterminado(0, 2, 2, CFG).final, 'humano')
  assertEquals(resolverIndeterminado(1, 5, 10, CFG).final, 'humano')
})

Deno.test('podeAplicar: desligado, outro funil, saiu da etapa, etapa não elegível', () => {
  const cfg: Cfg = { pipeline_id: 14062116, status_respondeu: 108545256, ativo: true, modo: 'aplicar', janela_rapida_s: 60, repeticao_min: 3, espera_s: 180, r3_min_palavras: 6, etapas_origem: [108545280, 108545284] }
  assertEquals(podeAplicar(cfg, { pipeline_id: 14062116, status_id: 108545280 }, 108545280).ok, true)
  assertEquals(podeAplicar({ ...cfg, ativo: false }, { pipeline_id: 14062116, status_id: 108545280 }, 108545280).ok, false)
  assertEquals(podeAplicar(cfg, { pipeline_id: 14062096, status_id: 108545092 }, 108545280).motivo, 'lead mudou de funil')
  assertEquals(podeAplicar(cfg, { pipeline_id: 14062116, status_id: 108545256 }, 108545280).motivo, 'lead já saiu da etapa de origem')
  assertEquals(podeAplicar(cfg, { pipeline_id: 14062116, status_id: 108545252 }, 108545252).motivo, 'etapa fora das elegíveis')
})

Deno.test('extrairLeadId: form do Kommo, JSON aninhado (add/status/update) e query', () => {
  const q = new URLSearchParams('')
  assertEquals(extrairLeadId({ 'leads[add][0][id]': '123' }, q), 123)
  assertEquals(extrairLeadId({ leads: { update: [{ id: 456 }] } }, q), 456)
  assertEquals(extrairLeadId({ leads: { status: [{ id: '789' }] } }, q), 789)
  assertEquals(extrairLeadId({}, new URLSearchParams('lead_id=42')), 42)
  assertEquals(extrairLeadId({ foo: 1 }, q), 0)
})
