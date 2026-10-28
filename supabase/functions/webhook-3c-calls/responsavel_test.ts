import { assertEquals } from 'jsr:@std/assert@1'
import { patchFollow, resolverResponsavel } from './responsavel.ts'

const base = { pipeline_id: 14062096, status_id: 108545100 }
const fake = (resp: { data?: any; error?: any } | 'throw', capt: any[] = []) => ({
  rpc: (fn: string, args: Record<string, unknown>) => {
    capt.push({ fn, args })
    if (resp === 'throw') return Promise.reject(new Error('rede'))
    return Promise.resolve({ data: resp.data ?? null, error: resp.error ?? null })
  },
})
const ch = { _id: 'abc', agent: { id: 999001, name: 'Arielle' } }

Deno.test('cadastrado: troca o responsável pelo kommo_user_id do cadastro', async () => {
  const capt: any[] = []
  const r = await resolverResponsavel(fake({ data: { ok: true, member_id: 'm1', membro: 'Edric', kommo_user_id: 15444836 } }, capt), ch, 24372899, false)
  assertEquals(r.kommo_user_id, 15444836)
  assertEquals(patchFollow(base, r), { ...base, responsible_user_id: 15444836 })
  assertEquals(capt[0].fn, 'ligacoes_resolver_agente_3c')
  assertEquals(capt[0].args, { p_agent_id: '999001', p_agent_nome: 'Arielle', p_lead: 24372899, p_call: 'abc', p_registrar: true })
})

Deno.test('agente sem cadastro (caso HESA 95): move SEM trocar o responsável', async () => {
  const r = await resolverResponsavel(fake({ data: { ok: false, motivo: 'agente_sem_cadastro' } }), ch, 24372899, false)
  assertEquals(r.ok, false)
  assertEquals(r.motivo, 'agente_sem_cadastro')
  assertEquals(patchFollow(base, r), base)
  assertEquals('responsible_user_id' in patchFollow(base, r), false)
})

Deno.test('duplicado e membro sem usuário Kommo: não troca', async () => {
  for (const motivo of ['agente_duplicado', 'membro_sem_kommo']) {
    const r = await resolverResponsavel(fake({ data: { ok: false, motivo, member_id: 'm1' } }), ch, 1, false)
    assertEquals(patchFollow(base, r), base)
  }
})

Deno.test('kommo_user_id vindo com ok=false nunca é usado', async () => {
  const r = await resolverResponsavel(fake({ data: { ok: false, motivo: 'membro_sem_kommo', kommo_user_id: 123 } }), ch, 1, false)
  assertEquals(patchFollow(base, r), base)
})

Deno.test('erro ou exceção da RPC: não lança e não troca', async () => {
  for (const resp of [{ error: { message: 'boom' } }, 'throw' as const]) {
    const r = await resolverResponsavel(fake(resp), ch, 1, false)
    assertEquals(r.motivo, 'erro_resolucao')
    assertEquals(patchFollow(base, r), base)
  }
})

Deno.test('dry: consulta sem registrar pendência; agente ausente vai vazio', async () => {
  const capt: any[] = []
  await resolverResponsavel(fake({ data: { ok: false, motivo: 'sem_agente' } }, capt), { _id: 'x' }, null, true)
  assertEquals(capt[0].args.p_registrar, false)
  assertEquals(capt[0].args.p_agent_id, '')
})
