// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/jwt.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verificarJwtKommo } from '../../../supabase/functions/_shared/kommo_jwt.ts'

const SECRET = 'segredo-de-teste'
const E = { secret: SECRET, contaId: '123', host: 'financeirorustonengenhariacombr.kommo.com', clientId: 'uuid-integ' }
const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
function assinar(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }, segredo = SECRET) {
  const h = b64(header), p = b64(payload)
  const s = createHmac('sha256', segredo).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${s}`
}
const agora = 1_800_000_000
const base = { iss: 'https://financeirorustonengenhariacombr.kommo.com', account_id: 123, user_id: 11420911, client_uuid: 'uuid-integ', iat: agora - 5, nbf: agora - 5, exp: agora + 300 }

test('token válido devolve o user_id', async () => {
  const r = await verificarJwtKommo(assinar(base), E, agora)
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.userId, 11420911)
})

test('negativos: assinatura, alg, expiração, conta, emissor, integração, usuário', async () => {
  const casos: [string, string][] = [
    [assinar(base, undefined, 'outro-segredo'), 'jwt_assinatura'],
    [assinar(base, { alg: 'none' }), 'jwt_alg'],
    [assinar(base, { alg: 'HS512' }), 'jwt_alg'],
    [assinar({ ...base, exp: agora - 120 }), 'jwt_expirado'],
    [assinar({ ...base, exp: undefined }), 'jwt_expirado'],
    [assinar({ ...base, nbf: agora + 600 }), 'jwt_nbf'],
    [assinar({ ...base, iat: undefined }), 'jwt_iat'],
    [assinar({ ...base, account_id: 999 }), 'jwt_conta'],
    [assinar({ ...base, iss: 'https://outraconta.kommo.com' }), 'jwt_emissor'],
    [assinar({ ...base, client_uuid: undefined }), 'jwt_integracao'],
    [assinar({ ...base, client_uuid: 'outra' }), 'jwt_integracao'],
    [assinar({ ...base, user_id: 'x' }), 'jwt_usuario'],
    ['abc.def', 'jwt_formato'],
    ['', 'jwt_formato'],
  ]
  for (const [tok, erro] of casos) {
    const r = await verificarJwtKommo(tok, E, agora)
    assert.equal(r.ok, false, erro)
    if (!r.ok) assert.equal(r.erro, erro)
  }
})

test('payload adulterado com assinatura antiga é rejeitado', async () => {
  const [h, , s] = assinar(base).split('.')
  const falso = `${h}.${b64({ ...base, user_id: 1 })}.${s}`
  const r = await verificarJwtKommo(falso, E, agora)
  assert.equal(r.ok, false)
})

test('emissor: aceita sem esquema, amoCRM do mesmo subdomínio; recusa outra conta/domínio e diz o host recebido', async () => {
  for (const iss of ['financeirorustonengenhariacombr.kommo.com', 'https://financeirorustonengenhariacombr.kommo.com/', 'https://FinanceiroRustonEngenhariaComBr.kommo.com', 'https://financeirorustonengenhariacombr.amocrm.com']) {
    const r = await verificarJwtKommo(assinar({ ...base, iss, subdomain: 'financeirorustonengenhariacombr' }), E, agora)
    assert.equal(r.ok, true, iss)
  }
  const casos: [unknown, string][] = [
    ['https://outraconta.kommo.com', 'outraconta.kommo.com'],
    ['https://financeirorustonengenhariacombr.kommo.com.evil.io', 'financeirorustonengenhariacombr.kommo.com.evil.io'],
    ['https://financeirorustonengenhariacombr.evil.io', 'financeirorustonengenhariacombr.evil.io'],
    [undefined, ''],
  ]
  for (const [iss, det] of casos) {
    const r = await verificarJwtKommo(assinar({ ...base, iss }), E, agora) as any
    assert.equal(r.erro, 'jwt_emissor', String(iss)); assert.equal(r.detalhe, det)
  }
  const sub = await verificarJwtKommo(assinar({ ...base, iss: 'https://financeirorustonengenhariacombr.amocrm.com', subdomain: 'outra' }), E, agora) as any
  assert.equal(sub.erro, 'jwt_emissor')                                     // claim subdomain incoerente
})

test('claim subdomain incoerente é recusado em QUALQUER host (exato com e sem esquema, e amoCRM)', async () => {
  for (const iss of ['https://financeirorustonengenhariacombr.kommo.com', 'financeirorustonengenhariacombr.kommo.com', 'https://financeirorustonengenhariacombr.amocrm.com']) {
    const r = await verificarJwtKommo(assinar({ ...base, iss, subdomain: 'outra' }), E, agora) as any
    assert.equal(r.erro, 'jwt_emissor', iss)
  }
  const sem = await verificarJwtKommo(assinar({ ...base, iss: 'https://financeirorustonengenhariacombr.kommo.com' }), E, agora)
  assert.equal(sem.ok, true)                                                // sem o claim: vale o host
})
