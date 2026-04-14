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

const PARSE_PROMPT = `Analise TODAS as paginas deste contrato V4 Company (SOW - Statement of Work) e extraia os dados estruturados.
Retorne APENAS um JSON valido, sem texto adicional.

IMPORTANTE: Leia o documento INTEIRO, pagina por pagina. Os produtos estao espalhados em MULTIPLAS paginas.

## PASSO 1: Valores e datas (secao "CONDICOES DA CONTRATACAO", geralmente pagina 1)

**Recorrente (MRR):**
- "Valor mensal do projeto: R$ X.XXX,XX" → valor_recorrente
- "Data do primeiro pagamento recorrente: DD de MMMM de AAAA" → data_pgto_recorrente
- "Data de inicio do projeto: DD de MMMM de AAAA" → data_inicio_recorrente

**Implementacao (OT / Pontual):**
- "Valor de implementacao (pontual): R$ XX.XXX,XX" → valor_escopo
- "Data de inicio do escopo fechado: DD de MMMM de AAAA" → data_inicio_escopo
- "Data do primeiro pagamento: DD de MMMM de AAAA" → data_pgto_escopo

## PASSO 2: Identificar produtos (DUAS fontes — use AMBAS)

**Fonte A — Servicos inclusos na pagina 1 (logo apos condicoes):**
Procure a frase "estao inclusos no presente contrato os seguintes servicos" e leia os itens (i, ii, iii...).
Exemplo: "Landing Pages" → Landing Page Recorrente, "IA SDR" → IA, "e-mail marketing" → Email Mkt

**Fonte B — Secao "DESCRITIVO DO SERVICO/PRODUTO" (paginas 2, 3, 4...):**
Cada produto tem um bloco "Entregaveis:" seguido de descricao e "Diretrizes Especificas:".
Percorra TODAS as paginas e identifique CADA bloco "Entregaveis:".
Exemplos reais de como aparecem:
- "O Profissional de Midia Paga atua no planejamento..." → Gestor de Trafego
- "O Profissional de Design Grafico e responsavel..." → Designer
- "O Profissional de Social Media planeja..." → Social Media
- "O Profissional de CRM..." → CRM

## Tabela de mapeamento (use EXATAMENTE estes nomes)

**Produtos MRR (recorrentes):**
| Texto no contrato | Nome no sistema |
|---|---|
| "Profissional de Midia Paga" ou "Midia Paga" | Gestor de Trafego |
| "Profissional de Design Grafico" ou "Design Grafico" | Designer |
| "Profissional de Social Media" ou "Social Media" | Social Media |
| "IA SDR" ou "inteligencia artificial" ou "ferramenta de IA" | IA |
| "Landing Page" (servico recorrente/manutencao) | Landing Page Recorrente |
| "CRM" (servico recorrente) | CRM |
| "e-mail marketing" ou "disparos mensais" | Email Mkt |

**Produtos OT (one-time / escopo fechado):**
| Texto no contrato | Nome no sistema |
|---|---|
| "Diagnostico e Planejamento" ou "Estruturacao" | Estruturacao Estrategica |
| "Landing Page (Wireframe)" (entrega pontual) | LP One Time |
| "Manual de Identidade Visual" ou "MIV" | MIV |
| "Site" (entrega pontual) | Site |
| "Implementacao CRM" | Implementacao CRM |
| "Implementacao IA" | Implementacao IA |

## PASSO 3: Gerar JSON

Datas no formato YYYY-MM-DD.

{
  "empresa": "nome da contratante",
  "cnpj": "apenas numeros",
  "produtos_mrr": ["nomes EXATOS da tabela acima"],
  "produtos_ot": ["nomes EXATOS da tabela acima"],
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
        max_tokens: 4000,
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

    // Validate products (normalize accents for matching)
    const VALID_MRR = ['Gestor de Tráfego','Designer','Social Media','IA','Landing Page Recorrente','CRM','Email Mkt']
    const VALID_OT = ['Estruturação Estratégica','Site','MIV','DRX','LP One Time','Implementação CRM','Implementação IA']

    const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    const findMatch = (p: string, validList: string[]) => validList.find(v => normalize(v) === normalize(p))

    result.produtos_mrr = (result.produtos_mrr || [])
      .map((p: string) => findMatch(p, VALID_MRR))
      .filter(Boolean)
    result.produtos_ot = (result.produtos_ot || [])
      .map((p: string) => findMatch(p, VALID_OT))
      .filter(Boolean)
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
