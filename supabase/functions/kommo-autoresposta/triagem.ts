// Regras puras da triagem (sem rede): normalização, casamento de padrões e classificação.
// Testes em triagem_test.ts (deno test). Padrões vivem na tabela autoresposta_padroes.

export type Padrao = { id: number; padrao: string; descricao?: string | null; tipo: 'autoresposta' | 'humano' }
export type Cfg = {
  pipeline_id: number; status_respondeu: number | null; ativo: boolean; modo: 'aplicar' | 'observar'
  janela_rapida_s: number; repeticao_min: number; espera_s: number
  etapas_origem: number[] | null        // etapas de disparo elegíveis (NULL = qualquer etapa do funil)
  r3_min_palavras: number               // R3 só para textos com pelo menos N palavras (template, não "ok")
}

// normaliza pra comparar/hashear: minúsculas, sem acento, urls → 'url', dígitos → '#',
// sem pontuação/emoji, espaços únicos
export function normalizar(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/https?:\/\/\S+/g, ' url ').replace(/\d+/g, '#').replace(/[^a-z#\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
export const palavras = (norm: string) => (norm ? norm.split(' ').filter(Boolean).length : 0)

export async function sha1(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// Compila a regex da tabela (semântica JavaScript; os seeds da migration usam \b, não \y).
export function compilar(p: Padrao): RegExp | null {
  try { return new RegExp(p.padrao, 'i') } catch { return null }
}

// Padrão que casa, sobre o texto normalizado E o original. Os de tipo 'humano' (áudio, cartão de
// contato, pedido de proposta, "pode me ligar"…) têm prioridade e encerram como humano.
export function casaPadrao(texto: string, padroes: Padrao[]): Padrao | null {
  const norm = normalizar(texto)
  const ordem = [...padroes].sort((a, b) => (a.tipo === 'humano' ? -1 : 0) - (b.tipo === 'humano' ? -1 : 0))
  for (const p of ordem) {
    const re = compilar(p)
    if (re && (re.test(texto) || re.test(norm))) return p
  }
  return null
}

export type Classificacao = 'autoresposta' | 'humano' | 'indeterminado'

/**
 * Decisão (sem efeito):
 *  - padrão tipo 'humano' → humano, sempre;
 *  - R1 (padrão autoresposta) → autoresposta;
 *  - R3: o MESMO texto já veio de outros leads; conta o lead atual (outros + 1 ≥ repeticao_min),
 *    só para texto com ≥ r3_min_palavras palavras (template, não "ok"/"sim") e só se o lead NÃO
 *    mandou outra mensagem (quem conversa é humano);
 *  - R2 (rápida e única, sem R1/R3) → indeterminado: só espera; nunca segura sozinha;
 *  - senão humano.
 */
export function classificar(args: {
  texto: string; intervaloS: number | null; outrosLeadsMesmoTexto: number; padrao: Padrao | null
  cfg: Pick<Cfg, 'janela_rapida_s' | 'repeticao_min' | 'r3_min_palavras'>; msgsRecebidasDepois: number
}): { classificacao: Classificacao; regras: string[] } {
  const regras: string[] = []
  if (args.padrao?.tipo === 'humano') return { classificacao: 'humano', regras: [`H:${args.padrao.id}`] }
  if (args.padrao) regras.push(`R1:${args.padrao.id}`)
  const totalLeads = args.outrosLeadsMesmoTexto + 1
  const r3 = totalLeads >= args.cfg.repeticao_min && palavras(normalizar(args.texto)) >= args.cfg.r3_min_palavras && args.msgsRecebidasDepois === 0
  if (r3) regras.push(`R3:${totalLeads}`)
  const rapida = args.intervaloS != null && args.intervaloS <= args.cfg.janela_rapida_s
  if (rapida) regras.push(`R2:${args.intervaloS}s`)
  if (args.padrao || r3) return { classificacao: 'autoresposta', regras }
  if (rapida && args.msgsRecebidasDepois === 0) return { classificacao: 'indeterminado', regras }
  return { classificacao: 'humano', regras }
}

// Resolução de um indeterminado na varredura: 2ª mensagem → humano; R3 (contando o lead atual) → autoresposta; senão humano.
export function resolverIndeterminado(msgsDepois: number, outrosLeadsMesmoTexto: number, nPalavras: number, cfg: Pick<Cfg, 'repeticao_min' | 'r3_min_palavras'>): { final: 'humano' | 'autoresposta'; motivo: string } {
  if (msgsDepois > 0) return { final: 'humano', motivo: 'varredura:2a_msg' }
  const total = outrosLeadsMesmoTexto + 1
  if (total >= cfg.repeticao_min && nPalavras >= cfg.r3_min_palavras) return { final: 'autoresposta', motivo: `varredura:R3:${total}` }
  return { final: 'humano', motivo: 'varredura:sem_2a_msg=humano' }
}

// Antes de aplicar no Kommo: o lead ainda está onde estava? (funil ativo, mesma etapa de origem,
// etapa dentro das elegíveis). Se não, a pendência foi superada por humano/outro fluxo.
export function podeAplicar(cfg: Cfg, leadAgora: { pipeline_id: number; status_id: number }, statusOrigem: number | null): { ok: boolean; motivo?: string } {
  if (!cfg.ativo) return { ok: false, motivo: 'funil desligado' }
  if (Number(leadAgora.pipeline_id) !== Number(cfg.pipeline_id)) return { ok: false, motivo: 'lead mudou de funil' }
  if (statusOrigem != null && Number(leadAgora.status_id) !== Number(statusOrigem)) return { ok: false, motivo: 'lead já saiu da etapa de origem' }
  if (cfg.etapas_origem?.length && !cfg.etapas_origem.map(Number).includes(Number(leadAgora.status_id))) return { ok: false, motivo: 'etapa fora das elegíveis' }
  return { ok: true }
}

// Lead id no payload do Salesbot/Kommo (form-urlencoded ou JSON) ou na query.
export function extrairLeadId(payload: Record<string, unknown>, query: URLSearchParams): number {
  const p = payload as any
  const cand = [
    query.get('lead_id'), p.lead_id, p['leads[add][0][id]'], p['leads[status][0][id]'], p['leads[update][0][id]'],
    p?.leads?.add?.[0]?.id, p?.leads?.status?.[0]?.id, p?.leads?.update?.[0]?.id, p?.lead?.id, p?.id,
  ]
  for (const c of cand) { const n = Number(c); if (Number.isInteger(n) && n > 0) return n }
  return 0
}
