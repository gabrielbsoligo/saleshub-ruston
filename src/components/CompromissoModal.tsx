// =============================================================
// CompromissoModal — modal proativo de declaração do dia
// =============================================================
// Aparece automaticamente quando user faz primeira sessão do dia
// após 7h e ainda não declarou compromisso. Pode ser dispensado
// (localStorage) e reaberto manualmente via botão.
// =============================================================
import React, { useEffect, useState } from 'react';
import { X, Save, ListChecks } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';
import { useAppStore } from '../store';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export const CompromissoModal: React.FC<Props> = ({ open, onClose, onSaved }) => {
  const { currentUser } = useAppStore();
  const [form, setForm] = useState({
    meta_ligacoes: 100,
    meta_reunioes_marcadas: 3,
    meta_reunioes_realizadas: 2,
    meta_contratos_rua: 0,
    meta_contratos_fechados: 0,
    observacao: '',
  });
  const [saving, setSaving] = useState(false);

  // Quando abrir, carrega compromisso já existente do dia (caso user reabra pra editar)
  useEffect(() => {
    if (!open || !currentUser?.id) return;
    (async () => {
      const { data } = await supabase
        .from('compromissos_dia')
        .select('*')
        .eq('member_id', currentUser.id)
        .eq('data', todayStr())
        .maybeSingle();
      if (data) {
        setForm({
          meta_ligacoes: data.meta_ligacoes ?? 0,
          meta_reunioes_marcadas: data.meta_reunioes_marcadas ?? 0,
          meta_reunioes_realizadas: data.meta_reunioes_realizadas ?? 0,
          meta_contratos_rua: data.meta_contratos_rua ?? 0,
          meta_contratos_fechados: data.meta_contratos_fechados ?? 0,
          observacao: data.observacao ?? '',
        });
      }
    })();
  }, [open, currentUser?.id]);

  if (!open || !currentUser) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        member_id: currentUser.id,
        data: todayStr(),
        declarado_em: new Date().toISOString(),
        meta_ligacoes: Number(form.meta_ligacoes) || 0,
        meta_reunioes_marcadas: Number(form.meta_reunioes_marcadas) || 0,
        meta_reunioes_realizadas: Number(form.meta_reunioes_realizadas) || 0,
        meta_contratos_rua: Number(form.meta_contratos_rua) || 0,
        meta_contratos_fechados: Number(form.meta_contratos_fechados) || 0,
        observacao: form.observacao || null,
      };
      const { error } = await supabase
        .from('compromissos_dia')
        .upsert(payload, { onConflict: 'member_id,data' });
      if (error) throw error;
      toast.success('Compromisso registrado! Boa marcha 🚀');
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDispensar = () => {
    // Marca dispensa pra o dia inteiro (não vai abrir de novo automaticamente)
    localStorage.setItem(`compromisso_dismissed_${todayStr()}`, '1');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-start justify-between px-6 py-4 border-b border-[var(--color-v4-border)] bg-gradient-to-br from-[var(--color-v4-red)]/15 to-transparent">
          <div>
            <div className="flex items-center gap-2">
              <ListChecks size={18} className="text-[var(--color-v4-red)]" />
              <h3 className="text-lg font-bold text-white">Compromisso do dia</h3>
            </div>
            <p className="text-xs text-[var(--color-v4-text-muted)] mt-1">
              {currentUser.name?.split(' ')[0]}, o que você entrega hoje?
            </p>
          </div>
          <button onClick={handleDispensar} className="p-1.5 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-3 text-sm">
          <Row label="Ligações" value={form.meta_ligacoes} onChange={v => setForm(p => ({ ...p, meta_ligacoes: v }))} hint="100-150 é o ritmo de quem bate. Ajusta se necessário." />
          <Row label="Reuniões marcadas" value={form.meta_reunioes_marcadas} onChange={v => setForm(p => ({ ...p, meta_reunioes_marcadas: v }))} />
          <Row label="Reuniões realizadas" value={form.meta_reunioes_realizadas} onChange={v => setForm(p => ({ ...p, meta_reunioes_realizadas: v }))} />
          <Row label="Contratos pra rua" value={form.meta_contratos_rua} onChange={v => setForm(p => ({ ...p, meta_contratos_rua: v }))} />
          <Row label="Contratos fechados" value={form.meta_contratos_fechados} onChange={v => setForm(p => ({ ...p, meta_contratos_fechados: v }))} />

          <div className="pt-2">
            <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Observação (opcional)</label>
            <input
              type="text"
              value={form.observacao}
              onChange={e => setForm(p => ({ ...p, observacao: e.target.value }))}
              placeholder="ex: vou focar em Olimpo BH e tirar 1 OT da Air Group"
              className="w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs"
            />
          </div>
        </div>

        <div className="flex gap-2 px-6 py-3 border-t border-[var(--color-v4-border)] bg-[var(--color-v4-bg)]/30">
          <button onClick={handleDispensar} className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs">
            Mais tarde
          </button>
          <button onClick={handleSave} disabled={saving} className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50">
            <Save size={14} /> {saving ? 'Salvando…' : 'Vamos pra cima'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; value: number; onChange: (v: number) => void; hint?: string }> = ({ label, value, onChange, hint }) => (
  <div className="flex items-center justify-between gap-3">
    <div className="flex-1">
      <div className="text-white text-sm">{label}</div>
      {hint && <div className="text-[10px] text-[var(--color-v4-text-muted)]">{hint}</div>}
    </div>
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        className="w-7 h-7 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white"
      >−</button>
      <input
        type="number"
        min={0}
        value={value}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-14 text-center px-1 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm"
      />
      <button
        onClick={() => onChange(value + 1)}
        className="w-7 h-7 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white"
      >+</button>
    </div>
  </div>
);
