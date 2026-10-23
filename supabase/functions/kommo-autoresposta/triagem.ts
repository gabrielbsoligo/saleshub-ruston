// Regras puras da triagem (sem rede): normalização, casamento de padrões e classificação.
// Testes em triagem_test.ts (deno test). Padrões vivem na tabela autoresposta_padroes.

export type Padrao = { id: number; padrao: string; descricao?: string | null; tipo: 'autoresposta' | 'humano' }
export type Cfg = { pipeline_id: number; status_respondeu: number | null; ativo: boolean; janela_rapida_s: number; repeticao_min: number; espera_s: number; modo: 'aplicar' | 'observar' }

// normaliza pra comparar/hashear: minúsculas, sem acento, urls → 'url', dígitos → '#',
// sem pontuação/emoji, espaços únicos
export function normalizar(t: string): string {
  return (t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/https?:\/\/\S+/g, ' url ').replace(/\d+/g, '#').replace(/[^a-z#\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

export async function sha1(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// Padrão que casa (regex, case-insensitive, sobre o texto normalizado E o original).
// Os de tipo 'humano' (áudio, cartão de contato) têm prioridade e encerram como humano.
export function casaPadrao(texto: string, padroes: Padrao[]): Padrao | null {
  const norm = normalizar(texto)
  const ordem = [...padroes].sort((a, b) => (a.tipo === 'humano' ? -1 : 0) - (b.tipo === 'humano' ? -1 : 0))
  for (const p of ordem) {
    try {
      const re = new RegExp(p.padrao, 'i')
      if (re.test(texto) || re.test(norm)) return p
    } catch { /* regex inválida na tabela: ignora */ }
  }
  return null
}

export type Classificacao = 'autoresposta' | 'humano' | 'indeterminado'

// R1 (padrão) ou R3 (repetição entre leads) → autoresposta.
// R2 (rápida e única) → indeterminado: só espera a 2ª mensagem ou R3; nunca segura sozinha.
// Padrão tipo 'humano' → humano, sempre.
export function classificar(args: { intervaloS: number | null; repeticoes: number; padrao: Padrao | null; cfg: Pick<Cfg, 'janela_rapida_s' | 'repeticao_min'>; msgsRecebidasDepois: number }): { classificacao: Classificacao; regras: string[] } {
  const regras: string[] = []
  if (args.padrao?.tipo === 'humano') return { classificacao: 'humano', regras: [`H:${args.padrao.id}`] }
  if (args.padrao) regras.push(`R1:${args.padrao.id}`)
  if (args.repeticoes >= args.cfg.repeticao_min) regras.push(`R3:${args.repeticoes}`)
  const rapida = args.intervaloS != null && args.intervaloS <= args.cfg.janela_rapida_s
  if (rapida) regras.push(`R2:${args.intervaloS}s`)
  if (args.padrao || args.repeticoes >= args.cfg.repeticao_min) return { classificacao: 'autoresposta', regras }
  if (rapida && args.msgsRecebidasDepois === 0) return { classificacao: 'indeterminado', regras }
  return { classificacao: 'humano', regras }
}

// Resolução de um indeterminado na varredura: 2ª mensagem → humano; R3 → autoresposta; senão humano.
export function resolverIndeterminado(msgsDepois: number, repeticoes: number, repeticaoMin: number): { final: 'humano' | 'autoresposta'; motivo: string } {
  if (msgsDepois > 0) return { final: 'humano', motivo: 'varredura:2a_msg' }
  if (repeticoes >= repeticaoMin) return { final: 'autoresposta', motivo: `varredura:R3:${repeticoes}` }
  return { final: 'humano', motivo: 'varredura:sem_2a_msg=humano' }
}
