// Confere se um bearer é uma chave de serviço do projeto (service_role).
// Não basta comparar com SUPABASE_SERVICE_ROLE_KEY: o cron usa o JWT legado e a
// edge pode ter a chave em outro formato. A prova é o Auth aceitar a chave num
// endpoint só de admin. Sem cache: revogação/expiração valem na hora (o custo é
// uma consulta por tick do cron).
export async function ehChaveDeServico(bearer, { url, chaveEnv = '', fetchImpl = globalThis.fetch } = {}) {
  if (!bearer) return false;
  if (chaveEnv && bearer === chaveEnv) return true;
  try {
    const r = await fetchImpl(`${url}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: bearer, Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    await r.body?.cancel?.();
    return r.ok;
  } catch {
    return false; // rede: trata como não autorizado
  }
}
