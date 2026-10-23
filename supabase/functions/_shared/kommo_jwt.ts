// Verificação do token descartável (JWT HS256) que o Kommo envia em X-Auth-Token quando o widget usa
// self.$authorizedAjax. Assinado com o secret da integração privada. Sem dependências (WebCrypto).
// Falha fechada: qualquer claim esperado ausente ou divergente = negado.

const b64urlToBytes = (s: string) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0))
}

export interface Esperado {
  secret: string
  contaId: string            // account_id da conta permitida
  host: string               // ex.: financeirorustonengenhariacombr.kommo.com (vem em iss)
  clientId: string           // id da integração (client_uuid)
}

export type ResultadoJwt =
  | { ok: true; userId: number; payload: Record<string, unknown> }
  | { ok: false; erro: string }

export async function verificarJwtKommo(token: string, e: Esperado, agora = Math.floor(Date.now() / 1000)): Promise<ResultadoJwt> {
  const partes = String(token || '').split('.')
  if (partes.length !== 3) return { ok: false, erro: 'jwt_formato' }
  let header: any, payload: any
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(partes[0])))
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(partes[1])))
  } catch { return { ok: false, erro: 'jwt_json' } }
  if (header?.alg !== 'HS256') return { ok: false, erro: 'jwt_alg' }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(e.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  let sig: Uint8Array
  try { sig = b64urlToBytes(partes[2]) } catch { return { ok: false, erro: 'jwt_assinatura' } }
  const valido = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${partes[0]}.${partes[1]}`))
  if (!valido) return { ok: false, erro: 'jwt_assinatura' }

  const folga = 30
  if (typeof payload.exp !== 'number' || payload.exp < agora - folga) return { ok: false, erro: 'jwt_expirado' }
  if (typeof payload.nbf === 'number' && payload.nbf > agora + folga) return { ok: false, erro: 'jwt_nbf' }
  if (typeof payload.iat !== 'number' || payload.iat > agora + folga) return { ok: false, erro: 'jwt_iat' }
  if (String(payload.account_id ?? '') !== e.contaId) return { ok: false, erro: 'jwt_conta' }
  let host = ''
  try { host = new URL(String(payload.iss ?? '')).hostname } catch { host = '' }
  if (host !== e.host) return { ok: false, erro: 'jwt_emissor' }
  if (String(payload.client_uuid ?? '') !== e.clientId) return { ok: false, erro: 'jwt_integracao' }
  const userId = Number(payload.user_id)
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, erro: 'jwt_usuario' }
  return { ok: true, userId, payload }
}
