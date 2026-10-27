// Resultado final da ligação (prevendas_voz_resultado.ts) com I/O falso: banco (posse por token) + Kommo (notas).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABANDONO_S, buscarCdrs, GRACA_GRAVACAO_S, LEASE_S, paginaCdr, processarLigacao, SEM_CDR_S, temMarcador,
  type EventoPendente, type IoResultado,
} from '../../../supabase/functions/_shared/prevendas_voz_resultado.ts'

const UID = 11420911, EV = 501
const T0 = 2_000_000_000                       // epoch s da discagem
const iso = (s: number) => new Date(s * 1000).toISOString()
const iso4com = (s: number) => new Date((s - 3 * 3600) * 1000).toISOString()   // Brasília rotulado Z
const cdrDe = (o: Record<string, unknown> = {}) => ({
  id: 'cdr-1', started_at: iso4com(T0 + 5), ended_at: iso4com(T0 + 65), to: '047997293673', duration: 50,
  hangup_cause: 'NORMAL_CLEARING', record_url: 'https://listener.api4com.com/files/listen/abc.mp3', metadata: { widget_ev: EV, kommo_user: UID }, ...o,
})
const evento = (o: Partial<EventoPendente> = {}): EventoPendente =>
  ({ id: EV, kommo_user: UID, em: iso(T0), entidade: 'leads:10', nota_entidade: 'leads:10', nota_id: null, final: null, ...o })

/** Mundo falso: uma linha do banco + notas do Kommo; relógio controlado. */
function mundo(o: { notas?: Array<{ id: number; texto: string }>; contatos?: any[][]; agora?: number } = {}) {
  const w = {
    agora: o.agora ?? T0 + 600,
    row: { final: null as any, final_em: null as any, nota_entidade: null as any, nota_id: null as any, cdr_id: null as any },
    notas: [...(o.notas ?? [])], proxId: 9000, posts: 0, patches: 0,
    perderRespostaPost: false, falharGravar: false, toks: 0,
    contatos: o.contatos ?? [[]], buscasContato: 0,
    aoPatch: null as null | (() => void),
  }
  const io: IoResultado = {
    agoraS: () => w.agora,
    token: () => `tok${++w.toks}`,
    reivindicar: async (_id, ant, tok, proc) => {
      if (w.row.final_em) return false
      if (ant ? w.row.final?.tok !== ant : w.row.final != null) return false
      w.row.final = { proc, tok }; return true
    },
    confirmar: async (_id, tok) => !w.row.final_em && w.row.final?.tok === tok,
    gravar: async (_id, tok, dados) => {
      if (w.falharGravar || w.row.final_em || w.row.final?.tok !== tok) return false
      Object.assign(w.row, dados); return true
    },
    liberar: async (_id, tok) => { if (w.row.final?.tok === tok) w.row.final = null },
    kommo: async (path, init) => {
      if (path.startsWith('/api/v4/contacts?')) {
        const pg = Number(new URL('http://x' + path).searchParams.get('page')); w.buscasContato++
        const l = w.contatos[pg - 1]; if (!l) return null
        return { _embedded: { contacts: l }, _links: pg < w.contatos.length ? { next: {} } : {} }
      }
      if (/\/notes\?/.test(path)) return w.notas.length ? { _embedded: { notes: w.notas.map((n) => ({ id: n.id, params: { text: n.texto } })) }, _links: {} } : null
      const corpo = JSON.parse(init!.body)[0]
      if (init!.method === 'POST') {
        w.posts++; const id = ++w.proxId; w.notas.push({ id, texto: corpo.params.text })
        if (w.perderRespostaPost) throw new Error('timeout')                        // aceito, resposta perdida
        return { _embedded: { notes: [{ id }] } }
      }
      w.patches++; w.aoPatch?.()
      const n = w.notas.find((x) => x.id === corpo.id)!; n.texto = corpo.params.text
      return { _embedded: { notes: [{ id: n.id }] } }
    },
    membro: () => ({ name: 'Gabriel', role: 'sdr', ramal_4com: '1006' }),
  }
  return { w, io }
}
const todos = (lista: any[]) => ({ lista, cobreDesde: 0 })

test('marcador: só o ev exato', () => {
  assert.ok(temMarcador('x\nRef. widget #501', 501))
  assert.ok(!temMarcador('x\nRef. widget #5011', 501))
  assert.ok(!temMarcador('x\nRef. widget #50', 501))
})

test('1) POST aceito com resposta perdida: a retomada ACHA a nota pelo marcador e atualiza (uma nota só)', async () => {
  const { w, io } = mundo()
  w.perderRespostaPost = true
  const a = await processarLigacao(evento(), todos([cdrDe()]), io)
  assert.equal(a.feito, false); assert.equal(w.posts, 1); assert.equal(w.row.final, null)    // posse devolvida
  w.perderRespostaPost = false
  const b = await processarLigacao(evento(), todos([cdrDe()]), io)
  assert.equal(b.feito, true); assert.equal(w.posts, 1); assert.equal(w.patches, 1); assert.equal(w.notas.length, 1)
  assert.equal(w.row.nota_id, w.notas[0].id); assert.equal(w.row.cdr_id, 'cdr-1')
  assert.match(w.notas[0].texto, /Resultado: atendida · duração 50 s\nGravação: https:.*abc\.mp3\nRef\. widget #501$/)
})

test('1b) nota da discagem criada mas nota_id não gravado: PATCH na nota do marcador, sem POST', async () => {
  const { w, io } = mundo({ notas: [{ id: 77, texto: '📞 Ligação 4com pelo widget — G (ramal 1) para +55 47 99729-3673\nResultado: aguardando o fim da ligação…\nRef. widget #501' }] })
  const r = await processarLigacao(evento({ nota_id: null }), todos([cdrDe({ record_url: null, duration: 0, hangup_cause: 'USER_BUSY' })]), io)
  assert.equal(r.feito, true); assert.equal(w.posts, 0); assert.equal(w.row.nota_id, 77)
  assert.match(w.notas[0].texto, /\nResultado: ocupado\nRef\. widget #501$/)
})

test('2) posse: A vence o lease, B assume e conclui, A volta — A não escreve nem limpa nada', async () => {
  const { w, io } = mundo({ notas: [{ id: 77, texto: 'cab\nResultado: aguardando\nRef. widget #501' }] })
  // A reivindica e trava antes do efeito (o relógio anda além do abandono durante a leitura das notas)
  let pausa!: () => void
  const leituraA = new Promise<void>((ok) => { pausa = ok })
  const kommoOriginal = io.kommo
  let primeira = true
  io.kommo = async (p, i) => { if (primeira && /\/notes\?/.test(p)) { primeira = false; await leituraA } return kommoOriginal(p, i) }
  const pa = processarLigacao(evento(), todos([cdrDe()]), io)
  await new Promise((ok) => setTimeout(ok, 5))
  assert.equal(w.row.final?.tok, 'tok1')
  w.agora += ABANDONO_S + 1
  const b = await processarLigacao(evento({ final: { ...w.row.final } }), todos([cdrDe()]), io)
  assert.equal(b.feito, true); assert.equal(w.patches, 1)
  const concluido = JSON.stringify(w.row)
  pausa()
  const a = await pa
  assert.deepEqual(a, { ev: EV, feito: false, motivo: 'posse_perdida' })
  assert.equal(w.patches, 1); assert.equal(JSON.stringify(w.row), concluido)              // nada sobrescrito
})

test('2b) dono dentro do lease não é tomado; lease vencido (sem abandono) impede o efeito', async () => {
  const { w, io } = mundo({ notas: [{ id: 77, texto: 'cab\nRef. widget #501' }] })
  w.row.final = { proc: w.agora - 10, tok: 'outro' }
  assert.equal((await processarLigacao(evento({ final: w.row.final }), todos([cdrDe()]), io) as any).motivo, 'em_processamento')
  // o próprio worker passa do lease antes do PATCH: desiste sem efeito
  const m2 = mundo({ notas: [{ id: 77, texto: 'cab\nRef. widget #501' }] })
  const k = m2.io.kommo
  m2.io.kommo = async (p, i) => { if (/\/notes\?/.test(p)) m2.w.agora += LEASE_S; return k(p, i) }
  assert.equal((await processarLigacao(evento(), todos([cdrDe()]), m2.io) as any).motivo, 'posse_perdida')
  assert.equal(m2.w.patches, 0)
})

test('3) CDR fora da cobertura ADIA (nunca vira "sem registro"); coberto e com 15 min vira', async () => {
  const { w, io } = mundo({ agora: T0 + SEM_CDR_S + 60, notas: [{ id: 77, texto: 'cab\nRef. widget #501' }] })
  const r = await processarLigacao(evento(), { lista: [], cobreDesde: T0 + 100 }, io)
  assert.equal((r as any).motivo, 'cdr_fora_da_cobertura'); assert.equal(w.row.final, null)
  const r2 = await processarLigacao(evento(), { lista: [], cobreDesde: T0 - 1000 }, io)
  assert.equal(r2.feito, true); assert.match(w.notas[0].texto, /sem registro na 4com/)
  const m = mundo({ agora: T0 + 300 })
  assert.equal((await processarLigacao(evento(), todos([]), m.io) as any).motivo, 'aguardando_cdr')
})

test('3b) buscarCdrs: pagina até cobrir; envelope {data,meta}; envelope inesperado não cobre', async () => {
  const pag = (n: number, ini: number) => Array.from({ length: n }, (_, i) => ({ id: `c${ini + i}`, started_at: iso4com(T0 - (ini + i) * 60) }))
  const chamadas: number[] = []
  const r = await buscarCdrs(async (skip, lim) => { chamadas.push(skip); return { data: pag(lim, skip), meta: { nextPage: 9 } } }, T0 - 250 * 60, 8, 100)
  assert.deepEqual(chamadas, [0, 100, 200]); assert.ok(r.cobreDesde <= T0 - 250 * 60); assert.equal(r.lista.length, 300)
  const fim = await buscarCdrs(async () => ({ data: pag(3, 0), meta: { nextPage: null } }), T0 - 1e6)
  assert.equal(fim.cobreDesde, 0)
  const ruim = await buscarCdrs(async () => ({ erro: 'x' }), T0)
  assert.equal(ruim.cobreDesde, Infinity)
  const parcial = await buscarCdrs(async (skip) => (skip ? null : { data: pag(100, 0), meta: { nextPage: 2 } }), T0 - 1e6)
  assert.ok(parcial.cobreDesde > T0 - 1e6)                                                      // truncado: não cobre a antiga
  assert.equal(paginaCdr([{}], 100)?.proxima, false)
})

test('4) contato: busca COMPLETA (paginada); um só na 1ª página e outro na 2ª = ambíguo, sem nota', async () => {
  const c = (id: number, tel: string, dono = UID) => ({ id, responsible_user_id: dono, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: tel }] }] })
  const sem = evento({ nota_entidade: null, entidade: 'manual' })
  const amb = mundo({ contatos: [[c(1, '+5547997293673')], [c(2, '47 99729-3673')]] })
  const r = await processarLigacao(sem, todos([cdrDe()]), amb.io)
  assert.equal(r.feito, true); assert.equal(amb.w.buscasContato, 2); assert.equal(amb.w.posts, 0); assert.equal(amb.w.row.nota_entidade, null)
  const um = mundo({ contatos: [[c(1, '+5547997293673'), c(3, '+5547999990000')], [c(4, '+5511988887777')]] })
  const r2 = await processarLigacao(sem, todos([cdrDe()]), um.io)
  assert.equal(r2.feito, true); assert.equal(um.w.posts, 1); assert.equal(um.w.row.nota_entidade, 'contacts:1')
  const alheio = mundo({ contatos: [[c(1, '+5547997293673', 999)]] })
  await processarLigacao(sem, todos([cdrDe()]), alheio.io)
  assert.equal(alheio.w.posts, 0)                                                               // contato de outro dono: negado
  const longo = mundo({ contatos: [[], [], [], [], [c(1, '+5547997293673')]] })
  await processarLigacao(sem, todos([cdrDe()]), longo.io)
  assert.equal(longo.w.buscasContato, 4); assert.equal(longo.w.posts, 0)                      // orçamento acabou: não decide
})

test('6) gravação: não repete a da nota da N8N; espera a N8N antes de concluir atendida com gravação', async () => {
  const n8n = { id: 50, texto: 'LIGAÇÃO\nFeita por G\nResumo…\nGravação: https://listener.api4com.com/files/listen/abc.mp3' }
  const { w, io } = mundo({ notas: [n8n, { id: 77, texto: 'cab\nResultado: aguardando\nRef. widget #501' }] })
  await processarLigacao(evento({ entidade: 'manual leads:10' }), todos([cdrDe()]), io)
  assert.doesNotMatch(w.notas[1].texto, /Gravação/); assert.equal(w.row.final.gravacao_na_nota, false)
  const cedo = mundo({ agora: T0 + 65 + GRACA_GRAVACAO_S - 5 })
  assert.equal((await processarLigacao(evento(), todos([cdrDe()]), cedo.io) as any).motivo, 'aguardando_n8n')
})

test('falha no Kommo devolve a posse (nova tentativa); recente demais não é processada', async () => {
  const { w, io } = mundo()
  io.kommo = async () => { throw new Error('kommo 500') }
  assert.equal((await processarLigacao(evento(), todos([cdrDe()]), io) as any).motivo, 'nota_falhou')
  assert.equal(w.row.final, null)
  const m = mundo({ agora: T0 + 30 })
  assert.equal((await processarLigacao(evento(), todos([cdrDe({ record_url: null })]), m.io) as any).motivo, 'recente')
})
