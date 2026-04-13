import React, { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Printer,
  X,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  TrendingUp,
  Target,
  Zap,
  Calendar,
  MessageCircle,
} from "lucide-react";

export interface Diagnostico {
  empresa: string;
  segmento_corrigido?: string | null;
  segmento_justificativa?: string | null;
  faturamento_atual?: string;
  meta_faturamento?: string | null;
  sumario_executivo: Array<{ titulo: string; status: "critico" | "atencao" | "ok"; resumo: string }>;
  analise_site: Array<{ aspecto: string; status: "critico" | "atencao" | "ok"; observacao: string }>;
  instagram: { posicionamento: string; engajamento: string; link_bio: string; observacoes: string[] };
  meta_ads: { presenca: string; criativos: string; niveis_consciencia: string; observacoes: string[] };
  score_maturidade: Array<{ dimensao: string; nota: number; status: string; justificativa: string }>;
  media_total: number;
  concorrentes: Array<{
    nome: string;
    site?: string;
    instagram?: string;
    meta_ads?: string;
    diferencial: string;
    vantagem_sobre_lead: string;
  }>;
  maior_ameaca: { concorrente: string; motivo: string };
  oportunidade_exclusiva: string;
  gaps: Array<{ titulo: string; descricao: string; impacto_estimado: string }>;
  quick_wins: Array<{ titulo: string; descricao: string; timeline: string; impacto: string }>;
  plano_90_dias: {
    mes_1: { fase: string; iniciativas: string[] };
    mes_2: { fase: string; iniciativas: string[] };
    mes_3: { fase: string; iniciativas: string[] };
  };
  pergunta_impacto: string;
}

type StatusBadgeType = "critico" | "atencao" | "ok";

function StatusBadge({ status, children }: { status: StatusBadgeType; children?: React.ReactNode }) {
  const cfg = {
    critico: { bg: "bg-red-500/15", border: "border-red-500/40", text: "text-red-400", icon: XCircle },
    atencao: { bg: "bg-amber-500/15", border: "border-amber-500/40", text: "text-amber-400", icon: AlertTriangle },
    ok: { bg: "bg-green-500/15", border: "border-green-500/40", text: "text-green-400", icon: CheckCircle2 },
  }[status];
  const Icon = cfg.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${cfg.bg} ${cfg.border} ${cfg.text}`}
    >
      <Icon size={10} />
      {children || status}
    </span>
  );
}

function statusFromNota(n: number): string {
  if (n <= 2) return "Crítico";
  if (n <= 4) return "Fraco";
  if (n <= 6) return "Médio";
  if (n <= 8) return "Bom";
  return "Excelente";
}

function SlideShell({
  n,
  total,
  title,
  subtitle,
  children,
}: {
  n: number;
  total: number;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="slide relative w-full h-full flex flex-col bg-black text-white p-10 md:p-14">
      {title && (
        <div className="mb-8 flex-shrink-0">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--color-v4-red)] font-bold">
            V4 · DIAGNÓSTICO
          </div>
          <h2 className="text-3xl md:text-4xl font-display font-bold mt-1">{title}</h2>
          {subtitle && <p className="text-base text-slate-300 mt-1">{subtitle}</p>}
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      <div className="mt-6 flex items-center justify-between text-[10px] text-slate-500 uppercase tracking-widest flex-shrink-0">
        <div>
          <span className="text-[var(--color-v4-red)] font-bold">V4</span> · Growth Diagnostics
        </div>
        <div>
          {n.toString().padStart(2, "0")} / {total.toString().padStart(2, "0")}
        </div>
      </div>
    </div>
  );
}

// Slide 1 - Capa
function Slide1({ d }: { d: Diagnostico }) {
  return (
    <div className="slide relative w-full h-full flex flex-col justify-center items-center bg-black text-white p-14 text-center overflow-hidden">
      <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(circle_at_top_right,var(--color-v4-red),transparent_60%)]" />
      <div className="relative z-10">
        <div className="text-xs uppercase tracking-[0.3em] text-[var(--color-v4-red)] font-bold mb-6">
          V4 · Diagnóstico Growth
        </div>
        <h1 className="text-5xl md:text-7xl font-display font-bold leading-[1.05] mb-6">
          {d.empresa}
        </h1>
        <div className="inline-flex items-center gap-3 px-5 py-2 rounded-full border border-white/20 bg-white/5 text-sm font-medium mb-8">
          {d.segmento_corrigido || "E-commerce"}
          {d.faturamento_atual && (
            <>
              <span className="w-1 h-1 bg-white/30 rounded-full" />
              {d.faturamento_atual}
            </>
          )}
        </div>
        <div className="h-px w-32 bg-[var(--color-v4-red)] mx-auto mb-8" />
        <p className="text-slate-400 text-sm max-w-md mx-auto">
          Análise diagnóstica completa — Tráfego · Engajamento · Conversão · Retenção
        </p>
      </div>
    </div>
  );
}

// Slide 2 - Sumário Executivo
function Slide2({ d }: { d: Diagnostico }) {
  return (
    <SlideShell n={2} total={10} title="Sumário Executivo" subtitle="Visão geral do lead em 4 dimensões">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1">
        {d.sumario_executivo.slice(0, 4).map((c, i) => {
          const cfg = {
            critico: "border-red-500/40 bg-red-500/5",
            atencao: "border-amber-500/40 bg-amber-500/5",
            ok: "border-green-500/40 bg-green-500/5",
          }[c.status];
          return (
            <div key={i} className={`p-5 rounded-lg border ${cfg}`}>
              <div className="flex items-start justify-between mb-2 gap-2">
                <h3 className="text-base font-bold flex-1">{c.titulo}</h3>
                <StatusBadge status={c.status} />
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{c.resumo}</p>
            </div>
          );
        })}
      </div>
    </SlideShell>
  );
}

// Slide 3 - Análise do Site
function Slide3({ d }: { d: Diagnostico }) {
  return (
    <SlideShell n={3} total={10} title="Análise do Site" subtitle="Aspectos técnicos e de conversão">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-white/10">
              <th className="pb-3 pr-4 w-1/4">Aspecto</th>
              <th className="pb-3 pr-4 w-32">Status</th>
              <th className="pb-3">Observação</th>
            </tr>
          </thead>
          <tbody>
            {d.analise_site.map((row, i) => (
              <tr key={i} className="border-b border-white/5">
                <td className="py-3 pr-4 font-medium">{row.aspecto}</td>
                <td className="py-3 pr-4">
                  <StatusBadge status={row.status} />
                </td>
                <td className="py-3 text-sm text-slate-300">{row.observacao}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SlideShell>
  );
}

// Slide 4 - Instagram + Meta Ads
function Slide4({ d }: { d: Diagnostico }) {
  return (
    <SlideShell n={4} total={10} title="Instagram + Meta Ads" subtitle="Presença orgânica e paga">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-1">
        <div className="p-5 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center text-xs font-bold">
              IG
            </div>
            <h3 className="font-bold">Instagram</h3>
          </div>
          <dl className="space-y-2 text-sm mb-4">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400">Posicionamento</dt>
              <dd className="text-slate-200">{d.instagram.posicionamento}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400">Engajamento</dt>
              <dd className="text-slate-200">{d.instagram.engajamento}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400">Link da bio</dt>
              <dd className="text-slate-200">{d.instagram.link_bio}</dd>
            </div>
          </dl>
          <ul className="space-y-1.5 text-sm text-slate-300">
            {d.instagram.observacoes?.map((o, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[var(--color-v4-red)] mt-0.5">•</span>
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="p-5 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold">
              FB
            </div>
            <h3 className="font-bold">Meta Ads</h3>
          </div>
          <dl className="space-y-2 text-sm mb-4">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400">Presença</dt>
              <dd className="text-slate-200">{d.meta_ads.presenca}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400">Criativos</dt>
              <dd className="text-slate-200">{d.meta_ads.criativos}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-400">Níveis de consciência</dt>
              <dd className="text-slate-200">{d.meta_ads.niveis_consciencia}</dd>
            </div>
          </dl>
          <ul className="space-y-1.5 text-sm text-slate-300">
            {d.meta_ads.observacoes?.map((o, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[var(--color-v4-red)] mt-0.5">•</span>
                <span>{o}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SlideShell>
  );
}

// Slide 5 - Score de Maturidade
function Slide5({ d }: { d: Diagnostico }) {
  return (
    <SlideShell
      n={5}
      total={10}
      title="Score de Maturidade Digital"
      subtitle={`Média total: ${d.media_total ?? "N/D"}/10`}
    >
      <div className="flex-1 space-y-4">
        {d.score_maturidade.map((s, i) => {
          const pct = Math.max(0, Math.min(100, (s.nota / 10) * 100));
          const color =
            s.nota <= 3
              ? "bg-red-500"
              : s.nota <= 5
              ? "bg-amber-500"
              : s.nota <= 7
              ? "bg-blue-500"
              : "bg-green-500";
          return (
            <div key={i}>
              <div className="flex items-baseline justify-between mb-1.5">
                <div className="flex items-baseline gap-3">
                  <span className="font-bold text-base">{s.dimensao}</span>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400">
                    {s.status || statusFromNota(s.nota)}
                  </span>
                </div>
                <span className="font-display text-2xl font-bold">{s.nota}<span className="text-sm text-slate-500">/10</span></span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden mb-1.5">
                <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-slate-400">{s.justificativa}</p>
            </div>
          );
        })}
      </div>
    </SlideShell>
  );
}

// Slide 6 - Análise Competitiva
function Slide6({ d }: { d: Diagnostico }) {
  return (
    <SlideShell n={6} total={10} title="Análise Competitiva" subtitle="3 concorrentes diretos">
      <div className="flex-1 overflow-auto mb-4">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-white/10">
              <th className="pb-2 pr-2">Concorrente</th>
              <th className="pb-2 pr-2">Site</th>
              <th className="pb-2 pr-2">Instagram</th>
              <th className="pb-2 pr-2">Meta Ads</th>
              <th className="pb-2 pr-2">Diferencial</th>
              <th className="pb-2">Vantagem</th>
            </tr>
          </thead>
          <tbody>
            {d.concorrentes.map((c, i) => (
              <tr key={i} className="border-b border-white/5 align-top">
                <td className="py-2 pr-2 font-semibold text-white">{c.nome}</td>
                <td className="py-2 pr-2 text-slate-400 break-all text-[11px]">{c.site || "—"}</td>
                <td className="py-2 pr-2 text-slate-400">{c.instagram || "—"}</td>
                <td className="py-2 pr-2 text-slate-400">{c.meta_ads || "—"}</td>
                <td className="py-2 pr-2 text-slate-300">{c.diferencial}</td>
                <td className="py-2 text-slate-300">{c.vantagem_sobre_lead}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-shrink-0">
        <div className="p-3 rounded-lg border border-red-500/40 bg-red-500/5">
          <div className="text-[10px] uppercase tracking-wider text-red-400 font-bold mb-1">
            Maior ameaça
          </div>
          <div className="text-sm font-bold">{d.maior_ameaca.concorrente}</div>
          <p className="text-xs text-slate-300 mt-1">{d.maior_ameaca.motivo}</p>
        </div>
        <div className="p-3 rounded-lg border border-green-500/40 bg-green-500/5">
          <div className="text-[10px] uppercase tracking-wider text-green-400 font-bold mb-1">
            Oportunidade exclusiva
          </div>
          <p className="text-xs text-slate-200">{d.oportunidade_exclusiva}</p>
        </div>
      </div>
    </SlideShell>
  );
}

// Slide 7 - Gaps
function Slide7({ d }: { d: Diagnostico }) {
  return (
    <SlideShell n={7} total={10} title="Onde está perdendo dinheiro" subtitle="Gaps prioritários">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 flex-1">
        {d.gaps.slice(0, 4).map((g, i) => (
          <div key={i} className="p-4 rounded-lg border border-red-500/30 bg-red-500/[0.04] flex flex-col">
            <div className="flex items-start gap-2 mb-2">
              <div className="w-7 h-7 rounded bg-red-500 flex items-center justify-center text-sm font-bold flex-shrink-0">
                {i + 1}
              </div>
              <h3 className="text-sm font-bold flex-1">{g.titulo}</h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed flex-1">{g.descricao}</p>
            <div className="mt-3 pt-3 border-t border-white/5">
              <span className="text-[10px] uppercase tracking-wider text-red-400 font-bold">
                Impacto:
              </span>{" "}
              <span className="text-xs text-slate-200">{g.impacto_estimado}</span>
            </div>
          </div>
        ))}
      </div>
    </SlideShell>
  );
}

// Slide 8 - Quick Wins
function Slide8({ d }: { d: Diagnostico }) {
  return (
    <SlideShell n={8} total={10} title="3 Quick Wins Imediatos" subtitle="Ações de alto impacto e baixo custo">
      <div className="flex-1 space-y-3">
        {d.quick_wins.slice(0, 3).map((q, i) => (
          <div key={i} className="p-4 rounded-lg border border-green-500/30 bg-green-500/[0.04]">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                <Zap size={16} />
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-3 mb-1 flex-wrap">
                  <h3 className="text-base font-bold">{q.titulo}</h3>
                  <span className="text-[10px] uppercase tracking-wider text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">
                    {q.timeline}
                  </span>
                </div>
                <p className="text-sm text-slate-300 mb-2">{q.descricao}</p>
                <div className="text-xs text-slate-400">
                  <TrendingUp size={12} className="inline mr-1" />
                  <strong className="text-green-400">Impacto:</strong> {q.impacto}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </SlideShell>
  );
}

// Slide 9 - 90 dias
function Slide9({ d }: { d: Diagnostico }) {
  const meses = [
    { key: "mes_1" as const, label: "Mês 1", data: d.plano_90_dias.mes_1, color: "border-blue-500/40 bg-blue-500/5", num: "01" },
    { key: "mes_2" as const, label: "Mês 2", data: d.plano_90_dias.mes_2, color: "border-purple-500/40 bg-purple-500/5", num: "02" },
    { key: "mes_3" as const, label: "Mês 3", data: d.plano_90_dias.mes_3, color: "border-red-500/40 bg-red-500/5", num: "03" },
  ];
  return (
    <SlideShell n={9} total={10} title="Primeiros 90 dias com a V4" subtitle="Roadmap em 3 fases">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1">
        {meses.map((m) => (
          <div key={m.key} className={`p-4 rounded-lg border ${m.color} flex flex-col`}>
            <div className="flex items-center gap-2 mb-1">
              <Calendar size={14} className="text-slate-400" />
              <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                {m.label}
              </span>
              <span className="ml-auto text-lg font-display font-bold text-slate-600">{m.num}</span>
            </div>
            <h3 className="font-bold text-lg mb-3">{m.data.fase}</h3>
            <ul className="space-y-2 text-xs text-slate-300 flex-1">
              {m.data.iniciativas?.map((ini, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-[var(--color-v4-red)] mt-0.5">▸</span>
                  <span>{ini}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SlideShell>
  );
}

// Slide 10 - Pergunta de Impacto
function Slide10({ d }: { d: Diagnostico }) {
  return (
    <div className="slide relative w-full h-full flex flex-col justify-center items-center bg-black text-white p-14 text-center overflow-hidden">
      <div className="absolute inset-0 opacity-[0.04] bg-[radial-gradient(circle_at_center,var(--color-v4-red),transparent_70%)]" />
      <div className="relative z-10 max-w-3xl">
        <MessageCircle size={48} className="text-[var(--color-v4-red)] mx-auto mb-6" />
        <div className="text-xs uppercase tracking-[0.3em] text-[var(--color-v4-red)] font-bold mb-4">
          Pergunta de impacto
        </div>
        <p className="text-3xl md:text-4xl font-display font-bold leading-tight">
          "{d.pergunta_impacto}"
        </p>
        <div className="h-px w-24 bg-[var(--color-v4-red)] mx-auto mt-10 mb-6" />
        <p className="text-sm text-slate-400">
          Use esta pergunta na abertura da reunião com <strong className="text-white">{d.empresa}</strong>
        </p>
      </div>
    </div>
  );
}

export const DiagnosticoSlideDeck: React.FC<{ diagnostico: Diagnostico; onClose: () => void }> = ({
  diagnostico,
  onClose,
}) => {
  const [idx, setIdx] = useState(0);
  const total = 10;
  const slides = [Slide1, Slide2, Slide3, Slide4, Slide5, Slide6, Slide7, Slide8, Slide9, Slide10];
  const Current = slides[idx];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        setIdx((i) => Math.min(total - 1, i + 1));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePrint = () => window.print();

  return (
    <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur flex flex-col">
      {/* Top bar (hidden on print) */}
      <div className="no-print flex items-center gap-3 px-4 py-2.5 bg-black/80 border-b border-white/10 flex-shrink-0">
        <div className="text-xs text-slate-400">
          Slide <span className="text-white font-bold">{idx + 1}</span> / {total}
        </div>
        <div className="flex-1" />
        <button
          onClick={handlePrint}
          className="px-3 py-1.5 bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] rounded-md text-xs font-semibold flex items-center gap-1.5 text-white"
        >
          <Printer size={13} />
          Exportar PDF
        </button>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-white/10 rounded-md text-slate-300"
          title="Fechar (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* Slide viewport (screen mode) */}
      <div className="no-print flex-1 flex items-center justify-center p-4 md:p-8 overflow-hidden">
        <div
          className="relative w-full max-w-5xl aspect-[16/9] shadow-2xl rounded-lg overflow-hidden border border-white/10"
          style={{ boxShadow: "0 0 80px rgba(230,57,70,0.15)" }}
        >
          <Current d={diagnostico} />
        </div>
      </div>

      {/* Nav controls (hidden on print) */}
      <div className="no-print flex items-center justify-center gap-3 pb-4 flex-shrink-0">
        <button
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          disabled={idx === 0}
          className="p-2 rounded-full bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="flex gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`w-6 h-1.5 rounded-full transition-all ${
                i === idx ? "bg-[var(--color-v4-red)] w-8" : "bg-white/20 hover:bg-white/30"
              }`}
            />
          ))}
        </div>
        <button
          onClick={() => setIdx((i) => Math.min(total - 1, i + 1))}
          disabled={idx === total - 1}
          className="p-2 rounded-full bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      {/* Print mode: render all slides stacked */}
      <div className="print-only hidden">
        {slides.map((S, i) => (
          <div key={i} className="print-slide">
            <S d={diagnostico} />
          </div>
        ))}
      </div>

      {/* Print CSS */}
      <style>{`
        @media print {
          @page { size: 16in 9in landscape; margin: 0; }
          body { background: black !important; }
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          .print-slide { page-break-after: always; width: 16in; height: 9in; }
          .slide { border-radius: 0 !important; border: none !important; }
        }
      `}</style>
    </div>
  );
};
