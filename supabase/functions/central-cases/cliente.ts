// central-cases/cliente.ts — adaptadores reais (Supabase, motor do Enriquecedor) para o motor.ts.
// A busca web NÃO chama a Brave daqui: passa pelo motor do Enriquecedor (Railway), que já tem
// chave, cache em Postgres (enriquecedor_cache, 14 dias) e ritmo (1/s). Idem a Biblioteca de
// Anúncios (/api/anuncios, headless + proxy). Auth no motor = login do usuário de integração,
// feito num CLIENTE SEPARADO (anon key): o cliente admin (service_role) nunca recebe sessão de usuário.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ErroCritico, hostPublico, ipPrivado, type Candidato, type Deps, type ResultadoWeb } from './motor.ts'

export type Sb = any
const DIA = 24 * 60 * 60 * 1000

// A sondagem de site NÃO é feita daqui: a edge não consegue fixar a conexão no IP validado (DNS rebinding).
// Fica no motor (enriquecedor/server/sonda.mjs), que conecta no IP aprovado preservando Host/SNI e revalida
// cada salto. Aqui só a pré-checagem barata do host e a chamada à rota.
export function depsReais(sb: Sb, motorUrl: string, token: () => Promise<string>, fetchFn: typeof fetch = fetch): Deps {
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
    // site no ar: pré-checagem do host aqui; medição pelo motor (/api/cases/site-no-ar, sonda.mjs) — nunca GET direto da edge
    async siteNoAr(url) {
      let host = ''
      try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return null; host = u.hostname } catch { return null }
      if (!hostPublico(host)) return null
      const k = chave('site', url)
      const hit = await cacheGet(k)
      if (hit && typeof hit.no_ar !== 'undefined') return hit.no_ar
      const r = await motor('/api/cases/site-no-ar', { url })
      if (r.status !== 200 || !r.body || r.body.ok !== true) return null
      const v = !!r.body.noAr
      await cacheSet(k, { no_ar: v }, 7 * DIA)
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
