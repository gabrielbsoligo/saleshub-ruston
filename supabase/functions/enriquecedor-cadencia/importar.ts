// Importar um modelo do Kommo pro hub sem migration: o corpo do Kommo usa
// {{lead.cf.<id do campo>}}; aqui vira {{1}}..{{n}} (na ordem em que aparecem) e cada
// campo CAD vira a chave do motor (chaves_vars). Placeholder que não é campo CAD
// conhecido = erro (o motor não saberia preencher). Sem dependências: importar_test.ts.

export type Importado = { corpo: string; chaves_vars: string[]; variaveis: string[]; botoes: string[] }

export function importarCorpo(
  content: string,
  botoesKommo: { text?: string }[] | null | undefined,
  nomeDoCampo: Map<number, string>,
  chaveDoCampo: Record<string, string>,
): { ok: true; modelo: Importado } | { ok: false; erro: string } {
  const posicao = new Map<string, number>()
  const chaves: string[] = []
  const variaveis: string[] = []
  const desconhecidos: string[] = []
  const corpo = String(content ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (bruto, ref: string) => {
    const m = /^lead\.cf\.(\d+)$/.exec(ref)
    const campo = m ? nomeDoCampo.get(Number(m[1])) : undefined
    const chave = campo ? chaveDoCampo[campo] : undefined
    if (!chave) { desconhecidos.push(campo ? `${ref} (${campo})` : ref); return bruto }
    if (!posicao.has(chave)) { posicao.set(chave, chaves.length + 1); chaves.push(chave); variaveis.push(campo!) }
    return `{{${posicao.get(chave)}}}`
  }).trim()
  if (desconhecidos.length) return { ok: false, erro: `variáveis que o hub não sabe preencher: ${[...new Set(desconhecidos)].join(', ')}` }
  if (!corpo) return { ok: false, erro: 'modelo sem corpo' }
  const botoes = (botoesKommo ?? []).map((b) => String(b?.text ?? '').trim()).filter(Boolean)
  return { ok: true, modelo: { corpo, chaves_vars: chaves, variaveis, botoes } }
}

/** Conversas distintas (cards) por canal nas últimas 24 h — o limite da Meta conta conversas. */
export function volume24h(envios: { source_id: number | string | null; kommo_lead_id: string | null; enviado_em: string | null }[], agoraMs: number) {
  const desde = agoraMs - 24 * 3600_000
  const por = new Map<string, Set<string>>()
  for (const e of envios) {
    if (!e.enviado_em || new Date(e.enviado_em).getTime() < desde) continue
    const k = e.source_id == null ? 'sem_canal' : String(e.source_id)
    const s = por.get(k) ?? new Set<string>()
    s.add(String(e.kommo_lead_id ?? ''))
    por.set(k, s)
  }
  return Object.fromEntries([...por].map(([k, s]) => [k, s.size]))
}
