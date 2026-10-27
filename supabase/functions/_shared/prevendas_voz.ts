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
  else if ((d.length === 11 || d.length === 12) && d.startsWith('0')) d = d.slice(1)   // 0 + DDD + fixo/celular (formato do CDR da 4com)
  if (d.length !== 10 && d.length !== 11) return null
  const ddd = Number(d.slice(0, 2)), num = d.slice(2)
  if (ddd < 11 || ddd % 10 === 0) return null                               // DDD brasileiro nunca termina em 0
  if (num.length === 9 && num[0] !== '9') return null
  // celular gravado no formato antigo (8 dígitos, começa com 6–9): hoje tem o 9 na frente
  if (num.length === 8 && /^[6-9]/.test(num)) return `+55${d.slice(0, 2)}9${num}`
  if (num.length === 8 && !/^[2-5]/.test(num)) return null
  return `+55${d}`
}
/** Final do número para log/nota (nunca o número inteiro em log). */
export function finalTelefone(e164: string): string { return '***' + e164.slice(-4) }
/** Número completo legível para a NOTA do Kommo (pedido do Gabriel): +55 47 99729-3673 / +55 47 3333-4444. */
export function telefoneLegivel(e164: string): string {
  const d = String(e164).replace(/\D/g, '').replace(/^55/, '')
  if (d.length === 11) return `+55 ${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `+55 ${d.slice(0, 2)} ${d.slice(2, 6)}-${d.slice(6)}`
  return String(e164)
}

export interface ContatoKommo { id: number; name?: string | null; custom_fields_values?: Array<{ field_code?: string | null; values?: Array<{ value?: unknown }> }> | null }
/** Telefones (E.164, sem repetição) dos contatos, a partir do campo de sistema PHONE. */
export function telefonesDosContatos(contatos: ContatoKommo[]): Array<{ contato_id: number; nome: string; telefones: Array<{ e164: string; exibir: string }>; invalidos: number }> {
  return contatos.map((c) => {
    const vistos = new Set<string>(), telefones: Array<{ e164: string; exibir: string }> = []
    let invalidos = 0
    for (const f of c.custom_fields_values ?? []) {
      if (f.field_code !== 'PHONE') continue
      for (const v of f.values ?? []) {
        const e = telefoneE164(String(v.value ?? ''))
        if (e && !vistos.has(e)) { vistos.add(e); telefones.push({ e164: e, exibir: String(v.value) }) }
        else if (!e && String(v.value ?? '').trim()) invalidos++
      }
    }
    return { contato_id: Number(c.id), nome: c.name ?? '', telefones, invalidos }
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

/** Tarefa própria de verdade: confere CADA tarefa devolvida (não confia no filtro enviado à API). */
export function tarefaPropriaValida(tarefas: unknown, uid: number, etype: string, eid: number): boolean {
  if (!Array.isArray(tarefas)) return false
  return tarefas.some((t: any) => t && Number(t.responsible_user_id) === Number(uid) && t.is_completed === false &&
    t.entity_type === etype && Number(t.entity_id) === Number(eid))
}

export type DecisaoEntidade =
  | { ok: true; motivo: 'gestor' | 'dono' | 'tarefa'; contatos: ReturnType<typeof telefonesDosContatos> }
  | { ok: false; erro: 'entidade_inconsistente' | 'sem_permissao' }
/**
 * Decide, com os objetos DEVOLVIDOS pelo Kommo, se o usuário pode usar os telefones da entidade e quais são eles.
 * - a entidade devolvida tem que ser exatamente a pedida (id); envelope inesperado nega;
 * - autorização: gestor, dono, ou tarefa aberta própria nessa entidade (conferida tarefa a tarefa);
 * - telefones: só de contatos VINCULADOS (lead → ids em _embedded.contacts; contato → ele mesmo).
 */
export function decidirEntidade(p: {
  uid: number; papel: string | null; etype: 'leads' | 'contacts'; eid: number
  entidade: any; tarefas: unknown; contatosDevolvidos: unknown
}): DecisaoEntidade {
  const e = p.entidade
  if (!e || typeof e !== 'object' || Number(e.id) !== Number(p.eid)) return { ok: false, erro: 'entidade_inconsistente' }
  const motivo = motivoAutorizacao({ papel: p.papel, uid: p.uid, donoEntidade: e.responsible_user_id ?? null,
    temTarefaPropria: tarefaPropriaValida(p.tarefas, p.uid, p.etype, p.eid) })
  if (!motivo) return { ok: false, erro: 'sem_permissao' }
  let contatos: ContatoKommo[] = []
  if (p.etype === 'contacts') contatos = [e]
  else {
    const vinc = Array.isArray(e?._embedded?.contacts) ? e._embedded.contacts : []
    const ids = new Set<number>(vinc.map((c: any) => Number(c?.id)).filter((n: number) => Number.isInteger(n) && n > 0))
    const vistos = new Set<number>()
    for (const c of Array.isArray(p.contatosDevolvidos) ? p.contatosDevolvidos : []) {
      const id = Number((c as any)?.id)
      if (ids.has(id) && !vistos.has(id)) { vistos.add(id); contatos.push(c as ContatoKommo) }
    }
  }
  return { ok: true, motivo, contatos: telefonesDosContatos(contatos) }
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

// ---------------- provedores: 4com e 3C ----------------
export type Provedor = '4com' | '3c'
/**
 * Provedor do telefone do usuário: o pedido (setting do widget) ou o padrão do servidor, desde que o usuário tenha
 * o dado necessário (ramal_4com p/ 4com; agente_3c_id p/ 3C). Sem pedido/padrão: 4com se houver ramal, senão 3C.
 */
export function decidirProvedor(pedido: unknown, m: { ramal_4com?: string | null; agente_3c_id?: string | number | null }, padrao?: unknown): Provedor | null {
  const tem4 = /^\d{2,8}$/.test(String(m.ramal_4com ?? '').trim()), tem3 = /^\d{1,12}$/.test(String(m.agente_3c_id ?? '').trim())
  const p = pedido === '3c' || pedido === '4com' ? pedido : (padrao === '3c' || padrao === '4com' ? padrao : null)
  if (p === '3c') return tem3 ? '3c' : null
  if (p === '4com') return tem4 ? '4com' : null
  return tem4 ? '4com' : (tem3 ? '3c' : null)
}

/** Número no formato do 3C (DDD + número, sem o 55 — como o próprio app do 3C faz na discagem manual). */
export function telefone3c(e164: string): string { return String(e164).replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '') }

/** Credencial SIP do 3C a partir do usuário (GET /users/{id}?include=extension,company). Senha nunca sai daqui. */
export function credencial3c(u: any): { wss: string; dominio: string; usuario: string; realm: string; ha1: string; uri: string; ramal: string } | null {
  const tid = String(u?.telephony_id ?? '').trim(), senha = String(u?.extension_password ?? '')
  const dom = String((u?.company?.data ?? u?.company)?.domain ?? '').trim().toLowerCase()
  const ext = String((u?.extension?.data ?? u?.extension)?.extension_number ?? '').trim()
  if (!/^\d+$/.test(tid) || !senha || !/^[a-z0-9-]+$/.test(dom) || !/^\d+$/.test(ext)) return null
  const dominio = `${dom}.3c.plus`
  return { wss: 'wss://vox-socket.3c.plus:4443', dominio, usuario: tid, realm: dominio, ha1: ha1(tid, dominio, senha), uri: `sip:${tid}@${dominio}`, ramal: ext }
}

/** Lê a resposta do POST /click2call do 3C (mesmo formato de resultado da 4com). */
export function interpretar3c(status: number, corpo: unknown): Resultado4com {
  const j = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, any>
  const erros = j?.errors && typeof j.errors === 'object' ? Object.values(j.errors).flat().map(String).join(' ') : ''
  const msg = String(erros || j?.detail || j?.message || '').replace(/\s+/g, ' ').slice(0, 200)
  if (status >= 200 && status < 300) { const id = j?.data?.id ?? j?.id ?? j?.call_id ?? null; return { ok: true, chamada_id: id != null ? String(id) : null } }
  if (status === 401 || status === 403) return { ok: false, erro: 'provedor_auth', mensagem: 'O 3C recusou a credencial do servidor.' }
  if (status === 429) return { ok: false, erro: 'provedor_limite', mensagem: 'Limite de ligações do 3C atingido; tente em 1 minuto.' }
  if (status === 0 || status >= 500) return { ok: false, erro: 'provedor_indisponivel', mensagem: msg || 'O 3C não respondeu.', incerto: true }
  return { ok: false, erro: 'provedor_recusou', mensagem: msg || `O 3C recusou a ligação (${status}).` }
}

export type Preparo3c =
  | { tipo: 'ok'; c: NonNullable<ReturnType<typeof credencial3c>> }
  | { tipo: 'limite'; retryAfter: number }
  | { tipo: 'sem_ramal' }
  | { tipo: 'indisponivel' }
/**
 * PREPARAÇÃO da discagem 3C (ramal do agente), separada do ENVIO: nada aqui é "incerto", porque o /click2call
 * ainda não foi chamado. 429 vira limite com o Retry-After recebido (1..3600, padrão 60).
 */
export async function prepararAgente3c(obter: () => Promise<{ status: number; retryAfter: string | null; u: unknown }>): Promise<Preparo3c> {
  let r: { status: number; retryAfter: string | null; u: unknown }
  try { r = await obter() } catch { return { tipo: 'indisponivel' } }
  if (r.status === 429) return { tipo: 'limite', retryAfter: Math.min(3600, Math.max(1, Number(r.retryAfter) || 60)) }
  if (r.status < 200 || r.status >= 300) return { tipo: 'indisponivel' }
  const c = credencial3c(r.u)
  return c ? { tipo: 'ok', c } : { tipo: 'sem_ramal' }
}

// ---------------- resultado final da ligação (CDR da 4com) ----------------
// O id devolvido pelo POST /calls NÃO é o id do CDR; o elo é o metadata que o widget manda no POST
// (widget_ev = id do evento de auditoria + kommo_user). duration do CDR = tempo de conversa (0 sem atendimento).
export interface FinalLigacao { rotulo: string; duracao: number; gravacao: string | null; causa: string; inicio: string | null }

const CAUSAS: Record<string, string> = {
  USER_BUSY: 'ocupado',
  NO_ANSWER: 'não atendida', NO_USER_RESPONSE: 'não atendida', ALLOTTED_TIMEOUT: 'não atendida', RECOVERY_ON_TIMER_EXPIRE: 'não atendida',
  ORIGINATOR_CANCEL: 'cancelada antes de atender', CALL_REJECTED: 'recusada',
  UNALLOCATED_NUMBER: 'número inexistente', NUMBER_CHANGED: 'número inexistente', INVALID_NUMBER_FORMAT: 'número inválido',
  NO_ROUTE_DESTINATION: 'número inexistente', SUBSCRIBER_ABSENT: 'fora de área/desligado',
}

/** CDR da 4com → resultado legível. Atendida = duração de conversa > 0 (ou gravação) com encerramento normal. */
export function resultadoCdr(c: any): FinalLigacao {
  const causa = String(c?.hangup_cause ?? '').toUpperCase()
  const duracao = Math.max(0, Math.round(Number(c?.duration) || 0))
  const gravacao = typeof c?.record_url === 'string' && /^https:\/\//.test(c.record_url) ? c.record_url : null
  const atendida = (duracao > 0 || !!gravacao) && (causa === 'NORMAL_CLEARING' || causa === '')
  const rotulo = atendida ? 'atendida' : CAUSAS[causa] ?? (causa === 'NORMAL_CLEARING' ? 'não atendida' : `não completou (${causa || 'sem causa'})`)
  return { rotulo, duracao, gravacao: atendida ? gravacao : null, causa, inicio: c?.started_at ? String(c.started_at) : null }
}

/** O CDR da tentativa: metadata.widget_ev e metadata.kommo_user conferem (nunca o de outro usuário). */
export function acharCdr(lista: unknown, ev: number, uid: number): any | null {
  if (!Array.isArray(lista)) return null
  return lista.find((c: any) => c?.metadata && String(c.metadata.widget_ev) === String(ev) && String(c.metadata.kommo_user) === String(uid)) ?? null
}

const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`)

/**
 * Texto da nota da ligação (uma nota por ligação: criada ao discar e ATUALIZADA com o resultado). Número completo
 * (pedido do Gabriel). Marcador "Ref. widget #<ev>" na última linha: identifica a nota da ligação (idempotência:
 * a retomada procura a nota pelo marcador antes de criar). A gravação só entra quando nenhuma outra nota da entidade
 * (integração 4com/N8N "LIGAÇÃO … Resumo") já a tem — quem decide é prevendas_voz_resultado.ts (gravacaoAqui).
 */
export function textoNota(p: { provedor: '4com' | '3c'; nome: string; ramal: string; numero: string; manual: boolean; final?: FinalLigacao | null; gravacaoAqui?: boolean; ev?: number | null }): string {
  const cab = `📞 Ligação ${p.provedor === '3c' ? '3C' : '4com'} pelo widget — ${p.nome} (ramal ${p.ramal}) para ${telefoneLegivel(p.numero)}${p.manual ? ' (discagem manual)' : ''}`
  const ref = p.ev ? [`Ref. widget #${p.ev}`] : []
  if (!p.final) return [cab, ...(p.provedor === '4com' ? ['Resultado: aguardando o fim da ligação…'] : []), ...ref].join('\n')   // 3C: ainda sem CDR
  return [cab, ...linhasResultado(p.final, !!p.gravacaoAqui), ...ref].join('\n')
}

function linhasResultado(f: FinalLigacao, gravacaoAqui: boolean): string[] {
  const l = [`Resultado: ${f.rotulo}${f.rotulo === 'atendida' ? ` · duração ${fmtDur(f.duracao)}` : ''}`]
  if (f.gravacao && gravacaoAqui) l.push(`Gravação: ${f.gravacao}`)
  return l
}

/**
 * Atualiza o texto da nota existente: troca a linha "Resultado:" (e o que vier depois) pelo resultado final e
 * mantém/põe o marcador no fim. Idempotente.
 */
export function comResultado(textoAtual: string, f: FinalLigacao, gravacaoAqui: boolean, ev?: number | null): string {
  let base = String(textoAtual ?? '').replace(/\r\n/g, '\n')
  const m = base.match(/\n?Ref\. widget #(\d+)\s*$/)
  const evRef = ev ?? (m ? Number(m[1]) : null)
  if (m) base = base.slice(0, m.index)
  const i = base.indexOf('\nResultado:')
  const cab = (i >= 0 ? base.slice(0, i) : base).trimEnd()
  return [cab, ...linhasResultado(f, gravacaoAqui), ...(evRef ? [`Ref. widget #${evRef}`] : [])].join('\n')
}
