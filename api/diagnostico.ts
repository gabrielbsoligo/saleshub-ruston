import Anthropic from "@anthropic-ai/sdk";

export const config = {
  maxDuration: 60,
};

const SYSTEM_PROMPT = `Você é um Especialista em Growth Marketing da V4 Company. Realiza análise diagnóstica completa de leads pré-vendas seguindo o método V4 (Tráfego, Engajamento, Conversão, Retenção).

Sua tarefa: receber dados de um lead e devolver um diagnóstico estruturado em JSON estrito (sem markdown, sem texto antes ou depois).

Use a ferramenta web_search liberalmente para:
1. Acessar o site do lead e verificar velocidade/proposta/CTA/mobile
2. Buscar anúncios ativos na Meta Ads Library (https://www.facebook.com/ads/library/?q={empresa}&country=BR)
3. Identificar 3 concorrentes diretos no segmento e região
4. Pesquisar Instagram e presença digital

RESPONDA APENAS COM JSON VÁLIDO seguindo EXATAMENTE este schema:

{
  "empresa": "string",
  "segmento_corrigido": "string ou null se segmento informado estiver correto",
  "segmento_justificativa": "string de 1 linha ou null",
  "faturamento_atual": "string (ex: R$ 350.000/mês)",
  "meta_faturamento": "string ou null",
  "sumario_executivo": [
    {"titulo": "string curto (max 30 chars)", "status": "critico|atencao|ok", "resumo": "string (max 80 chars)"}
  ],
  "analise_site": [
    {"aspecto": "Velocidade|Proposta|Rastreamento|UX/UI|CTA|Mobile", "status": "critico|atencao|ok", "observacao": "string curta"}
  ],
  "instagram": {
    "posicionamento": "Autoridade|Vitrine|Misto|Inexistente",
    "engajamento": "string curta",
    "link_bio": "string curta",
    "observacoes": ["array de 3-5 bullets curtos"]
  },
  "meta_ads": {
    "presenca": "Ativa|Inativa|Fraca",
    "criativos": "string curta sobre variedade",
    "niveis_consciencia": "string curta",
    "observacoes": ["array de 3-5 bullets"]
  },
  "score_maturidade": [
    {"dimensao": "Tráfego", "nota": 0-10, "status": "Crítico|Fraco|Médio|Bom|Excelente", "justificativa": "1 linha"},
    {"dimensao": "Engajamento", "nota": 0-10, "status": "...", "justificativa": "..."},
    {"dimensao": "Conversão", "nota": 0-10, "status": "...", "justificativa": "..."},
    {"dimensao": "Retenção", "nota": 0-10, "status": "...", "justificativa": "..."}
  ],
  "media_total": "número 0-10 com uma casa decimal",
  "concorrentes": [
    {"nome": "string", "site": "url", "instagram": "@handle", "meta_ads": "Ativo|Inativo|Fraco", "diferencial": "string curta", "vantagem_sobre_lead": "string curta"}
  ],
  "maior_ameaca": {"concorrente": "nome", "motivo": "string curta"},
  "oportunidade_exclusiva": "string — oportunidade que nenhum concorrente explora",
  "gaps": [
    {"titulo": "string curto", "descricao": "string", "impacto_estimado": "string (ex: R$ 20k/mês perdidos)"}
  ],
  "quick_wins": [
    {"titulo": "string", "descricao": "string", "timeline": "string (ex: 7 dias)", "impacto": "string"}
  ],
  "plano_90_dias": {
    "mes_1": {"fase": "Fundação", "iniciativas": ["3-4 bullets"]},
    "mes_2": {"fase": "Ativação", "iniciativas": ["3-4 bullets"]},
    "mes_3": {"fase": "Escala", "iniciativas": ["3-4 bullets"]}
  },
  "pergunta_impacto": "string — pergunta provocativa pra abrir reunião"
}

Regras:
- sumario_executivo: EXATAMENTE 4 cards
- analise_site: EXATAMENTE 6 linhas (uma por aspecto listado)
- score_maturidade: EXATAMENTE 4 dimensões
- concorrentes: EXATAMENTE 3 concorrentes
- gaps: EXATAMENTE 4 gaps
- quick_wins: EXATAMENTE 3 quick wins
- Tudo em português do Brasil.
- Baseado em dados reais pesquisados. Se não tiver info, escreva "N/D" ou "não identificado" no campo.
- NÃO invente seguidores/métricas. Se não conseguir confirmar, seja vago ("baixo engajamento aparente").
- Retorne APENAS o JSON. Nada de \`\`\`json, nada de explicação.`;

function buildUserMessage(body: any): string {
  const empresa = body.empresa || "não informado";
  const adsLibUrl = body.adsLink || `https://www.facebook.com/ads/library/?q=${encodeURIComponent(empresa)}&country=BR`;

  return [
    `Empresa: ${empresa}`,
    `Segmento: ${body.segmento || "E-commerce"}`,
    `Site: ${body.site || "não informado"}`,
    `Instagram: ${body.instagram || "não informado"}`,
    body.adsLink ? `Meta Ads Library: ${body.adsLink}` : `Meta Ads: buscar em ${adsLibUrl}`,
    body.adsDesc ? `Anúncios conhecidos: ${body.adsDesc}` : null,
    body.fat ? `Faturamento atual: ${body.fat}` : null,
    body.fatMeta ? `Meta: ${body.fatMeta}` : null,
    body.concorrentes ? `Concorrentes conhecidos: ${body.concorrentes}` : `Concorrentes: pesquisar os 3 principais do segmento e região`,
    body.contexto ? `Contexto: ${body.contexto}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  if (!body?.empresa && !body?.contexto) {
    return res.status(400).json({ error: "empresa ou contexto obrigatório" });
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 8,
        } as any,
      ],
      messages: [{ role: "user", content: buildUserMessage(body) }],
    });

    // Extract final text content (after tool uses)
    const textBlocks = response.content.filter((b: any) => b.type === "text");
    const fullText = textBlocks.map((b: any) => b.text).join("\n").trim();

    // Try to parse JSON (handle possible ```json fences even though prompt says no)
    let jsonStr = fullText;
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Find first { and last } to be robust
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first >= 0 && last > first) {
      jsonStr = jsonStr.slice(first, last + 1);
    }

    let diagnostico;
    try {
      diagnostico = JSON.parse(jsonStr);
    } catch (e: any) {
      return res.status(502).json({
        error: "Resposta da IA não está em JSON válido",
        raw: fullText.slice(0, 2000),
      });
    }

    return res.status(200).json({
      diagnostico,
      usage: response.usage,
    });
  } catch (e: any) {
    console.error("Erro Anthropic:", e);
    return res.status(500).json({
      error: e?.message || "Erro desconhecido",
      type: e?.type,
    });
  }
}
