// Núcleo PURO do prevendas-voz (sem rede): HA1 do digest SIP, telefones, autorização e leitura da resposta da 4com.
// Testado em kommo-widget/ruston-prevendas/tests/voz.test.ts.
//
// Por que HA1 e não a senha: o navegador precisa de uma credencial para registrar o ramal (WebRTC/SIP sobre WSS).
// O HA1 = MD5(ramal:realm:senha) autentica o digest SIP sem revelar a senha do ramal. Ele AINDA permite usar o
// ramal (registrar e originar chamada), por isso só vai para o próprio dono, no-store, só em memória.

// ---------------- MD5 (RFC 1321) — o Web Crypto não tem MD5 ----------------
function md5Bytes(msg: Uint8Array): Uint8Array {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0
  const len = msg.length, total = (((len + 8) >>> 6) + 1) * 64
  const buf = new Uint8Array(total); buf.set(msg); buf[len] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(total - 8, (len * 8) >>> 0, true); dv.setUint32(total - 4, Math.floor(len / 0x20000000), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < total; off += 64) {
    let A = a0, B = b0, C = c0, D = d0
    for (let i = 0; i < 64; i++) {
      let F: number, g: number
      if (i < 16) { F = (B & C) | (~B & D); g = i }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * i) % 16 }
      const s = S[(i >> 4) * 4 + (i % 4)]
      F = (F + A + K[i] + dv.getUint32(off + g * 4, true)) >>> 0
      A = D; D = C; C = B; B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
  }
  const out = new Uint8Array(16), o = new DataView(out.buffer)
  o.setUint32(0, a0, true); o.setUint32(4, b0, true); o.setUint32(8, c0, true); o.setUint32(12, d0, true)
  return out
}
export function md5(texto: string): string {
  return [...md5Bytes(new TextEncoder().encode(texto))].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** HA1 do digest SIP (RFC 2617/3261): MD5(usuario:realm:senha). */
export function ha1(usuario: string, realm: string, senha: string): string { return md5(`${usuario}:${realm}:${senha}`) }

// ---------------- telefones ----------------
/**
 * Normaliza um telefone brasileiro para E.164 (+55DDDNÚMERO). Aceita máscara, DDI e zero de operadora.
 * Devolve null se não for um número BR plausível (DDD 11–99; fixo 8 dígitos ou celular 9 dígitos começando com 9).
 */
export function telefoneE164(bruto: string | null | undefined): string | null {
  let d = String(bruto ?? '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)            // 0 + DDD + fixo
  if (d.length !== 10 && d.length !== 11) return null
  const ddd = Number(d.slice(0, 2)), num = d.slice(2)
  if (ddd < 11 || ddd % 10 === 0) return null                               // DDD brasileiro nunca termina em 0
  if (num.length === 9 && num[0] !== '9') return null
  if (num.length === 8 && !/^[2-5]/.test(num)) return null
  return `+55${d}`
}
/** Final do número para log/nota (nunca o número inteiro em log). */
export function finalTelefone(e164: string): string { return '***' + e164.slice(-4) }

export interface ContatoKommo { id: number; name?: string | null; custom_fields_values?: Array<{ field_code?: string | null; values?: Array<{ value?: unknown }> }> | null }
/** Telefones (E.164, sem repetição) dos contatos, a partir do campo de sistema PHONE. */
export function telefonesDosContatos(contatos: ContatoKommo[]): Array<{ contato_id: number; nome: string; telefones: Array<{ e164: string; exibir: string }> }> {
  return contatos.map((c) => {
    const vistos = new Set<string>(), telefones: Array<{ e164: string; exibir: string }> = []
    for (const f of c.custom_fields_values ?? []) {
      if (f.field_code !== 'PHONE') continue
      for (const v of f.values ?? []) {
        const e = telefoneE164(String(v.value ?? ''))
        if (e && !vistos.has(e)) { vistos.add(e); telefones.push({ e164: e, exibir: String(v.value) }) }
      }
    }
    return { contato_id: Number(c.id), nome: c.name ?? '', telefones }
  })
}

// ---------------- autorização ----------------
/**
 * Quem pode usar o telefone de uma entidade (lead/contato): gestor ativo, o dono da entidade, ou quem tem uma
 * tarefa ABERTA própria nela (conferida ao vivo). Papel/modo sozinhos não autorizam.
 */
export function motivoAutorizacao(p: { papel: string | null; uid: number; donoEntidade: number | null; temTarefaPropria: boolean }): 'gestor' | 'dono' | 'tarefa' | null {
  if (p.papel === 'gestor') return 'gestor'
  if (p.donoEntidade != null && Number(p.donoEntidade) === Number(p.uid)) return 'dono'
  if (p.temTarefaPropria) return 'tarefa'
  return null
}

/** Usuários liberados (lista do servidor, fail-closed: vazia = ninguém). */
export function usuarioLiberado(lista: string | undefined, uid: number): boolean {
  return String(lista ?? '').split(',').map((x) => x.trim()).filter(Boolean).includes(String(uid))
}

// ---------------- 4com ----------------
export type Resultado4com = { ok: true; chamada_id: string | null } | { ok: false; erro: string; mensagem: string; incerto?: boolean }
/** Lê a resposta do POST /calls da 4com. Mensagem curta e sem dados sensíveis. */
export function interpretar4com(status: number, corpo: unknown): Resultado4com {
  const j = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, any>
  const msg = String(j?.error?.message ?? j?.message ?? j?.detail ?? '').replace(/\s+/g, ' ').slice(0, 200)
  if (status >= 200 && status < 300) return { ok: true, chamada_id: j.id != null ? String(j.id) : null }
  if (status === 401 || status === 403) return { ok: false, erro: 'provedor_auth', mensagem: 'A 4com recusou a credencial do servidor.' }
  if (status === 429) return { ok: false, erro: 'provedor_limite', mensagem: 'Limite de ligações da 4com atingido; tente em 1 minuto.' }
  if (status === 0 || status >= 500) return { ok: false, erro: 'provedor_indisponivel', mensagem: msg || 'A 4com não respondeu.', incerto: true }
  return { ok: false, erro: 'provedor_recusou', mensagem: msg || `A 4com recusou a ligação (${status}).` }
}
