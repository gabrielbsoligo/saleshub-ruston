// =============================================
// CallAnalyzer - Analisa transcrições de calls via Edge Function (Claude)
// =============================================

import {
  PRODUTOS_MRR,
  PRODUTOS_OT,
  TIER_LABELS,
  type CallAnalysisResult,
} from '../types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
 * Analisa a transcricao via Edge Function (Claude server-side).
 */
export async function analyzeTranscript(transcript: string): Promise<CallAnalysisResult> {
  if (!transcript || transcript.trim().length < 50) {
    throw new Error('Transcricao muito curta ou vazia para analise');
  }

  const prompt = buildPrompt(transcript);

  const response = await fetch(`${SUPABASE_URL}/functions/v1/analyze-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ transcript, prompt }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error || `Erro ${response.status}`);
  }

  const result: CallAnalysisResult = await response.json();

  // Validar e sanitizar
  result.produtos_ot = (result.produtos_ot || []).filter((p) =>
    (PRODUTOS_OT as readonly string[]).includes(p)
  );
  result.produtos_mrr = (result.produtos_mrr || []).filter((p) =>
    (PRODUTOS_MRR as readonly string[]).includes(p)
  );
  result.bant = Math.max(1, Math.min(4, Math.round(result.bant || 1)));
  result.valor_escopo = Math.max(0, result.valor_escopo || 0);
  result.valor_recorrente = Math.max(0, result.valor_recorrente || 0);

  return result;
}
