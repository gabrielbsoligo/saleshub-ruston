// central-cases/motor.ts — lógica pura da Central de Cases (testável com fakes).
//
// Passada LEVE (automática ao agendar) e PROFUNDA (closer, na aba):
//   1) termos: nicho/segmento do lead + tokens do nome → cases_buscar() na base do BI (nome/razão social)
//   2) presença digital dos N melhores: 1 busca web por case ("nome cidade") → site + instagram
//   3) Biblioteca de Anúncios da Meta nos 3 melhores (pelo motor do Enriquecedor)
//   4) ordenação final e "por que é bom exemplo"
// Toda chamada externa vem por `deps` (base, buscaWeb, anuncios, repo) — nada de fetch aqui.

// Erro CRÍTICO (auth, banco, posse): nunca vira aviso — atravessa tenta() e aborta a rodada.
export class ErroCritico extends Error { constructor(msg: string) { super(msg); this.name = 'ErroCritico' } }
export type Candidato = {
  id_cliente: number; nome: string; razao_social?: string | null; cidade?: string | null; uf?: string | null
  status?: string | null; tier?: string | null; categoria?: string | null; produto_origem?: string | null
  lt_meses?: number | null; fee?: number | null; score: number; termos_casados: string[]
  site?: string | null; instagram?: string | null; instagram_nao_confirmado?: string | null
  anuncios?: { ativos: number | null; url: string; nota?: string | null; confirmado?: boolean } | null
  por_que?: string[]
  score_final?: number
}
export type ResultadoWeb = { url: string; title: string; desc: string }
export type Deps = {
  base: (termos: string[], uf: string | null, limite: number) => Promise<Candidato[]>
  buscaWeb: (consulta: string) => Promise<{ ok: boolean; results: ResultadoWeb[]; nota?: string }>
  // ativos = anúncios VALIDADOS como da empresa (página confirmada ou validação cruzada); confirmado=false = parcial
  anuncios: (c: { company: string; siteDomain: string | null; cidade: string | null; fbHandle: string | null }) => Promise<{ ok: boolean; ativos: number | null; confirmado?: boolean; nota?: string }>
  agora: () => number
}
export type Perfil = { leve: boolean }
export const LIMITES = { leve: { base: 12, web: 6, anuncios: 3, finais: 5 }, profunda: { base: 30, web: 12, anuncios: 3, finais: 8 } }

// ── 1) termos de busca ──────────────────────────────────────────────────────────
const SUFIXOS = new Set(['ltda', 'me', 'eireli', 'epp', 'sa', 's/a', 's.a', 'cia', 'limitada', 'empresa', 'grupo', 'holding', 'comercio', 'comercial', 'servicos', 'servico', 'industria', 'participacoes', 'brasil', 'brasileira', 'the', 'and', 'com', 'para', 'por', 'dos', 'das', 'de', 'do', 'da', 'em', 'e', 'o', 'a', 'os', 'as', 'um', 'uma'])
const SINONIMOS: Record<string, string[]> = {
  odonto: ['odonto', 'odontologia', 'odontologica', 'dental', 'dentista'], odontologia: ['odonto', 'odontologia', 'odontologica', 'dental'],
  clinica: ['clinica', 'clinic', 'saude', 'medic'], estetica: ['estetica', 'beleza', 'harmonizacao', 'dermato'],
  imobiliaria: ['imobiliaria', 'imoveis', 'imobiliario', 'construtora', 'incorporadora'], imoveis: ['imoveis', 'imobiliaria', 'construtora'],
  construtora: ['construtora', 'incorporadora', 'engenharia', 'empreendimentos'],
  advocacia: ['advocacia', 'advogados', 'juridico', 'sociedade de advogados'], contabilidade: ['contabilidade', 'contabil', 'contadores'],
  academia: ['academia', 'fitness', 'crossfit', 'studio'], escola: ['escola', 'colegio', 'educacao', 'ensino', 'curso'],
  restaurante: ['restaurante', 'gastronomia', 'bar', 'pizzaria', 'hamburgueria'], loja: ['loja', 'varejo', 'store', 'shop'],
  moveis: ['moveis', 'planejados', 'marcenaria'], veiculos: ['veiculos', 'automoveis', 'autos', 'motors', 'concessionaria'],
  agro: ['agro', 'agricola', 'agropecuaria', 'fazenda'], energia: ['energia', 'solar', 'fotovoltaica'],
  software: ['software', 'tecnologia', 'tech', 'sistemas', 'saas'], logistica: ['logistica', 'transportes', 'transportadora'],
  pet: ['pet', 'veterinaria', 'veterinario', 'petshop'], farmacia: ['farmacia', 'drogaria', 'farma'],
  hotel: ['hotel', 'pousada', 'hospedagem', 'resort'], turismo: ['turismo', 'viagens', 'agencia de viagens'],
  seguros: ['seguros', 'corretora', 'seguradora'], financeira: ['financeira', 'credito', 'consorcio', 'investimentos'],
  cosmeticos: ['cosmeticos', 'perfumaria', 'beleza'], roupas: ['roupas', 'moda', 'confeccoes', 'vestuario', 'boutique'],
  franquia: ['franquia', 'franchising', 'franqueadora'],
}
export function normalizar(t: string): string {
  return (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s/.-]/g, ' ').replace(/\s+/g, ' ').trim()
}
export function tokens(t: string): string[] {
  return normalizar(t).split(/[\s/.,-]+/).filter((x) => x.length >= 3 && !SUFIXOS.has(x) && !/^\d+$/.test(x))
}
/** termos para cases_buscar: nicho (com sinônimos) primeiro, depois tokens do nome do lead (sem sufixos) */
export function termosDe(empresa: string, nicho: string | null | undefined): string[] {
  const out: string[] = []
  const por = (x: string) => { const n = normalizar(x); if (n && !out.includes(n)) out.push(n) }
  for (const tk of tokens(nicho ?? '')) { por(tk); for (const s of SINONIMOS[tk] ?? []) por(s) }
  for (const tk of tokens(empresa)) { for (const s of SINONIMOS[tk] ?? []) por(s); por(tk) }
  return out.slice(0, 12)
}

// ── 2) presença digital a partir de uma busca web ───────────────────────────────
const SOCIAIS = /(^|\.)(instagram|facebook|linkedin|youtube|tiktok|twitter|x)\.com$/
const DIRETORIOS = /(^|\.)(google|bing|cnpj\.biz|cnpja|econodata|casadosdados|consultacnpj|cnpj\.info|solutudo|apontador|telelistas|guiamais|reclameaqui|jusbrasil|escavador|glassdoor|indeed|catho|infojobs|olx|mercadolivre|ifood|booking|tripadvisor|yelp|wikipedia|gov\.br|receita|empresascnpj|cadastroempresa|informecadastral|listamais|hotfrog|kekanto|cylex|encontra|foursquare|waze|maps)\./
export function hostDe(url: string): string | null { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return null } }
// Identidade: um handle/domínio "casa" com o nome quando contém um token (≥4 letras) do nome, ou
// quando o nome compactado (sem espaços) contém o handle/domínio compactado (ou vice-versa, ≥6 letras).
export function casaComNome(chave: string, nome: string): boolean {
  const k = normalizar(chave).replace(/[^a-z0-9]/g, '')
  if (k.length < 3) return false
  const toks = tokens(nome)
  if (toks.some((t) => t.length >= 4 && k.includes(t))) return true
  const nk = toks.join('')
  // comparação compactada só com ≥6 letras NOS DOIS lados ("cli" ou "sor" não confirmam "Clínica Sorriso")
  return nk.length >= 6 && k.length >= 6 && (nk.includes(k) || k.includes(nk))
}
export function extrairPresenca(results: ResultadoWeb[], nome: string): { site: string | null; instagram: string | null; instagram_nao_confirmado: string | null } {
  let site: string | null = null, instagram: string | null = null, instagram_nao_confirmado: string | null = null
  const toks = tokens(nome)
  for (const r of results) {
    const h = hostDe(r.url); if (!h) continue
    if (/(^|\.)instagram\.com$/.test(h)) {
      const m = r.url.match(/instagram\.com\/([A-Za-z0-9_.]{2,40})\/?(\?|$)/)
      if (m && !['p', 'reel', 'explore', 'accounts', 'stories'].includes(m[1])) {
        // só vira "Instagram da empresa" se o handle casa com o nome; senão fica como candidato sem bônus
        if (!instagram && casaComNome(m[1], nome)) instagram = m[1]
        else if (!instagram_nao_confirmado) instagram_nao_confirmado = m[1]
      }
      continue
    }
    if (site || SOCIAIS.test(h) || DIRETORIOS.test(h)) continue
    const hk = h.replace(/[^a-z0-9]/g, '')
    const casa = toks.some((t) => t.length >= 4 && hk.includes(t)) || toks.length === 0
    if (casa) site = `https://${h}`
  }
  return { site, instagram, instagram_nao_confirmado }
}

// ── 3/4) pipeline ───────────────────────────────────────────────────────────────
export type Progresso = (etapa: 'base' | 'web' | 'anuncios' | 'pronto', candidatos: Candidato[]) => Promise<void>
export async function gerarCases(deps: Deps, entrada: { empresa: string; nicho?: string | null; cidade?: string | null; uf?: string | null; profundidade: 'leve' | 'profunda' }, progresso?: Progresso): Promise<Candidato[]> {
  const L = LIMITES[entrada.profundidade]
  const termos = termosDe(entrada.empresa, entrada.nicho)
  if (!termos.length) return []
  let cands = (await deps.base(termos, entrada.uf ?? null, L.base)).map((c) => ({ ...c, por_que: [] as string[] }))
  await progresso?.('base', cands)
  // presença digital nos N melhores (1 busca por case; cache/ritmo ficam no deps.buscaWeb)
  // etapas OPCIONAIS (web/anúncios): falha de transporte de um candidato vira aviso nele, nunca aborta
  const tenta = async <T>(fn: () => Promise<T>, falha: (msg: string) => T): Promise<T> => { try { return await fn() } catch (e) { if (e instanceof ErroCritico) throw e; return falha(String((e as Error)?.message ?? e).slice(0, 120)) } }
  for (const c of cands.slice(0, L.web)) {
    const r = await tenta(() => deps.buscaWeb(`"${c.nome}" ${c.cidade ?? ''}`.trim()), (msg) => ({ ok: false, results: [], nota: msg }))
    if (!r.ok) { c.por_que!.push(`busca web indisponível${r.nota ? ` (${r.nota})` : ''}`); continue }
    const p = extrairPresenca(r.results, c.nome)
    c.site = p.site; c.instagram = p.instagram; c.instagram_nao_confirmado = p.instagram_nao_confirmado
  }
  await progresso?.('web', cands)
  // anúncios da Meta nos 3 melhores com alguma presença (site ou instagram) — senão nos 3 primeiros
  const alvo = [...cands.slice(0, L.web)].sort((a, b) => pontuar(b) - pontuar(a)).slice(0, L.anuncios)
  for (const c of alvo) {
    const r = await tenta(() => deps.anuncios({ company: c.nome, siteDomain: c.site ? hostDe(c.site) : null, cidade: c.cidade ?? null, fbHandle: c.instagram ?? null }), (msg) => ({ ok: false, ativos: null, nota: msg }))
    c.anuncios = { ativos: r.ok ? r.ativos : null, confirmado: r.ok ? r.confirmado !== false : false, url: urlAdLibrary(c.nome), nota: r.ok ? (r.nota ?? null) : (r.nota ?? 'indisponível') }
  }
  await progresso?.('anuncios', cands)
  for (const c of cands) { c.score_final = pontuar(c); c.por_que = [...porQue(c, entrada), ...(c.por_que ?? [])] }  // mantém avisos (ex.: busca indisponível)
  cands = cands.sort((a, b) => (b.score_final ?? 0) - (a.score_final ?? 0)).slice(0, L.finais)
  await progresso?.('pronto', cands)
  return cands
}
export const urlAdLibrary = (nome: string) => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(nome)}&search_type=keyword_unordered&media_type=all`
export function pontuar(c: Candidato): number {
  return Number(c.score ?? 0) + (c.site ? 20 : 0) + (c.instagram ? 15 : 0) + ((c.anuncios?.ativos ?? 0) > 0 && c.anuncios?.confirmado !== false ? 25 : 0)
}
export function porQue(c: Candidato, e: { nicho?: string | null; uf?: string | null }): string[] {
  const m: string[] = []
  if (c.termos_casados?.length) m.push(`nome casa com "${c.termos_casados.join('", "')}"`)
  if (c.status === 'Ativo') m.push('cliente ativo da rede')
  if (c.lt_meses && c.lt_meses >= 12) m.push(`${c.lt_meses} meses de casa`)
  if (c.tier && ['Medium', 'Large', 'Enterprise'].includes(c.tier)) m.push(`porte ${c.tier}`)
  if (e.uf && c.uf === e.uf) m.push(`mesma UF (${c.uf})`)
  if (c.site) m.push('tem site')
  if (c.instagram) m.push(`Instagram @${c.instagram}`)
  else if (c.instagram_nao_confirmado) m.push(`Instagram a confirmar: @${c.instagram_nao_confirmado}`)
  if ((c.anuncios?.ativos ?? 0) > 0 && c.anuncios?.confirmado !== false) m.push(`${c.anuncios!.ativos} anúncios ativos na Meta (confirmados)`)
  else if ((c.anuncios?.ativos ?? 0) > 0) m.push(`${c.anuncios!.ativos} anúncios na Meta a confirmar`)
  else if (c.anuncios && c.anuncios.ativos === 0 && c.anuncios.confirmado !== false) m.push('sem anúncios ativos na Meta')
  else if (c.anuncios && c.anuncios.ativos === 0) m.push(`nenhum anúncio confirmado nesta busca${c.anuncios.nota ? ` (${c.anuncios.nota})` : ''}`)
  else if (c.anuncios && c.anuncios.nota) m.push(`anúncios: ${c.anuncios.nota}`)
  if (c.produto_origem) m.push(`produto: ${c.produto_origem}`)
  return m
}
