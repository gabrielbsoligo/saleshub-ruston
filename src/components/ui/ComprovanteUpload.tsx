import React, { useRef, useState } from "react";
import { UploadCloud, Receipt, X, Loader2, Download } from "lucide-react";
import { supabase } from "../../lib/supabase";
import toast from "react-hot-toast";

// Comprovante de pagamento do fechamento (imagem, OPCIONAL).
// Vive no bucket 'contracts' em <dealId>/comprovante_<nome> — aparece na aba Arquivos.
interface Props {
  dealId: string;
  url?: string;
  filename?: string;
  onUploaded: (url: string, filename: string) => void;
  onRemoved: () => void;
}

export const ComprovanteUpload: React.FC<Props> = ({ dealId, url, filename, onUploaded, onRemoved }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
      toast.error('Envie uma imagem (print/foto) ou PDF do comprovante.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) { toast.error('Tamanho máximo: 10MB.'); return; }

    setBusy(true);
    const toastId = toast.loading('Enviando comprovante...');
    try {
      const safeName = 'comprovante_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${dealId}/${safeName}`;
      const { error } = await supabase.storage.from('contracts').upload(path, file, { upsert: true });
      if (error) throw error;
      const { data: { publicUrl } } = supabase.storage.from('contracts').getPublicUrl(path);
      onUploaded(publicUrl, file.name);
      toast.success('Comprovante anexado!', { id: toastId });
    } catch (err: any) {
      toast.error('Erro ao enviar: ' + err.message, { id: toastId });
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const handleRemove = async () => {
    if (!filename || !confirm('Remover comprovante?')) return;
    setBusy(true);
    try {
      const safeName = 'comprovante_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      await supabase.storage.from('contracts').remove([`${dealId}/${safeName}`]);
      onRemoved();
      toast.success('Comprovante removido.');
    } catch {
      toast.error('Erro ao remover.');
    } finally { setBusy(false); }
  };

  if (url) {
    return (
      <div>
        <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">Comprovante de pagamento (opcional)</label>
        <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-v4-bg)] border border-emerald-500/30">
          <div className="flex items-center gap-2 overflow-hidden">
            <Receipt size={16} className="text-emerald-400 flex-shrink-0" />
            <span className="text-xs text-white truncate">{filename || 'comprovante'}</span>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <a href={url} target="_blank" rel="noopener" className="p-1.5 rounded hover:bg-[var(--color-v4-card-hover)] text-[var(--color-v4-text-muted)] hover:text-white">
              <Download size={14} />
            </a>
            <button onClick={handleRemove} disabled={busy} className="p-1.5 rounded hover:bg-red-500/20 text-[var(--color-v4-text-muted)] hover:text-red-400">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">Comprovante de pagamento (opcional)</label>
      <input ref={fileRef} type="file" accept="image/*,.pdf" onChange={handleUpload} className="hidden" />
      <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
        className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border-2 border-dashed border-[var(--color-v4-border)] hover:border-emerald-500 text-[var(--color-v4-text-muted)] hover:text-white transition-colors">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <UploadCloud size={16} />}
        <span className="text-xs">{busy ? 'Enviando...' : 'Anexar comprovante (imagem ou PDF)'}</span>
      </button>
    </div>
  );
};
