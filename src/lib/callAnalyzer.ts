// =============================================
// CallAnalyzer - Analisa transcrições de calls de vendas com Gemini
// =============================================

import { GoogleGenAI, Type } from '@google/genai';
import {
  PRODUTOS_MRR,
  PRODUTOS_OT,
  TIER_LABELS,
  type CallAnalysisResult,
  type DealTier,
  type Temperatura,
} from '../types';

// API Key injetada pelo Vite (vite.config.ts define process.env.GEMINI_API_KEY)
const GEMINI_API_KEY = (process.env as any).GEMINI_API_KEY || '';

const SYSTEM_INSTRUCTION = `Voce e um analista especializado em calls de vendas da V4 Company, uma assessoria de marketing digital.
Sua funcao e analisar transcricoes de reunioes de vendas e extrair dados estruturados para alimentar o CRM automaticamente.
Responda SEMPRE em portugues brasileiro. Seja preciso e objetivo.`;

function buildPrompt(transcript: string): string {
  const produtosMrrList = PRODUTOS_MRR.join(', ');
  const produtosOtList = PRODUTOS_OT.join(', ');
  const tierList = Object.entries(TIER_LABELS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n');

  return `Analise a seguinte transcricao de uma call de vendas e extraia os dados estruturados.

## Regras de Classificacao

### Temperatura
- **quente**: Proposta foi formalizada, cliente demonstrou alta intencao de fechar, pediu contrato ou proximos passos concretos
- **morno**: Cliente demonstrou interesse mas tem objecoes, marcou segunda call, pediu para pensar
- **frio**: Cliente deu negativa, nao demonstrou interesse, nao quer prosseguir

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
- valor_recorrente (MRR): e o valor MENSAL recorrente que o cliente pagara apos o projeto inicial. Ex: "R$4.900 por mes".

### Indicacoes / Recomendacoes
Extraia nomes de pessoas/empresas que o lead INDICOU ou RECOMENDOU durante a conversa. Inclua telefone se mencionado.

### Proxima Reuniao
Se foi combinada uma proxima reuniao, extraia data e horario. Se nao foi mencionada, retorne null.

## Transcricao da Call

${transcript}`;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    temperatura: {
      type: Type.STRING,
      enum: ['quente', 'morno', 'frio'],
      description: 'Temperatura/qualificacao do lead',
    },
    valor_escopo: {
      type: Type.NUMBER,
      description: 'Valor total do escopo OT (one-time) em reais. 0 se nao mencionado.',
    },
    valor_recorrente: {
      type: Type.NUMBER,
      description: 'Valor recorrente mensal (MRR) em reais. 0 se nao mencionado.',
    },
    produtos_ot: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Produtos one-time discutidos (usar nomes exatos da taxonomia)',
    },
    produtos_mrr: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Produtos recorrentes discutidos (usar nomes exatos da taxonomia)',
    },
    bant: {
      type: Type.NUMBER,
      description: 'BANT score de 1 a 4',
    },
    tier: {
      type: Type.STRING,
      enum: ['tiny', 'small', 'medium', 'large', 'enterprise'],
      description: 'Tier do cliente baseado no faturamento mencionado',
    },
    resumo_executivo: {
      type: Type.STRING,
      description: 'Resumo executivo da call em portugues: pontos-chave, objecoes, proximos passos. Maximo 200 palavras.',
    },
    indicacoes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          nome: { type: Type.STRING, description: 'Nome da pessoa indicada' },
          empresa: { type: Type.STRING, description: 'Empresa da pessoa indicada' },
          telefone: { type: Type.STRING, description: 'Telefone se mencionado' },
        },
        required: ['nome', 'empresa'],
      },
      description: 'Indicacoes/recomendacoes extraidas da conversa',
    },
    proxima_reuniao: {
      type: Type.OBJECT,
      properties: {
        data: { type: Type.STRING, description: 'Data no formato YYYY-MM-DD' },
        hora: { type: Type.STRING, description: 'Horario no formato HH:MM' },
      },
      required: ['data', 'hora'],
      nullable: true,
      description: 'Proxima reuniao combinada, ou null se nao mencionada',
    },
  },
  required: [
    'temperatura',
    'valor_escopo',
    'valor_recorrente',
    'produtos_ot',
    'produtos_mrr',
    'bant',
    'tier',
    'resumo_executivo',
    'indicacoes',
    'proxima_reuniao',
  ],
};

/**
 * Analisa a transcricao de uma call de vendas usando Google Gemini.
 * Retorna dados estruturados para preencher o deal automaticamente.
 */
export async function analyzeTranscript(transcript: string): Promise<CallAnalysisResult> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY nao configurada. Adicione no .env.local');
  }

  if (!transcript || transcript.trim().length < 50) {
    throw new Error('Transcricao muito curta ou vazia para analise');
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const response = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: buildPrompt(transcript),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.2, // baixa temperatura para respostas mais consistentes
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Gemini retornou resposta vazia');
  }

  const result: CallAnalysisResult = JSON.parse(text);

  // Validar e sanitizar produtos (so aceitar nomes da taxonomia)
  result.produtos_ot = result.produtos_ot.filter((p) =>
    (PRODUTOS_OT as readonly string[]).includes(p)
  );
  result.produtos_mrr = result.produtos_mrr.filter((p) =>
    (PRODUTOS_MRR as readonly string[]).includes(p)
  );

  // Validar BANT range
  result.bant = Math.max(1, Math.min(4, Math.round(result.bant)));

  // Validar valores nao-negativos
  result.valor_escopo = Math.max(0, result.valor_escopo);
  result.valor_recorrente = Math.max(0, result.valor_recorrente);

  return result;
}
