import React, { useEffect, useState } from "react";
import { Sparkles, Zap, Loader2, AlertCircle } from "lucide-react";
import toast from "react-hot-toast";
import { DiagnosticoSlideDeck, type Diagnostico } from "./DiagnosticoSlideDeck";

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

const LOADING_STEPS = [
  { t: 0, msg: "Conectando no agente V4..." },
  { t: 4, msg: "Acessando site e checando rastreamento..." },
  { t: 12, msg: "Analisando presença no Instagram..." },
  { t: 20, msg: "Buscando anúncios na Meta Ads Library..." },
  { t: 28, msg: "Mapeando concorrentes diretos..." },
  { t: 38, msg: "Calculando score de maturidade..." },
  { t: 48, msg: "Identificando gaps e quick wins..." },
  { t: 55, msg: "Montando plano de 90 dias..." },
];

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

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [diagnostico, setDiagnostico] = useState<Diagnostico | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) return;
    const start = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(iv);
  }, [loading]);

  const currentStep = LOADING_STEPS.filter((s) => s.t <= elapsed).slice(-1)[0] || LOADING_STEPS[0];

  const handleGenerate = async () => {
    if (!empresa.trim() && !contexto.trim()) {
      toast.error("Preencha ao menos o nome da empresa ou o contexto do lead.");
      return;
    }
    setError(null);
    setLoading(true);
    setElapsed(0);

    try {
      const res = await fetch("/api/diagnostico", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa: empresa.trim(),
          site: site.trim(),
          instagram: instagram.trim(),
          adsLink: adsLink.trim(),
          adsDesc: adsDesc.trim(),
          contexto: contexto.trim(),
          fat: fat ? fmtFat(fat.trim()) : "",
          fatMeta,
          concorrentes: concorr.trim(),
          segmento,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Erro HTTP ${res.status}`);
      }
      if (!data?.diagnostico) {
        throw new Error("Resposta sem diagnóstico");
      }
      setDiagnostico(data.diagnostico);
      toast.success("Diagnóstico gerado!", { icon: "✨" });
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Erro ao gerar diagnóstico");
      toast.error("Falhou ao gerar diagnóstico");
    } finally {
      setLoading(false);
    }
  };

  if (diagnostico) {
    return <DiagnosticoSlideDeck diagnostico={diagnostico} onClose={() => setDiagnostico(null)} />;
  }

  const inputCls =
    "w-full bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-md px-3 py-2 text-sm text-white placeholder:text-[var(--color-v4-text-disabled)] focus:outline-none focus:border-[var(--color-v4-red)] focus:bg-[var(--color-v4-card-hover)] transition-colors disabled:opacity-50";
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
            v3.0 · AI
          </span>
        </div>

        {/* Chips */}
        <div className="flex gap-2 flex-wrap mb-5">
          {[
            { label: "Pesquisa automática", color: "bg-green-500" },
            { label: "Score de maturidade", color: "bg-green-500" },
            { label: "3 concorrentes", color: "bg-green-500" },
            { label: "Plano 90 dias", color: "bg-blue-500" },
            { label: "10 slides + PDF", color: "bg-green-500" },
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

        <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-600/30 border-l-[3px] border-l-amber-500 rounded-md px-3.5 py-2.5 text-xs text-amber-400 leading-relaxed mb-5">
          <Zap size={14} className="flex-shrink-0 mt-0.5" />
          Preencha os dados do lead. O agente pesquisa automaticamente site, Instagram, Meta Ads e concorrentes. Demora ~40-60s pra gerar.
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2.5 bg-red-500/10 border border-red-500/30 border-l-[3px] border-l-red-500 rounded-md px-3.5 py-2.5 text-xs text-red-400 mb-5">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <div>
              <strong className="block mb-1">Falhou ao gerar diagnóstico</strong>
              {error}
            </div>
          </div>
        )}

        {/* Identificação */}
        <div className={sectionLabel}>Identificação</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Empresa</label>
            <input type="text" disabled={loading} value={empresa} onChange={(e) => setEmpresa(e.target.value)} placeholder="Ex: APM Brasil" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Site</label>
            <input type="text" disabled={loading} value={site} onChange={(e) => setSite(e.target.value)} placeholder="https://..." className={inputCls} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>Instagram</label>
            <input type="text" disabled={loading} value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@usuario" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>
              Meta Ads <span className={optCls}>opcional</span>
            </label>
            <input type="text" disabled={loading} value={adsLink} onChange={(e) => setAdsLink(e.target.value)} placeholder="Link da biblioteca ou deixe em branco" className={inputCls} />
          </div>
        </div>

        {/* Financeiro */}
        <div className={sectionLabel}>Financeiro</div>
        <div className="flex flex-col gap-1.5">
          <label className={labelCls}>Faturamento mensal</label>
          <div className="flex gap-2.5 flex-col sm:flex-row">
            <input type="text" disabled={loading} value={fat} onChange={(e) => setFat(e.target.value)} placeholder="Ex: 350000" className={inputCls + " flex-1"} />
            <select disabled={loading} value={fatMeta} onChange={(e) => setFatMeta(e.target.value)} className={inputCls + " sm:w-52 sm:flex-shrink-0 cursor-pointer"}>
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
                disabled={loading}
                onClick={() => setSegmento(s)}
                className={
                  "px-3.5 py-1.5 text-xs font-medium border rounded-full transition-all disabled:opacity-50 " +
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
            <textarea disabled={loading} value={contexto} onChange={(e) => setContexto(e.target.value)} placeholder="Dores, objetivos, histórico de marketing, resultados atuais, ciclo de vendas..." className={inputCls + " min-h-[80px] resize-y leading-relaxed"} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>
              Concorrentes conhecidos <span className={optCls}>opcional</span>
            </label>
            <input type="text" disabled={loading} value={concorr} onChange={(e) => setConcorr(e.target.value)} placeholder="Ex: APVS Brasil, Security Proteção (vazio = pesquisa automática)" className={inputCls} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className={labelCls}>
              Anúncios ativos <span className={optCls}>opcional</span>
            </label>
            <textarea disabled={loading} value={adsDesc} onChange={(e) => setAdsDesc(e.target.value)} placeholder="Cole o texto dos anúncios ou descreva o que está rodando. Se vazio, busca automática na Meta Ads Library." className={inputCls + " min-h-[60px] resize-y leading-relaxed"} />
          </div>
        </div>

        <div className="h-px bg-[var(--color-v4-border)] my-6" />

        {/* CTA */}
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="w-full py-3.5 px-5 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] active:scale-[0.99] disabled:opacity-80 disabled:cursor-not-allowed text-white rounded-md text-sm font-semibold flex items-center justify-center gap-2 transition-all shadow-md shadow-[var(--color-v4-red-muted)]"
        >
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Gerando diagnóstico... ({elapsed}s)
            </>
          ) : (
            <>
              <Sparkles size={16} />
              Gerar Diagnóstico Completo + Apresentação
            </>
          )}
        </button>

        {/* Loading progress */}
        {loading && (
          <div className="mt-4 bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-lg px-4 py-3.5">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 size={12} className="animate-spin text-[var(--color-v4-red)]" />
              <span className="text-xs text-[var(--color-v4-text-muted)]">{currentStep.msg}</span>
            </div>
            <div className="h-1 bg-[var(--color-v4-border)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--color-v4-red)] transition-all duration-500"
                style={{ width: `${Math.min(95, (elapsed / 60) * 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-[var(--color-v4-text-disabled)] mt-2">
              Claude Sonnet 4.5 + web_search está analisando em tempo real. Pode levar até 60s.
            </p>
          </div>
        )}

        {/* What happens */}
        {!loading && (
          <div className="mt-4 bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded-lg px-4 py-3.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-v4-text-muted)] mb-2.5">
              O que será gerado
            </div>
            {[
              { n: 1, t: "Análise do lead", d: "site, Instagram, Meta Ads, gaps e 3 Quick Wins." },
              { n: 2, t: "Análise competitiva", d: "3 concorrentes + maior ameaça + oportunidade exclusiva." },
              { n: 3, t: "Score de maturidade", d: "nota 0–10 por dimensão V4 + status e justificativa." },
              { n: 4, t: "Apresentação 10 slides", d: "renderizada no app com botão exportar PDF." },
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
        )}
      </div>
    </div>
  );
};
