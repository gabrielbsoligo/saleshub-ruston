// Edge Function: Analisa transcricao de call.
// LLM: OpenAI (gpt-4.1) e a PRIMARIA; Claude (sonnet) entra como RESERVA se a
// OpenAI falhar — sem saldo, 4xx/5xx ou timeout (pedido do Gabriel, 09/08).
// Roda server-side para evitar CORS do browser.

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const SYSTEM = 'Voce e um analista especializado em calls de vendas da V4 Company. Analise transcricoes e retorne APENAS um JSON valido, sem texto adicional. Responda em portugues brasileiro.'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// retry para erros transientes (429 / 5xx), backoff 2s, 4s
async function fetchRetry(mk: () => Promise<Response>, transient: (s: number) => boolean): Promise<Response | null> {
  let response: Response | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await mk()
    if (response.ok || !transient(response.status)) break
    if (attempt < 3) {
      console.log(`LLM ${response.status}, retry ${attempt}/3...`)
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
    }
  }
  return response
}

async function viaOpenAI(content: string): Promise<string | null> {
  if (!OPENAI_API_KEY) return null
  const response = await fetchRetry(() => fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: 'gpt-4.1',
      max_tokens: 2000,
      temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
    }),
  }), (s) => s === 429 || s >= 500)
  if (!response?.ok) {
    console.error(`OpenAI API ${response?.status}: ${(await response?.text().catch(() => '') || '').slice(0, 300)}`)
    return null
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content || null
}

async function viaClaude(content: string): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null
  const response = await fetchRetry(() => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
    }),
  }), (s) => s === 429 || s === 529 || s >= 500)
  if (!response?.ok) {
    console.error(`Claude API ${response?.status}: ${(await response?.text().catch(() => '') || '').slice(0, 300)}`)
    return null
  }
  const data = await response.json()
  return data.content?.[0]?.text || null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const { transcript, prompt } = await req.json()

    if (!transcript || transcript.trim().length < 50) {
      return new Response(JSON.stringify({ error: 'Transcricao muito curta' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'Nenhuma chave de LLM configurada (OPENAI_API_KEY / ANTHROPIC_API_KEY)' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const content = prompt || transcript
    let text = await viaOpenAI(content)
    if (!text) {
      console.log('OpenAI indisponivel — usando Claude como reserva')
      text = await viaClaude(content)
    }
    if (!text) {
      return new Response(JSON.stringify({ error: 'OpenAI e Claude falharam — ver logs da function' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Extrair JSON da resposta
    let jsonStr = text
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) jsonStr = jsonMatch[1]
    const braceMatch = jsonStr.match(/\{[\s\S]*\}/)
    if (braceMatch) jsonStr = braceMatch[0]

    // Sanitizar: trocar undefined por null (o modelo as vezes retorna undefined literal)
    jsonStr = jsonStr.replace(/:\s*undefined/g, ': null')

    const result = JSON.parse(jsonStr.trim())

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
