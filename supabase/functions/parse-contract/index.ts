// Edge Function: parse-contract
// Recebe URL do PDF do contrato (já no Supabase Storage), extrai texto e
// usa Claude para extrair produtos, preços e datas estruturados.

import { createClient } from 'npm:@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ============================================================
// PDF text extraction (basic — works for text-based PDFs)
// ============================================================

async function extractTextFromPdf(pdfBytes: Uint8Array): Promise<string> {
  // Deno doesn't have native PDF parsing, so we extract text using a simple
  // approach: decode PDF stream objects. For V4 contracts (text-based, not scanned),
  // this works well enough. We use pdf-parse compatible approach.

  // Convert to string and find text between BT/ET markers or stream objects
  const decoder = new TextDecoder('latin1')
  const raw = decoder.decode(pdfBytes)

  const textChunks: string[] = []

  // Method 1: Extract from text objects (BT...ET blocks with Tj/TJ operators)
  const btEtRegex = /BT\s([\s\S]*?)ET/g
  let match
  while ((match = btEtRegex.exec(raw)) !== null) {
    const block = match[1]
    // Extract Tj strings: (text) Tj
    const tjRegex = /\(([^)]*)\)\s*Tj/g
    let tjMatch
    while ((tjMatch = tjRegex.exec(block)) !== null) {
      textChunks.push(decodePdfString(tjMatch[1]))
    }
    // Extract TJ arrays: [(text) number (text)] TJ
    const tjArrayRegex = /\[(.*?)\]\s*TJ/g
    let tjArrMatch
    while ((tjArrMatch = tjArrayRegex.exec(block)) !== null) {
      const arrContent = tjArrMatch[1]
      const strRegex = /\(([^)]*)\)/g
      let strMatch
      while ((strMatch = strRegex.exec(arrContent)) !== null) {
        textChunks.push(decodePdfString(strMatch[1]))
      }
    }
  }

  // Method 2: Extract from stream/endstream blocks (decompressed)
  // This catches text in content streams
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g
  while ((match = streamRegex.exec(raw)) !== null) {
    const content = match[1]
    // Only process if it looks like text content (has BT/ET or text operators)
    if (content.includes('Tj') || content.includes('TJ')) {
      const innerBt = /BT\s([\s\S]*?)ET/g
      let innerMatch
      while ((innerMatch = innerBt.exec(content)) !== null) {
        const block = innerMatch[1]
        const tjRegex = /\(([^)]*)\)\s*Tj/g
        let tjMatch
        while ((tjMatch = tjRegex.exec(block)) !== null) {
          textChunks.push(decodePdfString(tjMatch[1]))
        }
        const tjArrayRegex = /\[(.*?)\]\s*TJ/g
        let tjArrMatch
        while ((tjArrMatch = tjArrayRegex.exec(block)) !== null) {
          const strRegex2 = /\(([^)]*)\)/g
          let s
          while ((s = strRegex2.exec(tjArrMatch[1])) !== null) {
            textChunks.push(decodePdfString(s[1]))
          }
        }
      }
    }
  }

  return textChunks.join(' ').replace(/\s+/g, ' ').trim()
}

function decodePdfString(s: string): string {
  // Decode PDF escape sequences and common encodings
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\(\d{3})/g, (_: string, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

// ============================================================
// Claude analysis
// ============================================================

const PARSE_PROMPT = `Analise o texto extraido de um contrato V4 Company (SOW - Statement of Work) e extraia os dados estruturados.
Retorne APENAS um JSON valido.

## Estrutura do Contrato V4

### Secao "CONDICOES DA CONTRATACAO" (pagina 1)

**Recorrente (MRR):**
- "Valor mensal do projeto: R$ X.XXX,XX" → valor_recorrente
- "Data do primeiro pagamento recorrente: DD de MMMM de AAAA" → data_pgto_recorrente
- "Data de inicio do projeto: DD de MMMM de AAAA" → data_inicio_recorrente
- "Numero de parcelas: N" → parcelas_mrr

**Implementacao (OT / Pontual):**
- "Valor de implementacao (pontual): R$ XX.XXX,XX" → valor_escopo
- "Data de inicio do escopo fechado: DD de MMMM de AAAA" → data_inicio_escopo
- "Data do primeiro pagamento: DD de MMMM de AAAA" → data_pgto_escopo
- "Quantidade de parcelas: N" → parcelas_ot

### Secao "DESCRITIVO DO SERVICO/PRODUTO"

Identifique TODOS os produtos/servicos contratados pelo texto descritivo:

**Produtos MRR (recorrentes) - identificar por:**
- "Profissional de Midia Paga" ou "campanhas digitais" → "Gestor de Trafego"
- "Profissional de Design Grafico" ou "pecas visuais" → "Designer"
- "Profissional de Social Media" ou "estrategias digitais por meio de conteudos" → "Social Media"
- "IA SDR" ou "inteligencia artificial para atendimento" → "IA"
- "Landing Page" mencionada como servico recorrente incluso → "Landing Page Recorrente"
- "CRM" como servico recorrente → "CRM"
- "e-mail marketing" ou "disparos mensais" → "Email Mkt"

**Produtos OT (one-time / pontual) - identificar por:**
- "Diagnostico e Planejamento de Marketing" ou "DRX" ou cronograma de semanas → "Estruturacao Estrategica"
- "Landing Page (Wireframe)" dentro de diagnostico → "LP One Time"
- "manual de identidade Visual (MIV)" → "MIV"
- "Site" como entrega pontual → "Site"
- "Implementacao CRM" → "Implementacao CRM"
- "Implementacao IA" → "Implementacao IA"

IMPORTANTE:
- Use EXATAMENTE os nomes dos produtos listados acima
- Se nao houver secao recorrente (sem "Valor mensal"), produtos_mrr = [] e valor_recorrente = 0
- Se nao houver implementacao pontual, produtos_ot = [] e valor_escopo = 0
- Datas no formato YYYY-MM-DD
- Valores em numero (sem R$, sem pontos de milhar)

## Formato JSON
{
  "empresa": "nome da empresa contratante",
  "cnpj": "CNPJ sem formatacao",
  "produtos_mrr": ["nomes exatos"],
  "produtos_ot": ["nomes exatos"],
  "valor_recorrente": number,
  "valor_escopo": number,
  "data_inicio_recorrente": "YYYY-MM-DD" | null,
  "data_pgto_recorrente": "YYYY-MM-DD" | null,
  "data_inicio_escopo": "YYYY-MM-DD" | null,
  "data_pgto_escopo": "YYYY-MM-DD" | null,
  "parcelas_mrr": number | null,
  "parcelas_ot": number | null,
  "forma_pagamento": "Pix" | "Boleto" | "Cartao de credito parcelado" | null
}`

async function analyzeContractText(text: string): Promise<any> {
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
        system: 'Voce e um parser de contratos da V4 Company. Extraia dados estruturados do texto do contrato. Retorne APENAS JSON valido, sem texto adicional.',
        messages: [
          { role: 'user', content: `${PARSE_PROMPT}\n\n## Texto do Contrato\n\n${text}` },
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
  const text_out = data.content?.[0]?.text || ''

  // Extract JSON
  let jsonStr = text_out
  const jsonMatch = text_out.match(/```(?:json)?\s*([\s\S]*?)```/)
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
    const { contract_url, contract_text } = await req.json()

    if (!ANTHROPIC_API_KEY) {
      return json({ error: 'ANTHROPIC_API_KEY nao configurada' }, 500)
    }

    let text = contract_text || ''

    // If URL provided, download and extract text
    if (contract_url && !text) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

      // contract_url is a Supabase Storage URL — extract bucket/path
      // Format: https://xxx.supabase.co/storage/v1/object/public/contracts/deal-id/file.pdf
      // Or signed URL
      let pdfBytes: Uint8Array

      if (contract_url.includes('/storage/v1/')) {
        // Direct Supabase storage — download via storage API
        const pathMatch = contract_url.match(/\/storage\/v1\/object\/(?:public|sign)\/(.+?)\/(.+)/)
        if (pathMatch) {
          const bucket = pathMatch[1]
          const path = decodeURIComponent(pathMatch[2])
          const { data, error } = await supabase.storage.from(bucket).download(path)
          if (error || !data) throw new Error(`Storage download failed: ${error?.message}`)
          pdfBytes = new Uint8Array(await data.arrayBuffer())
        } else {
          // Fallback: fetch directly
          const resp = await fetch(contract_url)
          if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)
          pdfBytes = new Uint8Array(await resp.arrayBuffer())
        }
      } else {
        const resp = await fetch(contract_url)
        if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)
        pdfBytes = new Uint8Array(await resp.arrayBuffer())
      }

      text = await extractTextFromPdf(pdfBytes)
      console.log(`Extracted ${text.length} chars from PDF`)

      if (text.length < 100) {
        return json({
          error: 'Texto extraido do PDF muito curto. O PDF pode ser uma imagem escaneada (nao suportado).',
          extracted_length: text.length,
        }, 400)
      }
    }

    if (!text || text.length < 100) {
      return json({ error: 'Texto do contrato nao fornecido ou muito curto' }, 400)
    }

    // Truncate to avoid token limits (contracts are ~5-10 pages)
    const truncated = text.slice(0, 15000)

    const result = await analyzeContractText(truncated)

    // Validate products against known list
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
