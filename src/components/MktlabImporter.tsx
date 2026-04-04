import React, { useState } from "react";
import { useAppStore } from "../store";
import { CANAL_LABELS, ALL_PRODUTOS, type LeadCanal } from "../types";
import { Zap, Copy, Check, ArrowRight } from "lucide-react";

// Bookmarklet code that extracts data from mktlab page
const BOOKMARKLET_CODE = `javascript:void(function(){try{var d=document;var getData=function(sel){var el=d.querySelector(sel);return el?el.textContent.trim():''};var getInput=function(sel){var el=d.querySelector(sel);return el?el.value.trim():''};var data={empresa:getData('h1,h2,.lead-name,.company-name,[class*=name]')||d.title,contato:getData('.contact-name,.lead-contact,[class*=contact]'),telefone:getData('.phone,a[href^=tel],[class*=phone],[class*=telefone]'),email:getData('.email,a[href^=mailto],[class*=email]'),cnpj:getData('[class*=cnpj],[class*=CNPJ]'),faturamento:getData('[class*=faturamento],[class*=revenue]'),url:location.href};var json=JSON.stringify(data);navigator.clipboard.writeText(json).then(function(){alert('SalesHub: Dados copiados!\\n'+data.empresa+'\\nCole no sistema com Ctrl+V')}).catch(function(){prompt('Copie manualmente:',json)})}catch(e){alert('Erro: '+e.message)}})()`;

export const MktlabImporter: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { addLead, members } = useAppStore();
  const sdrs = members.filter(m => m.role === 'sdr' || m.role === 'gestor');
  const [copied, setCopied] = useState(false);
  const [pastedData, setPastedData] = useState('');
  const [form, setForm] = useState({
    empresa: '', nome_contato: '', telefone: '', cnpj: '', faturamento: '',
    canal: 'leadbroker' as LeadCanal, fonte: '', produto: '', sdr_id: '',
  });

  const inputClass = "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";

  const handleCopyBookmarklet = () => {
    navigator.clipboard.writeText(BOOKMARKLET_CODE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePaste = (text: string) => {
    setPastedData(text);
    try {
      const data = JSON.parse(text);
      setForm(prev => ({
        ...prev,
        empresa: data.empresa || prev.empresa,
        nome_contato: data.contato || prev.nome_contato,
        telefone: data.telefone || prev.telefone,
        cnpj: data.cnpj || prev.cnpj,
        faturamento: data.faturamento || prev.faturamento,
      }));
    } catch {
      // Not JSON, try to parse as text
    }
  };

  const [isProcessing, setIsProcessing] = useState(false);

  const handleSave = async () => {
    if (!form.empresa || isProcessing) return;
    setIsProcessing(true);
    try { await addLead(form as any); onClose(); }
    finally { setIsProcessing(false); }
  };

  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl overflow-hidden">
        <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-6 py-4 flex items-center gap-3">
          <Zap size={20} className="text-emerald-400" />
          <div>
            <h3 className="text-sm font-bold text-emerald-400">Importar do MKTLAB</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Extraia dados com 1 clique</p>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Instrucoes */}
          <div className="bg-[var(--color-v4-surface)] rounded-lg p-4 space-y-3">
            <p className="text-xs text-[var(--color-v4-text-muted)] font-semibold uppercase">Como usar:</p>
            <div className="flex items-start gap-3">
              <span className="text-xs bg-emerald-500 text-black w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0">1</span>
              <div>
                <p className="text-xs text-white">Arraste o botao abaixo para sua barra de favoritos:</p>
                <div className="mt-2 flex items-center gap-2">
                  <a href={BOOKMARKLET_CODE} onClick={e => e.preventDefault()}
                    className="inline-block px-3 py-1.5 rounded bg-emerald-500 text-black text-xs font-bold cursor-grab">
                    Extrair p/ SalesHub
                  </a>
                  <button onClick={handleCopyBookmarklet} className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1">
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? 'Copiado!' : 'Copiar link'}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-xs bg-emerald-500 text-black w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0">2</span>
              <p className="text-xs text-white">Abra o lead no MKTLAB e clique no bookmarklet</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-xs bg-emerald-500 text-black w-5 h-5 rounded-full flex items-center justify-center font-bold flex-shrink-0">3</span>
              <p className="text-xs text-white">Cole os dados aqui (Ctrl+V):</p>
            </div>
          </div>

          <textarea className={inputClass + " h-16"} placeholder='Cole os dados extraidos aqui (Ctrl+V)...'
            value={pastedData} onChange={e => handlePaste(e.target.value)} />

          <hr className="border-[var(--color-v4-border)]" />

          {/* Form pre-populado */}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Empresa *</label>
              <input className={inputClass} value={form.empresa} onChange={e => set('empresa', e.target.value)} /></div>
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Contato</label>
              <input className={inputClass} value={form.nome_contato} onChange={e => set('nome_contato', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Telefone</label>
              <input className={inputClass} value={form.telefone} onChange={e => set('telefone', e.target.value)} /></div>
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Canal</label>
              <select className={inputClass} value={form.canal} onChange={e => set('canal', e.target.value)}>
                {Object.entries(CANAL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">SDR</label>
              <select className={inputClass} value={form.sdr_id} onChange={e => set('sdr_id', e.target.value)}>
                <option value="">Selecionar</option>
                {sdrs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
            <div><label className="block text-xs text-[var(--color-v4-text-muted)] mb-1">Produto</label>
              <select className={inputClass} value={form.produto} onChange={e => set('produto', e.target.value)}>
                <option value="">Selecionar</option>
                {ALL_PRODUTOS.map(p => <option key={p} value={p}>{p}</option>)}
              </select></div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[var(--color-v4-border)] flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
          <button onClick={handleSave} disabled={!form.empresa || isProcessing}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-30 text-black font-bold text-sm">
            <ArrowRight size={14} /> {isProcessing ? 'Criando...' : 'Criar Lead'}
          </button>
        </div>
      </div>
    </div>
  );
};
