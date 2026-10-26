// central-cases/cliente.ts — adaptadores reais (Supabase, motor do Enriquecedor) para o motor.ts.
// A busca web NÃO chama a Brave daqui: passa pelo motor do Enriquecedor (Railway), que já tem
// chave, cache em Postgres (enriquecedor_cache, 14 dias) e ritmo (1/s). Idem a Biblioteca de
// Anúncios (/api/anuncios, headless + proxy). Auth no motor = login do usuário de integração,
// feito num CLIENTE SEPARADO (anon key): o cliente admin (service_role) nunca recebe sessão de usuário.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ErroCritico, hostPublico, ipPrivado, type Candidato, type Deps, type ResultadoWeb } from './motor.ts'

export type ResolveDns = (host: string) => Promise<string[]>
const resolveDnsPadrao: ResolveDns = async (host) => {
  const out: string[] = []
  for (const t of ['A', 'AAAA'] as const) { try { out.push(...(await (Deno as any).resolveDns(host, t))) } catch { /* sem registro desse tipo */ } }
  return out
}
/** sondagem HTTP segura: só http(s) público; redirects seguidos MANUALMENTE (≤5), validando host e IPs resolvidos
 *  a cada salto; nunca segue para loopback/privado/link-local. null = não deu para medir. */
export async function sondarSite(url: string, fetchFn: typeof fetch, resolver: ResolveDns = resolveDnsPadrao, saltos = 5): Promise<boolean | null> {
  let atual = url
  for (let i = 0; i <= saltos; i++) {
    let u: URL
    try { u = new URL(atual) } catch { return null }
    if (!/^https?:$/.test(u.protocol) || !hostPublico(u.hostname)) return null
    if (!/^[\d.]+$/.test(u.hostname) && !u.hostname.includes(':')) {
      const ips = await resolver(u.hostname).catch(() => [] as string[])
      if (!ips.length || ips.some((ip) => ipPrivado(ip))) return null
    }
    let r: Response
    try { r = await fetchFn(u.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; SalesHub-Cases/1.0)' } }) } catch { return null }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location'); if (!loc) return null
      try { atual = new URL(loc, u).toString() } catch { return null }
      continue
    }
    return r.status < 400
  }
  return null   // redirects demais
}

export type Sb = any
const DIA = 24 * 60 * 60 * 1000

export async function sessaoMotor(supabaseUrl: string, anonKey: string): Promise<string> {
  const login = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await login.auth.signInWithPassword({ email: Deno.env.get('ENRIQ_INTEG_EMAIL') ?? '', password: Deno.env.get('ENRIQ_INTEG_SENHA') ?? '' })
  if (error || !data?.session?.access_token) throw new Error(`auth integração falhou: ${error?.message ?? 'sem sessão'}`)
  return data.session.access_token as string
}

/** anúncios VALIDADOS como da empresa (meta.validados); modo 'pagina' = identidade confirmada; keyword com
 *  itens a validar/descartados = parcial (confirmado:false). Nunca conta descartados. */
export function interpretarAnuncios(body: any): { ok: boolean; ativos: number | null; confirmado?: boolean; nota?: string } {
  if (!body || body.ok === false) return { ok: false, ativos: null, nota: String(body?.note ?? 'anúncios indisponíveis') }
  const meta = body.meta
  if (!meta) return { ok: false, ativos: null, nota: String(body.note ?? 'sem medição') }
  const validados = Array.isArray(meta.validados) ? meta.validados.length : 0
  const aValidar = Array.isArray(meta.aValidar) ? meta.aValidar.length : 0
  const descartados = Array.isArray(meta.descartados) ? meta.descartados.length : 0
  if (meta.modo === 'pagina') return { ok: true, ativos: Number(meta.total ?? validados), confirmado: true }
  if (validados > 0) return { ok: true, ativos: validados, confirmado: aValidar === 0, nota: aValidar ? `${aValidar} a validar` : undefined }
  if (aValidar > 0) return { ok: true, ativos: aValidar, confirmado: false, nota: 'identidade não confirmada' }
  return { ok: true, ativos: 0, confirmado: descartados === 0, nota: descartados ? `${descartados} anúncios de terceiros descartados` : undefined }
}

export function depsReais(sb: Sb, motorUrl: string, token: () => Promise<string>, fetchFn: typeof fetch = fetch, resolver: ResolveDns = resolveDnsPadrao): Deps {
  const chave = (prefixo: string, ...p: unknown[]) => `${prefixo}:${p.map((x) => String(x ?? '').toLowerCase().trim()).join('|')}`.slice(0, 900)
  // cache é best-effort: erro de leitura = sem cache (segue para o motor); erro de escrita = aviso no log
  const cacheGet = async (k: string) => {
    const r = await sb.from('cases_web_cache').select('valor').eq('chave', k).gt('expira_em', new Date().toISOString()).maybeSingle()
    if (r.error) { console.warn('central-cases cache: leitura falhou', r.error.message); return undefined }
    return r.data?.valor
  }
  const cacheSet = async (k: string, valor: unknown, ttl: number) => {
    const r = await sb.from('cases_web_cache').upsert({ chave: k, valor, expira_em: new Date(Date.now() + ttl).toISOString() }, { onConflict: 'chave' })
    if (r.error) console.warn('central-cases cache: gravação falhou', r.error.message)
  }
  // Transporte (rede/timeout/abort) do motor NÃO é crítico: vira status 0 + nota, e a etapa fica
  // "indisponível" para aquele candidato. A autenticação (token()) continua lançando: é crítica.
  const motor = async (rota: string, body: unknown): Promise<{ status: number; body: any; nota?: string }> => {
    let tk: string
    try { tk = await token() } catch (e) { throw new ErroCritico(`auth do motor: ${String((e as Error)?.message ?? e).slice(0, 160)}`) }   // crítico: atravessa o tenta() do motor
    try {
      const r = await fetchFn(`${motorUrl}${rota}`, { method: 'POST', headers: { Authorization: `Bearer ${tk}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
      const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null } catch { /* corpo não-JSON */ }
      return { status: r.status, body: j }
    } catch (e) {
      return { status: 0, body: null, nota: `motor indisponível: ${String((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timeout' : (e as Error)?.message ?? e).slice(0, 120)}` }
    }
  }
  return {
    agora: () => Math.floor(Date.now() / 1000),
    async base(nicho, nome, uf, limite) {
      const { data, error } = await sb.rpc('cases_buscar', { p_nicho: nicho, p_nome: nome, p_uf: uf, p_limit: limite })
      if (error) throw new ErroCritico(`cases_buscar: ${error.message}`)
      return (data ?? []).map((r: any) => ({ ...r, score: Number(r.score ?? 0), termos_casados: r.termos_casados ?? [] })) as Candidato[]
    },
    // site no ar: sondagem segura (sondarSite): só público, redirects validados salto a salto; rede/timeout/privado = null
    async siteNoAr(url) {
      const k = chave('site', url)
      const hit = await cacheGet(k)
      if (hit && typeof hit.no_ar !== 'undefined') return hit.no_ar
      const v = await sondarSite(url, fetchFn, resolver)
      if (v !== null) await cacheSet(k, { no_ar: v }, 7 * DIA)
      return v
    },
    async instagramExiste(handle) {
      const k = chave('ig', handle)
      const hit = await cacheGet(k)
      if (hit && typeof hit.existe !== 'undefined') return hit.existe
      const r = await motor('/api/ops/rede-existe', { instagram: handle })
      if (r.status !== 200 || !r.body?.instagram) return null
      const existe = r.body.instagram.existe === true ? true : r.body.instagram.existe === false ? false : null
      if (existe !== null) await cacheSet(k, { existe }, 7 * DIA)
      return existe
    },
    // Google Business pela rota que DISTINGUE indisponível (ok:false, não cacheia) de não encontrado (ok:true, found:false)
    async googleNegocio(nome, cidade) {
      const k = chave('gmn', nome, cidade)
      const hit = await cacheGet(k)
      if (hit && typeof hit.encontrado !== 'undefined') return { ok: true, ...hit }
      const r = await motor('/api/cases/google-negocio', { company: nome, cidade })
      if (r.status !== 200 || !r.body || r.body.ok !== true) return { ok: false, encontrado: false, rating: null, avaliacoes: null }
      const b = r.body
      const encontrado = b.found === true
      const out = { encontrado, rating: encontrado && b.rating != null ? Number(b.rating) : null, avaliacoes: encontrado && b.reviews != null ? Number(b.reviews) : null }
      await cacheSet(k, out, 7 * DIA)
      return { ok: true, ...out }
    },
    async buscaWeb(consulta) {
      const k = chave('web', consulta)
      const hit = await cacheGet(k)
      if (hit && Array.isArray(hit.results)) return { ok: true, results: hit.results as ResultadoWeb[] }
      const r = await motor('/api/busca-web', { q: consulta })
      const item = r.body?.itens?.[0]
      if (r.status !== 200 || !item) return { ok: false, results: [], nota: r.nota ?? `motor HTTP ${r.status}` }
      if (item.ok === false) return { ok: false, results: [], nota: item.note ?? 'busca indisponível' }
      const results = (item.results ?? []).map((x: any) => ({ url: String(x.url ?? ''), title: String(x.title ?? ''), desc: String(x.desc ?? '') })).filter((x: ResultadoWeb) => x.url)
      await cacheSet(k, { results }, 14 * DIA)
      return { ok: true, results }
    },
    async anuncios(c) {
      const k = chave('ads', c.company, c.siteDomain, c.cidade, c.fbHandle)
      const hit = await cacheGet(k)
      if (hit && typeof hit.ativos !== 'undefined') return { ok: true, ativos: hit.ativos, confirmado: hit.confirmado, nota: hit.nota }
      const r = await motor('/api/anuncios', { company: c.company, fbHandle: c.fbHandle, siteDomain: c.siteDomain, cidade: c.cidade })
      if (r.status !== 200 || !r.body) return { ok: false, ativos: null, nota: r.nota ?? `motor HTTP ${r.status}` }
      const out = interpretarAnuncios(r.body)
      if (out.ok) await cacheSet(k, { ativos: out.ativos, confirmado: out.confirmado, nota: out.nota ?? null }, 7 * DIA)
      return out
    },
  }
}
