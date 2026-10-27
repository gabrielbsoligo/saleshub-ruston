// Resultado final da ligação (prevendas_voz_resultado.ts) com I/O falso: banco (posse por token) + Kommo (notas).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABANDONO_S, buscarCdrs, CDR_INCOMPLETO_S, coberta, GRACA_GRAVACAO_S, janelasCdr, LEASE_S, paginaCdr, processarLigacao, processarPendentes, SEM_CDR_S, temMarcador,
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
const todos = (lista: any[]) => ({ lista, cobertas: [[-Infinity, Infinity]] as Array<[number, number]> })

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
  const r = await processarLigacao(evento(), { lista: [], cobertas: [[T0 + 100, T0 + 5000]] }, io)
  assert.equal((r as any).motivo, 'cdr_fora_da_cobertura'); assert.equal(w.row.final, null)
  const r2 = await processarLigacao(evento(), { lista: [], cobertas: janelasCdr([T0]) }, io)
  assert.equal(r2.feito, true); assert.match(w.notas[0].texto, /sem registro na 4com/)
  const m = mundo({ agora: T0 + 300 })
  assert.equal((await processarLigacao(evento(), todos([]), m.io) as any).motivo, 'aguardando_cdr')
})

test('1v) CDR primeiro INCOMPLETO (sem fim/causa) adia; o mesmo CDR encerrado depois conclui', async () => {
  const { w, io } = mundo({ notas: [{ id: 77, texto: 'cab\nResultado: aguardando\nRef. widget #501' }] })
  const incompleto = cdrDe({ ended_at: null, hangup_cause: null, duration: 0, record_url: null })
  const a = await processarLigacao(evento(), todos([incompleto]), io)
  assert.equal((a as any).motivo, 'cdr_incompleto'); assert.equal(w.patches, 0); assert.equal(w.row.final_em, null)
  assert.equal((await processarLigacao(evento(), todos([cdrDe({ ended_at: iso4com(T0 + 70), hangup_cause: '' , duration: 0, record_url: null })]), io) as any).motivo, 'cdr_incompleto')
  const b = await processarLigacao(evento(), todos([cdrDe({ duration: 0, record_url: null, hangup_cause: 'NO_ANSWER' })]), io)
  assert.equal(b.feito, true); assert.match(w.notas[0].texto, /Resultado: não atendida\n/)
  // incompleto por tempo demais: fecha como indeterminado (não fica pendente para sempre)
  const velho = mundo({ agora: T0 + CDR_INCOMPLETO_S + 10, notas: [{ id: 77, texto: 'cab\nRef. widget #501' }] })
  const c = await processarLigacao(evento(), todos([incompleto]), velho.io)
  assert.equal(c.feito, true); assert.match(velho.w.notas[0].texto, /indeterminado/)
})

/** 4com falsa: where started_at between (rótulo Brasília-Z), ordem DESC, skip/limit, meta.nextPage. */
function api4com(cdrs: any[], cont = { req: 0 }) {
  return async (de: string, ate: string, skip: number, lim: number) => {
    cont.req++
    const f = cdrs.filter((c) => c.started_at >= de && c.started_at <= ate).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    return { data: f.slice(skip, skip + lim), meta: { nextPage: skip + lim < f.length ? 2 : null } }
  }
}

test('3b) buscarCdrs por faixa: janela lida inteira cobre; envelope ruim, item sem horário ou orçamento esgotado não cobrem', async () => {
  const cdrs = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, started_at: iso4com(T0 - 300 + i), metadata: {} }))
  const r = await buscarCdrs(api4com(cdrs), [T0], 30, 5, 100)
  assert.equal(r.lista.length, 250); assert.ok(coberta(r, T0))
  const curto = await buscarCdrs(api4com(cdrs), [T0], 30, 2, 100)                                // 2 páginas < 250: truncada
  assert.ok(!coberta(curto, T0)); assert.equal(curto.lista.length, 200)
  assert.ok(!coberta(await buscarCdrs(async () => ({ erro: 'x' }), [T0]), T0))
  assert.ok(!coberta(await buscarCdrs(async () => ({ data: [{ id: 'x' }], meta: {} }), [T0]), T0))
  assert.ok(!coberta(await buscarCdrs(api4com(cdrs), [T0], 0), T0))
  assert.deepEqual(janelasCdr([T0, T0 + 100, T0 + 50_000]).length, 2)                          // fundidas só se sobrepõem
  assert.equal(paginaCdr([{}], 100)?.proxima, false)
})

test('3c) histórico com >800 CDRs e rodadas LIMITADAS: pendências antigas (23 h) E novas progridem', async () => {
  const AGORA = T0 + 24 * 3600
  const cdrs: any[] = Array.from({ length: 1200 }, (_, i) => ({ id: `x${i}`, started_at: iso4com(T0 + i * 72), ended_at: iso4com(T0 + i * 72 + 10), hangup_cause: 'NO_ANSWER', duration: 0, metadata: {} }))
  // 20 pendências espalhadas de 23 h atrás até 5 min atrás, cada uma com o seu CDR encerrado
  const rows = new Map<number, any>()
  const ems = Array.from({ length: 20 }, (_, i) => AGORA - 23 * 3600 + Math.floor(i * (23 * 3600 - 300) / 19))
  ems.forEach((em, i) => {
    const ev = 1000 + i
    rows.set(ev, { id: ev, kommo_user: UID, em: iso(em), entidade: 'manual', nota_entidade: null, nota_id: null, final: null, final_em: null })
    cdrs.push({ id: `p${ev}`, started_at: iso4com(em + 20), ended_at: iso4com(em + 40), hangup_cause: 'USER_BUSY', duration: 0, to: '047997293673', metadata: { widget_ev: ev, kommo_user: UID } })
  })
  const io: IoResultado = {
    agoraS: () => AGORA, token: () => Math.random().toString(36),
    reivindicar: async (id, ant, tok, proc) => { const r = rows.get(id); if (r.final_em || (ant ? r.final?.tok !== ant : r.final)) return false; r.final = { proc, tok }; return true },
    confirmar: async (id, tok) => rows.get(id).final?.tok === tok,
    gravar: async (id, tok, d) => { const r = rows.get(id); if (r.final?.tok !== tok || r.final_em) return false; Object.assign(r, d); return true },
    liberar: async (id, tok) => { const r = rows.get(id); if (r.final?.tok === tok) r.final = null },
    kommo: async () => null,                                                                    // sem contato: fecha sem nota
    membro: () => null,
  }
  const pendentes = () => [...rows.values()].filter((r) => !r.final_em).sort((a, b) => a.em.localeCompare(b.em))
  const rodada = async () => {                                                                   // como a edge: 25+25 por ponta, orçamento de 4 requisições
    const p = pendentes(), sel = [...new Set([...p.slice(0, 25), ...p.slice(-25)])]
    const c = await buscarCdrs(api4com(cdrs), sel.map((r) => Math.floor(Date.parse(r.em) / 1000)), 4, 5, 100)
    return processarPendentes(sel, c, io, AGORA + 60)
  }
  const r1 = await rodada()
  const feitos1 = r1.filter((x) => x.feito).map((x) => x.ev)
  assert.ok(feitos1.includes(1000) && feitos1.includes(1019))                                   // a mais antiga E a mais nova já na 1ª rodada
  let n = 1
  while (pendentes().length && n < 10) { await rodada(); n++ }
  assert.equal(pendentes().length, 0); assert.ok(n <= 5)                                         // progresso garantido
  assert.match(rows.get(1000).final.rotulo, /ocupado/); assert.equal(rows.get(1000).cdr_id, 'p1000')
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
