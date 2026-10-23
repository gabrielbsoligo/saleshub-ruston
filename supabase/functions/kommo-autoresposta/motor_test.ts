// deno test --allow-read supabase/functions/kommo-autoresposta/motor_test.ts
// Fluxo completo (webhook → decisão → efeito → varredura) com repositório e Kommo FALSOS, sem rede.
import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { LeituraFalhou, Throttled, aplicarEfeito, processarTrabalho, receberWebhook, varrer, type Deps, type KommoFn, type Linha, type Repo, type Trabalho } from './motor.ts'
import type { Cfg, Padrao } from './triagem.ts'

const PIPE = 14062116, RESP = 108545256, D1 = 108545280, D2 = 108545284
const cfgBase: Cfg = { pipeline_id: PIPE, status_respondeu: RESP, ativo: true, modo: 'aplicar', janela_rapida_s: 60, repeticao_min: 3, espera_s: 180, r3_min_palavras: 6, etapas_origem: [D1, D2] }
const PADROES: Padrao[] = [
  { id: 1, padrao: '^\\[(audio|midia)\\]$', tipo: 'humano' },
  { id: 3, padrao: 'agradec\\w* (sua mensagem|seu contato)', tipo: 'autoresposta' },
  { id: 7, padrao: 'mensagem automatica', tipo: 'autoresposta' },
]

// ── repositório em memória
type LinhaFake = Linha & { lease_ate: number | null; extra: Record<string, unknown> }
type TrabalhoFake = Trabalho & { estado: string; erro: string | null }
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
      async criarTrabalho(leadId: number) { const t = { id: seq++, kommo_lead_id: leadId, tentativas: 0, estado: 'pendente', erro: null }; trabalhos.push(t); return t },
      async concluirTrabalho(id: number, estado: string, erro: string | null = null) { const t = trabalhos.find((x) => x.id === id)!; t.estado = estado; t.erro = erro; if (estado === 'pendente') t.tentativas++ },
      async trabalhosPendentes(n: number) { return trabalhos.filter((t) => t.estado === 'pendente').slice(0, n) },
      async linhasDoLead(leadId: number) { return linhas.filter((l) => l.kommo_lead_id === leadId) },
      async criarLinhas(novas: Partial<Linha>[]) { for (const n of novas) if (!linhas.some((l) => l.kommo_lead_id === n.kommo_lead_id && l.mensagem_id === n.mensagem_id)) linhas.push(Object.assign({ id: seq++, texto: null, hash: null, decidido_em: null, claim_token: null, efeito_fase: null, tentativas: 0, lease_ate: null, extra: {} }, n) as LinhaFake) },
      async linha(leadId: number, m: string) { return linhas.find((l) => l.kommo_lead_id === leadId && l.mensagem_id === m)! },
      async decidir(id: number, dec: any) { const l = linhas.find((x) => x.id === id)!; if (l.estado_efeito !== 'pendente' || (l.lease_ate && l.lease_ate > Date.now())) return null; Object.assign(l, dec); return l },
      async outrosLeadsComHash(hash: string, leadId: number) { return new Set(linhas.filter((l) => l.hash === hash && l.kommo_lead_id !== leadId).map((l) => l.kommo_lead_id)).size },
      async superar(leadId: number, exceto: number | null, antesDe: string | null, motivo: string) { for (const l of linhas) if (l.kommo_lead_id === leadId && l.id !== exceto && ['pendente', 'falhou'].includes(l.estado_efeito) && (!antesDe || l.recebido_em < antesDe)) { l.estado_efeito = 'superado'; l.extra.motivo_efeito = motivo } },
      async claim(id: number, leaseS: number) { const l = linhas.find((x) => x.id === id)!; const livre = ['pendente', 'falhou'].includes(l.estado_efeito) || (l.estado_efeito === 'em_andamento' && (l.lease_ate ?? 0) < Date.now()); if (!livre) return null; l.estado_efeito = 'em_andamento'; l.lease_ate = Date.now() + leaseS * 1000; l.claim_token = crypto.randomUUID(); return l.claim_token },
      async renovar(id: number, token: string, leaseS: number) { const l = linhas.find((x) => x.id === id)!; if (l.claim_token !== token || l.estado_efeito !== 'em_andamento' || (l.lease_ate ?? 0) < Date.now()) return false; l.lease_ate = Date.now() + leaseS * 1000; return true },
      async fase(id: number, token: string, fase: string) { const l = linhas.find((x) => x.id === id)!; if (l.claim_token !== token) return false; l.efeito_fase = fase; return true },
      async fim(id: number, token: string, estado: Linha['estado_efeito'], extra: Record<string, unknown>) { const l = linhas.find((x) => x.id === id)!; if (l.claim_token !== token) return false; l.estado_efeito = estado; l.lease_ate = null; Object.assign(l.extra, extra); if ('efeito_fase' in extra) l.efeito_fase = String(extra.efeito_fase); return true },
      async acerto() {},
      async pendentesEfeito(n: number) { return linhas.filter((l) => (l.classificacao === 'indeterminado' && l.estado_efeito === 'pendente') || ['pendente', 'falhou'].includes(l.estado_efeito) || (l.estado_efeito === 'em_andamento' && (l.lease_ate ?? 0) < Date.now())).slice(0, n) },
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

Deno.test('#2 duas mensagens novas: ambas ganham linha; a anterior fica superada (texto indisponível); só a última decide', async () => {
  const st = repoFake(); const k = kommoFake({ texto: 'pode mandar a proposta', ins: [{ id: 'a', ts: T0 - 8 }, { id: 'b', ts: T0 - 3 }], outs: [T0 - 1000] })
  const r = await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(st.linhas.length, 2)
  assertEquals(st.linhas.find((l) => l.mensagem_id === 'a')!.estado_efeito, 'superado')
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
  const tokA = await st2.repo.claim(lx.id, 300); lx.lease_ate = Date.now() - 1 // expira
  const tokB = await st2.repo.claim(lx.id, 300)
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

Deno.test('texto vazio: pendente até 5 tentativas, depois mídia = humano', async () => {
  const st = repoFake(); const k = kommoFake({ texto: '', ins: [{ id: 'm1', ts: T0 - 900 }], outs: [T0 - 1000] })
  await receberWebhook(deps(st.repo, k.fn), 1)
  assertEquals(st.linhas[0].regras, ['texto_vazio'])
  for (let i = 0; i < 5; i++) await varrer(deps(st.repo, k.fn))
  assertEquals(st.linhas[0].classificacao, 'humano'); assertEquals(st.linhas[0].texto, '[midia]')
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
