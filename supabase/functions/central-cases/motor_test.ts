// deno test --allow-read supabase/functions/central-cases/motor_test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { ErroCritico, casaComNome, extrairPresenca, gerarCases, hostPublico, ipPrivado, nomeDeBusca, pontuar, qualidadeDe, termosDe, tokens, type Candidato, type Deps } from './motor.ts'
// sinais de presença neutros (não medidos) para os fakes inline
const sinais = { siteNoAr: async () => null, instagramExiste: async () => null, googleNegocio: async () => ({ ok: false, encontrado: false, rating: null, avaliacoes: null }) }
import { depsReais } from './cliente.ts'
import { assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

Deno.test('termosDe: nicho com sinônimos primeiro, depois tokens do nome sem sufixos jurídicos/stopwords', () => {
  const t = termosDe('Clínica Sorriso Odontologia LTDA - ME', 'odonto')
  assertEquals(t.nicho.slice(0, 5), ['odonto', 'odontologia', 'odontologica', 'dental', 'dentista'])
  assert(!t.nicho.includes('clinica') && t.nome.includes('clinica') && t.nome.includes('sorriso') && !t.nome.includes('ltda') && !t.nome.includes('me'))   // nicho explícito: 'clinica' do nome fica como NOME
  assertEquals(termosDe('A B LTDA', null), { nicho: [], nome: [] })   // nada com 3+ letras
  // Gabriel (26/10): genéricos e nomes de pessoa NÃO viram termo; nicho pesa, nome só desempata
  assertEquals(termosDe('Fraternidade Alex Salomão', null, ['Alex Salomão']), { nicho: [], nome: [] })
  assertEquals(termosDe('Consultoria Gestão XYZ Serviços Ltda', null), { nicho: [], nome: ['xyz'] })
  assertEquals(termosDe('Quality remodeling by alex', 'Imobiliária'), { nicho: ['imobiliaria', 'imoveis', 'imobiliario', 'construtora', 'incorporadora'], nome: ['quality', 'remodeling'] })
  // R2#3 nicho EXPLÍCITO é o filtro: "clinica" do nome NÃO entra no nicho (uma Clínica Veterinária não passaria);
  // sem nicho explícito, o nome infere o nicho
  const comNicho = termosDe('Clinica Sorriso', 'odontologia')
  assertEquals(comNicho.nicho, ['odontologia', 'odonto', 'odontologica', 'dental']); assert(!comNicho.nicho.includes('clinica') && comNicho.nome.includes('clinica') && comNicho.nome.includes('sorriso'))
  const semNicho = termosDe('Clinica Sorriso', null)
  assert(semNicho.nicho.includes('clinica') && semNicho.nicho.includes('saude') && semNicho.nome.includes('sorriso'))
  assertEquals(termosDe('XYZ Ltda', null).nome, ['xyz'])   // 3 letras passam (mesmo mínimo da RPC)
  assertEquals(termosDe('ALEX GENOVESE', null, ['Alex']).nome, [])
  assertEquals(tokens('Grupo Imóveis & Cia S/A'), ['imoveis'])        // grupo/cia/sa são sufixos; "imóveis" normalizado
})

Deno.test('extrairPresenca: site = 1º domínio não-social/não-diretório que casa com o nome; instagram = handle de perfil', () => {
  const r = [
    { url: 'https://www.google.com/maps/place/x', title: '', desc: '' },
    { url: 'https://cnpj.biz/12345', title: '', desc: '' },
    { url: 'https://www.instagram.com/p/abc123/', title: '', desc: '' },          // post, não perfil
    { url: 'https://www.instagram.com/clinicasorriso/', title: '', desc: '' },
    { url: 'https://outraempresa.com.br/', title: '', desc: '' },                 // não casa com o nome
    { url: 'https://www.clinicasorriso.com.br/sobre', title: '', desc: '' },
  ]
  assertEquals(extrairPresenca(r, 'Clínica Sorriso'), { site: 'https://clinicasorriso.com.br', instagram: 'clinicasorriso', instagram_nao_confirmado: null })
  assertEquals(extrairPresenca([], 'X'), { site: null, instagram: null, instagram_nao_confirmado: null })
})

Deno.test('R1#10 Instagram sem identidade confirmada NÃO vira o Instagram da empresa: fica como candidato, sem bônus e sem ir como fbHandle', async () => {
  assert(casaComNome('clinicasorriso', 'Clínica Sorriso') && casaComNome('sorriso.odonto', 'Clínica Sorriso') && !casaComNome('outra_empresa', 'Clínica Sorriso'))
  assert(!casaComNome('cli', 'Clínica Sorriso') && !casaComNome('sor', 'Clínica Sorriso') && !casaComNome('clinic', 'Clínica Sorriso') === false) // 'clinic' casa por token ≥4 ('clinica' contém? não: handle 'clinic' ⊂ token 'clinica' → não; compactado 'clinic' ≥6 ⊂ 'clinicasorriso' → sim)
  const curtos = [{ url: 'https://www.instagram.com/cli/', title: '', desc: '' }, { url: 'https://www.instagram.com/sor/', title: '', desc: '' }]
  assertEquals(extrairPresenca(curtos, 'Clínica Sorriso').instagram, null)
  const r = [{ url: 'https://www.instagram.com/outra_empresa/', title: '', desc: '' }]
  assertEquals(extrairPresenca(r, 'Clínica Sorriso'), { site: null, instagram: null, instagram_nao_confirmado: 'outra_empresa' })
  const handles: (string | null)[] = []
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [cand(1, 'Clinica Sorriso', 90)], buscaWeb: async () => ({ ok: true, results: r }), anuncios: async (c) => { handles.push(c.fbHandle); return { ok: true, ativos: 0 } } }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'leve' })
  assertEquals(handles, [null]); assertEquals(out[0].instagram ?? null, null)
  assertEquals(pontuar(out[0]), 90); assert(out[0].por_que!.some((m) => m.includes('a confirmar: @outra_empresa')))
})

Deno.test('R3#1 falha de transporte na busca web/anúncios de um candidato não aborta a rodada: aviso no candidato, demais concluídos', async () => {
  let n = 0
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [cand(1, 'A', 60), cand(2, 'B', 50)], buscaWeb: async (q) => { if (++n === 1) throw new Error('network unavailable'); return { ok: true, results: [] } }, anuncios: async () => { throw new DOMException('timeout', 'TimeoutError') } }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'leve' })
  assertEquals(out.length, 2)
  assert(out.find((c) => c.nome === 'A')!.por_que!.some((m) => m.includes('busca web indisponível (network unavailable)')))
  assert(out.every((c) => c.anuncios?.ativos === null && (c.anuncios?.nota ?? '').includes('timeout')))
})

Deno.test('R4#1 fluxo completo: login do motor inválido = ErroCritico (rodada rejeita, vai para retomada); timeout de fetch = conclui com aviso', async () => {
  const sbFake = { rpc: async () => ({ data: [{ id_cliente: 1, nome: 'Odonto A', score: 50, termos_casados: ['odonto'] }], error: null }), from: () => ({ select: () => ({ eq: () => ({ gt: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), upsert: async () => ({ error: null }) }) }
  // login falha → crítico mesmo dentro de gerarCases
  const semLogin = depsReais(sbFake, 'https://motor.x', async () => { throw new Error('auth integração falhou: Invalid login credentials') }, (async () => new Response('{}')) as any)
  await assertRejects(() => gerarCases(semLogin, { empresa: 'Clinica X', nicho: 'odonto', profundidade: 'leve' }), ErroCritico, 'auth do motor')
  // login ok, fetch estoura timeout → aviso no candidato, rodada conclui
  const timeout = depsReais(sbFake, 'https://motor.x', async () => 'jwt', (async () => { throw new DOMException('aborted', 'TimeoutError') }) as any)
  const out = await gerarCases(timeout, { empresa: 'Clinica X', nicho: 'odonto', profundidade: 'leve' })
  assertEquals(out.length, 1); assert(out[0].por_que!.some((m) => m.includes('busca web indisponível (motor indisponível: timeout)')))
})

Deno.test('R3#3 zero anúncios sem confirmação (10 terceiros descartados) diz "nenhum anúncio confirmado", não "sem anúncios ativos"', async () => {
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [cand(1, 'A', 50)], buscaWeb: async () => ({ ok: true, results: [] }), anuncios: async () => ({ ok: true, ativos: 0, confirmado: false, nota: '10 anúncios de terceiros descartados' }) }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'leve' })
  assert(out[0].por_que!.some((m) => m.includes('nenhum anúncio confirmado nesta busca (10 anúncios de terceiros descartados)')))
  assert(!out[0].por_que!.some((m) => m.includes('sem anúncios ativos')))
})

Deno.test('R1#8 anúncios só pontuam quando CONFIRMADOS; parcial (a validar) vira "a confirmar", sem bônus', async () => {
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [cand(1, 'A', 50), cand(2, 'B', 50)], buscaWeb: async () => ({ ok: true, results: [] }),
    anuncios: async (c) => c.company === 'A' ? { ok: true, ativos: 10, confirmado: false, nota: 'identidade não confirmada' } : { ok: true, ativos: 2, confirmado: true } }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'leve' })
  assertEquals(out[0].nome, 'B'); assertEquals(pontuar(out[0]), 75); assertEquals(pontuar(out[1]), 50)
  assert(out[1].por_que!.some((m) => m.includes('10 anúncios na Meta a confirmar')))
})

function depsFake(opts: { base?: Candidato[]; webOk?: boolean; adsAtivos?: Record<string, number | null>; adsFalha?: boolean }) {
  const chamadas = { web: [] as string[], ads: [] as string[] }
  const deps: Deps = {
    ...sinais,
    agora: () => 1,
    base: async (nicho, nome, uf, limite) => (opts.base ?? []).slice(0, limite),
    buscaWeb: async (q) => { chamadas.web.push(q); if (opts.webOk === false) return { ok: false, results: [], nota: 'quota' }; const nome = q.replace(/"/g, '').split(' ')[0].toLowerCase(); return { ok: true, results: [{ url: `https://www.${nome}.com.br/`, title: '', desc: '' }, { url: `https://www.instagram.com/${nome}/`, title: '', desc: '' }] } },
    anuncios: async (c) => { chamadas.ads.push(c.company); if (opts.adsFalha) return { ok: false, ativos: null, nota: 'headless_indisponivel' }; return { ok: true, ativos: opts.adsAtivos?.[c.company] ?? 0 } },
  }
  return { deps, chamadas }
}
const cand = (id: number, nome: string, score: number, extra: Partial<Candidato> = {}): Candidato => ({ id_cliente: id, nome, score, termos_casados: ['odonto'], status: 'Ativo', uf: 'SP', cidade: 'Campinas', lt_meses: 14, ...extra })

Deno.test('gerarCases (expandida por padrão): até 40 da base → web nos 15 melhores → anúncios nos 5 com mais presença → 10 finais ordenados por QUALIDADE; por_que explica', async () => {
  const base = Array.from({ length: 12 }, (_, i) => cand(i + 1, `Odonto${i + 1}`, 100 - i))
  const { deps, chamadas } = depsFake({ base, adsAtivos: { Odonto3: 7, Odonto1: 0 } })
  const etapas: string[] = []
  const r = await gerarCases(deps, { empresa: 'Clínica Sorriso Odontologia', nicho: 'odonto', uf: 'SP', profundidade: 'leve' }, async (e) => { etapas.push(e) })
  assertEquals(etapas, ['base', 'web', 'anuncios', 'pronto'])
  assertEquals(chamadas.web.length, 12); assertEquals(chamadas.ads.length, 5)
  assertEquals(r.length, 10)
  assertEquals(r[0].nome, 'Odonto3')                                   // 7 anúncios ativos confirmados: qualidade 30+10+15 = 55 > demais
  assertEquals(r[0].qualidade, 55); assert(r[0].por_que![0].startsWith('qualidade 55/100'))
  assert(r[0].por_que!.some((m) => m.includes('7 anúncios ativos')))
  assert(r[0].por_que!.some((m) => m.includes('Instagram @odonto3')) && r[0].site === 'https://odonto3.com.br')
  assert(r.find((c) => c.nome === 'Odonto1')!.por_que!.some((m) => m.includes('sem anúncios ativos')))
  assertEquals(pontuar(r[0]) >= pontuar(r[1]), true)
})

Deno.test('gerarCases: busca web indisponível não derruba a rodada (candidatos sem site, motivo anotado); anúncios indisponíveis = nota, ativos null', async () => {
  const { deps } = depsFake({ base: [cand(1, 'Odonto A', 90), cand(2, 'Odonto B', 80)], webOk: false, adsFalha: true })
  const r = await gerarCases(deps, { empresa: 'Odonto X', nicho: 'odonto', profundidade: 'leve' })
  assertEquals(r.length, 2); assertEquals(r[0].site ?? null, null)
  assert(r[0].por_que!.some((m) => m.startsWith('busca web indisponível')))
  assertEquals(r[0].anuncios?.ativos, null); assertEquals(r[0].anuncios?.nota, 'headless_indisponivel')
})

Deno.test('gerarCases: sem termos (nome só com sufixos e sem nicho) → vazio sem chamar nada', async () => {
  const { deps, chamadas } = depsFake({ base: [cand(1, 'X', 1)] })
  assertEquals(await gerarCases(deps, { empresa: 'LTDA ME', nicho: null, profundidade: 'leve' }), [])
  assertEquals(chamadas.web.length, 0)
})

Deno.test('gerarCases profunda: 40 da base, 15 na web, 5 de anúncios e 10 finais', async () => {
  const base = Array.from({ length: 40 }, (_, i) => cand(i + 1, `Imob${i + 1}`, 100 - i))
  const { deps, chamadas } = depsFake({ base })
  const r = await gerarCases(deps, { empresa: 'Imobiliária Z', nicho: 'imoveis', profundidade: 'profunda' })
  assertEquals(chamadas.web.length, 15); assertEquals(chamadas.ads.length, 5); assertEquals(r.length, 10)
})


Deno.test('busca web pelo NOME LIMPO (sem LTDA/genéricos) + cidade, sem aspas; 2ª tentativa "site oficial" só se não achou site; termos_casados sem duplicatas', async () => {
  assertEquals(nomeDeBusca({ nome: 'VERSATI INCORPORADORA E CONSTRUTORA LTDA' }), 'versati incorporadora construtora')
  assertEquals(nomeDeBusca({ nome: 'LTDA ME' }), 'ltda me')
  const consultas: string[] = []
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [{ ...cand(1, 'VERSATI INCORPORADORA E CONSTRUTORA LTDA', 90, { cidade: 'Campinas' }), termos_casados: ['construtora', 'incorporadora', 'construtora'] }],
    buscaWeb: async (q) => { consultas.push(q); return q.includes('site oficial') ? { ok: true, results: [{ url: 'https://versati.com.br/', title: '', desc: '' }] } : { ok: true, results: [{ url: 'https://cnpj.biz/x', title: '', desc: '' }] } },
    anuncios: async () => ({ ok: true, ativos: 0 }) }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'construtora', profundidade: 'profunda' })
  assertEquals(consultas, ['versati incorporadora construtora Campinas', 'versati incorporadora construtora site oficial'])
  assertEquals(out[0].site, 'https://versati.com.br'); assertEquals(out[0].termos_casados, ['construtora', 'incorporadora'])
})

Deno.test('qualidadeDe: 0–100 por presença digital (site no ar, Instagram ativo, anúncios confirmados, Google Business); não medido conta parcial', () => {
  const c = (x: Partial<Candidato>): Candidato => ({ id_cliente: 1, nome: 'A', score: 0, termos_casados: [], ...x })
  assertEquals(qualidadeDe(c({})), 0)
  assertEquals(qualidadeDe(c({ site: 'https://a.com' })), 10)                                   // site achado, não medido
  assertEquals(qualidadeDe(c({ site: 'https://a.com', site_no_ar: true })), 25)
  assertEquals(qualidadeDe(c({ site: 'https://a.com', site_no_ar: false })), 0)
  assertEquals(qualidadeDe(c({ instagram: 'a', instagram_existe: true })), 20)
  assertEquals(qualidadeDe(c({ instagram: 'a', instagram_existe: false })), 0)
  assertEquals(qualidadeDe(c({ anuncios: { ativos: 2, url: '', confirmado: true } })), 15)
  assertEquals(qualidadeDe(c({ anuncios: { ativos: 5, url: '', confirmado: true } })), 30)
  assertEquals(qualidadeDe(c({ anuncios: { ativos: 9, url: '', confirmado: false } })), 0)      // não confirmado não pontua
  assertEquals(qualidadeDe(c({ google: { encontrado: true, rating: 4.8, avaliacoes: 120 } })), 25)
  assertEquals(qualidadeDe(c({ site: 'https://a.com', site_no_ar: true, instagram: 'a', instagram_existe: true, anuncios: { ativos: 5, url: '', confirmado: true }, google: { encontrado: true, rating: 4.8, avaliacoes: 120 } })), 100)
})

Deno.test('ordem final = qualidade primeiro: case menos relevante mas com presença forte vem antes do mais relevante sem presença', async () => {
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [cand(1, 'Odonto Fraca', 120), cand(2, 'Odonto Forte', 80)],
    buscaWeb: async (q) => /forte/i.test(q) ? { ok: true, results: [{ url: 'https://odontoforte.com.br/', title: '', desc: '' }, { url: 'https://www.instagram.com/odontoforte/', title: '', desc: '' }] } : { ok: true, results: [] },
    siteNoAr: async () => true, instagramExiste: async () => true,
    googleNegocio: async (nome) => nome.includes('Forte') ? { ok: true, encontrado: true, rating: 4.7, avaliacoes: 80 } : { ok: true, encontrado: false, rating: null, avaliacoes: null },
    anuncios: async (c) => ({ ok: true, ativos: c.company.includes('Forte') ? 4 : 0, confirmado: true }) }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'profunda' })
  assertEquals(out.map((c) => c.nome), ['Odonto Forte', 'Odonto Fraca'])
  assertEquals(out[0].qualidade, 100); assertEquals(out[1].qualidade, 0)
  assert(out[0].por_que!.some((m) => m.includes('Google Business 4.7★ (80 avaliações)')) && out[0].por_que!.some((m) => m === 'site no ar'))
})


Deno.test('R2#1 SSRF: a edge NUNCA faz GET direto no site — pré-checa o host e delega ao motor (sonda.mjs, IP fixado); host não público nem chega ao motor', async () => {
  assert(ipPrivado('127.0.0.1') && ipPrivado('10.1.2.3') && ipPrivado('172.16.0.9') && ipPrivado('192.168.0.1') && ipPrivado('169.254.169.254') && ipPrivado('::1') && ipPrivado('fd00::1') && ipPrivado('0.0.0.0'))
  assert(!ipPrivado('8.8.8.8') && !ipPrivado('200.1.2.3') && !ipPrivado('2800:3f0::1'))
  assert(!hostPublico('localhost') && !hostPublico('app.internal') && !hostPublico('127.0.0.1') && !hostPublico('[::1]') && !hostPublico('semponto') && hostPublico('clinicasorriso.com.br'))
  const chamadas: string[] = []
  const sbFake = { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: () => ({ gt: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), upsert: async () => ({ error: null }) }) }
  const fetchFake = (async (u: string | URL | Request, init?: RequestInit) => { chamadas.push(String(u)); const body = JSON.parse(String(init?.body ?? '{}')); return new Response(JSON.stringify(body.url === 'https://fora.com/' ? { ok: true, noAr: false, status: 503 } : body.url === 'https://indisponivel.com/' ? { ok: false, motivo: 'timeout' } : { ok: true, noAr: true, status: 200 }), { status: 200 }) }) as unknown as typeof fetch
  const d = depsReais(sbFake, 'https://motor.x', async () => 'jwt', fetchFake)
  assertEquals(await d.siteNoAr('https://clinicasorriso.com.br/'), true)
  assertEquals(await d.siteNoAr('https://fora.com/'), false)
  assertEquals(await d.siteNoAr('https://indisponivel.com/'), null)
  assertEquals(await d.siteNoAr('http://127.0.0.1/'), null); assertEquals(await d.siteNoAr('https://app.internal/'), null); assertEquals(await d.siteNoAr('ftp://x.com/'), null)
  assert(chamadas.every((u) => u.startsWith('https://motor.x/api/cases/site-no-ar')))   // só a rota do motor; nunca o site
  assertEquals(chamadas.length, 3)                                                       // os 3 recusados não chegaram ao motor
})

Deno.test('R2#2 pulso de posse é chamado entre candidatos e chamadas lentas (web ×4 por candidato + anúncios); se lançar, a rodada aborta', async () => {
  let pulsos = 0
  const base = Array.from({ length: 4 }, (_, i) => cand(i + 1, `Odonto${i + 1}`, 90 - i))
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => base, buscaWeb: async () => ({ ok: true, results: [] }), anuncios: async () => ({ ok: true, ativos: 0 }), pulso: async () => { pulsos++ } }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'profunda' })
  assertEquals(out.length, 4); assertEquals(pulsos, 4 * 4 + 4)   // por candidato: busca, 2ª busca (sem site), Instagram, Google; + anúncios
  const perde: Deps = { ...deps, pulso: async () => { throw new ErroCritico('posse perdida') } }
  await assertRejects(() => gerarCases(perde, { empresa: 'X', nicho: 'odonto', profundidade: 'profunda' }), ErroCritico)
})

Deno.test('R2#4 Google Business: resposta do motor com ok:false = indisponível (ok:false, google=null) e NÃO cacheia; found:false cacheia como não encontrado', async () => {
  const escritas: any[] = []
  const sbFake = { rpc: async () => ({ data: [], error: null }), from: () => ({ select: () => ({ eq: () => ({ gt: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), upsert: async (row: any) => { escritas.push(row); return { error: null } } }) }
  const fetchFake = (resp: unknown) => (async () => new Response(JSON.stringify(resp), { status: 200 })) as unknown as typeof fetch
  const d1 = depsReais(sbFake, 'https://motor.x', async () => 'jwt', fetchFake({ ok: false, found: false, note: 'serper_indisponivel' }))
  assertEquals(await d1.googleNegocio('A', null), { ok: false, encontrado: false, rating: null, avaliacoes: null }); assertEquals(escritas.length, 0)
  const d2 = depsReais(sbFake, 'https://motor.x', async () => 'jwt', fetchFake({ ok: true, found: false }))
  assertEquals((await d2.googleNegocio('A', null)).encontrado, false); assertEquals(escritas.length, 1)
  // no motor.ts, ok:false vira google=null (não "não encontrado")
  const deps: Deps = { ...sinais, agora: () => 1, base: async () => [cand(1, 'A', 50)], buscaWeb: async () => ({ ok: true, results: [] }), anuncios: async () => ({ ok: true, ativos: 0 }), googleNegocio: async () => ({ ok: false, encontrado: false, rating: null, avaliacoes: null }) }
  const out = await gerarCases(deps, { empresa: 'X', nicho: 'odonto', profundidade: 'profunda' })
  assertEquals(out[0].google ?? null, null)
})
