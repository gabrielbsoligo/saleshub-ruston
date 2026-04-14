import React, { useRef, useState } from "react";
import { UploadCloud, FileText, X, Loader2, Download } from "lucide-react";
import { supabase } from "../../lib/supabase";
import toast from "react-hot-toast";

interface ContractUploadProps {
  dealId: string;
  contractUrl?: string;
  contractFilename?: string;
  onUploaded: (url: string, filename: string) => void;
  onRemoved: () => void;
  onParsing?: (parsing: boolean) => void;
  onParsed?: (result: any) => void;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const ContractUpload: React.FC<ContractUploadProps> = ({ dealId, contractUrl, contractFilename, onUploaded, onRemoved, onParsing, onParsed }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      toast.error("Apenas arquivos PDF são permitidos.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Tamanho máximo: 10MB.");
      return;
    }

    setIsUploading(true);
    const toastId = toast.loading("Enviando contrato...");

    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${dealId}/${safeName}`;

      const { error } = await supabase.storage.from('contracts').upload(path, file, { upsert: true });
      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage.from('contracts').getPublicUrl(path);

      onUploaded(publicUrl, file.name);
      toast.success("Contrato anexado!", { id: toastId });

      // Auto-parse contract with AI (send base64 directly — more reliable than URL)
      if (onParsed) {
        onParsing?.(true);
        const parseToast = toast.loading("Analisando contrato com IA...");
        try {
          // Read file as base64 client-side
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // Remove data:application/pdf;base64, prefix
              resolve(result.split(',')[1] || result);
            };
            reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
            reader.readAsDataURL(file);
          });

          const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-contract`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ pdf_base64: base64 }),
          });
          if (resp.ok) {
            const parsed = await resp.json();
            if (parsed.ok) {
              onParsed(parsed);
              toast.success("Contrato analisado! Campos preenchidos.", { id: parseToast, icon: '📄' });
            } else {
              toast.error(parsed.error || "Erro ao analisar", { id: parseToast });
            }
          } else {
            const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
            toast.error(err.error || "Erro ao analisar contrato", { id: parseToast });
          }
        } catch (e: any) {
          toast.error("Erro ao analisar: " + e.message, { id: parseToast });
        } finally {
          onParsing?.(false);
        }
      }
    } catch (err: any) {
      toast.error("Erro ao enviar: " + err.message, { id: toastId });
    } finally {
      setIsUploading(false);
      e.target.value = "";
    }
  };

  const handleRemove = async () => {
    if (!contractFilename || !confirm('Remover contrato?')) return;
    setIsUploading(true);
    try {
      const safeName = contractFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
      await supabase.storage.from('contracts').remove([`${dealId}/${safeName}`]);
      onRemoved();
      toast.success("Contrato removido.");
    } catch {
      toast.error("Erro ao remover.");
    } finally {
      setIsUploading(false);
    }
  };

  if (contractUrl) {
    return (
      <div>
        <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">Contrato PDF *</label>
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-v4-bg)] border border-green-500/30">
          <div className="flex items-center gap-2 overflow-hidden">
            <FileText size={16} className="text-green-400 flex-shrink-0" />
            <span className="text-xs text-white truncate">{contractFilename || 'contrato.pdf'}</span>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <a href={contractUrl} target="_blank" rel="noopener" className="p-1.5 rounded hover:bg-[var(--color-v4-card-hover)] text-[var(--color-v4-text-muted)] hover:text-white">
              <Download size={14} />
            </a>
            <button onClick={handleRemove} disabled={isUploading} className="p-1.5 rounded hover:bg-red-500/20 text-[var(--color-v4-text-muted)] hover:text-red-400">
              {isUploading ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">Contrato PDF *</label>
      <input ref={fileRef} type="file" accept=".pdf" onChange={handleUpload} className="hidden" />
      <button type="button" onClick={() => fileRef.current?.click()} disabled={isUploading}
        className="w-full flex items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] text-[var(--color-v4-text-muted)] hover:text-white transition-colors">
        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <UploadCloud size={18} />}
        <span className="text-sm">{isUploading ? 'Enviando...' : 'Clique para anexar PDF (máx 10MB)'}</span>
      </button>
    </div>
  );
};
