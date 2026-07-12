import React, { useEffect, useMemo, useState } from "react";
import { GraduationCap, Search, Upload, X, FileText, FileType2, FileCode2, FileSpreadsheet, FileImage, FileArchive, Presentation, File as FileIcon, Download, Trash2, Pencil, ExternalLink } from "lucide-react";
import toast from "react-hot-toast";
import { supabase } from "../lib/supabase";

// Educação — biblioteca de materiais (HTML/PDF/MD) com título, descrição, data de
// atualização e busca full-text (conteudo_texto extraído no upload; PDF via pdf.js).
// tipo = extens\u00e3o crua (aberto a qualquer arquivo). A categoria define \u00edcone/preview.
interface Material {
  id: string; titulo: string; descricao: string | null; tipo: string;
  storage_path: string | null; file_url: string; conteudo_texto: string | null;
  tamanho_bytes: number | null; created_at: string; updated_at: string;
}

const norm = (s: string) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fmtDate = (s: string) => new Date(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtSize = (b: number | null) => b == null ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;

type Cat = "md" | "html" | "pdf" | "image" | "sheet" | "doc" | "slide" | "archive" | "text" | "file";
const CATS: { cat: Cat; exts: string[]; label: string; Icon: React.ComponentType<{ size?: number }>; cls: string }[] = [
  { cat: "md",      exts: ["md", "markdown"],                          label: "MD",       Icon: FileText,        cls: "text-emerald-400 bg-emerald-500/15" },
  { cat: "html",    exts: ["html", "htm"],                            label: "HTML",     Icon: FileCode2,       cls: "text-sky-400 bg-sky-500/15" },
  { cat: "pdf",     exts: ["pdf"],                                    label: "PDF",      Icon: FileType2,       cls: "text-red-400 bg-red-500/15" },
  { cat: "image",   exts: ["png","jpg","jpeg","gif","webp","svg","bmp","avif"], label: "Imagem", Icon: FileImage, cls: "text-violet-400 bg-violet-500/15" },
  { cat: "sheet",   exts: ["xls","xlsx","csv","ods"],                 label: "Planilha", Icon: FileSpreadsheet, cls: "text-green-400 bg-green-500/15" },
  { cat: "doc",     exts: ["doc","docx","odt","rtf"],                 label: "Doc",      Icon: FileText,        cls: "text-blue-400 bg-blue-500/15" },
  { cat: "slide",   exts: ["ppt","pptx","odp"],                       label: "Slides",   Icon: Presentation,    cls: "text-orange-400 bg-orange-500/15" },
  { cat: "archive", exts: ["zip","rar","7z","tar","gz"],              label: "Arquivo",  Icon: FileArchive,     cls: "text-amber-400 bg-amber-500/15" },
  { cat: "text",    exts: ["txt","log","json"],                       label: "Texto",    Icon: FileText,        cls: "text-slate-300 bg-slate-500/15" },
];
const extFromName = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "file");
function catMeta(ext: string): { cat: Cat; label: string; Icon: React.ComponentType<{ size?: number }>; cls: string } {
  const f = CATS.find((c) => c.exts.includes((ext || "").toLowerCase()));
  return f ? { cat: f.cat, label: f.label, Icon: f.Icon, cls: f.cls }
           : { cat: "file", label: (ext || "arquivo").toUpperCase().slice(0, 5), Icon: FileIcon, cls: "text-[var(--color-v4-text-muted)] bg-white/5" };
}

// extrai texto pra busca s\u00f3 dos tipos leg\u00edveis; o resto entra sem texto (busca por t\u00edtulo/descri\u00e7\u00e3o).
const TEXT_EXTS = ["md", "markdown", "txt", "log", "json", "csv"];
async function extractText(file: File, ext: string): Promise<string> {
  const e = (ext || "").toLowerCase();
  try {
    if (TEXT_EXTS.includes(e)) return (await file.text()).slice(0, 500000);
    if (["html", "htm"].includes(e)) {
      const doc = new DOMParser().parseFromString(await file.text(), "text/html");
      return (doc.body?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500000);
    }
    if (e === "pdf") {
      const pdfjs: any = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      let text = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const c = await (await pdf.getPage(i)).getTextContent();
        text += c.items.map((it: any) => it.str).join(" ") + "\n";
      }
      return text.replace(/\s+/g, " ").trim().slice(0, 500000);
    }
  } catch (e2) { console.warn("extractText falhou", e2); }
  return "";
}

// mini-markdown -> html (escape primeiro; formatação básica). Suficiente pra materiais.
function renderMd(src: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(src).split(/\r?\n/); const out: string[] = []; let inUl = false, inCode = false;
  const inline = (t: string) => t
    .replace(/`([^`]+)`/g, '<code class="px-1 rounded bg-black/30">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="text-sky-400 underline" href="$2" target="_blank" rel="noopener">$1</a>');
  for (const ln of lines) {
    if (/^```/.test(ln)) { if (inUl) { out.push("</ul>"); inUl = false; } inCode = !inCode; out.push(inCode ? '<pre class="bg-black/30 rounded p-2 overflow-x-auto"><code>' : "</code></pre>"); continue; }
    if (inCode) { out.push(ln); continue; }
    const h = ln.match(/^(#{1,4})\s+(.*)/);
    if (h) { if (inUl) { out.push("</ul>"); inUl = false; } const lvl = h[1].length; out.push(`<h${lvl} class="font-bold text-white mt-3 mb-1 text-${lvl <= 1 ? "lg" : lvl === 2 ? "base" : "sm"}">${inline(h[2])}</h${lvl}>`); continue; }
    const li = ln.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inUl) { out.push('<ul class="list-disc pl-5 space-y-0.5">'); inUl = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (ln.trim() === "") out.push("<br/>"); else out.push(`<p class="mb-1">${inline(ln)}</p>`);
  }
  if (inUl) out.push("</ul>"); if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

export const EducacaoView: React.FC = () => {
  const [items, setItems] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [viewing, setViewing] = useState<Material | null>(null);
  const [editing, setEditing] = useState<Material | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.from("materiais_educacao").select("*").order("updated_at", { ascending: false });
    if (error) toast.error("Falha ao carregar materiais");
    setItems((data as Material[]) || []); setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const filtrados = useMemo(() => {
    const q = norm(busca).trim();
    if (!q) return items;
    const terms = q.split(/\s+/);
    return items.filter((m) => {
      const hay = norm(`${m.titulo} ${m.descricao || ""} ${m.conteudo_texto || ""}`);
      return terms.every((t) => hay.includes(t));
    });
  }, [items, busca]);

  const onDelete = async (m: Material) => {
    if (!confirm(`Excluir "${m.titulo}"?`)) return;
    const t = toast.loading("Excluindo...");
    if (m.storage_path) await supabase.storage.from("educacao").remove([m.storage_path]);
    const { error } = await supabase.from("materiais_educacao").delete().eq("id", m.id);
    if (error) toast.error("Falha ao excluir", { id: t }); else { toast.success("Excluído", { id: t }); load(); }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[var(--color-v4-red-muted)] text-[var(--color-v4-red)] flex items-center justify-center"><GraduationCap size={18} /></div>
          <div>
            <h1 className="text-lg font-bold text-white">Educação</h1>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Materiais do time — playbooks, scripts, guias e qualquer arquivo. Busca por conteúdo em HTML, PDF, Markdown e texto.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar no conteúdo…"
              className="pl-8 pr-3 py-2 w-64 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-sm text-white placeholder:text-[var(--color-v4-text-muted)] focus:outline-none focus:border-[var(--color-v4-red)]" />
          </div>
          <button onClick={() => setShowUpload(true)} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-red)] text-white hover:opacity-90">
            <Upload size={15} /> Adicionar
          </button>
        </div>
      </div>

      {loading ? <div className="text-[var(--color-v4-text-muted)] text-sm">Carregando…</div>
        : filtrados.length === 0 ? <div className="text-[var(--color-v4-text-muted)] text-sm py-10 text-center">{busca ? "Nenhum material bate com a busca." : "Nenhum material ainda. Clique em Adicionar."}</div>
        : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtrados.map((m) => {
            const meta = catMeta(m.tipo);
            return (
              <div key={m.id} className="rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-surface)] p-4 flex flex-col gap-2 hover:border-[var(--color-v4-red)]/40 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <button onClick={() => setViewing(m)} className="text-left flex items-center gap-2 min-w-0">
                    <span className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${meta.cls}`}><meta.Icon size={16} /></span>
                    <span className="font-semibold text-white text-sm truncate">{m.titulo}</span>
                  </button>
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${meta.cls}`}>{meta.label}</span>
                </div>
                {m.descricao && <p className="text-xs text-[var(--color-v4-text-muted)] line-clamp-2">{m.descricao}</p>}
                <div className="mt-auto flex items-center justify-between pt-1">
                  <span className="text-[11px] text-[var(--color-v4-text-muted)]">Atualizado {fmtDate(m.updated_at)}{m.tamanho_bytes ? ` · ${fmtSize(m.tamanho_bytes)}` : ""}</span>
                  <div className="flex items-center gap-1">
                    <button title="Abrir" onClick={() => setViewing(m)} className="p-1.5 rounded hover:bg-white/5 text-[var(--color-v4-text-muted)] hover:text-white"><ExternalLink size={14} /></button>
                    <button title="Editar" onClick={() => setEditing(m)} className="p-1.5 rounded hover:bg-white/5 text-[var(--color-v4-text-muted)] hover:text-white"><Pencil size={14} /></button>
                    <button title="Excluir" onClick={() => onDelete(m)} className="p-1.5 rounded hover:bg-white/5 text-[var(--color-v4-text-muted)] hover:text-red-400"><Trash2 size={14} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); load(); }} />}
      {editing && <EditModal material={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />}
      {viewing && <ViewerModal material={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};

// ---------- Upload ----------
const UploadModal: React.FC<{ onClose: () => void; onDone: () => void }> = ({ onClose, onDone }) => {
  const [file, setFile] = useState<File | null>(null);
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [saving, setSaving] = useState(false);

  const pick = (f: File | null) => {
    setFile(f);
    if (f && !titulo) setTitulo(f.name.replace(/\.[^.]+$/, ""));
  };

  const submit = async () => {
    if (!file) { toast.error("Escolha um arquivo"); return; }
    if (!titulo.trim()) { toast.error("Dê um título"); return; }
    if (file.size > 50 * 1024 * 1024) { toast.error("Tamanho máximo: 50MB"); return; }
    const ext = extFromName(file.name);      // qualquer extensão
    const tipo = ext;
    setSaving(true);
    const t = toast.loading("Enviando material…");
    try {
      const conteudo = await extractText(file, ext);
      const id = crypto.randomUUID();
      const path = `${id}.${ext}`;
      const { error: upErr } = await supabase.storage.from("educacao").upload(path, file, { upsert: true, contentType: file.type || undefined });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = supabase.storage.from("educacao").getPublicUrl(path);
      const { error } = await supabase.from("materiais_educacao").insert({
        id, titulo: titulo.trim(), descricao: descricao.trim() || null, tipo,
        storage_path: path, file_url: publicUrl, conteudo_texto: conteudo || null,
        tamanho_bytes: file.size, updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      toast.success("Material adicionado!", { id: t });
      onDone();
    } catch (e: any) { toast.error(`Falha: ${e.message || e}`, { id: t }); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Adicionar material" onClose={onClose}>
      <label className="block mb-3">
        <span className="text-xs text-[var(--color-v4-text-muted)]">Arquivo (qualquer tipo — HTML, PDF, MD, DOCX, XLSX, imagens…)</span>
        <input type="file" onChange={(e) => pick(e.target.files?.[0] || null)}
          className="mt-1 block w-full text-sm text-white file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-[var(--color-v4-red)] file:text-white" />
        {file && <span className="mt-1 block text-[11px] text-[var(--color-v4-text-muted)]">{file.name} · {fmtSize(file.size)}{TEXT_EXTS.concat(["html","htm","pdf"]).includes(extFromName(file.name)) ? " · conteúdo será indexado p/ busca" : " · busca por título/descrição"}</span>}
      </label>
      <Field label="Título"><input value={titulo} onChange={(e) => setTitulo(e.target.value)} className={inputCls} /></Field>
      <Field label="Descrição"><textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={3} className={inputCls} /></Field>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-[var(--color-v4-text-muted)] hover:text-white">Cancelar</button>
        <button onClick={submit} disabled={saving} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-red)] text-white hover:opacity-90 disabled:opacity-50">{saving ? "Enviando…" : "Adicionar"}</button>
      </div>
    </Modal>
  );
};

// ---------- Editar metadados (bump updated_at) ----------
const EditModal: React.FC<{ material: Material; onClose: () => void; onDone: () => void }> = ({ material, onClose, onDone }) => {
  const [titulo, setTitulo] = useState(material.titulo);
  const [descricao, setDescricao] = useState(material.descricao || "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!titulo.trim()) { toast.error("Título obrigatório"); return; }
    setSaving(true); const t = toast.loading("Salvando…");
    const { error } = await supabase.from("materiais_educacao")
      .update({ titulo: titulo.trim(), descricao: descricao.trim() || null, updated_at: new Date().toISOString() })
      .eq("id", material.id);
    if (error) toast.error("Falha ao salvar", { id: t }); else { toast.success("Atualizado", { id: t }); onDone(); }
    setSaving(false);
  };
  return (
    <Modal title="Editar material" onClose={onClose}>
      <Field label="Título"><input value={titulo} onChange={(e) => setTitulo(e.target.value)} className={inputCls} /></Field>
      <Field label="Descrição"><textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={3} className={inputCls} /></Field>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-[var(--color-v4-text-muted)] hover:text-white">Cancelar</button>
        <button onClick={save} disabled={saving} className="px-3 py-2 rounded-lg text-sm bg-[var(--color-v4-red)] text-white hover:opacity-90 disabled:opacity-50">Salvar</button>
      </div>
    </Modal>
  );
};

// ---------- Viewer ----------
const ViewerModal: React.FC<{ material: Material; onClose: () => void }> = ({ material, onClose }) => (
  <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-xl w-full max-w-5xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-v4-border)]">
        <div className="min-w-0">
          <h2 className="text-white font-semibold text-sm truncate">{material.titulo}</h2>
          <p className="text-[11px] text-[var(--color-v4-text-muted)]">Atualizado {fmtDate(material.updated_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href={material.file_url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-v4-text-muted)] hover:text-white" title="Abrir em nova aba"><ExternalLink size={16} /></a>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {(() => {
          const cat = catMeta(material.tipo).cat;
          if (cat === "md") return <div className="h-full overflow-y-auto p-6 text-[13px] text-white leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMd(material.conteudo_texto || "") }} />;
          if (cat === "image") return <div className="h-full overflow-auto flex items-center justify-center bg-black/40 p-4"><img src={material.file_url} alt={material.titulo} className="max-w-full max-h-full object-contain" /></div>;
          if (cat === "html" || cat === "pdf" || cat === "text") return <iframe src={material.file_url} title={material.titulo} className={`w-full h-full border-0 ${cat === "html" ? "bg-white" : ""}`} />;
          // office/zip/desconhecido: navegador não pré-visualiza -> baixar/abrir
          const M = catMeta(material.tipo);
          return (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
              <span className={`w-16 h-16 rounded-2xl flex items-center justify-center ${M.cls}`}><M.Icon size={30} /></span>
              <p className="text-sm text-[var(--color-v4-text-muted)] max-w-xs">Este tipo de arquivo (.{material.tipo}) não tem pré-visualização no navegador.</p>
              <a href={material.file_url} target="_blank" rel="noopener noreferrer" download className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-[var(--color-v4-red)] text-white hover:opacity-90"><Download size={15} /> Baixar / abrir</a>
            </div>
          );
        })()}
      </div>
    </div>
  </div>
);

// ---------- helpers de UI ----------
const inputCls = "mt-1 block w-full rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-sm text-white px-3 py-2 focus:outline-none focus:border-[var(--color-v4-red)]";
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block mb-3"><span className="text-xs text-[var(--color-v4-text-muted)]">{label}</span>{children}</label>
);
const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-4"><h2 className="text-white font-semibold">{title}</h2><button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button></div>
      {children}
    </div>
  </div>
);
