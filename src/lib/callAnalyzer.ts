// =============================================
// CallAnalyzer - Analisa transcrições de calls de vendas com Claude (Anthropic)
// Fallback: Gemini se Anthropic não configurada
// =============================================

import {
  PRODUTOS_MRR,
  PRODUTOS_OT,
  TIER_LABELS,
  type CallAnalysisResult,
} from '../types';

const ANTHROPIC_API_KEY = (process.env as any).ANTHROPIC_API_KEY || '';
const GEMINI_API_KEY = (process.env as any).GEMINI_API_KEY || '';

const SYSTEM_INSTRUCTION = `Voce e um analista especializado em calls de vendas da V4 Company, uma assessoria de marketing digital.
Sua funcao e analisar transcricoes de reunioes de vendas e extrair dados estruturados para alimentar o CRM automaticamente.
Responda SEMPRE em portugues brasileiro. Seja preciso e objetivo.
Retorne APENAS um JSON valido, sem texto adicional, sem markdown, sem code blocks.`;

function buildPrompt(transcript: string): string {
  const produtosMrrList = PRODUTOS_MRR.join(', ');
  const produtosOtList = PRODUTOS_OT.join(', ');
  const tierList = Object.entries(TIER_LABELS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n');

  return `Analise a seguinte transcricao de uma call de vendas e extraia os dados estruturados.
Retorne APENAS um JSON valido com os campos especificados.

## Regras de Classificacao

### Temperatura
- "quente": Proposta foi formalizada, cliente demonstrou alta intencao de fechar, pediu contrato ou proximos passos concretos
- "morno": Cliente demonstrou interesse mas tem objecoes, marcou segunda call, pediu para pensar
- "frio": Cliente deu negativa, nao demonstrou interesse, nao quer prosseguir

### BANT Score (1-4)
- 1: Apenas Budget (orcamento) foi discutido
- 2: Budget + Authority (decisor identificado)
- 3: Budget + Authority + Need (necessidade clara)
- 4: Todos - Budget + Authority + Need + Timeline (prazo definido)

### Tier (por faturamento mensal do cliente)
${tierList}

### Produtos Disponiveis
**MRR (recorrentes):** ${produtosMrrList}
**OT (one-time):** ${produtosOtList}

IMPORTANTE: So inclua produtos que foram EXPLICITAMENTE discutidos na call. Use os nomes EXATOS da lista acima.

### Valores (OT e MRR)
- valor_escopo (OT): e o VALOR TOTAL do projeto one-time. Se o closer mencionar parcelas (ex: "12x de R$3.746"), calcule o total (ex: 12 x 3746 = R$44.952). Nunca use o valor da parcela como valor do escopo.
- valor_recorrente (MRR): e o valor MENSAL recorrente que o cliente pagara apos o projeto inicial.

### Indicacoes / Recomendacoes
Extraia nomes de pessoas/empresas que o lead INDICOU ou RECOMENDOU durante a conversa. Inclua telefone se mencionado.

### Proxima Reuniao
Se foi combinada uma proxima reuniao, extraia data e horario. Se nao foi mencionada, retorne null.

## Formato do JSON de resposta
{
  "temperatura": "quente" | "morno" | "frio",
  "valor_escopo": number,
  "valor_recorrente": number,
  "produtos_ot": ["nome exato do produto"],
  "produtos_mrr": ["nome exato do produto"],
  "bant": number (1-4),
  "tier": "tiny" | "small" | "medium" | "large" | "enterprise",
  "resumo_executivo": "string max 200 palavras em pt-br",
  "indicacoes": [{"nome": "string", "empresa": "string", "telefone": "string ou undefined"}],
  "proxima_reuniao": {"data": "YYYY-MM-DD", "hora": "HH:MM"} | null
}

## Transcricao da Call

${transcript}`;
}

/**
 * Analisa via Anthropic Claude API (chamada direta via fetch)
 */
async function analyzeWithClaude(transcript: string): Promise<CallAnalysisResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: SYSTEM_INSTRUCTION,
      messages: [
        { role: 'user', content: buildPrompt(transcript) },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Claude retornou resposta vazia');

  // Extrair JSON da resposta (pode vir com markdown code block)
  let jsonStr = text;
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonStr = jsonMatch[1];
  // Ou pode ter texto antes/depois do JSON
  const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (braceMatch) jsonStr = braceMatch[0];

  return JSON.parse(jsonStr.trim());
}

/**
 * Analisa via Google Gemini API (fallback)
 */
async function analyzeWithGemini(transcript: string): Promise<CallAnalysisResult> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: buildPrompt(transcript),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini retornou resposta vazia');
  return JSON.parse(text);
}

/**
 * Analisa a transcricao de uma call de vendas.
 * Usa Claude (Anthropic) como primario, Gemini como fallback.
 */
export async function analyzeTranscript(transcript: string): Promise<CallAnalysisResult> {
  if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
    throw new Error('Nenhuma API key configurada. Adicione ANTHROPIC_API_KEY ou GEMINI_API_KEY no .env.local');
  }

  if (!transcript || transcript.trim().length < 50) {
    throw new Error('Transcricao muito curta ou vazia para analise');
  }

  let result: CallAnalysisResult;

  if (ANTHROPIC_API_KEY) {
    try {
      result = await analyzeWithClaude(transcript);
    } catch (e: any) {
      console.warn('Claude falhou, tentando Gemini:', e.message);
      if (!GEMINI_API_KEY) throw e;
      result = await analyzeWithGemini(transcript);
    }
  } else {
    result = await analyzeWithGemini(transcript);
  }

  // Validar e sanitizar produtos (so aceitar nomes da taxonomia)
  result.produtos_ot = (result.produtos_ot || []).filter((p) =>
    (PRODUTOS_OT as readonly string[]).includes(p)
  );
  result.produtos_mrr = (result.produtos_mrr || []).filter((p) =>
    (PRODUTOS_MRR as readonly string[]).includes(p)
  );

  // Validar BANT range
  result.bant = Math.max(1, Math.min(4, Math.round(result.bant || 1)));

  // Validar valores nao-negativos
  result.valor_escopo = Math.max(0, result.valor_escopo || 0);
  result.valor_recorrente = Math.max(0, result.valor_recorrente || 0);

  return result;
}
