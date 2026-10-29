// Confere se um bearer é uma chave de serviço do projeto (service_role).
// Não basta comparar com SUPABASE_SERVICE_ROLE_KEY: o cron usa o JWT legado e a
// edge pode ter a chave em outro formato. A prova é o Auth aceitar a chave num
// endpoint só de admin. Resultado guardado por instância (hash, nunca a chave).
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const confirmadas = new Set<string>()

async function hash(t: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function ehChaveDeServico(bearer: string): Promise<boolean> {
  if (!bearer) return false
  if (SERVICE_KEY && bearer === SERVICE_KEY) return true
  const h = await hash(bearer)
  if (confirmadas.has(h)) return true
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    })
    await r.body?.cancel()
    if (r.ok) { confirmadas.add(h); return true }
  } catch { /* rede: trata como não autorizado */ }
  return false
}
