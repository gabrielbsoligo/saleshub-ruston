import React, { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { X, UploadCloud, FileSpreadsheet, Loader2, CheckCircle2, AlertTriangle, ArrowLeft, ArrowRight } from "lucide-react";
import toast from "react-hot-toast";
import { useAppStore } from "../store";
import { CANAL_LABELS, type LeadCanal, type Lead } from "../types";

interface Props {
  onClose: () => void;
}

// Campos do lead que podem ser mapeados a partir de colunas do arquivo
const LEAD_FIELDS: { key: keyof Lead; label: string; required?: boolean }[] = [
  { key: "empresa", label: "Empresa", required: true },
  { key: "nome_contato", label: "Nome do contato" },
  { key: "telefone", label: "Telefone" },
  { key: "email", label: "E-mail" },
  { key: "cnpj", label: "CNPJ" },
  { key: "faturamento", label: "Faturamento" },
  { key: "produto", label: "Produto" },
  { key: "fonte", label: "Fonte" },
];

// Palpites de auto-mapeamento por nome de cabeçalho (normalizado)
const GUESSES: Record<string, string[]> = {
  empresa: ["empresa", "razao", "razão", "company", "cliente", "nome da empresa"],
  nome_contato: ["contato", "nome", "responsavel", "responsável", "name"],
  telefone: ["telefone", "fone", "celular", "whatsapp", "phone", "tel"],
  email: ["email", "e-mail", "mail"],
  cnpj: ["cnpj", "documento", "doc"],
  faturamento: ["faturamento", "receita", "revenue", "porte"],
  produto: ["produto", "interesse", "product"],
  fonte: ["fonte", "origem", "source"],
};

const norm = (s: string) => (s || "").trim().toLowerCase();
const digits = (s: string) => (s || "").replace(/\D/g, "");

const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

interface KommoPipeline { pipeline_id: number; name: string; statuses: { id: number; name: string }[]; }

type RowStatus =
  | { kind: "nova" }
  | { kind: "invalida"; motivo: string }
  | { kind: "duplicada"; onde: "base" | "arquivo"; campo: string };

export const ImportLeadsModal: React.FC<Props> = ({ onClose }) => {
  const { leads, members, bulkImportLeads } = useAppStore();
  // Libera todos os usuários ativos como possível responsável
  const responsaveis = useMemo(() => members.filter((m) => m.active), [members]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [fileName, setFileName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [canal, setCanal] = useState<LeadCanal>("outbound");
  const [sdrId, setSdrId] = useState("");
  const [pipelines, setPipelines] = useState<KommoPipeline[]>([]);
  const [pipelineId, setPipelineId] = useState<number | "">("");
  const [statusId, setStatusId] = useState<number | "">("");
  const [decisions, setDecisions] = useState<Record<number, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; failed: number } | null>(null);

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  // Busca os funis/etapas reais do Kommo (silencioso: se falhar, cai no automático pelo canal)
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/kommo-pipelines`, {
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        setPipelines(data.pipelines || []);
      } catch { /* mantém vazio → usa mapeamento por canal */ }
    })();
  }, []);

  const statusesOfPipeline = useMemo(
    () => pipelines.find((p) => p.pipeline_id === pipelineId)?.statuses || [],
    [pipelines, pipelineId],
  );

  // ---------- Parse (CSV ou XLSX) ----------
  const ingest = (matrix: any[][]) => {
    const clean = matrix.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
    if (clean.length < 2) { toast.error("Arquivo sem dados (precisa de cabeçalho + linhas)."); return; }
    const hdr = clean[0].map((c) => String(c ?? "").trim());
    const body = clean.slice(1).map((r) => hdr.map((_, i) => String(r[i] ?? "").trim()));
    setHeaders(hdr);
    setRows(body);
    // auto-map
    const guess: Record<string, number> = {};
    for (const f of LEAD_FIELDS) {
      const tokens = GUESSES[f.key as string] || [];
      const idx = hdr.findIndex((h) => tokens.some((t) => norm(h).includes(t)));
      guess[f.key as string] = idx; // -1 se não achou
    }
    setMapping(guess);
    setStep(2);
  };

  const handleFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false, defval: "" });
      setFileName(file.name);
      ingest(matrix);
    } catch (e: any) {
      toast.error("Falha ao ler o arquivo: " + (e.message || "erro"));
    }
  };

  const handlePaste = () => {
    if (!pasteText.trim()) { toast.error("Cole o conteúdo CSV."); return; }
    try {
      const wb = XLSX.read(pasteText, { type: "string" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const matrix = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, blankrows: false, defval: "" });
      setFileName("(colado)");
      ingest(matrix);
    } catch (e: any) {
      toast.error("Falha ao parsear: " + (e.message || "erro"));
    }
  };

  // ---------- Linhas parseadas conforme mapeamento ----------
  const parsed = useMemo(() => {
    return rows.map((r) => {
      const get = (key: string) => {
        const idx = mapping[key];
        return idx >= 0 ? (r[idx] || "").trim() : "";
      };
      return {
        empresa: get("empresa"),
        nome_contato: get("nome_contato"),
        telefone: get("telefone"),
        email: get("email"),
        cnpj: get("cnpj"),
        faturamento: get("faturamento"),
        produto: get("produto"),
        fonte: get("fonte"),
      };
    });
  }, [rows, mapping]);

  // ---------- Dedupe (contra a base em memória + entre linhas do arquivo) ----------
  const statuses = useMemo<RowStatus[]>(() => {
    const exEmpresa = new Set(leads.map((l) => norm(l.empresa)).filter(Boolean));
    const exEmail = new Set(leads.map((l) => norm(l.email || "")).filter(Boolean));
    const exFone = new Set(leads.map((l) => digits(l.telefone || "")).filter((v) => v.length >= 8));
    const exCnpj = new Set(leads.map((l) => digits(l.cnpj || "")).filter((v) => v.length >= 11));
    const seenEmpresa = new Set<string>(), seenEmail = new Set<string>(), seenFone = new Set<string>(), seenCnpj = new Set<string>();

    return parsed.map((p) => {
      if (!p.empresa) return { kind: "invalida", motivo: "sem empresa" } as RowStatus;
      const e = norm(p.empresa), em = norm(p.email), fo = digits(p.telefone), cn = digits(p.cnpj);
      // contra a base
      if (e && exEmpresa.has(e)) return { kind: "duplicada", onde: "base", campo: "empresa" };
      if (em && exEmail.has(em)) return { kind: "duplicada", onde: "base", campo: "email" };
      if (fo.length >= 8 && exFone.has(fo)) return { kind: "duplicada", onde: "base", campo: "telefone" };
      if (cn.length >= 11 && exCnpj.has(cn)) return { kind: "duplicada", onde: "base", campo: "cnpj" };
      // entre linhas do arquivo
      let dupFile = "";
      if (e && seenEmpresa.has(e)) dupFile = "empresa";
      else if (em && seenEmail.has(em)) dupFile = "email";
      else if (fo.length >= 8 && seenFone.has(fo)) dupFile = "telefone";
      else if (cn.length >= 11 && seenCnpj.has(cn)) dupFile = "cnpj";
      if (e) seenEmpresa.add(e);
      if (em) seenEmail.add(em);
      if (fo.length >= 8) seenFone.add(fo);
      if (cn.length >= 11) seenCnpj.add(cn);
      if (dupFile) return { kind: "duplicada", onde: "arquivo", campo: dupFile };
      return { kind: "nova" };
    });
  }, [parsed, leads]);

  const summary = useMemo(() => {
    let novas = 0, dups = 0, inval = 0;
    for (const s of statuses) {
      if (s.kind === "nova") novas++;
      else if (s.kind === "duplicada") dups++;
      else inval++;
    }
    return { novas, dups, inval };
  }, [statuses]);

  // entra no preview: inicializa decisões (novas marcadas, duplicadas desmarcadas)
  const goPreview = () => {
    if ((mapping["empresa"] ?? -1) < 0) { toast.error("Mapeie a coluna de Empresa."); return; }
    const init: Record<number, boolean> = {};
    statuses.forEach((s, i) => { init[i] = s.kind === "nova"; });
    setDecisions(init);
    setStep(3);
  };

  const selectedCount = useMemo(
    () => statuses.reduce((acc, s, i) => acc + (s.kind !== "invalida" && decisions[i] ? 1 : 0), 0),
    [statuses, decisions],
  );

  const handleImport = async () => {
    // Funil/etapa escolhidos (se houver). Etapa vazia → 1ª etapa real do funil.
    const chosenPipeline = pipelineId || null;
    const chosenStatus = chosenPipeline ? (statusId || statusesOfPipeline[0]?.id || null) : null;

    const toCreate: Partial<Lead>[] = [];
    parsed.forEach((p, i) => {
      if (statuses[i].kind === "invalida" || !decisions[i]) return;
      toCreate.push({
        empresa: p.empresa,
        nome_contato: p.nome_contato || undefined,
        telefone: p.telefone || undefined,
        email: p.email || undefined,
        cnpj: p.cnpj || undefined,
        faturamento: p.faturamento || undefined,
        produto: p.produto || undefined,
        fonte: (p.fonte || undefined) as any,
        canal,
        sdr_id: sdrId || undefined,
        status: "sem_contato",
        kommo_pipeline_id: chosenPipeline ?? undefined,
        kommo_status_id: chosenStatus ?? undefined,
      });
    });
    if (!toCreate.length) { toast.error("Nada selecionado para importar."); return; }
    setImporting(true);
    try {
      const res = await bulkImportLeads(toCreate);
      setResult(res);
      setStep(4);
      if (res.inserted) toast.success(`${res.inserted} lead(s) importado(s)!`);
    } catch (e: any) {
      toast.error(e.message || "Falha ao importar");
    } finally {
      setImporting(false);
    }
  };

  const statusBadge = (s: RowStatus) => {
    if (s.kind === "nova") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">nova</span>;
    if (s.kind === "invalida") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">inválida: {s.motivo}</span>;
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">dup. {s.campo} ({s.onde})</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-3xl bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl max-h-[88vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={18} className="text-[var(--color-v4-red)]" />
            <div>
              <h3 className="text-sm font-bold text-white">Importar lista de leads</h3>
              <p className="text-[11px] text-[var(--color-v4-text-muted)]">
                Passo {step} de 4 · {step === 1 ? "Arquivo" : step === 2 ? "Mapear colunas" : step === 3 ? "Revisar duplicatas" : "Concluído"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {/* STEP 1 — Upload */}
          {step === 1 && (
            <div className="space-y-4">
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <button onClick={() => fileRef.current?.click()}
                className="w-full flex flex-col items-center justify-center gap-2 py-10 rounded-xl border-2 border-dashed border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] transition-colors">
                <UploadCloud size={28} className="text-[var(--color-v4-text-muted)]" />
                <span className="text-sm text-white">Selecionar arquivo CSV ou Excel (.xlsx)</span>
                <span className="text-[11px] text-[var(--color-v4-text-muted)]">a primeira linha deve ser o cabeçalho</span>
              </button>
              <div className="text-center text-[11px] text-[var(--color-v4-text-muted)]">ou cole o CSV abaixo</div>
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={4}
                placeholder="empresa,email,telefone&#10;Acme,contato@acme.com,11999999999"
                className={inputClass} />
              <div className="flex justify-end">
                <button onClick={handlePaste} disabled={!pasteText.trim()}
                  className="px-4 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-sm disabled:opacity-40">
                  Usar CSV colado
                </button>
              </div>
            </div>
          )}

          {/* STEP 2 — Mapear colunas + canal/sdr */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-xs text-[var(--color-v4-text-muted)]">
                Arquivo: <strong className="text-white">{fileName}</strong> · {rows.length} linha(s) · {headers.length} coluna(s)
              </p>
              <div className="grid grid-cols-2 gap-3">
                {LEAD_FIELDS.map((f) => (
                  <div key={f.key as string}>
                    <label className="block text-[11px] text-[var(--color-v4-text-muted)] mb-1">
                      {f.label}{f.required && <span className="text-[var(--color-v4-red)]"> *</span>}
                    </label>
                    <select className={inputClass} value={mapping[f.key as string] ?? -1}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.key as string]: parseInt(e.target.value, 10) }))}>
                      <option value={-1}>— não importar —</option>
                      {headers.map((h, i) => <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3 border-t border-[var(--color-v4-border)] pt-4">
                <div>
                  <label className="block text-[11px] text-[var(--color-v4-text-muted)] mb-1">Canal (todo o lote) <span className="text-[var(--color-v4-red)]">*</span></label>
                  <select className={inputClass} value={canal} onChange={(e) => setCanal(e.target.value as LeadCanal)}>
                    {(Object.keys(CANAL_LABELS) as LeadCanal[]).map((c) => <option key={c} value={c}>{CANAL_LABELS[c]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-[var(--color-v4-text-muted)] mb-1">Responsável (todo o lote)</label>
                  <select className={inputClass} value={sdrId} onChange={(e) => setSdrId(e.target.value)}>
                    <option value="">— sem responsável —</option>
                    {responsaveis.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>

              {/* Funil + etapa do Kommo (opcional; senão deriva do canal) */}
              {pipelines.length > 0 && (
                <div className="grid grid-cols-2 gap-3 border-t border-[var(--color-v4-border)] pt-4">
                  <div>
                    <label className="block text-[11px] text-[var(--color-v4-text-muted)] mb-1">Funil no Kommo</label>
                    <select className={inputClass} value={pipelineId}
                      onChange={(e) => { const v = e.target.value ? parseInt(e.target.value, 10) : ""; setPipelineId(v); setStatusId(""); }}>
                      <option value="">— automático (pelo canal) —</option>
                      {pipelines.map((p) => <option key={p.pipeline_id} value={p.pipeline_id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-[var(--color-v4-text-muted)] mb-1">Etapa</label>
                    <select className={inputClass} value={statusId} disabled={!pipelineId}
                      onChange={(e) => setStatusId(e.target.value ? parseInt(e.target.value, 10) : "")}>
                      <option value="">{pipelineId ? "— 1ª etapa do funil —" : "—"}</option>
                      {statusesOfPipeline.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 3 — Preview + duplicatas */}
          {step === 3 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded bg-emerald-500/15 text-emerald-300">{summary.novas} novas</span>
                <span className="px-2 py-1 rounded bg-amber-500/15 text-amber-300">{summary.dups} duplicadas</span>
                <span className="px-2 py-1 rounded bg-red-500/15 text-red-300">{summary.inval} inválidas</span>
                <span className="px-2 py-1 rounded bg-[var(--color-v4-surface)] text-white ml-auto">{selectedCount} selecionada(s) p/ importar</span>
              </div>
              <div className="overflow-auto max-h-[46vh] rounded-lg border border-[var(--color-v4-border)]">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--color-v4-surface)] sticky top-0">
                    <tr className="text-left text-[var(--color-v4-text-muted)]">
                      <th className="px-2 py-2 w-8"></th>
                      <th className="px-2 py-2">Empresa</th>
                      <th className="px-2 py-2">Contato</th>
                      <th className="px-2 py-2">E-mail</th>
                      <th className="px-2 py-2">Telefone</th>
                      <th className="px-2 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((p, i) => {
                      const s = statuses[i];
                      const disabled = s.kind === "invalida";
                      return (
                        <tr key={i} className="border-t border-[var(--color-v4-border)]">
                          <td className="px-2 py-1.5">
                            <input type="checkbox" disabled={disabled}
                              checked={!!decisions[i]}
                              onChange={(e) => setDecisions((d) => ({ ...d, [i]: e.target.checked }))}
                              className="accent-[var(--color-v4-red)] w-4 h-4 disabled:opacity-30" />
                          </td>
                          <td className="px-2 py-1.5 text-white">{p.empresa || <span className="text-red-400">—</span>}</td>
                          <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{p.nome_contato}</td>
                          <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{p.email}</td>
                          <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{p.telefone}</td>
                          <td className="px-2 py-1.5">{statusBadge(s)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-[var(--color-v4-text-muted)]">
                Duplicatas vêm desmarcadas; marque as que quiser importar mesmo assim. Inválidas (sem empresa) não podem ser importadas.
              </p>
            </div>
          )}

          {/* STEP 4 — Resultado */}
          {step === 4 && result && (
            <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
              <CheckCircle2 size={40} className="text-emerald-400" />
              <p className="text-white font-semibold">{result.inserted} lead(s) importado(s)!</p>
              {result.failed > 0 && (
                <p className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle size={12} /> {result.failed} falharam (veja o console).</p>
              )}
              <p className="text-xs text-[var(--color-v4-text-muted)] max-w-md">
                Os leads estão sendo criados no Kommo automaticamente (o link aparece em alguns minutos).
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[var(--color-v4-border)] flex items-center justify-between">
          <div>
            {step === 2 && (
              <button onClick={() => setStep(1)} className="flex items-center gap-1 text-xs text-[var(--color-v4-text-muted)] hover:text-white">
                <ArrowLeft size={14} /> Voltar
              </button>
            )}
            {step === 3 && (
              <button onClick={() => setStep(2)} className="flex items-center gap-1 text-xs text-[var(--color-v4-text-muted)] hover:text-white">
                <ArrowLeft size={14} /> Voltar ao mapeamento
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {step === 2 && (
              <button onClick={goPreview}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-medium">
                Revisar <ArrowRight size={14} />
              </button>
            )}
            {step === 3 && (
              <button onClick={handleImport} disabled={importing || selectedCount === 0}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-medium disabled:opacity-40">
                {importing ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
                {importing ? "Importando…" : `Importar ${selectedCount}`}
              </button>
            )}
            {step === 4 && (
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-medium">
                Concluir
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
