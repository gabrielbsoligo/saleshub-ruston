// Edge Function: parse-contract
// Recebe PDF do contrato (base64 ou URL), envia direto pro Claude (lê PDF nativo)
// e extrai produtos, preços e datas estruturados.

import { createClient } from 'npm:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ============================================================
// Prompt
// ============================================================

const PARSE_PROMPT = `Analise este contrato V4 Company (SOW - Statement of Work) e extraia os dados estruturados.
Retorne APENAS um JSON valido, sem texto adicional.

## O que extrair

### Secao "CONDICOES DA CONTRATACAO" (pagina 1)

**Recorrente (MRR):**
- "Valor mensal do projeto: R$ X.XXX,XX" → valor_recorrente
- "Data do primeiro pagamento recorrente: DD de MMMM de AAAA" → data_pgto_recorrente
- "Data de inicio do projeto: DD de MMMM de AAAA" → data_inicio_recorrente

**Implementacao (OT / Pontual):**
- "Valor de implementacao (pontual): R$ XX.XXX,XX" → valor_escopo
- "Data de inicio do escopo fechado: DD de MMMM de AAAA" → data_inicio_escopo
- "Data do primeiro pagamento: DD de MMMM de AAAA" → data_pgto_escopo

### Secao "DESCRITIVO DO SERVICO/PRODUTO"

Identifique TODOS os produtos/servicos contratados:

**Produtos MRR (recorrentes):**
- "Profissional de Midia Paga" → "Gestor de Trafego"
- "Profissional de Design Grafico" → "Designer"
- "Profissional de Social Media" → "Social Media"
- "IA SDR" ou "inteligencia artificial" → "IA"
- "Landing Page" como servico recorrente → "Landing Page Recorrente"
- "CRM" como servico recorrente → "CRM"
- "e-mail marketing" ou "disparos mensais" → "Email Mkt"

**Produtos OT (one-time):**
- "Diagnostico e Planejamento" → "Estruturacao Estrategica"
- "Landing Page (Wireframe)" → "LP One Time"
- "manual de identidade Visual (MIV)" → "MIV"
- "Site" como entrega pontual → "Site"
- "Implementacao CRM" → "Implementacao CRM"
- "Implementacao IA" → "Implementacao IA"

IMPORTANTE: Use EXATAMENTE os nomes listados acima. Datas no formato YYYY-MM-DD.

## JSON
{
  "empresa": "nome da contratante",
  "cnpj": "apenas numeros",
  "produtos_mrr": ["nomes exatos"],
  "produtos_ot": ["nomes exatos"],
  "valor_recorrente": number,
  "valor_escopo": number,
  "data_inicio_recorrente": "YYYY-MM-DD" | null,
  "data_pgto_recorrente": "YYYY-MM-DD" | null,
  "data_inicio_escopo": "YYYY-MM-DD" | null,
  "data_pgto_escopo": "YYYY-MM-DD" | null,
  "parcelas_mrr": number | null,
  "parcelas_ot": number | null
}`

// ============================================================
// Claude with native PDF reading
// ============================================================

async function analyzeContractPdf(pdfBase64: string): Promise<any> {
  const maxRetries = 3
  let response: Response | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: pdfBase64,
                },
              },
              {
                type: 'text',
                text: PARSE_PROMPT,
              },
            ],
          },
        ],
        temperature: 0.1,
      }),
    })

    if (response.ok || (response.status !== 429 && response.status !== 529)) break
    if (attempt < maxRetries) {
      console.log(`Claude API ${response.status}, retry ${attempt}/${maxRetries}...`)
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)))
    }
  }

  if (!response || !response.ok) {
    const err = await response?.text() || 'No response'
    throw new Error(`Claude API ${response?.status}: ${err}`)
  }

  const data = await response.json()
  const textOut = data.content?.[0]?.text || ''

  let jsonStr = textOut
  const jsonMatch = textOut.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) jsonStr = jsonMatch[1]
  const braceMatch = jsonStr.match(/\{[\s\S]*\}/)
  if (braceMatch) jsonStr = braceMatch[0]

  return JSON.parse(jsonStr.trim())
}

// ============================================================
// HTTP entry
// ============================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json()
    const { pdf_base64, contract_url } = body

    if (!ANTHROPIC_API_KEY) {
      return json({ error: 'ANTHROPIC_API_KEY nao configurada' }, 500)
    }

    let base64Data = pdf_base64 || ''

    // If URL provided, download PDF and convert to base64
    if (contract_url && !base64Data) {
      console.log(`Downloading PDF from: ${contract_url}`)
      const resp = await fetch(contract_url)
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)
      const arrayBuffer = await resp.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)

      // Convert to base64
      let binary = ''
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      base64Data = btoa(binary)
      console.log(`PDF downloaded: ${bytes.length} bytes, base64: ${base64Data.length} chars`)
    }

    if (!base64Data) {
      return json({ error: 'Envie pdf_base64 ou contract_url' }, 400)
    }

    const result = await analyzeContractPdf(base64Data)

    // Validate products
    const VALID_MRR = ['Gestor de Tráfego','Designer','Social Media','IA','Landing Page Recorrente','CRM','Email Mkt']
    const VALID_OT = ['Estruturação Estratégica','Site','MIV','DRX','LP One Time','Implementação CRM','Implementação IA']

    result.produtos_mrr = (result.produtos_mrr || []).filter((p: string) => VALID_MRR.includes(p))
    result.produtos_ot = (result.produtos_ot || []).filter((p: string) => VALID_OT.includes(p))
    result.valor_escopo = Math.max(0, result.valor_escopo || 0)
    result.valor_recorrente = Math.max(0, result.valor_recorrente || 0)

    return json({ ok: true, ...result })
  } catch (e: any) {
    console.error('parse-contract error:', e)
    return json({ error: e.message }, 500)
  }
})

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
