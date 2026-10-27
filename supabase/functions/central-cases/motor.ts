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
  site_no_ar?: boolean | null
  instagram_existe?: boolean | null
  google?: { encontrado: boolean; rating: number | null; avaliacoes: number | null } | null
  qualidade?: number            // 0–100: presença digital (site no ar, Instagram, anúncios confirmados, Google Business)
  por_que?: string[]
  score_final?: number
}
export type ResultadoWeb = { url: string; title: string; desc: string }
export type Deps = {
  /** relevância na base do BI: termos de NICHO (pesam) e de NOME (desempatam) */
  base: (nicho: string[], nome: string[], uf: string | null, limite: number) => Promise<Candidato[]>
  siteNoAr: (url: string) => Promise<boolean | null>                                   // null = não deu para medir
  instagramExiste: (handle: string) => Promise<boolean | null>
  googleNegocio: (nome: string, cidade: string | null) => Promise<{ ok: boolean; encontrado: boolean; rating: number | null; avaliacoes: number | null }>
  /** batimento de posse: chamado entre candidatos/chamadas lentas (renova o lease); opcional */
  pulso?: () => Promise<void>
  buscaWeb: (consulta: string) => Promise<{ ok: boolean; results: ResultadoWeb[]; nota?: string }>
  // ativos = anúncios VALIDADOS como da empresa (página confirmada ou validação cruzada); confirmado=false = parcial
  anuncios: (c: { company: string; siteDomain: string | null; cidade: string | null; fbHandle: string | null }) => Promise<{ ok: boolean; ativos: number | null; confirmado?: boolean; nota?: string }>
  agora: () => number
}
export type Perfil = { leve: boolean }
// Gabriel (26/10): a passada automática já é a EXPANDIDA. 'leve' fica como alias (mesmos limites).
export const LIMITES = { leve: { base: 40, web: 15, anuncios: 5, finais: 10 }, profunda: { base: 40, web: 15, anuncios: 5, finais: 10 } }

// ── 1) termos de busca ──────────────────────────────────────────────────────────
// termos que NÃO identificam nicho nem empresa (jurídicos, genéricos de negócio, conectivos)
const SUFIXOS = new Set(['ltda', 'me', 'mei', 'eireli', 'epp', 'sa', 's/a', 's.a', 'cia', 'limitada', 'empresa', 'empresas', 'grupo', 'holding', 'comercio', 'comercial', 'servicos', 'servico', 'industria', 'industrial', 'participacoes', 'brasil', 'brasileira', 'brasileiro', 'the', 'and', 'com', 'para', 'por', 'dos', 'das', 'de', 'do', 'da', 'em', 'e', 'o', 'a', 'os', 'as', 'um', 'uma',
  'consultoria', 'consultores', 'gestao', 'solucoes', 'solucao', 'negocios', 'assessoria', 'representacoes', 'distribuidora', 'distribuicao', 'importacao', 'exportacao', 'atacado', 'varejo', 'atacadista', 'varejista', 'produtos', 'projetos', 'sistemas', 'tecnologia', 'digital', 'online', 'marketing', 'vendas', 'company', 'co', 'inc', 'llc', 'ltd', 'group', 'international', 'nacional', 'regional', 'central', 'centro', 'casa', 'ponto', 'mundo', 'top', 'mais', 'plus', 'prime', 'premium', 'master', 'express', 'star', 'vip', 'max', 'new', 'nova', 'novo', 'bom', 'boa', 'bem', 'sem', 'fronteiras', 'organizacao', 'associacao', 'fraternidade', 'fundacao', 'instituto', 'sociedade', 'cooperativa', 'unidade', 'filial', 'matriz',
  'atividades', 'atividade', 'outras', 'outros', 'nao', 'especificadas', 'anteriormente', 'exceto', 'informada', 'economica', 'especificados', 'tipo', 'tipos', 'uso', 'geral', 'gerais', 'diversos', 'diversas', 'relacionadas', 'relacionados', 'similares', 'congeneres'])
// nomes próprios de pessoa comuns no Brasil (não identificam nicho; o nome do contato/sócio do lead também sai)
const NOMES_PESSOA = new Set(['alex', 'alexandre', 'ana', 'andre', 'antonio', 'bruno', 'carlos', 'carla', 'cesar', 'daniel', 'daniela', 'diego', 'eduardo', 'fabio', 'felipe', 'fernanda', 'fernando', 'gabriel', 'gabriela', 'gustavo', 'henrique', 'joao', 'jose', 'juliana', 'julio', 'leandro', 'leonardo', 'lucas', 'luis', 'luiz', 'luciana', 'marcelo', 'marcos', 'marcio', 'maria', 'mariana', 'mario', 'mateus', 'matheus', 'miguel', 'patricia', 'paulo', 'pedro', 'rafael', 'rafaela', 'renato', 'ricardo', 'roberto', 'rodrigo', 'rogerio', 'ronaldo', 'sergio', 'thiago', 'tiago', 'vinicius', 'vitor', 'victor', 'wagner', 'william', 'silva', 'santos', 'oliveira', 'souza', 'sousa', 'pereira', 'lima', 'costa', 'ferreira', 'rodrigues', 'almeida', 'nascimento', 'araujo', 'carvalho', 'gomes', 'martins', 'rocha', 'ribeiro', 'alves', 'monteiro', 'mendes', 'barros', 'freitas', 'barbosa', 'pinto', 'moura', 'cavalcanti', 'dias', 'castro', 'campos', 'cardoso', 'correia', 'teixeira', 'moreira', 'nunes', 'ramos', 'reis', 'vieira', 'salomao', 'abe', 'genovese', 'junior', 'filho', 'neto', 'sobrinho'])
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
/** termos para cases_buscar, separados: NICHO (segmento/CNAE + sinônimos; pesa) e NOME (tokens do nome da
 *  empresa sem genéricos, sem nomes de pessoa e sem o nome do contato/sócio; só desempata) */
export function termosDe(empresa: string, nicho: string | null | undefined, pessoas: string[] = []): { nicho: string[]; nome: string[] } {
  const n: string[] = [], m: string[] = [], inferido: string[] = []
  const por = (arr: string[], x: string) => { const v = normalizar(x); if (v && !arr.includes(v)) arr.push(v) }
  for (const tk of tokens(nicho ?? '')) { por(n, tk); for (const s of SINONIMOS[tk] ?? []) por(n, s) }
  const pessoaTk = new Set(pessoas.flatMap((p) => tokens(p)))
  for (const tk of tokens(empresa)) {
    if (NOMES_PESSOA.has(tk) || pessoaTk.has(tk)) continue
    // nicho INFERIDO pelo nome ("odonto", "clinica"): só vira filtro de nicho quando NÃO há nicho explícito;
    // com nicho explícito ele fica como termo de NOME (desempate) — "Clínica Sorriso"+odontologia não deixa
    // passar uma Clínica Veterinária só por "clinica"
    const sin = SINONIMOS[tk] ?? []
    if (sin.length) { for (const s of sin) por(inferido, s); por(m, tk) } else por(m, tk)
  }
  const nichoFinal = n.length ? n : inferido
  return { nicho: nichoFinal.slice(0, 12), nome: m.slice(0, 8) }
}

// ── rede: um host é "público" se não é IP de loopback/privado/link-local/multicast nem nome local.
// Usado pela sondagem de site (SSRF): cada salto de redirect e cada IP resolvido passam por aqui.
export function ipPrivado(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v6.includes(':')) return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:') || v6.startsWith('ff')
  return true   // não é IP válido: trata como não-público
}
export function hostPublico(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || !h.includes('.')) return false
  if (/^[\d.]+$/.test(h) || h.includes(':')) return !ipPrivado(h)
  return true
}

// ── 2) presença digital a partir de uma busca web ───────────────────────────────
const SOCIAIS = /(^|\.)(instagram|facebook|linkedin|youtube|tiktok|twitter|x)\.com$/
const DIRETORIOS = /(^|\.)(google|bing|cnpj\.biz|cnpja|econodata|casadosdados|consultacnpj|cnpj\.info|solutudo|apontador|telelistas|guiamais|reclameaqui|jusbrasil|escavador|glassdoor|indeed|catho|infojobs|olx|mercadolivre|ifood|booking|tripadvisor|yelp|wikipedia|gov\.br|receita|empresascnpj|cadastroempresa|informecadastral|listamais|hotfrog|kekanto|cylex|encontra|foursquare|waze|maps)\./
/** nome de busca: tokens do nome sem sufixos/genéricos (até 4), senão o nome como veio */
export function nomeDeBusca(c: { nome: string; razao_social?: string | null }): string {
  const tk = tokens(c.nome).slice(0, 4)
  return tk.length ? tk.join(' ') : normalizar(c.nome)
}
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
export async function gerarCases(deps: Deps, entrada: { empresa: string; nicho?: string | null; cidade?: string | null; uf?: string | null; pessoas?: string[]; profundidade: 'leve' | 'profunda' }, progresso?: Progresso): Promise<Candidato[]> {
  const L = LIMITES[entrada.profundidade]
  const termos = termosDe(entrada.empresa, entrada.nicho, entrada.pessoas ?? [])
  if (!termos.nicho.length && !termos.nome.length) return []
  let cands = (await deps.base(termos.nicho, termos.nome, entrada.uf ?? null, L.base)).map((c) => ({ ...c, por_que: [] as string[] }))
  await progresso?.('base', cands)
  // presença digital nos N melhores (1 busca por case; cache/ritmo ficam no deps.buscaWeb)
  // etapas OPCIONAIS (web/anúncios): falha de transporte de um candidato vira aviso nele, nunca aborta
  const tenta = async <T>(fn: () => Promise<T>, falha: (msg: string) => T): Promise<T> => { try { return await fn() } catch (e) { if (e instanceof ErroCritico) throw e; return falha(String((e as Error)?.message ?? e).slice(0, 120)) } }
  const pulso = async () => { if (deps.pulso) await deps.pulso() }   // posse renovada ENTRE candidatos/chamadas lentas (crítico: se lançar, aborta)
  for (const c of cands.slice(0, L.web)) {
    c.termos_casados = [...new Set(c.termos_casados ?? [])]
    await pulso()
    // consulta pelo NOME LIMPO (sem LTDA/ME/genéricos, ≤4 palavras) + cidade, sem aspas — a razão social
    // completa entre aspas quase nunca acha o site; se ainda assim não achar site, 2ª tentativa com "site"
    const q1 = `${nomeDeBusca(c)} ${c.cidade ?? ''}`.trim()
    let r = await tenta(() => deps.buscaWeb(q1), (msg) => ({ ok: false, results: [], nota: msg }))
    if (!r.ok) { c.por_que!.push(`busca web indisponível${r.nota ? ` (${r.nota})` : ''}`); continue }
    let p = extrairPresenca(r.results, c.nome)
    if (!p.site) {
      await pulso()
      const r2 = await tenta(() => deps.buscaWeb(`${nomeDeBusca(c)} site oficial`), (msg) => ({ ok: false, results: [], nota: msg }))
      if (r2.ok) { const p2 = extrairPresenca(r2.results, c.nome); p = { site: p2.site, instagram: p.instagram ?? p2.instagram, instagram_nao_confirmado: p.instagram_nao_confirmado ?? p2.instagram_nao_confirmado } }
    }
    c.site = p.site; c.instagram = p.instagram; c.instagram_nao_confirmado = p.instagram_nao_confirmado
    // sinais de presença (opcionais; falha vira null, nunca aborta)
    c.site_no_ar = c.site ? await tenta(() => deps.siteNoAr(c.site!), () => null) : null
    await pulso()
    c.instagram_existe = c.instagram ? await tenta(() => deps.instagramExiste(c.instagram!), () => null) : null
    await pulso()
    const g = await tenta(() => deps.googleNegocio(c.nome, c.cidade ?? null), () => ({ ok: false, encontrado: false, rating: null, avaliacoes: null }))
    c.google = g.ok ? { encontrado: g.encontrado, rating: g.rating, avaliacoes: g.avaliacoes } : null
  }
  await progresso?.('web', cands)
  // anúncios da Meta nos 3 melhores com alguma presença (site ou instagram) — senão nos 3 primeiros
  const alvo = [...cands.slice(0, L.web)].sort((a, b) => qualidadeDe(b) - qualidadeDe(a) || pontuar(b) - pontuar(a)).slice(0, L.anuncios)
  for (const c of alvo) {
    await pulso()
    const r = await tenta(() => deps.anuncios({ company: c.nome, siteDomain: c.site ? hostDe(c.site) : null, cidade: c.cidade ?? null, fbHandle: c.instagram ?? null }), (msg) => ({ ok: false, ativos: null, nota: msg }))
    c.anuncios = { ativos: r.ok ? r.ativos : null, confirmado: r.ok ? r.confirmado !== false : false, url: urlAdLibrary(c.nome), nota: r.ok ? (r.nota ?? null) : (r.nota ?? 'indisponível') }
  }
  await progresso?.('anuncios', cands)
  for (const c of cands) { c.qualidade = qualidadeDe(c); c.score_final = pontuar(c); c.por_que = [...porQue(c, entrada), ...(c.por_que ?? [])] }  // mantém avisos
  // ordem final: QUALIDADE (presença digital) primeiro, relevância desempata — pedido do Gabriel
  cands = cands.sort((a, b) => (b.qualidade ?? 0) - (a.qualidade ?? 0) || (b.score_final ?? 0) - (a.score_final ?? 0)).slice(0, L.finais)
  await progresso?.('pronto', cands)
  return cands
}
export const urlAdLibrary = (nome: string) => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(nome)}&search_type=keyword_unordered&media_type=all`
/** QUALIDADE do case, 0–100 (presença digital): site no ar 25 (site achado mas não medido 10); Instagram
 *  confirmado 20 (existência confirmada +5 já incluída; só candidato 0); anúncios Meta confirmados 30 (1–2: 15,
 *  3+: 30; não confirmados 0); Google Business 25 (encontrado 10 + avaliações ≥10: +5, ≥50: +10; nota ≥4,5: +5). */
export function qualidadeDe(c: Candidato): number {
  let q = 0
  if (c.site) q += c.site_no_ar === true ? 25 : c.site_no_ar === false ? 0 : 10
  if (c.instagram) q += c.instagram_existe === false ? 0 : c.instagram_existe === true ? 20 : 15
  const ativos = c.anuncios?.ativos ?? 0
  if (ativos > 0 && c.anuncios?.confirmado !== false) q += ativos >= 3 ? 30 : 15
  if (c.google?.encontrado) { q += 10; const av = c.google.avaliacoes ?? 0; q += av >= 50 ? 10 : av >= 10 ? 5 : 0; if ((c.google.rating ?? 0) >= 4.5) q += 5 }
  return Math.max(0, Math.min(100, q))
}
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
  if (c.qualidade != null) m.unshift(`qualidade ${c.qualidade}/100`)
  if (c.site) m.push(c.site_no_ar === true ? 'site no ar' : c.site_no_ar === false ? 'site fora do ar' : 'tem site')
  if (c.google?.encontrado) m.push(`Google Business${c.google.rating != null ? ` ${c.google.rating}★` : ''}${c.google.avaliacoes != null ? ` (${c.google.avaliacoes} avaliações)` : ''}`)
  if (c.instagram) m.push(`Instagram @${c.instagram}${c.instagram_existe === false ? ' (não encontrado)' : c.instagram_existe === true ? ' (ativo)' : ''}`)
  else if (c.instagram_nao_confirmado) m.push(`Instagram a confirmar: @${c.instagram_nao_confirmado}`)
  if ((c.anuncios?.ativos ?? 0) > 0 && c.anuncios?.confirmado !== false) m.push(`${c.anuncios!.ativos} anúncios ativos na Meta (confirmados)`)
  else if ((c.anuncios?.ativos ?? 0) > 0) m.push(`${c.anuncios!.ativos} anúncios na Meta a confirmar`)
  else if (c.anuncios && c.anuncios.ativos === 0 && c.anuncios.confirmado !== false) m.push('sem anúncios ativos na Meta')
  else if (c.anuncios && c.anuncios.ativos === 0) m.push(`nenhum anúncio confirmado nesta busca${c.anuncios.nota ? ` (${c.anuncios.nota})` : ''}`)
  else if (c.anuncios && c.anuncios.nota) m.push(`anúncios: ${c.anuncios.nota}`)
  if (c.produto_origem) m.push(`produto: ${c.produto_origem}`)
  return m
}
