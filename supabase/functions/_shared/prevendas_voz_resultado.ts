// Resultado final das ligações do widget (CDR da 4com) → a nota DA LIGAÇÃO no Kommo (uma por ligação).
// Usado pela ação 'resultado' (widget) e pela varredura do cron (prevendas-voz { acao: 'varrer' }), com I/O
// injetado (testável). Garantias:
//  - posse por ligação com TOKEN exclusivo e lease: toda escrita é condicionada ao token; antes de cada efeito no
//    Kommo o lease é revalidado (o abandono só é declarado bem depois do lease — um worker vencido não escreve);
//  - nota idempotente: a nota leva o marcador "Ref. widget #<ev>"; sem nota_id, a nota é PROCURADA pelo marcador
//    na entidade antes de criar (POST aceito com resposta perdida, ou id não gravado, não gera segunda nota);
//  - ausência de CDR só vira "sem registro" com a janela de CDRs COBERTA e a ligação com 15 min; envelope
//    inesperado/truncado adia, nunca conclui;
//  - contato (discagem sem lead): só com busca COMPLETA e exatamente um contato com o número (ambiguidade ou
//    orçamento esgotado = sem nota);
//  - gravação: só entra na nossa nota se nenhuma outra nota da entidade já a tiver (nota da integração 4com/N8N);
//    ligação atendida com gravação espera GRACA_GRAVACAO_S após o fim para a N8N escrever primeiro.
// Convergência (AUDITORIA-LIGACOES F5): quando a tabela calls + kommo-writer existirem, este módulo é desligado e o
// writer atualiza a nota por nota_id/marcador (cdr_id = provider_call_id).
import { acharCdr, comResultado, motivoAutorizacao, resultadoCdr, telefoneE164, telefonesDosContatos, textoNota, type FinalLigacao } from './prevendas_voz.ts'

export const MIN_IDADE_S = 90         // a discagem ainda pode estar criando a nota inicial (POST 4com até 45 s + nota)
export const LEASE_S = 90             // efeitos só dentro do lease
export const ABANDONO_S = 150         // posse abandonada (> lease + prazo de uma chamada ao Kommo)
export const SEM_CDR_S = 15 * 60      // sem CDR (com janela coberta) depois disso = não completou
export const GRACA_GRAVACAO_S = 120   // atendida com gravação: a N8N escreve a nota dela primeiro
export const MARGEM_COBERTURA_S = 300 // o CDR começa logo depois do POST /calls; folga para relógios/empates
export const DESISTIR_NOTA_S = 3 * 3600 // nota que falha por mais que isso: fecha sem nota (fica no log e no widget)
export const CDR_INCOMPLETO_S = 6 * 3600 // CDR sem fim/causa por mais que isso: fecha como indeterminado
export const JANELA_MAX_S = 3600     // janelas fundidas não passam disso (cada uma cabe nas páginas de uma busca)
export const FUSO_4COM_S = 3 * 3600   // a 4com devolve horário de Brasília rotulado como Z
export const MAX_PAGINAS_KOMMO = 4

export const marcador = (ev: number) => `Ref. widget #${ev}`
export function temMarcador(texto: unknown, ev: number): boolean {
  const m = String(texto ?? '').match(/Ref\. widget #(\d+)(?!\d)/)
  return !!m && Number(m[1]) === ev
}

/** Horário da 4com (Brasília rotulado Z) → epoch s real. */
export function instante4com(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? Math.floor(t / 1000) + FUSO_4COM_S : null
}

/** Página do GET /calls: { data: [...], meta: { nextPage } } (ou array puro). null = envelope inesperado. */
export function paginaCdr(corpo: unknown, limite: number): { itens: any[]; proxima: boolean } | null {
  if (Array.isArray(corpo)) return { itens: corpo, proxima: corpo.length >= limite }
  const j = corpo as any
  if (!j || typeof j !== 'object' || !Array.isArray(j.data)) return null
  return { itens: j.data, proxima: j.data.length > 0 && j.meta?.nextPage != null }
}

/** epoch s real → horário no formato da 4com (Brasília rotulado Z), para o filtro where.started_at. */
export const rotulo4com = (s: number) => new Date((s - FUSO_4COM_S) * 1000).toISOString()

/** Janela de busca de cada ligação ([em − MARGEM, em + JANELA_DEPOIS_S]), fundidas quando se sobrepõem. */
export const JANELA_DEPOIS_S = 600
export function janelasCdr(emsS: number[]): Array<[number, number]> {
  const js = emsS.filter(Number.isFinite).map((e) => [e - MARGEM_COBERTURA_S, e + JANELA_DEPOIS_S] as [number, number]).sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const j of js) { const u = out[out.length - 1]; if (u && j[0] <= u[1] && Math.max(u[1], j[1]) - u[0] <= JANELA_MAX_S) u[1] = Math.max(u[1], j[1]); else out.push([...j]) }
  return out
}

export type Cdrs = { lista: any[]; cobertas: Array<[number, number]> }
/**
 * CDRs por FAIXA DE TEMPO (where started_at between): cada janela das pendentes é lida inteira (paginada) e
 * independente das outras — uma pendência antiga não depende de paginar o histórico todo a partir de agora, nem
 * impede as mais novas. Janela lida até o fim = coberta; envelope inesperado, item sem horário ou orçamento de
 * requisições esgotado = janela NÃO coberta (as ligações dela adiam). Ordem: mais novas primeiro e mais antigas
 * primeiro, alternadas (nenhum dos lados fica sem orçamento).
 */
export async function buscarCdrs(obter: (de: string, ate: string, skip: number, limite: number) => Promise<unknown>, emsS: number[],
  maxReq = 30, maxPaginasJanela = 5, limite = 100): Promise<Cdrs> {
  const js = janelasCdr(emsS), ordem: Array<[number, number]> = []
  for (let a = 0, b = js.length - 1; a <= b; a++, b--) { ordem.push(js[b]); if (a !== b) ordem.push(js[a]) }
  const lista: any[] = [], cobertas: Array<[number, number]> = []
  let req = 0
  janelas: for (const [ini, fim] of ordem) {
    const daJanela: any[] = []
    for (let i = 0; i < maxPaginasJanela; i++) {
      if (req >= maxReq) break janelas
      req++
      const pg = paginaCdr(await obter(rotulo4com(ini), rotulo4com(fim), i * limite, limite), limite)
      if (!pg || pg.itens.some((c) => instante4com(c?.started_at) == null)) continue janelas   // não confia: não cobre
      daJanela.push(...pg.itens)
      if (!pg.proxima) { lista.push(...daJanela); cobertas.push([ini, fim]); continue janelas }
    }
    lista.push(...daJanela)                                                  // truncada: serve para achar, não cobre
  }
  return { lista, cobertas }
}
/** A ligação (em) está numa janela lida inteira? */
export const coberta = (c: Cdrs, emS: number) => c.cobertas.some(([a, b]) => a <= emS - MARGEM_COBERTURA_S && emS + JANELA_DEPOIS_S <= b)

/** CDR encerrado: fim e causa presentes (registro em andamento/incompleto não conclui). */
export function cdrEncerrado(c: any): boolean {
  return instante4com(c?.ended_at) != null && String(c?.hangup_cause ?? '').trim() !== ''
}

export interface EventoPendente { id: number; kommo_user: number; em: string; entidade: string | null; nota_entidade: string | null; nota_id: number | null; final: any }
export interface MembroVoz { name: string | null; role: string | null; ramal_4com: string | null }
export interface IoResultado {
  agoraS(): number
  token(): string
  /** final := {proc, tok} se (final IS NULL) ou (final->>tok = anterior), e final_em IS NULL */
  reivindicar(id: number, anterior: string | null, tok: string, procS: number): Promise<boolean>
  /** o token ainda é o dono (final->>tok = tok e final_em IS NULL) */
  confirmar(id: number, tok: string): Promise<boolean>
  /** update condicionado ao token; false = perdeu a posse */
  gravar(id: number, tok: string, dados: Record<string, unknown>): Promise<boolean>
  /** final := null, condicionado ao token */
  liberar(id: number, tok: string): Promise<void>
  kommo(path: string, init?: { method: string; body: string }): Promise<any>
  membro(uid: number): MembroVoz | null
}
export type Desfecho =
  | { ev: number; feito: true; final: FinalLigacao & { nota: boolean; onde: string | null } }
  | { ev: number; feito: false; motivo: string }

const SEM_CDR: FinalLigacao = { rotulo: 'não completou (sem registro na 4com)', duracao: 0, gravacao: null, causa: 'SEM_CDR', inicio: null }
const INDETERMINADO: FinalLigacao = { rotulo: 'resultado indeterminado (registro incompleto na 4com)', duracao: 0, gravacao: null, causa: 'CDR_INCOMPLETO', inicio: null }
const arquivo = (url: string) => url.split('?')[0].split('/').pop() || url

/** Notas comuns da entidade atualizadas desde `desdeS` (todas as páginas; incompleta = null). */
async function notasDaEntidade(io: IoResultado, et: string, id: number, desdeS: number): Promise<Array<{ id: number; texto: string }> | null> {
  const out: Array<{ id: number; texto: string }> = []
  for (let pg = 1; pg <= MAX_PAGINAS_KOMMO; pg++) {
    const j = await io.kommo(`/api/v4/${et}/${id}/notes?filter[note_type]=common&filter[updated_at][from]=${desdeS}&limit=250&page=${pg}`)
    if (!j) return out                                                       // 204: sem (mais) notas
    const l = j?._embedded?.notes
    if (!Array.isArray(l)) throw new Error('kommo_envelope_notas')
    for (const n of l) if (Number.isInteger(Number(n?.id))) out.push({ id: Number(n.id), texto: String(n?.params?.text ?? '') })
    if (!j?._links?.next) return out
  }
  return null
}

/** O contato do número (discagem sem lead): busca COMPLETA, exatamente um com o número e autorizado. */
async function contatoDoNumero(io: IoResultado, numero: string, uid: number, papel: string | null): Promise<string | null> {
  const achados: any[] = []
  for (let pg = 1; pg <= MAX_PAGINAS_KOMMO; pg++) {
    const j = await io.kommo(`/api/v4/contacts?query=${encodeURIComponent(numero.slice(-8))}&limit=250&page=${pg}`)
    if (!j) break
    const l = j?._embedded?.contacts
    if (!Array.isArray(l)) throw new Error('kommo_envelope_contatos')
    achados.push(...l.filter((c: any) => telefonesDosContatos([c])[0]?.telefones.some((t) => t.e164 === numero)))
    if (achados.length > 1) return null                                      // ambíguo
    if (!j?._links?.next) break
    if (pg === MAX_PAGINAS_KOMMO) return null                                // orçamento esgotado: não decide
  }
  if (achados.length !== 1) return null
  const c = achados[0]
  return motivoAutorizacao({ papel, uid, donoEntidade: c?.responsible_user_id ?? null, temTarefaPropria: false }) ? `contacts:${Number(c.id)}` : null
}

/** Processa UMA ligação pendente. Falha no Kommo vira adiamento (posse devolvida); falha de banco propaga (a posse expira). */
export async function processarLigacao(p: EventoPendente, cdrs: Cdrs, io: IoResultado): Promise<Desfecho> {
  const ev = p.id, uid = Number(p.kommo_user)
  const emS = Math.floor(Date.parse(p.em) / 1000)
  const agora = io.agoraS(), idade = agora - emS
  if (idade < MIN_IDADE_S) return { ev, feito: false, motivo: 'recente' }
  const cdr = acharCdr(cdrs.lista, ev, uid)
  if (!cdr) {
    if (!coberta(cdrs, emS)) return { ev, feito: false, motivo: 'cdr_fora_da_cobertura' }
    if (idade < SEM_CDR_S) return { ev, feito: false, motivo: 'aguardando_cdr' }
  }
  // CDR achado mas ainda sem fim/causa (em andamento ou incompleto): adia; só fecha como indeterminado bem depois
  const encerrado = !!cdr && cdrEncerrado(cdr)
  if (cdr && !encerrado && idade < CDR_INCOMPLETO_S) return { ev, feito: false, motivo: 'cdr_incompleto' }
  const fin: FinalLigacao = !cdr ? SEM_CDR : encerrado ? resultadoCdr(cdr) : INDETERMINADO
  if (cdr && fin.gravacao) {
    const fim = instante4com(cdr.ended_at) ?? instante4com(cdr.started_at)
    if (fim != null && agora - fim < GRACA_GRAVACAO_S) return { ev, feito: false, motivo: 'aguardando_n8n' }
  }
  // posse
  const ant = p.final && typeof p.final === 'object' ? p.final : null
  if (ant?.tok && agora - Number(ant.proc) <= ABANDONO_S) return { ev, feito: false, motivo: 'em_processamento' }
  const tok = io.token(), proc = io.agoraS()
  if (!(await io.reivindicar(ev, ant?.tok ? String(ant.tok) : null, tok, proc))) return { ev, feito: false, motivo: 'posse_de_outro' }
  const noLease = () => io.agoraS() - proc < LEASE_S
  const valida = async () => noLease() && (await io.confirmar(ev, tok))

  const m = io.membro(uid)
  const numero = cdr ? telefoneE164(String(cdr.to ?? '')) : null
  const manual = String(p.entidade ?? '').startsWith('manual')
  let onde: string | null = p.nota_entidade ?? null, notaId: number | null = null, nota = false, gravacaoNaNota = false
  try {
    if (!onde && numero) {
      onde = await contatoDoNumero(io, numero, uid, m?.role ?? null)
      // intenção ANTES do efeito: a retomada procura a nota nesta mesma entidade
      if (onde && !(await io.gravar(ev, tok, { nota_entidade: onde }))) return { ev, feito: false, motivo: 'posse_perdida' }
    }
    const [et, idS] = String(onde ?? '').split(':'), idE = Number(idS)
    if (onde && (et === 'leads' || et === 'contacts') && Number.isInteger(idE) && idE > 0) {
      const notas = await notasDaEntidade(io, et, idE, emS - 120)
      if (!notas) throw new Error('notas_incompletas')
      const nossa = notas.find((n) => p.nota_id != null && n.id === Number(p.nota_id)) ?? notas.find((n) => temMarcador(n.texto, ev))
      gravacaoNaNota = !!fin.gravacao && !notas.some((n) => n !== nossa && n.texto.includes(arquivo(fin.gravacao!)))
      if (!(await valida())) return { ev, feito: false, motivo: 'posse_perdida' }
      if (nossa) {
        await io.kommo(`/api/v4/${et}/notes`, { method: 'PATCH', body: JSON.stringify([{ id: nossa.id, entity_id: idE, note_type: 'common', params: { text: comResultado(nossa.texto, fin, gravacaoNaNota, ev) } }]) })
        notaId = nossa.id; nota = true
      } else if (numero) {
        const j = await io.kommo(`/api/v4/${et}/notes`, { method: 'POST', body: JSON.stringify([{ entity_id: idE, note_type: 'common',
          params: { text: textoNota({ provedor: '4com', nome: m?.name ?? String(uid), ramal: String(m?.ramal_4com ?? '?'), numero, manual, final: fin, gravacaoAqui: gravacaoNaNota, ev }) } }]) })
        notaId = Number(j?._embedded?.notes?.[0]?.id) || null
        if (!notaId) throw new Error('nota_sem_id')                       // a retomada acha pelo marcador
        nota = true
      }
    }
  } catch (e) {
    console.error('[prevendas-voz] resultado', ev, (e as Error).message)
    if (idade < DESISTIR_NOTA_S) { await io.liberar(ev, tok); return { ev, feito: false, motivo: 'nota_falhou' } }
    nota = false
  }
  const final = { ...fin, gravacao_na_nota: gravacaoNaNota, nota, onde }
  const dados: Record<string, unknown> = { final, final_em: new Date(io.agoraS() * 1000).toISOString(), nota_entidade: onde, nota_id: notaId, cdr_id: cdr?.id != null ? String(cdr.id) : null }
  if (!(await io.gravar(ev, tok, dados))) return { ev, feito: false, motivo: 'posse_perdida' }
  return { ev, feito: true, final }
}

/** Processa as pendentes (mais antigas primeiro) até o prazo. */
export async function processarPendentes(pend: EventoPendente[], cdrs: Cdrs, io: IoResultado, prazoS: number): Promise<Desfecho[]> {
  const out: Desfecho[] = []
  for (const p of pend) {
    if (io.agoraS() >= prazoS) break
    out.push(await processarLigacao(p, cdrs, io))
  }
  return out
}
