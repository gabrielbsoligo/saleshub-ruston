import React, { useState } from "react";
import { Sparkles, Copy, Check, Zap } from "lucide-react";
import toast from "react-hot-toast";

const SEGMENTOS = [
  "E-commerce",
  "Serviços B2B",
  "Varejo local",
  "Educação",
  "Saúde",
  "SaaS",
  "Financeiro/Consórcio",
  "Proteção Veicular",
  "Food Service",
  "Outro",
];

const METAS_FAT = [
  { value: "", label: "Meta não informada" },
  { value: "2x o atual", label: "2x o atual" },
  { value: "3x o atual", label: "3x o atual" },
  { value: "R$ 500k/mês", label: "R$ 500k/mês" },
  { value: "R$ 1M/mês", label: "R$ 1M/mês" },
  { value: "Personalizado", label: "Personalizado" },
];

function fmtFat(v: string) {
  const n = parseInt(v.replace(/\D/g, ""), 10);
  if (isNaN(n) || n === 0) return v;
  return "R$ " + n.toLocaleString("pt-BR") + "/mês";
}

function buildPrompt(f: {
  empresa: string;
  site: string;
  instagram: string;
  adsLink: string;
  adsDesc: string;
  contexto: string;
  fat: string;
  fatMeta: string;
  concorr: string;
  segmento: string;
}): string {
  const adsLibUrl =
    f.adsLink ||
    (f.empresa
      ? "https://www.facebook.com/ads/library/?q=" +
        encodeURIComponent(f.empresa) +
        "&country=BR"
      : "");

  const linhas = [
    "Empresa: " + (f.empresa || "não informado"),
    "Segmento: " + f.segmento,
    "Site: " + (f.site || "não informado"),
    "Instagram: " + (f.instagram || "não informado"),
    f.adsLink
      ? "Meta Ads Library (link): " + f.adsLink
      : "Meta Ads: não informado — buscar automaticamente em " + adsLibUrl,
    f.adsDesc ? "Anúncios ativos conhecidos: " + f.adsDesc : null,
    f.fat ? "Faturamento atual: " + fmtFat(f.fat) : null,
    f.fatMeta ? "Meta de faturamento: " + f.fatMeta : null,
    f.concorr
      ? "Concorrentes conhecidos: " + f.concorr
      : "Concorrentes: pesquisar automaticamente os principais do segmento e região",
    f.contexto ? "Contexto: " + f.contexto : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `Você é um Especialista em Growth Marketing da V4 Company. Realize uma análise diagnóstica completa do lead abaixo para uma reunião de vendas, seguindo o método V4 (Tráfego, Engajamento, Conversão, Retenção).

ETAPA 0 — RECLASSIFICAÇÃO DE SEGMENTO
Antes de analisar, verifique se o segmento informado está correto com base no contexto. Se não estiver, corrija e justifique em uma linha.

ETAPA 1 — ANÁLISE DO LEAD
1. Site — acesse o site informado antes de analisar. Verifique velocidade/percepção, proposta de valor, rastreamento (Pixel/GTM), UX/UI, CTA, mobile.
2. Instagram — posicionamento (autoridade vs vitrine), engajamento, narrativa, link da bio.
3. Meta Ads — se não houver link ou descrição, use web_search para buscar anúncios ativos na Meta Ads Library. Analise presença, variedade de criativos e níveis de consciência.
4. Gaps — onde está perdendo dinheiro hoje + 3 Quick Wins imediatos.

Use tabelas para comparações e bullet points para gaps.

ETAPA 2 — ANÁLISE COMPETITIVA
Use web_search para identificar os 3 principais concorrentes diretos da empresa no mesmo segmento e região (ou nicho digital, se for nacional). Para cada concorrente:
- Pesquise o site, Instagram e presença em anúncios
- Monte uma tabela comparativa com as colunas: Concorrente | Site | Instagram (seguidores) | Meta Ads | Diferencial percebido | Vantagem sobre o lead
- Identifique qual é a maior ameaça e por quê
- Aponte 1 oportunidade que o lead tem que nenhum concorrente está explorando

ETAPA 3 — SCORE DE MATURIDADE DIGITAL
Atribua uma nota de 0 a 10 para cada dimensão V4:
- Tráfego (presença paga + orgânica)
- Engajamento (social + conteúdo)
- Conversão (site + CTA + funil)
- Retenção (remarketing + nutrição + CRM)
Calcule a média total. Apresente em tabela com nota, status (Crítico / Fraco / Médio / Bom / Excelente) e justificativa de 1 linha por dimensão.

ETAPA 4 — PERGUNTA DE IMPACTO
Finalize o diagnóstico com uma "Pergunta de Impacto" personalizada para usar na abertura da reunião.

ETAPA 5 — APRESENTAÇÃO PDF
Gere uma apresentação com identidade visual V4 (vermelho #E50914, preto #000000, fonte Montserrat) com os seguintes slides:
1. Capa com nome da empresa, segmento e faturamento atual
2. Sumário executivo (4 cards de status)
3. Análise do site (tabela com badges crítico/atenção/ok)
4. Instagram + Meta Ads (lado a lado)
5. Score de maturidade digital (tabela com notas e barras visuais usando formas)
6. Análise competitiva — tabela comparativa com os 3 concorrentes + 1 oportunidade exclusiva do lead
7. Gaps — onde está perdendo dinheiro (4 cards)
8. 3 Quick Wins imediatos (com timeline e impacto)
9. Primeiros 90 dias com a V4 — 3 fases: Mês 1 (fundação), Mês 2 (ativação), Mês 3 (escala)
10. Pergunta de Impacto (slide final)

Use a skill de PPTX para criar o arquivo, converta para PDF e entregue o PDF para download. Não entregue o PPTX.

Responda em português do Brasil.

---
${linhas}`;
}

export const DiagnosticoV4View: React.FC = () => {
  const [empresa, setEmpresa] = useState("");
  const [site, setSite] = useState("");
  const [instagram, setInstagram] = useState("");
  const [adsLink, setAdsLink] = useState("");
  const [adsDesc, setAdsDesc] = useState("");
  const [contexto, setContexto] = useState("");
  const [fat, setFat] = useState("");
  const [fatMeta, setFatMeta] = useState("");
  const [concorr, setConcorr] = useState("");
  const [segmento, setSegmento] = useState("E-commerce");
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    if (!empresa.trim() && !contexto.trim()) {
      toast.error("Preencha ao menos o nome da empresa ou o contexto do lead.");
      return;
    }
    const prompt = buildPrompt({
      empresa: empresa.trim(),
      site: site.trim(),
      instagram: instagram.trim(),
      adsLink: adsLink.trim(),
      adsDesc: adsDesc.trim(),
      contexto: contexto.trim(),
      fat: fat.trim(),
      fatMeta,
      concorr: concorr.trim(),
      segmento,
    });

    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      toast.success("Prompt copiado! Cole no Claude para gerar o diagnóstico.", {
        icon: "📋",
        duration: 4000,
      });
      setTimeout(() => setCopied(false), 4000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = prompt;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      toast.success("Prompt copiado!", { icon: "📋" });
      setTimeout(() => setCopied(false), 4000);
    }
  };

  const inputCls =
    "w-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-md px-3 py-2 text-sm text-white placeholder:text-[var(--color-v4-text-disabled)] focus:outline-none focus:border-[var(--color-v4-red)] focus:bg-[var(--color-v4-card-hover)] transition-colors";
  const labelCls =
    "text-[11px] font-semibold uppercase tracking-wider text-[var(--color-v4-text-muted)] flex items-center gap-1.5";
  const optCls =
    "text-[10px] font-normal normal-case tracking-normal text-[var(--color-v4-text-disabled)] bg-[var(--color-v4-surface)] px-1.5 py-0.5 rounded-full";
  const sectionLabel =
    "text-[10px] font-bold uppercase tracking-widest text-[var(--color-v4-text-muted)] flex items-center gap-2 mt-6 mb-3 after:content-[''] after:flex-1 after:h-px after:bg-[var(--color-v4-border)]";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 pb-16">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-md bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
            V4
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-display font-bold text-white">
              Agente de Diagnóstico V4
            </h1>
            <p className="text-xs text-[var(--color-v4-text-muted)] mt-0.5">
              Pré-Sales · Tráfego · Engajamento · Conversão · Retenção
            </p>
          </div>
          <span className="bg-[var(--color-v4-red)] text-white text-[10px] font-bold px-2.5 py-1 rounded-full tracking-wider">
            v2.1
          </span>
        </div>

        {/* Chips */}
        <div className="flex gap-2 flex-wrap mb-5">
          {[
            { label: "Meta Ads automático", color: "bg-green-500" },
            { label: "Score de maturidade", color: "bg-green-500" },
            { label: "90 dias com a V4", color: "bg-green-500" },
            { label: "Análise competitiva", color: "bg-blue-500" },
            { label: "PDF 10 slides", color: "bg-green-500" },
          ].map((c) => (
            <div
              key={c.label}
              className="flex items-center gap-1.5 px-3 py-1 bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-full text-[11px] text-[var(--color-v4-text-muted)]"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${c.color}`} />
              {c.label}
            </div>
          ))}
        </div>

        {/* Tip bar */}
        <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-600/30 border-l-[3px] border-l-amber-500 rounded-md px-3.5 py-2.5 text-xs text-amber-400 leading-relaxed mb-5">
          <Zap size={14} className="flex-shrink-0 mt-0.5" />
          Preencha os dados do lead. Concorrentes e Meta Ads são pesquisados
          automaticamente — deixe em branco se não souber.
        </div>

        {/* Identificação */}
        <div className={sectionLabel}>Identificação</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Empresa</label>
            <input
              type="text"
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value)}
              placeholder="Ex: APM Brasil"
              className={inputCls}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Site</label>
            <input
              type="text"
              value={site}
              onChange={(e) => setSite(e.target.value)}
              placeholder="https://..."
              className={inputCls}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Instagram</label>
            <input
              type="text"
              value={instagram}
              onChange={(e) => setInstagram(e.target.value)}
              placeholder="@usuario"
              className={inputCls}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>
              Meta Ads <span className={optCls}>opcional</span>
            </label>
            <input
              type="text"
              value={adsLink}
              onChange={(e) => setAdsLink(e.target.value)}
              placeholder="Link da biblioteca ou deixe em branco"
              className={inputCls}
            />
          </div>
        </div>

        {/* Financeiro */}
        <div className={sectionLabel}>Financeiro</div>
        <div className="flex flex-col gap-1.5">
          <label className={labelCls}>Faturamento mensal</label>
          <div className="flex gap-2.5 flex-col sm:flex-row">
            <input
              type="text"
              value={fat}
              onChange={(e) => setFat(e.target.value)}
              placeholder="Ex: 350000"
              className={inputCls + " flex-1"}
            />
            <select
              value={fatMeta}
              onChange={(e) => setFatMeta(e.target.value)}
              className={inputCls + " sm:w-52 sm:flex-shrink-0 cursor-pointer"}
            >
              {METAS_FAT.map((m) => (
                <option key={m.value} value={m.value} className="bg-[var(--color-v4-card)]">
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Segmento */}
        <div className={sectionLabel}>Segmento</div>
        <div className="flex gap-2 flex-wrap">
          {SEGMENTOS.map((s) => {
            const active = segmento === s;
            return (
              <button
                key={s}
                onClick={() => setSegmento(s)}
                className={
                  "px-3.5 py-1.5 text-xs font-medium border rounded-full transition-all " +
                  (active
                    ? "bg-[var(--color-v4-red-muted)] border-[var(--color-v4-red)] text-[var(--color-v4-red-hover)]"
                    : "bg-transparent border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:border-[var(--color-v4-text-muted)] hover:text-white")
                }
              >
                {s}
              </button>
            );
          })}
        </div>

        {/* Contexto */}
        <div className={sectionLabel}>Contexto & Concorrência</div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Contexto do lead</label>
            <textarea
              value={contexto}
              onChange={(e) => setContexto(e.target.value)}
              placeholder="Dores, objetivos, histórico de marketing, resultados atuais, ciclo de vendas..."
              className={inputCls + " min-h-[80px] resize-y leading-relaxed"}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>
              Concorrentes conhecidos <span className={optCls}>opcional</span>
            </label>
            <input
              type="text"
              value={concorr}
              onChange={(e) => setConcorr(e.target.value)}
              placeholder="Ex: APVS Brasil, Security Proteção (agente pesquisa automaticamente se vazio)"
              className={inputCls}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>
              Anúncios ativos <span className={optCls}>opcional</span>
            </label>
            <textarea
              value={adsDesc}
              onChange={(e) => setAdsDesc(e.target.value)}
              placeholder="Cole o texto dos anúncios ou descreva o que está rodando. Se vazio, busca automática na Meta Ads Library."
              className={inputCls + " min-h-[60px] resize-y leading-relaxed"}
            />
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[var(--color-v4-border)] my-6" />

        {/* CTA */}
        <button
          onClick={handleGenerate}
          className="w-full py-3.5 px-5 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] active:scale-[0.99] text-white rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-all shadow-md shadow-[var(--color-v4-red-muted)]"
        >
          {copied ? <Check size={16} /> : <Sparkles size={16} />}
          {copied ? "Prompt copiado" : "Gerar Diagnóstico Completo + PDF V4"}
        </button>

        {/* What happens */}
        <div className="mt-4 bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-lg px-4 py-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-v4-text-muted)] mb-2.5">
            O que será gerado
          </div>
          {[
            {
              n: 1,
              t: "Análise do lead",
              d: "site, Instagram, Meta Ads, gaps e 3 Quick Wins.",
            },
            {
              n: 2,
              t: "Análise competitiva",
              d: "3 concorrentes com tabela comparativa + oportunidade exclusiva.",
            },
            {
              n: 3,
              t: "Score de maturidade",
              d: "nota 0–10 por dimensão V4 + status e justificativa.",
            },
            {
              n: 4,
              t: "PDF com 10 slides",
              d: "identidade V4 (vermelho/preto/Montserrat), 90 dias, pergunta de impacto.",
            },
          ].map((s) => (
            <div key={s.n} className="flex items-start gap-2.5 mb-2 last:mb-0">
              <div className="w-5 h-5 bg-[var(--color-v4-red)] rounded-full text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5 text-white">
                {s.n}
              </div>
              <div className="text-xs text-[var(--color-v4-text-muted)] leading-relaxed">
                <strong className="text-white font-semibold">{s.t}</strong> — {s.d}
              </div>
            </div>
          ))}
        </div>

        {/* Hint */}
        <div className="mt-4 text-[11px] text-[var(--color-v4-text-disabled)] flex items-center gap-1.5">
          <Copy size={11} />
          Atalho: Ctrl + Enter para copiar o prompt.
        </div>
      </div>
    </div>
  );
};
