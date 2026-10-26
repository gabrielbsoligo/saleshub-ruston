// central-cases/cliente.ts — adaptadores reais (Supabase, motor do Enriquecedor) para o motor.ts.
// A busca web NÃO chama a Brave daqui: passa pelo motor do Enriquecedor (Railway), que já tem
// chave, cache em Postgres (enriquecedor_cache, 14 dias) e ritmo (1/s). Idem a Biblioteca de
// Anúncios (/api/anuncios, headless + proxy). Auth no motor = login do usuário de integração.
import type { Candidato, Deps, ResultadoWeb } from './motor.ts'

export type Sb = any
const DIA = 24 * 60 * 60 * 1000

export async function sessaoMotor(sb: Sb): Promise<string> {
  const { data, error } = await sb.auth.signInWithPassword({ email: Deno.env.get('ENRIQ_INTEG_EMAIL') ?? '', password: Deno.env.get('ENRIQ_INTEG_SENHA') ?? '' })
  if (error || !data?.session?.access_token) throw new Error(`auth integração falhou: ${error?.message ?? 'sem sessão'}`)
  return data.session.access_token as string
}

export function depsReais(sb: Sb, motorUrl: string, token: () => Promise<string>, fetchFn: typeof fetch = fetch): Deps {
  const chave = (prefixo: string, ...p: unknown[]) => `${prefixo}:${p.map((x) => String(x ?? '').toLowerCase().trim()).join('|')}`.slice(0, 900)
  const cacheGet = async (k: string) => {
    const r = await sb.from('cases_web_cache').select('valor').eq('chave', k).gt('expira_em', new Date().toISOString()).maybeSingle()
    return r.error ? undefined : r.data?.valor
  }
  const cacheSet = async (k: string, valor: unknown, ttl: number) => { await sb.from('cases_web_cache').upsert({ chave: k, valor, expira_em: new Date(Date.now() + ttl).toISOString() }, { onConflict: 'chave' }) }
  const motor = async (rota: string, body: unknown) => {
    const r = await fetchFn(`${motorUrl}${rota}`, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
    const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null } catch { /* corpo não-JSON */ }
    return { status: r.status, body: j }
  }
  return {
    agora: () => Math.floor(Date.now() / 1000),
    async base(termos, uf, limite) {
      const { data, error } = await sb.rpc('cases_buscar', { p_termos: termos, p_uf: uf, p_limit: limite })
      if (error) throw new Error(`cases_buscar: ${error.message}`)
      return (data ?? []).map((r: any) => ({ ...r, score: Number(r.score ?? 0), termos_casados: r.termos_casados ?? [] })) as Candidato[]
    },
    async buscaWeb(consulta) {
      const k = chave('web', consulta)
      const hit = await cacheGet(k)
      if (hit && Array.isArray(hit.results)) return { ok: true, results: hit.results as ResultadoWeb[] }
      const r = await motor('/api/busca-web', { q: consulta })
      const item = r.body?.itens?.[0]
      if (r.status !== 200 || !item) return { ok: false, results: [], nota: `motor HTTP ${r.status}` }
      if (item.ok === false) return { ok: false, results: [], nota: item.note ?? 'busca indisponível' }
      const results = (item.results ?? []).map((x: any) => ({ url: String(x.url ?? ''), title: String(x.title ?? ''), desc: String(x.desc ?? '') })).filter((x: ResultadoWeb) => x.url)
      await cacheSet(k, { results }, 14 * DIA)
      return { ok: true, results }
    },
    async anuncios(c) {
      const k = chave('ads', c.company, c.siteDomain, c.cidade)
      const hit = await cacheGet(k)
      if (hit && typeof hit.ativos !== 'undefined') return { ok: true, ativos: hit.ativos }
      const r = await motor('/api/anuncios', { company: c.company, fbHandle: c.fbHandle, siteDomain: c.siteDomain, cidade: c.cidade })
      if (r.status !== 200 || !r.body) return { ok: false, ativos: null, nota: `motor HTTP ${r.status}` }
      if (r.body.ok === false) return { ok: false, ativos: null, nota: r.body.note ?? 'anúncios indisponíveis' }
      const ativos = r.body.meta ? Number(r.body.meta.total ?? 0) : 0   // meta:null com ok:true = bloqueio/cap → conta como desconhecido? não: nota
      if (!r.body.meta && r.body.note) return { ok: false, ativos: null, nota: String(r.body.note) }
      await cacheSet(k, { ativos }, 7 * DIA)
      return { ok: true, ativos }
    },
  }
}
