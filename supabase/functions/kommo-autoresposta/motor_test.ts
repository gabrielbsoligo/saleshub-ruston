// deno test --allow-read supabase/functions/kommo-autoresposta/motor_test.ts
// Fluxo completo (webhook → decisão → efeito → varredura) com repositório e Kommo FALSOS, sem rede.
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { LeituraFalhou, Throttled, aplicarEfeito, correlacionar, processarTrabalho, receberWebhook, ultimoDisparoAte, varrer, type Deps, type KommoFn, type Linha, type Repo, type Trabalho } from './motor.ts'
import type { Cfg, Padrao } from './triagem.ts'

const PIPE = 14062116, RESP = 108545256, D1 = 108545280, D2 = 108545284
const cfgBase: Cfg = { pipeline_id: PIPE, status_respondeu: RESP, ativo: true, modo: 'aplicar', janela_rapida_s: 60, repeticao_min: 3, espera_s: 180, r3_min_palavras: 6, etapas_origem: [D1, D2] }
const PADROES: Padrao[] = [
  { id: 1, padrao: '^\\[(audio|midia)\\]$', tipo: 'humano' },
  { id: 3, padrao: 'agradec\\w* (sua mensagem|seu contato)', tipo: 'autoresposta' },
  { id: 7, padrao: 'mensagem automatica', tipo: 'autoresposta' },
  { id: 24, padrao: 'atendimento (esta|está) sendo transferido', tipo: 'autoresposta' },
]
const copia = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

// ── repositório em memória
type LinhaFake = Linha & { lease_ate: number | null; extra: Record<string, unknown> }
type TrabalhoFake = Trabalho & { estado: string; erro: string | null; contact_id?: number | null }
function repoFake(cfg: Cfg | null = cfgBase) {
  const trabalhos: TrabalhoFake[] = []
  const linhas: LinhaFake[] = []
  let seq = 1
  const estado: { cfg: Cfg | null } = { cfg }
  const st: { estado: { cfg: Cfg | null }; trabalhos: TrabalhoFake[]; linhas: LinhaFake[]; repo: Repo } = {
    estado, trabalhos, linhas,
    repo: {
      async padroesAtivos() { return PADROES },
      async config(p: number) { return estado.cfg && Number(estado.cfg.pipeline_id) === Number(p) ? { ...estado.cfg } : null },
      async criarTrabalho(leadId: number | null, msg: any = null, contactId: number | null = null) { const ja = msg?.id ? trabalhos.find((x) => x.mensagem_id === msg.id) : null; if (ja) return ja; const t = { id: seq++, kommo_lead_id: leadId, tentativas: 0, estado: 'pendente', erro: null, mensagem_id: msg?.id ?? null, texto: msg?.texto ?? null, recebido_em: msg ? new Date(msg.ts * 1000).toISOString() : null, contact_id: contactId }; trabalhos.push(t); return t },
      async vincularLead(id: number, leadId: number) { trabalhos.find((x) => x.id === id)!.kommo_lead_id = leadId },
      async atualizarTexto(id: number, texto: string) { const l = linhas.find((x) => x.id === id)!; if (l.estado_efeito !== 'pendente' || l.decidido_em) return false; l.texto = texto; return true },
      async concluirTrabalho(id: number, estado: string, erro: string | null = null) { const t = trabalhos.find((x) => x.id === id)!; t.estado = estado; t.erro = erro; if (estado === 'pendente') t.tentativas++ },
      async trabalhosPendentes(n: number) { return trabalhos.filter((t) => t.estado === 'pendente').slice(0, n) },
      async linhasDoLead(leadId: number) { return copia(linhas.filter((l) => l.kommo_lead_id === leadId)) },
      async criarLinhas(novas: Partial<Linha>[]) { for (const n of novas) if (!linhas.some((l) => l.kommo_lead_id === n.kommo_lead_id && l.mensagem_id === n.mensagem_id)) linhas.push(Object.assign({ id: seq++, texto: null, hash: null, decidido_em: null, claim_token: null, efeito_fase: null, tentativas: 0, lease_ate: null, extra: {} }, n) as LinhaFake) },
      async linha(leadId: number, m: string) { return copia(linhas.find((l) => l.kommo_lead_id === leadId && l.mensagem_id === m)!) },
      async decidir(id: number, dec: any) { const l = linhas.find((x) => x.id === id)!; if (l.estado_efeito !== 'pendente' || l.decidido_em || (l.lease_ate && l.lease_ate > Date.now())) return null; Object.assign(l, dec); return copia(l) },
      async outrosLeadsComHash(hash: string, leadId: number) { return new Set(linhas.filter((l) => l.hash === hash && l.kommo_lead_id !== leadId).map((l) => l.kommo_lead_id)).size },
      async superar(leadId: number, exceto: number | null, antesDe: string | null, motivo: string, opts: { somenteSemTexto?: boolean } = {}) { for (const l of linhas) if (l.kommo_lead_id === leadId && l.id !== exceto && ['pendente', 'falhou'].includes(l.estado_efeito) && (!antesDe || l.recebido_em < antesDe) && (!opts.somenteSemTexto || !(l.texto ?? '').trim())) { l.estado_efeito = 'superado'; l.extra.motivo_efeito = motivo } },
      async claim(id: number, leaseS: number) { const l = linhas.find((x) => x.id === id)!; const livre = ['pendente', 'falhou'].includes(l.estado_efeito) || (l.estado_efeito === 'em_andamento' && (l.lease_ate ?? 0) < Date.now()); if (!livre) return null; l.estado_efeito = 'em_andamento'; l.lease_ate = Date.now() + leaseS * 1000; l.claim_token = crypto.randomUUID(); return { token: l.claim_token, linha: copia(l) } },
      async renovar(id: number, token: string, leaseS: number) { const l = linhas.find((x) => x.id === id)!; if (l.claim_token !== token || l.estado_efeito !== 'em_andamento' || (l.lease_ate ?? 0) < Date.now()) return false; l.lease_ate = Date.now() + leaseS * 1000; return true },
      async fase(id: number, token: string, fase: string, extra: Record<string, unknown> = {}) { const l = linhas.find((x) => x.id === id)!; if (l.claim_token !== token) return false; l.efeito_fase = fase; Object.assign(l, extra); return true },
      async fim(id: number, token: string, estado: Linha['estado_efeito'], extra: Record<string, unknown>) { const l = linhas.find((x) => x.id === id)!; if (l.claim_token !== token) return false; l.estado_efeito = estado; l.lease_ate = null; Object.assign(l.extra, extra); Object.assign(l, extra); if (['aplicado', 'observado', 'superado'].includes(estado)) l.claim_token = null; return true },
      async acerto() {},
      async pendentesEfeito(n: number) { return copia(linhas.filter((l) => (l.classificacao === 'indeterminado' && l.estado_efeito === 'pendente') || ['pendente', 'falhou'].includes(l.estado_efeito) || (l.estado_efeito === 'em_andamento' && (l.lease_ate ?? 0) < Date.now())).slice(0, n)) },
    } as Repo,
  }
  return st
}

// ── Kommo falso: lead, eventos, campo, e registro das escritas
type KommoFakeOpts = { leadStatus?: number; leadPipeline?: number; texto?: string; ins?: { id: string; ts: number }[]; outs?: number[]; falhar?: Partial<Record<string, number>>; notas?: string[]; tags?: string[] }
function kommoFake(o: KommoFakeOpts) {
  const escritas: { m: string; p: string; body: any }[] = []
  const notas = o.notas ?? []
  const fn: KommoFn = async (m, p, body, opts) => {
    const etapa = opts?.etapa ?? p
    if (o.falhar?.[etapa] !== undefined) {
      const st = o.falhar[etapa]!
      if (st === 429 && opts?.pararEm429) throw new Throttled(5)
      if (m === 'GET') throw new LeituraFalhou(etapa, `HTTP ${st}`)
      return { ok: false, status: st, body: null }
    }
    if (m === 'GET' && /\/api\/v4\/leads\/\d+$/.test(p)) return { ok: true, status: 200, body: { id: 1, pipeline_id: o.leadPipeline ?? PIPE, status_id: o.leadStatus ?? D1, custom_fields_values: [{ field_id: 99, values: [{ value: o.texto ?? '' }] }], _embedded: { tags: (o.tags ?? []).map((n, i) => ({ id: i + 1, name: n })) } } }
    if (m === 'GET' && p.includes('incoming_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: (o.ins ?? []).map((i) => ({ id: i.id, created_at: i.ts, value_after: [{ message: { id: i.id } }] })) } } }
    if (m === 'GET' && p.includes('outgoing_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: (o.outs ?? []).map((t, i) => ({ id: `o${i}`, created_at: t })) } } }
    if (m === 'GET' && p.includes('custom_fields')) return { ok: true, status: 200, body: { _embedded: { custom_fields: [{ id: 99, name: 'Triagem Resposta' }] } } }
    if (m === 'GET' && p.includes('/notes')) return { ok: true, status: 200, body: { _embedded: { notes: notas.map((t) => ({ params: { text: t } })) } } }
    escritas.push({ m, p, body })
    if (m === 'POST' && p.includes('/notes')) notas.push((body as any)[0].params.text)
    if (m === 'PATCH' && (body as any)?.status_id) o.leadStatus = Number((body as any).status_id) // como o Kommo: o lead muda de etapa
    return { ok: true, status: 200, body: {} }
  }
  return { fn, escritas, notas }
}
const deps = (repo: Repo, kommo: KommoFn, agora = 2_000_000): Deps => ({ repo, kommo, agora: () => agora, campoTexto: 'Triagem Resposta', leaseS: 300, maxTentativas: 5 })
const T0 = 2_000_000

Deno.test('humano em modo aplicar: 1 linha, decisão humano, PATCH de status, estado aplicado, trabalho concluído', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 500 }], outs: [T0 - 1000] })
  const r = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(r.classificacao, 'humano'); assertEquals(r.estado, 'aplicado')
  assertEquals(k.escritas.filter((e) => e.m === 'PATCH' && e.body.status_id === RESP).length, 1)
  assertEquals(st.linhas.length, 1); assertEquals(st.trabalhos[0].estado, 'concluido')
})

Deno.test('autoresposta: tag mesclada + nota com marcador; lead não se move', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'Agradecemos sua mensagem. Não estamos disponíveis.', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], tags: ['vip'] })
  const r = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(r.classificacao, 'autoresposta'); assertEquals(r.estado, 'aplicado')
  assert(!k.escritas.some((e) => e.body?.status_id), 'não pode mover')
  const tag = k.escritas.find((e) => e.body?._embedded?.tags)!; assertEquals(tag.body._embedded.tags.map((t: any) => t.id ?? t.name), [1, 'autoresposta'])
  assert(k.notas[0].includes('[triagem:m1]'))
})

Deno.test('#1 retomada preserva a origem: lead mudou de etapa (ambas elegíveis) → superado, sem PATCH', async () => {
  const st = repoFake(); const k1 = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000], leadStatus: D1, falhar: { patch_status: 503 } })
  const r1 = await receberWebhook(deps(st.repo, k1.fn), 1)
  assertEquals(r1.estado, 'falhou'); assertEquals(st.linhas[0].status_id_origem, D1)
  const k2 = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000], leadStatus: D2 })
  const r2 = await varrer(deps(st.repo, k2.fn))
  assertEquals(st.linhas[0].estado_efeito, 'superado'); assertEquals(st.linhas[0].status_id_origem, D1)
  assertEquals(k2.escritas.length, 0); assert(JSON.stringify(r2).includes('saiu da etapa'))
})

Deno.test('#2 leitura inicial falha (503 no lead) → trabalho pendente gravado, zero linhas; cron retoma e conclui', async () => {
  const st = repoFake(); const k1 = kommoFake({ falhar: { lead: 503 } })
  await assertRejects(() => receberWebhook(deps(st.repo, k1.fn), 1), LeituraFalhou)
  assertEquals(st.trabalhos[0].estado, 'pendente'); assertEquals(st.trabalhos[0].tentativas, 1); assertEquals(st.linhas.length, 0)
  const k2 = kommoFake({ texto: 'Oi', ins: [{ id: 'm1', ts: T0 - 900 }], outs: [T0 - 1000] })
  await varrer(deps(st.repo, k2.fn))
  assertEquals(st.trabalhos[0].estado, 'concluido'); assertEquals(st.linhas[0].classificacao, 'humano')
})

Deno.test('#2 evento ainda não visível → trabalho continua pendente (não skipped definitivo)', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'Oi', ins: [], outs: [T0 - 10] })
  const r = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(r.pendente, true); assertEquals(st.trabalhos[0].estado, 'pendente'); assertEquals(st.linhas.length, 0)
})

Deno.test('#2 duas mensagens novas (caminho legado, sem webhook): ambas ganham linha; a anterior sem texto fica pendente para o cron; só a última decide', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'pode mandar a proposta', ins: [{ id: 'a', ts: T0 - 8 }, { id: 'b', ts: T0 - 3 }], outs: [T0 - 1000] })
  const r = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(st.linhas.length, 2)
  assertEquals(st.linhas.find((l) => l.mensagem_id === 'a')!.estado_efeito, 'pendente')
  assertEquals(r.classificacao, 'humano'); assertEquals(k.escritas.filter((e) => e.body?.status_id).length, 1)
})

Deno.test('#3 posse: segundo worker não altera decisão nem aplica; dono vencido não conclui', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'Mensagem automática: fora do horário', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10] })
  await receberWebhook(deps(st.repo, k.fn), 1)
  const l = st.linhas[0]; assertEquals(l.estado_efeito, 'aplicado')
  // decisão imutável: tentar redecidir uma linha já aplicada não muda nada
  assertEquals(await st.repo.decidir(l.id, { classificacao: 'humano' } as any), null)
  // dono vencido: claim de A, lease expira, B reassume; fim de A não grava
  const st2 = repoFake(); await st2.repo.criarLinhas([{ kommo_lead_id: 1, mensagem_id: 'x', pipeline_id: PIPE, status_id_origem: D1, recebido_em: new Date((T0 - 5) * 1000).toISOString(), classificacao: 'humano', regras: ['R1'], estado_efeito: 'pendente', modo: 'aplicar' } as any])
  const lx = st2.linhas[0]
  const tokA = (await st2.repo.claim(lx.id, 300))?.token; lx.lease_ate = Date.now() - 1 // expira
  const tokB = (await st2.repo.claim(lx.id, 300))?.token
  assert(tokA && tokB && tokA !== tokB)
  assertEquals(await st2.repo.fim(lx.id, tokA!, 'aplicado', {}), false)
  assertEquals(await st2.repo.fim(lx.id, tokB!, 'aplicado', {}), true)
})

Deno.test('#4 nota aceita com resposta perdida → retomada reconcilia pelo marcador e NÃO duplica', async () => {
  const st = repoFake()
  const notas: string[] = []
  const k1 = kommoFake({ texto: 'Mensagem automática: fora do horário', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], notas })
  const base = k1.fn
  // 1ª execução: POST da nota "some" (rede) depois de o Kommo ter gravado
  const k1fn: KommoFn = async (m, p, b, o) => { const r = await base(m, p, b, o); if (m === 'POST' && p.includes('/notes')) return { ok: false, status: 0, body: null }; return r }
  const r1 = await receberWebhook(deps(st.repo, k1fn), 1)
  assertEquals(r1.estado, 'falhou'); assertEquals(st.linhas[0].efeito_fase, 'nota_enviando'); assertEquals(notas.length, 1)
  const k2 = kommoFake({ texto: 'Mensagem automática: fora do horário', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], notas, tags: ['autoresposta'] })
  await varrer(deps(st.repo, k2.fn))
  assertEquals(st.linhas[0].estado_efeito, 'aplicado'); assertEquals(notas.length, 1, 'nota não pode duplicar')
})

Deno.test('#5 config desligada/observar entre a decisão e o efeito → relida após o claim: sem PATCH', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000] })
  const repoMut: Repo = { ...st.repo, async claim(id, s) { const tk = await st.repo.claim(id, s); st.estado.cfg = { ...cfgBase, ativo: false }; return tk } }
  const r = await receberWebhook(deps(repoMut, k.fn), 1)
  assertEquals(r.estado, 'superado'); assertEquals(k.escritas.length, 0)
})

Deno.test('#6 observar: lead já em RESPONDEU (gatilho antigo venceu) é registrado como observado, sem efeito', async () => {
  const st = repoFake({ ...cfgBase, modo: 'observar' }); const k = kommoFake({ texto: 'Agradecemos sua mensagem', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], leadStatus: RESP })
  const r = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(r.classificacao, 'autoresposta'); assertEquals(r.estado, 'observado'); assertEquals(k.escritas.length, 0)
})

Deno.test('#7 varredura para no primeiro 429 (Throttled) e devolve interrompida', async () => {
  const st = repoFake(); await st.repo.criarTrabalho(1); await st.repo.criarTrabalho(2)
  const k = kommoFake({ falhar: { lead: 429 } })
  const r: any = await varrer(deps(st.repo, k.fn))
  assert(String(r.interrompida).startsWith('429')); assertEquals(r.processadas, 0)
})

Deno.test('#8 envelope inesperado (200 sem _embedded) é leitura falha, não "sem disparo"', async () => {
  const st = repoFake()
  const k: KommoFn = async (m, p) => {
    if (/\/leads\/\d+$/.test(p)) return { ok: true, status: 200, body: { id: 1, pipeline_id: PIPE, status_id: D1, custom_fields_values: [] } }
    return { ok: true, status: 200, body: { oops: true } }
  }
  await assertRejects(() => receberWebhook(deps(st.repo, k), 1), LeituraFalhou, 'envelope')
  assertEquals(st.trabalhos[0].estado, 'pendente')
})

Deno.test('#8 padrão inválido ativo → fail closed (nenhuma decisão)', async () => {
  const st = repoFake(); const repoBad: Repo = { ...st.repo, async padroesAtivos() { return [...PADROES, { id: 9, padrao: '(', tipo: 'autoresposta' }] } }
  const k = kommoFake({ texto: 'Oi', ins: [{ id: 'm1', ts: T0 - 900 }], outs: [T0 - 1000] })
  await assertRejects(() => receberWebhook(deps(repoBad, k.fn), 1), LeituraFalhou, 'regex inválida')
  assertEquals(st.linhas[0].classificacao, 'indeterminado'); assertEquals(k.escritas.length, 0)
})

Deno.test('R2: rápida e única fica indeterminada; passada a espera sem 2ª mensagem vira humano e aplica', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'ok', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10] })
  const r1 = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(r1.classificacao, 'indeterminado'); assertEquals(k.escritas.length, 0)
  const r2 = await varrer(deps(st.repo, k.fn, T0 + 200))
  assertEquals(st.linhas[0].classificacao, 'humano'); assertEquals(st.linhas[0].estado_efeito, 'aplicado')
  assert(JSON.stringify(r2).includes('sem_2a_msg=humano'))
})

Deno.test('texto vazio (linha só de /events): pendente até 5 tentativas, depois superada — nunca decisão', async () => {
  const st = repoFake(); const k = kommoFake({ texto: '', ins: [{ id: 'm1', ts: T0 - 900 }], outs: [T0 - 1000] })
  await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(st.linhas[0].regras, ['texto_vazio'])
  for (let i = 0; i < 6; i++) await varrer(deps(st.repo, k.fn))
  assertEquals(st.linhas[0].estado_efeito, 'superado'); assertEquals(st.linhas[0].classificacao, 'indeterminado'); assertEquals(k.escritas.length, 0)
})

Deno.test('aplicarEfeito: lead deletado → superado; funil sem status_respondeu → observado', async () => {
  const st = repoFake({ ...cfgBase, status_respondeu: null })
  await st.repo.criarLinhas([{ kommo_lead_id: 1, mensagem_id: 'x', pipeline_id: PIPE, status_id_origem: D1, recebido_em: new Date((T0 - 5) * 1000).toISOString(), classificacao: 'humano', regras: [], estado_efeito: 'pendente', modo: 'aplicar' } as any])
  const k = kommoFake({})
  const r = await aplicarEfeito(deps(st.repo, k.fn), st.linhas[0])
  assertEquals(r.estado, 'observado')
  const st2 = repoFake(); await st2.repo.criarLinhas([{ kommo_lead_id: 1, mensagem_id: 'x', pipeline_id: PIPE, status_id_origem: D1, recebido_em: new Date((T0 - 5) * 1000).toISOString(), classificacao: 'humano', regras: [], estado_efeito: 'pendente', modo: 'aplicar' } as any])
  const k404: KommoFn = async () => ({ ok: false, status: 404, body: null })
  assertEquals((await aplicarEfeito(deps(st2.repo, k404), st2.linhas[0])).estado, 'superado')
})

// processarTrabalho é usado diretamente pela varredura; aqui só garante que a assinatura segue estável
Deno.test('processarTrabalho: funil sem config → trabalho descartado', async () => {
  const st = repoFake(null); const k = kommoFake({ texto: 'Oi', ins: [{ id: 'm1', ts: T0 - 900 }] })
  const t = await st.repo.criarTrabalho(1)
  const r = await processarTrabalho(deps(st.repo, k.fn), t)
  assertEquals(r.skipped, true); assertEquals(st.trabalhos[0].estado, 'descartado')
})


// ── 4ª rodada ──────────────────────────────────────────────────────────────────────────────
Deno.test('R4#1 decisão concorrente: B tenta regravar depois de A decidir → recusado; o efeito usa a fotografia do claim', async () => {
  const st = repoFake()
  const kA = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000] }) // humano (lento)
  let tentativaB: Linha | null | undefined
  const repoA: Repo = { ...st.repo, async decidir(id, dec) {
    const r = await st.repo.decidir(id, dec)                       // A grava humano
    tentativaB = await st.repo.decidir(id, { ...dec, classificacao: 'autoresposta', regras: ['R3:3'] }) // B chega depois com outra decisão
    return r
  } }
  const r = await receberWebhook(deps(repoA, kA.fn), 1)
  assertEquals(tentativaB, null, 'B não pode sobrescrever uma decisão final')
  assertEquals(st.linhas[0].classificacao, 'humano'); assertEquals(r.estado, 'aplicado')
  assertEquals(kA.escritas.filter((e) => e.body?.status_id === RESP).length, 1)
})

Deno.test('R4#1 chamador com fotografia velha: claim devolve a decisão do banco e é ela que vale', async () => {
  const st = repoFake()
  await st.repo.criarLinhas([{ kommo_lead_id: 1, mensagem_id: 'x', pipeline_id: PIPE, status_id_origem: D1, recebido_em: new Date((T0 - 5) * 1000).toISOString(), classificacao: 'autoresposta', regras: ['R1:3'], decidido_em: 'x', estado_efeito: 'pendente', modo: 'aplicar' } as any])
  const velha = { ...copia(st.linhas[0]), classificacao: 'humano' } as Linha // chamador acha que é humano
  const k = kommoFake({})
  const r = await aplicarEfeito(deps(st.repo, k.fn), velha)
  assertEquals(r.estado, 'aplicado'); assert(!k.escritas.some((e) => e.body?.status_id), 'não pode mover: no banco é autoresposta')
  assert(k.escritas.some((e) => e.body?._embedded?.tags))
})

Deno.test('R4#2 reconciliação da nota não regride a fase: GET notas 503 mantém nota_enviando; retomada seguinte não duplica', async () => {
  const st = repoFake(); const notas: string[] = []
  const k1 = kommoFake({ texto: 'Mensagem automática: fora do horário', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], notas })
  const k1fn: KommoFn = async (m, p, b, o) => { const r = await k1.fn(m, p, b, o); if (m === 'POST' && p.includes('/notes')) return { ok: false, status: 0, body: null }; return r }
  await receberWebhook(deps(st.repo, k1fn), 1)
  assertEquals(st.linhas[0].efeito_fase, 'nota_enviando'); assertEquals(notas.length, 1)
  const k2 = kommoFake({ texto: 'Mensagem automática: fora do horário', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], notas, tags: ['autoresposta'], falhar: { notas: 503 } })
  await varrer(deps(st.repo, k2.fn))
  assertEquals(st.linhas[0].estado_efeito, 'falhou'); assertEquals(st.linhas[0].efeito_fase, 'nota_enviando', 'fase não pode regredir'); assertEquals(notas.length, 1)
  const k3 = kommoFake({ texto: 'Mensagem automática: fora do horário', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10], notas, tags: ['autoresposta'] })
  await varrer(deps(st.repo, k3.fn))
  assertEquals(st.linhas[0].estado_efeito, 'aplicado'); assertEquals(notas.length, 1, 'nota não pode duplicar')
})

Deno.test('R4#3 PATCH de status aceito com resposta perdida → destino registrado antes; retomada reconcilia como aplicado/movido', async () => {
  const st = repoFake()
  const k1 = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000] })
  let moveu = false
  const k1fn: KommoFn = async (m, p, b, o) => { const r = await k1.fn(m, p, b, o); if (m === 'PATCH' && (b as any)?.status_id) { moveu = true; return { ok: false, status: 0, body: null } } return r }
  const r1 = await receberWebhook(deps(st.repo, k1fn), 1)
  assertEquals(r1.estado, 'falhou'); assertEquals(st.linhas[0].efeito_fase, 'status_enviando'); assertEquals((st.linhas[0] as any).movido_para, RESP); assert(moveu)
  const k2 = kommoFake({ texto: 'Oi, pode falar', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000], leadStatus: RESP }) // o Kommo aplicou
  await varrer(deps(st.repo, k2.fn))
  assertEquals(st.linhas[0].estado_efeito, 'aplicado'); assertEquals((st.linhas[0] as any).movido, true); assertEquals((st.linhas[0] as any).movido_para, RESP)
  assertEquals(k2.escritas.length, 0, 'não repete o PATCH')
})

Deno.test('R4#5 continuação de conversa: "ok" rápido (R2 pendente) + "Quero entender" na janela → humano agora; anterior superada', async () => {
  const st = repoFake()
  const k1 = kommoFake({ texto: 'ok', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10] })
  const r1 = await receberWebhook(deps(st.repo, k1.fn), 1)
  assertEquals(r1.classificacao, 'indeterminado')
  const k2 = kommoFake({ texto: 'Quero entender', ins: [{ id: 'm1', ts: T0 - 5 }, { id: 'm2', ts: T0 - 1 }], outs: [T0 - 10] })
  const r2 = await receberWebhook(deps(st.repo, k2.fn, T0), 1)
  assertEquals(r2.classificacao, 'humano'); assertEquals(r2.estado, 'aplicado')
  // m1 ('ok', texto conhecido) não é superada por tabela: o cron a resolve (2ª msg → humano) e a
  // revalidação vê o lead já em RESPONDEU → superado, sem 2º PATCH
  assertEquals(st.linhas.find((l) => l.mensagem_id === 'm1')!.estado_efeito, 'pendente')
  await varrer(deps(st.repo, k2.fn, T0 + 200))
  assertEquals(st.linhas.find((l) => l.mensagem_id === 'm1')!.estado_efeito, 'superado')
  assertEquals(k2.escritas.filter((e) => e.body?.status_id === RESP).length, 1)
})

Deno.test('R4#5 continuação de BOT (menu + "transferido") não vira humano: a 2ª mensagem é decidida sozinha e casa R1', async () => {
  const st = repoFake()
  const k1 = kommoFake({ texto: 'Agradecemos sua mensagem. Escolha uma opção', ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 10] })
  await receberWebhook(deps(st.repo, k1.fn), 1)
  assertEquals(st.linhas[0].classificacao, 'autoresposta')
  const k2 = kommoFake({ texto: 'Seu atendimento está sendo transferido.', ins: [{ id: 'm1', ts: T0 - 5 }, { id: 'm2', ts: T0 + 2000 }], outs: [T0 - 10], tags: ['autoresposta'] })
  const r2 = await receberWebhook(deps(st.repo, k2.fn, T0 + 2001), 1)
  assertEquals(r2.classificacao, 'autoresposta'); assert(!k2.escritas.some((e) => e.body?.status_id), 'não pode mover')
})


// ── 5ª rodada ──────────────────────────────────────────────────────────────────────────────
Deno.test('R5 ultimoDisparoAte: mesmo resultado em ordem crescente, decrescente e permutada', () => {
  const ts = T0 - 5
  for (const outs of [[T0 - 1000, T0 - 10], [T0 - 10, T0 - 1000], [T0 - 10, T0 + 50, T0 - 1000], [T0 + 50, T0 - 1000, T0 - 10]]) assertEquals(ultimoDisparoAte(outs, ts), T0 - 10)
  assertEquals(ultimoDisparoAte([], ts), null); assertEquals(ultimoDisparoAte([T0 + 1], ts), null)
})

Deno.test('R5 varredura com eventos fora de ordem: conversa anterior ao último disparo não conta; R3 decide autoresposta sem mover', async () => {
  for (const ordem of ['asc', 'desc', 'perm'] as const) {
    const txt = 'Nossa equipe recebeu a sua solicitação e vai analisar o pedido com carinho hoje'
    // agora o mesmo cenário chegando pela VARREDURA como pendência R2 (sem hash prévio nos outros leads)
    const st2 = repoFake()
    await st2.repo.criarLinhas([{ kommo_lead_id: 1, mensagem_id: 'm1', pipeline_id: PIPE, status_id_origem: D1, recebido_em: new Date((T0 - 5) * 1000).toISOString(), classificacao: 'indeterminado', regras: ['R2:5s'], estado_efeito: 'pendente', modo: 'aplicar', texto: txt } as any,
      ...[2, 3].map((lead) => ({ kommo_lead_id: lead, mensagem_id: 'z' + lead, pipeline_id: PIPE, status_id_origem: D1, recebido_em: new Date((T0 - 100) * 1000).toISOString(), classificacao: 'autoresposta', regras: ['R1'], estado_efeito: 'aplicado', modo: 'aplicar', hash: null } as any))])
    // hash dos outros = hash do texto (a decisão calcula o sha1 do normalizado; os fakes guardam o que recebem)
    const { normalizar, sha1 } = await import('./triagem.ts')
    const h = await sha1(normalizar(txt)); for (const l of st2.linhas) if (l.kommo_lead_id !== 1) l.hash = h
    const outsAsc = [T0 - 1000, T0 - 10], outsDesc = [T0 - 10, T0 - 1000], outsPerm = [T0 - 10, T0 - 2000, T0 - 1000]
    const outs = ordem === 'asc' ? outsAsc : ordem === 'desc' ? outsDesc : outsPerm
    const k2 = kommoFake({ texto: txt, ins: ordem === 'desc' ? [{ id: 'm1', ts: T0 - 5 }, { id: 'old', ts: T0 - 900 }] : [{ id: 'old', ts: T0 - 900 }, { id: 'm1', ts: T0 - 5 }], outs })
    await varrer(deps(st2.repo, k2.fn, T0 + 200))
    const l = st2.linhas.find((x) => x.kommo_lead_id === 1)!
    assertEquals(l.classificacao, 'autoresposta', `ordem ${ordem}`)
    assertEquals(l.intervalo_s, 5, `ordem ${ordem}: intervalo deve ser do disparo T0-10`)
    assert(!k2.escritas.some((e) => e.body?.status_id), `ordem ${ordem}: não pode mover`)
  }
})


// ── webhook de conta (add_message): texto direto, sem campo; evento pode ainda não estar em /events
Deno.test('WH texto direto do webhook decide sem ler o campo; mensagem ainda ausente em /events é incluída', async () => {
  const st = repoFake()
  const k = kommoFake({ texto: '', ins: [], outs: [T0 - 1000] }) // /events sem a mensagem; campo vazio
  const r = await receberWebhook({ ...deps(st.repo, k.fn), campoTexto: '' }, 1, { id: 'wh1', ts: T0 - 5, texto: 'Oi, pode falar' })
  assertEquals(r.classificacao, 'humano'); assertEquals(r.estado, 'aplicado')
  assertEquals(st.linhas[0].mensagem_id, 'wh1'); assertEquals(st.linhas[0].texto, 'Oi, pode falar')
  assert(!k.escritas.some((e) => e.p.includes('custom_fields')))
})

Deno.test('WH áudio ([audio] vindo do parser) é humano forte; autoresposta do webhook marca tag e não move', async () => {
  const st = repoFake(); const k = kommoFake({ ins: [{ id: 'wh2', ts: T0 - 5 }], outs: [T0 - 10] })
  const r = await receberWebhook({ ...deps(st.repo, k.fn), campoTexto: '' }, 1, { id: 'wh2', ts: T0 - 5, texto: '[audio]' })
  assertEquals(r.classificacao, 'humano')
  const st2 = repoFake(); const k2 = kommoFake({ ins: [{ id: 'wh3', ts: T0 - 5 }], outs: [T0 - 10] })
  const r2 = await receberWebhook({ ...deps(st2.repo, k2.fn), campoTexto: '' }, 1, { id: 'wh3', ts: T0 - 5, texto: 'Agradecemos sua mensagem. Não estamos disponíveis.' })
  assertEquals(r2.classificacao, 'autoresposta'); assert(!k2.escritas.some((e) => e.body?.status_id))
})

Deno.test('WH sem campo configurado e sem texto: segue o caminho texto_vazio (pendente), sem lançar', async () => {
  const st = repoFake(); const k = kommoFake({ texto: '', ins: [{ id: 'wh4', ts: T0 - 900 }], outs: [T0 - 1000] })
  const r = await receberWebhook({ ...deps(st.repo, k.fn), campoTexto: '' }, 1, { id: 'wh4', ts: T0 - 900, texto: '' })
  assertEquals(r.classificacao, 'indeterminado'); assertEquals(st.linhas[0].regras, ['texto_vazio'])
})


// ── 5ª rodada: recepção × resolução × linhas existentes
Deno.test('R5#1 dois webhooks de autoresposta: cada trabalho decide a SUA mensagem; texto conhecido nunca é superado nem fica vazio', async () => {
  const st = repoFake()
  const txt1 = 'Agradecemos sua mensagem. Não estamos disponíveis.', txt2 = 'Mensagem automática: retornaremos em breve.'
  // /events já adiantado com m1 e m2 quando chega o trabalho de m1
  const k = kommoFake({ ins: [{ id: 'm1', ts: T0 - 8 }, { id: 'm2', ts: T0 - 3 }], outs: [T0 - 10], tags: [] })
  const d = { ...deps(st.repo, k.fn), campoTexto: '' }
  const r1 = await receberWebhook(d, 1, { id: 'm1', ts: T0 - 8, texto: txt1 })
  assertEquals(r1.classificacao, 'autoresposta')
  const l2a = st.linhas.find((l) => l.mensagem_id === 'm2')!
  assertEquals(l2a.estado_efeito, 'pendente', 'm2 sem texto ainda NÃO decidida nem removida')
  const r2 = await receberWebhook(d, 1, { id: 'm2', ts: T0 - 3, texto: txt2 })
  const l1 = st.linhas.find((l) => l.mensagem_id === 'm1')!, l2 = st.linhas.find((l) => l.mensagem_id === 'm2')!
  assertEquals(l1.texto, txt1); assertEquals(l2.texto, txt2, 'texto do 2º webhook preenche a linha criada antes')
  assertEquals(r2.classificacao, 'autoresposta'); assertEquals(l1.estado_efeito, 'aplicado')
})

Deno.test('R5#1 trabalhos fora de ordem (m2 chega antes de m1): m1 ainda é decidida pelo próprio texto', async () => {
  const st = repoFake(); const k = kommoFake({ ins: [{ id: 'm1', ts: T0 - 8 }, { id: 'm2', ts: T0 - 3 }], outs: [T0 - 1000] })
  const d = { ...deps(st.repo, k.fn), campoTexto: '' }
  await receberWebhook(d, 1, { id: 'm2', ts: T0 - 3, texto: 'Oi, pode falar' }) // humano: move o lead
  const r1 = await receberWebhook(d, 1, { id: 'm1', ts: T0 - 8, texto: 'Mensagem automática: fora do horário' })
  assertEquals(r1.classificacao, 'autoresposta'); assertEquals(r1.estado, 'superado') // decidida pelo próprio texto; efeito superado (lead já saiu)
  assertEquals(st.linhas.find((l) => l.mensagem_id === 'm1')!.texto, 'Mensagem automática: fora do horário')
  assertEquals(k.escritas.filter((e) => e.body?.status_id === RESP).length, 1)
})

Deno.test('R5#1 linha só de /events sem texto nunca vira humano: após as tentativas fica superada', async () => {
  const st = repoFake(); const k = kommoFake({ texto: '', ins: [{ id: 'ev1', ts: T0 - 900 }], outs: [T0 - 1000] })
  const d = { ...deps(st.repo, k.fn), campoTexto: '' }
  await receberWebhook(d, 1, null) // caminho legado (sem mensagem): cria linha de /events sem texto
  for (let i = 0; i < 6; i++) await varrer(d)
  assertEquals(st.linhas[0].estado_efeito, 'superado'); assertEquals(k.escritas.length, 0)
})

Deno.test('R5#2 mensagem no CONTATO: trabalho durável antes de qualquer GET; falha de leitura → pendente, não perde', async () => {
  const st = repoFake(); const k = kommoFake({ falhar: { contato: 503 } })
  await assertRejects(() => receberWebhook({ ...deps(st.repo, k.fn), campoTexto: '' }, null, { id: 'c1', ts: T0 - 5, texto: 'Oi' }, 777), LeituraFalhou)
  assertEquals(st.trabalhos[0].estado, 'pendente'); assertEquals(st.trabalhos[0].contact_id, 777); assertEquals(st.trabalhos[0].kommo_lead_id, null)
})

Deno.test('R5#2 reentrega do mesmo webhook (mesmo message id) não duplica trabalho', async () => {
  const st = repoFake(); const k = kommoFake({ ins: [{ id: 'm1', ts: T0 - 5 }], outs: [T0 - 1000] })
  const d = { ...deps(st.repo, k.fn), campoTexto: '' }
  await receberWebhook(d, 1, { id: 'm1', ts: T0 - 5, texto: 'Oi, pode falar' })
  await receberWebhook(d, 1, { id: 'm1', ts: T0 - 5, texto: 'Oi, pode falar' })
  assertEquals(st.trabalhos.length, 1); assertEquals(st.linhas.length, 1)
})

Deno.test('R5#3 leadPeloContato: lê TODOS os leads; candidato só em etapa de origem; leitura falha = LeituraFalhou; 2 candidatos = ambíguo', async () => {
  const st = repoFake()
  const leads: Record<number, { pipeline_id: number; status_id: number }> = {}
  for (let i = 1; i <= 11; i++) leads[i] = { pipeline_id: 999, status_id: 1 }
  leads[1] = { pipeline_id: PIPE, status_id: D1 }; leads[11] = { pipeline_id: PIPE, status_id: D2 }
  const k: KommoFn = async (m, p) => {
    if (p.startsWith('/api/v4/contacts/')) return { ok: true, status: 200, body: { id: 5, _embedded: { leads: Object.keys(leads).map((id) => ({ id: Number(id) })) } } }
    const id = Number(p.split('/').pop()); return { ok: true, status: 200, body: { id, ...leads[id] } }
  }
  const d = { ...deps(st.repo, k), campoTexto: '' }
  const { leadPeloContato } = await import('./motor.ts')
  assertEquals((await leadPeloContato(d, 5)).leadId, null) // 1 e 11 elegíveis → ambíguo (o 11º também é lido)
  leads[11] = { pipeline_id: PIPE, status_id: RESP } // fora das etapas de origem
  assertEquals((await leadPeloContato(d, 5)).leadId, 1)
  const kFalha: KommoFn = async (m, p) => { if (p.startsWith('/api/v4/contacts/')) return k(m, p); if (p.endsWith('/11')) return { ok: false, status: 503, body: null }; return k(m, p) }
  await assertRejects(() => leadPeloContato({ ...d, kommo: kFalha }, 5), LeituraFalhou)
})

Deno.test('R5#4 evento de /events sem id de mensagem no mesmo instante do webhook é a MESMA mensagem (não cria 2ª linha)', async () => {
  const st = repoFake()
  const k: KommoFn = async (m, p, b, o) => {
    if (/\/api\/v4\/leads\/\d+$/.test(p)) return { ok: true, status: 200, body: { id: 1, pipeline_id: PIPE, status_id: D1, custom_fields_values: [], _embedded: { tags: [] } } }
    if (p.includes('incoming_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [{ id: 'evento-alias', created_at: T0 - 5, value_after: [{}] }] } } }
    if (p.includes('outgoing_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [{ id: 'o', created_at: T0 - 10 }] } } }
    return { ok: true, status: 200, body: {} }
  }
  const r = await receberWebhook({ ...deps(st.repo, k), campoTexto: '' }, 1, { id: 'wh-uuid', ts: T0 - 5, texto: 'Agradecemos sua mensagem' })
  assertEquals(r.classificacao, 'autoresposta'); assertEquals(st.linhas.length, 1); assertEquals(st.linhas[0].mensagem_id, 'wh-uuid')
})


Deno.test('R6 correlacionar: ids conhecidos distintos nunca se fundem por horário; evento sem id só com âncora única <=2 s; webhook sempre presente', () => {
  // webhook m2 a 1 s do evento m1 (id conhecido): são DUAS mensagens
  assertEquals(correlacionar([{ id: 'm1', ts: 100 }], [], { id: 'm2', ts: 101 }).map((r) => r.id).sort(), ['m1', 'm2'])
  // evento sem id: uma âncora <=2 s → alias da âncora; duas âncoras <=2 s → ambíguo, ignorado; nenhuma → ignorado
  assertEquals(correlacionar([{ id: '', ts: 100 }], [{ id: 'a', ts: 101 }], null), [{ id: 'a', ts: 101 }])
  assertEquals(correlacionar([{ id: '', ts: 100 }], [{ id: 'a', ts: 101 }, { id: 'b', ts: 99 }], null), [{ id: 'b', ts: 99 }, { id: 'a', ts: 101 }]) // ambíguo: só as âncoras, evento ignorado
  assertEquals(correlacionar([{ id: '', ts: 100 }], [], null), [])
  // união: âncora persistida entra mesmo sem aparecer em /events
  assertEquals(correlacionar([{ id: 'e1', ts: 50 }], [{ id: 'a', ts: 101 }], { id: 'w', ts: 102 }).map((r) => r.id), ['e1', 'a', 'w'])
  // webhook sem nenhum evento ainda → mesmo assim está no resultado
  assertEquals(correlacionar([], [], { id: 'w', ts: 5 }), [{ id: 'w', ts: 5 }])
})

Deno.test('R6#2 webhook m2 com /events trazendo só m1 um segundo antes: m2 ganha a própria linha e é decidida (não falha em repo.linha)', async () => {
  const st = repoFake(); const k = kommoFake({ texto: '', ins: [{ id: 'm1', ts: T0 - 6 }], outs: [T0 - 1000] })
  const r = await receberWebhook({ ...deps(st.repo, k.fn), campoTexto: '' }, 1, { id: 'm2', ts: T0 - 5, texto: 'Oi, pode falar sim' })
  assertEquals(r.classificacao, 'humano'); assertEquals(r.estado, 'aplicado')
  assertEquals(st.linhas.map((l) => l.mensagem_id).sort(), ['m1', 'm2'])
  assertEquals(st.linhas.find((l) => l.mensagem_id === 'm2')!.texto, 'Oi, pode falar sim')
})

Deno.test('R6#2 evento atrasado sem id (alias) de uma mensagem já registrada não cria linha nem conta como 2ª mensagem', async () => {
  const st = repoFake()
  let fase = 1
  const k: KommoFn = async (m, p, b, o) => {
    if (/\/api\/v4\/leads\/\d+$/.test(p)) return { ok: true, status: 200, body: { id: 1, pipeline_id: PIPE, status_id: D1, custom_fields_values: [], _embedded: { tags: [] } } }
    if (p.includes('incoming_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: fase === 1 ? [] : [{ id: 'ev-sem-id', created_at: T0 - 5, value_after: [{}] }] } } }
    if (p.includes('outgoing_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [{ id: 'o', created_at: T0 - 10 }] } } }
    return { ok: true, status: 200, body: {} }
  }
  const d = { ...deps(st.repo, k), campoTexto: '' }
  const r = await receberWebhook(d, 1, { id: 'w1', ts: T0 - 5, texto: 'ok' })   // R2: rápida e curta → indeterminado
  assertEquals(r.classificacao, 'indeterminado'); fase = 2
  await varrer({ ...d, agora: () => T0 + 400 })                                  // evento atrasado só agora, sem id
  assertEquals(st.linhas.length, 1); assertEquals(st.linhas[0].classificacao, 'humano') // 1 linha; humano por espera vencida, não por "2ª msg"
})

Deno.test('R6#3 varredura: alias do próprio evento não bloqueia R3 (mesmo texto longo em 2 outros leads → autoresposta, sem PATCH)', async () => {
  const st = repoFake()
  const texto = 'Olá! Recebemos sua mensagem e em breve um de nossos consultores entrará em contato com você'
  const escritas: any[] = []
  const k: KommoFn = async (m, p, b, o) => {
    const mLead = p.match(/\/leads\/(\d+)$/); const mEnt = p.match(/filter\[entity_id\]\[0\]=(\d+)/)
    const lead = Number(mLead?.[1] ?? mEnt?.[1] ?? 1)
    if (m !== 'GET') escritas.push({ m, p, b })
    if (/\/api\/v4\/leads\/\d+$/.test(p)) return { ok: true, status: 200, body: { id: lead, pipeline_id: PIPE, status_id: D1, custom_fields_values: [], _embedded: { tags: [] } } }
    if (p.includes('incoming_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [{ id: `ev-${lead}`, created_at: T0 - 5, value_after: [{}] }] } } }
    if (p.includes('outgoing_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [{ id: 'o', created_at: T0 - 10 }] } } }
    return { ok: true, status: 200, body: {} }
  }
  const d = { ...deps(st.repo, k), campoTexto: '' }
  const r1 = await receberWebhook(d, 1, { id: 'w1', ts: T0 - 5, texto })        // sozinha: R2 pendente (rápida)
  assertEquals(r1.classificacao, 'indeterminado')
  await receberWebhook(d, 2, { id: 'w2', ts: T0 - 5, texto }); await receberWebhook(d, 3, { id: 'w3', ts: T0 - 5, texto })
  await varrer({ ...d, agora: () => T0 + 400 })
  const l1 = st.linhas.find((l) => l.kommo_lead_id === 1)!
  assertEquals(l1.classificacao, 'autoresposta')
  assertEquals(escritas.filter((e) => e.b?.status_id === RESP).length, 0)
})


Deno.test('R7 dois webhooks do mesmo lead ("ok", depois "sim") com /events ainda VAZIO: a 2ª já é conhecida → humano, 1 PATCH', async () => {
  const st = repoFake(); const k = kommoFake({ texto: '', ins: [], outs: [T0 - 10] })
  const d = { ...deps(st.repo, k.fn), campoTexto: '' }
  const r1 = await receberWebhook(d, 1, { id: 'w1', ts: T0 - 5, texto: 'ok' })
  assertEquals(r1.classificacao, 'indeterminado')                                  // R2: rápida, curta, sozinha
  const r2 = await receberWebhook(d, 1, { id: 'w2', ts: T0 - 3, texto: 'sim' })
  assertEquals(r2.classificacao, 'humano'); assertEquals(r2.estado, 'aplicado')     // 2ª mensagem desde o disparo: conversa
  assertEquals(k.escritas.filter((e) => e.body?.status_id === RESP).length, 1)
  assertEquals(st.linhas.length, 2)
})

Deno.test('R7 evidência R3 (texto longo em 2 outros leads) NÃO vence conversa já comprovada do próprio lead (outra mensagem persistida, /events atrasado) → humano', async () => {
  const st = repoFake()
  const texto = 'Olá! Recebemos sua mensagem e em breve um de nossos consultores entrará em contato com você'
  const escritas: any[] = []
  const k: KommoFn = async (m, p, b, o) => {
    const mLead = p.match(/\/leads\/(\d+)$/); const mEnt = p.match(/filter\[entity_id\]\[0\]=(\d+)/)
    const lead = Number(mLead?.[1] ?? mEnt?.[1] ?? 1)
    if (m !== 'GET') escritas.push({ m, p, b, lead })
    if (/\/api\/v4\/leads\/\d+$/.test(p)) return { ok: true, status: 200, body: { id: lead, pipeline_id: PIPE, status_id: D1, custom_fields_values: [], _embedded: { tags: [] } } }
    if (p.includes('incoming_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [] } } }   // /events atrasado para todos
    if (p.includes('outgoing_chat_message')) return { ok: true, status: 200, body: { _embedded: { events: [{ id: 'o', created_at: T0 - 10 }] } } }
    return { ok: true, status: 200, body: {} }
  }
  const d = { ...deps(st.repo, k), campoTexto: '' }
  await receberWebhook(d, 2, { id: 'w2', ts: T0 - 5, texto }); await receberWebhook(d, 3, { id: 'w3', ts: T0 - 5, texto })
  const a = await receberWebhook(d, 1, { id: 'w1a', ts: T0 - 6, texto: 'Oi' })      // lead 1 já conversou (curta/rápida → pendente)
  assertEquals(a.classificacao, 'indeterminado')
  const b = await receberWebhook(d, 1, { id: 'w1b', ts: T0 - 4, texto })           // mesmo texto longo dos outros 2 leads
  assertEquals(b.classificacao, 'humano'); assertEquals(b.estado, 'aplicado')
  assertEquals(escritas.filter((e) => e.b?.status_id === RESP && e.lead === 1).length, 1)
})
