// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/voz.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  decidirEntidade, finalTelefone, ha1, interpretar4com, md5, motivoAutorizacao, tarefaPropriaValida, telefoneE164, telefonesDosContatos, usuarioLiberado,
} from '../../../supabase/functions/_shared/prevendas_voz.ts'

test('md5 próprio = md5 do Node (vazio, ASCII, UTF-8, blocos de 55/56/64/120 bytes)', () => {
  for (const s of ['', 'a', 'abc', 'message digest', 'ação ☎', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(120)]) {
    assert.equal(md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), JSON.stringify(s).slice(0, 20))
  }
})

test('HA1 do digest SIP = MD5(ramal:realm:senha) — vetor da RFC 2617', () => {
  assert.equal(ha1('Mufasa', 'testrealm@host.com', 'Circle Of Life'), '939e7578ed9e3c518a452acee763bce9')
})

test('telefoneE164: normaliza BR e rejeita lixo', () => {
  assert.equal(telefoneE164('47997293673'), '+5547997293673')
  assert.equal(telefoneE164('+55 (47) 99729-3673'), '+5547997293673')
  assert.equal(telefoneE164('005547997293673'), '+5547997293673')
  assert.equal(telefoneE164('(11) 3333-4444'), '+551133334444')
  assert.equal(telefoneE164('011 3333-4444'), '+551133334444')
  assert.equal(telefoneE164('0000000000'), null)          // DDD 00
  assert.equal(telefoneE164('2097293673'), null)          // DDD 20
  assert.equal(telefoneE164('4787293673'), '+5547987293673')   // celular no formato antigo (8 dígitos): ganha o 9
  assert.equal(telefoneE164('+55 44 9911-8581'), '+5544999118581')   // o caso do T1 ("Tel. comercial" da Marcia)
  assert.equal(telefoneE164('4717293673'), null)          // 8 dígitos começando com 1: nem fixo nem celular
  assert.equal(telefoneE164('47897293673'), null)         // 11 dígitos sem o 9
  assert.equal(telefoneE164('999999'), null)
  assert.equal(telefoneE164(null), null)
  assert.equal(finalTelefone('+5547997293673'), '***3673')
})

test('telefonesDosContatos: só o campo PHONE, sem repetir, ignora inválidos', () => {
  const r = telefonesDosContatos([
    { id: 1, name: 'Ana', custom_fields_values: [
      { field_code: 'PHONE', values: [{ value: '47 99729-3673' }, { value: '+55 47 99729 3673' }, { value: 'abc' }] },
      { field_code: 'EMAIL', values: [{ value: '4799729367' }] } ] },
    { id: 2, name: null, custom_fields_values: null },
  ])
  assert.deepEqual(r, [
    { contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: '47 99729-3673' }], invalidos: 1 },
    { contato_id: 2, nome: '', telefones: [], invalidos: 0 },
  ])
})

test('autorização: gestor, dono ou tarefa própria; papel sozinho não basta', () => {
  assert.equal(motivoAutorizacao({ papel: 'gestor', uid: 1, donoEntidade: 9, temTarefaPropria: false }), 'gestor')
  assert.equal(motivoAutorizacao({ papel: 'sdr', uid: 1, donoEntidade: 1, temTarefaPropria: false }), 'dono')
  assert.equal(motivoAutorizacao({ papel: 'closer', uid: 1, donoEntidade: 9, temTarefaPropria: true }), 'tarefa')
  assert.equal(motivoAutorizacao({ papel: 'closer', uid: 1, donoEntidade: 9, temTarefaPropria: false }), null)
  assert.equal(motivoAutorizacao({ papel: null, uid: 1, donoEntidade: null, temTarefaPropria: false }), null)
})

test('lista de usuários do servidor é fail-closed', () => {
  assert.equal(usuarioLiberado('', 11420911), false)
  assert.equal(usuarioLiberado(undefined, 11420911), false)
  assert.equal(usuarioLiberado(' 11420911 , 2', 11420911), true)
  assert.equal(usuarioLiberado('114209110', 11420911), false)
})

test('interpretar4com: sucesso, credencial, limite, indisponível (incerto) e recusa', () => {
  assert.deepEqual(interpretar4com(200, { status: '200', id: 'abc', message: 'successful request' }), { ok: true, chamada_id: 'abc' })
  assert.equal((interpretar4com(401, {}) as any).erro, 'provedor_auth')
  assert.equal((interpretar4com(429, {}) as any).erro, 'provedor_limite')
  const ind = interpretar4com(0, null) as any; assert.equal(ind.erro, 'provedor_indisponivel'); assert.equal(ind.incerto, true)
  const rec = interpretar4com(422, { error: { message: 'Ramal  offline' } }) as any
  assert.equal(rec.erro, 'provedor_recusou'); assert.equal(rec.mensagem, 'Ramal offline')
})

test('tarefaPropriaValida confere tarefa a tarefa (não confia no filtro da API)', () => {
  const ok = { responsible_user_id: 7, is_completed: false, entity_type: 'leads', entity_id: 50 }
  assert.equal(tarefaPropriaValida([ok], 7, 'leads', 50), true)
  assert.equal(tarefaPropriaValida([{ ...ok, responsible_user_id: 8 }], 7, 'leads', 50), false)     // alheia
  assert.equal(tarefaPropriaValida([{ ...ok, is_completed: true }], 7, 'leads', 50), false)        // concluída
  assert.equal(tarefaPropriaValida([{ ...ok, entity_id: 51 }], 7, 'leads', 50), false)             // outra entidade
  assert.equal(tarefaPropriaValida([{ ...ok, entity_type: 'contacts' }], 7, 'leads', 50), false)   // outro tipo
  assert.equal(tarefaPropriaValida([{ ...ok, is_completed: undefined }], 7, 'leads', 50), false)   // envelope incompleto
  assert.equal(tarefaPropriaValida({ tasks: [ok] }, 7, 'leads', 50), false)                         // envelope inesperado
})

test('decidirEntidade: id confere, autorização e só contatos VINCULADOS', () => {
  const tel = (v: string) => [{ field_code: 'PHONE', values: [{ value: v }] }]
  const lead = { id: 50, responsible_user_id: 9, _embedded: { contacts: [{ id: 1 }] } }
  const contatos = [{ id: 1, name: 'Ana', custom_fields_values: tel('47997293673') }, { id: 2, name: 'Intruso', custom_fields_values: tel('11999998888') }]
  const tarefa = [{ responsible_user_id: 7, is_completed: false, entity_type: 'leads', entity_id: 50 }]
  const d = decidirEntidade({ uid: 7, papel: 'sdr', etype: 'leads', eid: 50, entidade: lead, tarefas: tarefa, contatosDevolvidos: contatos }) as any
  assert.equal(d.ok, true); assert.equal(d.motivo, 'tarefa')
  assert.deepEqual(d.contatos.map((c: any) => c.contato_id), [1])                                   // o contato 2 não é do lead
  assert.deepEqual(decidirEntidade({ uid: 7, papel: 'sdr', etype: 'leads', eid: 50, entidade: lead, tarefas: [{ ...tarefa[0], responsible_user_id: 8 }], contatosDevolvidos: contatos }), { ok: false, erro: 'sem_permissao' })
  assert.deepEqual(decidirEntidade({ uid: 7, papel: 'sdr', etype: 'leads', eid: 50, entidade: { ...lead, id: 51 }, tarefas: tarefa, contatosDevolvidos: contatos }), { ok: false, erro: 'entidade_inconsistente' })
  assert.deepEqual(decidirEntidade({ uid: 7, papel: 'gestor', etype: 'leads', eid: 50, entidade: null, tarefas: [], contatosDevolvidos: [] }), { ok: false, erro: 'entidade_inconsistente' })
  const semEmbedded = decidirEntidade({ uid: 9, papel: 'sdr', etype: 'leads', eid: 50, entidade: { id: 50, responsible_user_id: 9 }, tarefas: [], contatosDevolvidos: contatos }) as any
  assert.equal(semEmbedded.ok, true); assert.deepEqual(semEmbedded.contatos, [])                     // sem vínculo = sem telefone
  const contato = decidirEntidade({ uid: 9, papel: 'sdr', etype: 'contacts', eid: 1, entidade: { id: 1, responsible_user_id: 9, custom_fields_values: tel('47997293673') }, tarefas: [], contatosDevolvidos: [] }) as any
  assert.equal(contato.ok, true); assert.equal(contato.contatos[0].telefones[0].e164, '+5547997293673')
})
