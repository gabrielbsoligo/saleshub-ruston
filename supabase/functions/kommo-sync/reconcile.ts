// Reconciliação de tarefas excluídas no Kommo — política de confirmação PURA (sem rede/banco),
// testada em reconcile_test.ts. A edge (index.ts) só injeta o cliente e grava o resultado.
//
// Regras:
//  - a resposta do lote precisa ser 204 (ninguém existe) ou 200 com _embedded.tasks ARRAY; 200 com
//    envelope inválido/vazio NÃO é ausência → aborta o lote (Error);
//  - qualquer id devolvido fora do lote = filtro ignorado → aborta;
//  - _links.next presente = página parcial → aborta (lote de 50 nunca deveria paginar);
//  - TODA ausência do lote é confirmada individualmente: GET /tasks/{id} 200 com body.id === id →
//    vista; 204 → ausente confirmada; qualquer outro status/corpo → aborta;
//  - erro em qualquer lote: nada da rodada é gravado (quem chama só persiste no fim).
export type RespostaHttp = { status: number; body: any }
export type GetRaw = (path: string) => Promise<RespostaHttp>

export class ReconciliacaoAbortada extends Error { constructor(msg: string) { super(msg) } }

// ── Janela/página de uma paginação por offset que atravessa invocações (events e full fatiado).
// Regra: enquanto uma paginação está em curso (full_page > 1, ou backfill pedido/persistido), a
// janela (`from`) é a GRAVADA em full_cursor — nunca recalculada; o cursor temporal só consolida ao
// terminar. `full:true` persiste o modo backfill (full_done=false, page=1, cursor = janela nova).
export type EstadoSync = { full_done: boolean; full_page: number | null; last_delta_at: number | null; full_cursor: string | null }
// full_cursor guarda, em JSON, o estado da paginação em curso: { from?: janela fixa (events), max: maior
// timestamp já visto nas fatias anteriores }. O max precisa sobreviver entre invocações: /events é
// DECRESCENTE (a última fatia tem os mais antigos) e, no full por updated_at asc, a última fatia pode
// vir vazia — sem persistir, o cursor consolidaria um valor velho e o delta seguinte repetiria milhares.
export type Cursor = { from?: number; max?: number }
export function lerCursor(s: string | null): Cursor | null {
  if (s == null || s === '') return null
  try { const o = JSON.parse(s); if (typeof o === 'number') return { from: o }; return o && typeof o === 'object' ? o : null } catch { return null }
}
export function janelaEventos(st: EstadoSync, full: boolean, agoraS: number, backfillDias: number): { from: number; page: number; iniciarBackfill: boolean; max: number } {
  const base = agoraS - backfillDias * 86400
  if (full) return { from: base, page: 1, iniciarBackfill: true, max: st.last_delta_at ?? 0 }        // pedido explícito: reinicia
  const emCurso = (st.full_page ?? 1) > 1 || !st.full_done
  const c = lerCursor(st.full_cursor)
  if (emCurso && c?.from != null) return { from: c.from, page: st.full_page ?? 1, iniciarBackfill: false, max: Math.max(c.max ?? 0, st.last_delta_at ?? 0) }
  return { from: st.last_delta_at ?? base, page: 1, iniciarBackfill: !st.full_done, max: st.last_delta_at ?? 0 }
}
export function paginaFull(st: EstadoSync, full: boolean): { doFull: boolean; page: number; iniciar: boolean; max: number } {
  if (full) return { doFull: true, page: 1, iniciar: true, max: st.last_delta_at ?? 0 }               // pedido explícito: reinicia e persiste o modo
  if (!st.full_done) return { doFull: true, page: st.full_page ?? 1, iniciar: false, max: Math.max(lerCursor(st.full_cursor)?.max ?? 0, st.last_delta_at ?? 0) } // continua de onde parou
  return { doFull: false, page: 1, iniciar: false, max: st.last_delta_at ?? 0 }
}

export function montarUrl(base: string, params: Record<string, string>): string {
  // base pode já ter query ('/leads?with=contacts,companies'): junta com '&' preservando o que existe
  const [path, q = ''] = base.split('?')
  const sp = new URLSearchParams(q)
  for (const [k, v] of Object.entries(params)) sp.set(k, v)
  const s = sp.toString()
  return s ? `${path}?${s}` : path
}

export async function conferirLote(get: GetRaw, lote: number[]): Promise<{ vistas: number[]; ausentes: number[] }> {
  if (!lote.length) return { vistas: [], ausentes: [] }
  const r = await get(montarUrl('/tasks', { ...Object.fromEntries(lote.map((id, k) => [`filter[id][${k}]`, String(id)])), limit: '250' }))
  let devolvidas = new Set<number>()
  if (r.status === 204) devolvidas = new Set()
  else if (r.status === 200) {
    const lista = r.body?._embedded?.tasks
    if (!Array.isArray(lista)) throw new ReconciliacaoAbortada('lote: 200 sem _embedded.tasks (envelope inválido)')
    if (r.body?._links?.next) throw new ReconciliacaoAbortada('lote: resposta paginada (parcial)')
    devolvidas = new Set(lista.map((t: any) => Number(t?.id)).filter(Number.isFinite))
    for (const id of devolvidas) if (!lote.includes(id)) throw new ReconciliacaoAbortada(`lote: id ${id} fora do lote (filtro ignorado)`)
  } else throw new ReconciliacaoAbortada(`lote: HTTP ${r.status}`)
  const vistas = lote.filter((id) => devolvidas.has(id))
  const candidatas = lote.filter((id) => !devolvidas.has(id))
  const ausentes: number[] = []
  for (const id of candidatas) {          // confirmação individual de TODA ausência
    const u = await get(`/tasks/${id}`)
    if (u.status === 200 && Number(u.body?.id) === id) { vistas.push(id); continue }
    if (u.status === 204) { ausentes.push(id); continue }
    throw new ReconciliacaoAbortada(`/tasks/${id}: HTTP ${u.status}${u.status === 200 ? ' com corpo inesperado' : ''}`)
  }
  return { vistas, ausentes }
}

/** Confere todos os lotes; qualquer falha aborta a rodada inteira (nada parcial). */
export async function conferirTodas(get: GetRaw, ids: number[], tamLote = 50): Promise<{ vistas: number[]; ausentes: number[] }> {
  const vistas: number[] = [], ausentes: number[] = []
  for (let i = 0; i < ids.length; i += tamLote) {
    const r = await conferirLote(get, ids.slice(i, i + tamLote))
    vistas.push(...r.vistas); ausentes.push(...r.ausentes)
  }
  return { vistas, ausentes }
}
