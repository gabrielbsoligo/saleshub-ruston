// =============================================================
// Gerador de Propostas — chamada ao LLM (Deno)
// =============================================================
// Mesma política do analyze-call (pedido do Gabriel, 09/08): OpenAI é a
// primária e o Claude entra como reserva se a OpenAI falhar. Aqui com mais
// tokens de saída (o escopo é maior que o resumo da call) e com timeout.
// =============================================================

import { redigir } from './redigir.mjs'

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const CLAUDE_MODEL = Deno.env.get('PROPOSTA_CLAUDE_MODEL') ?? 'claude-sonnet-5-5'
// Orçamento total das duas chamadas: com Drive/Slides depois, cabe nos 150 s de
// wall-clock da Edge no plano free. OpenAI tem até 45 s; o Claude, o que sobrar.
const ORCAMENTO_LLM_MS = 100_000
const TIMEOUT_OPENAI_MS = 45_000
const TIMEOUT_CLAUDE_MIN_MS = 20_000

const CHAVES = [OPENAI_API_KEY, ANTHROPIC_API_KEY]
const seguro = (t: unknown) => redigir(String(t ?? '').slice(0, 300), CHAVES)

const SYSTEM = 'Você é um closer sênior da V4 Company que monta escopos de proposta. Responda APENAS com um JSON válido, em português do Brasil.'

async function viaOpenAI(prompt: string, timeoutMs: number): Promise<string | null> {
  if (!OPENAI_API_KEY) return null
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4.1',
        max_tokens: 4000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) {
      console.error(`proposta LLM OpenAI ${r.status}: ${seguro(await r.text().catch(() => ''))}`)
      return null
    }
    const d = await r.json()
    return d.choices?.[0]?.message?.content || null
  } catch (e) {
    console.error('proposta LLM OpenAI falhou:', seguro((e as Error).message))
    return null
  }
}

async function viaClaude(prompt: string, timeoutMs: number): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        // modelos atuais pensam por padrão: o pensamento conta em max_tokens.
        // Extração para JSON não pede raciocínio longo: effort low corta tempo e custo
        // (exige modelo com effort, como o padrão claude-sonnet-5-5).
        max_tokens: 16000,
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) {
      console.error(`proposta LLM Claude ${r.status}: ${seguro(await r.text().catch(() => ''))}`)
      return null
    }
    const d = await r.json()
    // cortado no limite: o JSON viria quebrado; melhor falhar dizendo por quê
    if (d.stop_reason === 'max_tokens' || d.stop_reason === 'refusal') {
      console.error(`proposta LLM Claude sem resposta útil: stop_reason=${seguro(d.stop_reason)}`)
      return null
    }
    // o primeiro bloco pode ser 'thinking' (vazio); a resposta é o bloco 'text'
    const texto = (d.content || []).find((b: any) => b?.type === 'text')?.text || null
    if (!texto) console.error(`proposta LLM Claude sem texto: stop_reason=${seguro(d.stop_reason)}`)
    return texto
  } catch (e) {
    console.error('proposta LLM Claude falhou:', seguro((e as Error).message))
    return null
  }
}

export async function chamarLLM(prompt: string): Promise<{ texto: string; provedor: string }> {
  const inicio = Date.now()
  const a = await viaOpenAI(prompt, TIMEOUT_OPENAI_MS)
  if (a) return { texto: a, provedor: 'openai' }
  const b = await viaClaude(prompt, Math.max(TIMEOUT_CLAUDE_MIN_MS, ORCAMENTO_LLM_MS - (Date.now() - inicio)))
  if (b) return { texto: b, provedor: 'claude' }
  throw new Error('análise indisponível: OpenAI e Claude falharam')
}
