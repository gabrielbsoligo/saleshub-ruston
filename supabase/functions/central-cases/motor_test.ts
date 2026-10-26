// deno test --allow-read supabase/functions/central-cases/motor_test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { extrairPresenca, gerarCases, pontuar, termosDe, tokens, type Candidato, type Deps } from './motor.ts'

Deno.test('termosDe: nicho com sinônimos primeiro, depois tokens do nome sem sufixos jurídicos/stopwords', () => {
  const t = termosDe('Clínica Sorriso Odontologia LTDA - ME', 'odonto')
  assertEquals(t.slice(0, 5), ['odonto', 'odontologia', 'odontologica', 'dental', 'dentista'])
  assert(t.includes('clinica') && t.includes('sorriso') && !t.includes('ltda') && !t.includes('me'))
  assertEquals(termosDe('A B LTDA', null), [])                        // nada com 3+ letras
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
  assertEquals(extrairPresenca(r, 'Clínica Sorriso'), { site: 'https://clinicasorriso.com.br', instagram: 'clinicasorriso' })
  assertEquals(extrairPresenca([], 'X'), { site: null, instagram: null })
})

function depsFake(opts: { base?: Candidato[]; webOk?: boolean; adsAtivos?: Record<string, number | null>; adsFalha?: boolean }) {
  const chamadas = { web: [] as string[], ads: [] as string[] }
  const deps: Deps = {
    agora: () => 1,
    base: async (termos, uf, limite) => (opts.base ?? []).slice(0, limite),
    buscaWeb: async (q) => { chamadas.web.push(q); if (opts.webOk === false) return { ok: false, results: [], nota: 'quota' }; const nome = q.replace(/"/g, '').split(' ')[0].toLowerCase(); return { ok: true, results: [{ url: `https://www.${nome}.com.br/`, title: '', desc: '' }, { url: `https://www.instagram.com/${nome}/`, title: '', desc: '' }] } },
    anuncios: async (c) => { chamadas.ads.push(c.company); if (opts.adsFalha) return { ok: false, ativos: null, nota: 'headless_indisponivel' }; return { ok: true, ativos: opts.adsAtivos?.[c.company] ?? 0 } },
  }
  return { deps, chamadas }
}
const cand = (id: number, nome: string, score: number, extra: Partial<Candidato> = {}): Candidato => ({ id_cliente: id, nome, score, termos_casados: ['odonto'], status: 'Ativo', uf: 'SP', cidade: 'Campinas', lt_meses: 14, ...extra })

Deno.test('gerarCases leve: 12 da base → web nos 6 melhores → anúncios nos 3 com mais presença → 5 finais ordenados; por_que explica', async () => {
  const base = Array.from({ length: 12 }, (_, i) => cand(i + 1, `Odonto${i + 1}`, 100 - i))
  const { deps, chamadas } = depsFake({ base, adsAtivos: { Odonto3: 7, Odonto1: 0 } })
  const etapas: string[] = []
  const r = await gerarCases(deps, { empresa: 'Clínica Sorriso Odontologia', nicho: 'odonto', uf: 'SP', profundidade: 'leve' }, async (e) => { etapas.push(e) })
  assertEquals(etapas, ['base', 'web', 'anuncios', 'pronto'])
  assertEquals(chamadas.web.length, 6); assertEquals(chamadas.ads.length, 3)
  assertEquals(r.length, 5)
  assertEquals(r[0].nome, 'Odonto3')                                   // 7 anúncios ativos (+25) vence o score base
  assert(r[0].por_que!.some((m) => m.includes('7 anúncios ativos')))
  assert(r[0].por_que!.some((m) => m.includes('Instagram @odonto3')) && r[0].site === 'https://odonto3.com.br')
  assert(r.find((c) => c.nome === 'Odonto1')!.por_que!.some((m) => m.includes('sem anúncios ativos')))
  assertEquals(pontuar(r[0]) >= pontuar(r[1]), true)
})

Deno.test('gerarCases: busca web indisponível não derruba a rodada (candidatos sem site, motivo anotado); anúncios indisponíveis = nota, ativos null', async () => {
  const { deps } = depsFake({ base: [cand(1, 'Odonto A', 90), cand(2, 'Odonto B', 80)], webOk: false, adsFalha: true })
  const r = await gerarCases(deps, { empresa: 'Odonto X', nicho: 'odonto', profundidade: 'leve' })
  assertEquals(r.length, 2); assertEquals(r[0].site ?? null, null)
  assert(r[0].por_que!.includes('busca web indisponível'))
  assertEquals(r[0].anuncios?.ativos, null); assertEquals(r[0].anuncios?.nota, 'headless_indisponivel')
})

Deno.test('gerarCases: sem termos (nome só com sufixos e sem nicho) → vazio sem chamar nada', async () => {
  const { deps, chamadas } = depsFake({ base: [cand(1, 'X', 1)] })
  assertEquals(await gerarCases(deps, { empresa: 'LTDA ME', nicho: null, profundidade: 'leve' }), [])
  assertEquals(chamadas.web.length, 0)
})

Deno.test('gerarCases profunda: mais candidatos da base e da web (30/12), ainda 3 de anúncios e 8 finais', async () => {
  const base = Array.from({ length: 40 }, (_, i) => cand(i + 1, `Imob${i + 1}`, 100 - i))
  const { deps, chamadas } = depsFake({ base })
  const r = await gerarCases(deps, { empresa: 'Imobiliária Z', nicho: 'imoveis', profundidade: 'profunda' })
  assertEquals(chamadas.web.length, 12); assertEquals(chamadas.ads.length, 3); assertEquals(r.length, 8)
})
