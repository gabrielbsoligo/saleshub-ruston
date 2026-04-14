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

function buildPrompt(transcript: string, meetingDate: string): string {
  const produtosMrrList = PRODUTOS_MRR.join(', ');
  const produtosOtList = PRODUTOS_OT.join(', ');
  const tierList = Object.entries(TIER_LABELS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n');

  return `Analise a seguinte transcricao de uma call de vendas e extraia os dados estruturados.
Retorne APENAS um JSON valido com os campos especificados.

## Regras de Classificacao

### Temperatura
- "quente": Cliente vai analisar contrato, pediu proposta formal, ou ja tomou decisao de fechar na call
- "morno": Cliente precisa levar para o decisor, ou tem interesse mas depende de outra pessoa
- "frio": Nao tem data definida para fechar, cliente indefinido, sem compromisso concreto

### Proximo Passo
Baseado na analise da call, determine o proximo passo do deal:
- "contrato_na_rua": Cliente pediu contrato ou esta analisando proposta formal (temperatura quente)
- "contrato_assinado": Cliente confirmou fechamento na propria call
- "negociacao": Ainda em negociacao ativa, com proxima reuniao marcada
- "follow_longo": Sem data definida para proximo contato, acompanhamento de longo prazo
- "perdido": Cliente deu negativa clara, nao quer prosseguir

### BANT Score (1-4)
- 1: Apenas Budget (orcamento) foi discutido
- 2: Budget + Authority (decisor identificado)
- 3: Budget + Authority + Need (necessidade clara)
- 4: Todos - Budget + Authority + Need + Timeline (prazo definido)

### Tier (classificar pelo FATURAMENTO MENSAL do cliente)
O tier e baseado no faturamento MENSAL da empresa do lead (NAO o valor da proposta V4):
${tierList}
ATENCAO: Use o faturamento que o LEAD menciona sobre a empresa DELE, nao o valor da proposta.
Exemplo: se o lead diz "faturamos 120 mil por mes", o tier e "small" (101k-400k).
Exemplo: se o lead diz "faturamento de 300k mensal", o tier e "small" (101k-400k).
Exemplo: se o lead diz "50 mil por mes", o tier e "tiny" (51k-100k).
Se o faturamento nao for mencionado, use "small" como padrao.

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
Extraia a data e horario da proxima reuniao combinada. Preste MUITA ATENCAO a este campo:
- Procure frases como "amanha as 10h", "quinta-feira as 14h", "semana que vem", "dia 15 as 14h"
- Se disser "amanha as 10h", calcule a data de amanha a partir da data da reuniao atual
- Se disser "quinta-feira", calcule qual e a proxima quinta a partir da data da reuniao
- SEMPRE inclua o horario no formato HH:MM (ex: "10:00", "14:00", "09:30")
- Se nao foi mencionada NENHUMA proxima reuniao, retorne null
- Se mencionou data mas nao horario, use "10:00" como padrao

## Formato do JSON de resposta
{
  "temperatura": "quente" | "morno" | "frio",
  "proximo_passo": "negociacao" | "contrato_na_rua" | "contrato_assinado" | "follow_longo" | "perdido",
  "valor_escopo": number,
  "valor_recorrente": number,
  "produtos_ot": ["nome exato do produto"],
  "produtos_mrr": ["nome exato do produto"],
  "bant": number (1-4),
  "tier": "tiny" | "small" | "medium" | "large" | "enterprise",
  "resumo_executivo": "string max 200 palavras em pt-br",
  "indicacoes": [{"nome": "string", "empresa": "string", "telefone": "string ou null"}],
  "proxima_reuniao": {"data": "YYYY-MM-DD", "hora": "HH:MM"} | null
}

## Data da Reuniao
A reuniao ocorreu em: ${meetingDate}
Use esta data como referencia para calcular datas relativas como "amanha", "semana que vem", "proxima quinta", etc.
Exemplo: se a reuniao foi em 2026-04-07 e disseram "amanha as 10h", a proxima reuniao e 2026-04-08 as 10:00.

## Transcricao da Call

${transcript}`;
}

/**
 * Analisa a transcricao via Edge Function (Claude server-side).
 * @param meetingDate - data da reuniao no formato YYYY-MM-DD (para calcular datas relativas)
 */
export async function analyzeTranscript(transcript: string, meetingDate?: string): Promise<CallAnalysisResult> {
  if (!transcript || transcript.trim().length < 50) {
    throw new Error('Transcricao muito curta ou vazia para analise');
  }

  const prompt = buildPrompt(transcript, meetingDate || new Date().toISOString().split('T')[0]);

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
