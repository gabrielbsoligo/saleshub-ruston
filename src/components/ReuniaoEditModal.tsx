// =============================================================
// ReuniaoEditModal — gestor edita reuniao (qualquer campo)
// =============================================================
// Modal central com formulario completo. Usado pelo gestor pra
// corrigir dados de reunioes (closer trocado, data ajustada,
// status de show/realizada, anotacoes, etc).
// =============================================================
import React, { useEffect, useState } from 'react';
import { X, Save, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';
import type { Reuniao, TipoReuniao } from '../types';
import { supabase } from '../lib/supabase';

interface Props {
  reuniao: Reuniao | null;
  onClose: () => void;
}

const inputClass = "w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)] disabled:opacity-60";

function toLocalDateTimeInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  // YYYY-MM-DDTHH:mm  (datetime-local nao aceita timezone)
  const tzOffsetMin = d.getTimezoneOffset();
  const localMs = d.getTime() - tzOffsetMin * 60000;
  return new Date(localMs).toISOString().slice(0, 16);
}

function fromLocalDateTimeInput(local: string): string | null {
  if (!local) return null;
  return new Date(local).toISOString();
}

// URL do lead no mktlab pra "converter em oportunidade".
// Se o lead tem link/id salvo -> abre direto no lead; senão cai na lista geral
// (hook: quando o id do mktlab passar a ser capturado, abre direto sem mudar nada).
function mktlabUrl(lead?: { mktlab_link?: string; mktlab_id?: string } | null): string {
  if (lead?.mktlab_link) return lead.mktlab_link;
  if (lead?.mktlab_id) return `https://mktlab.app/crm/leads/${lead.mktlab_id}`;
  return 'https://mktlab.app/crm/leads';
}

export const ReuniaoEditModal: React.FC<Props> = ({ reuniao, onClose }) => {
  const { members, leads, updateReuniao, currentUser } = useAppStore();
  const isGestor = currentUser?.role === 'gestor';

  const [form, setForm] = useState<Partial<Reuniao>>({});
  const [dataReuniaoLocal, setDataReuniaoLocal] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (reuniao) {
      setForm({
        empresa: reuniao.empresa,
        nome_contato: reuniao.nome_contato,
        canal: reuniao.canal,
        tipo: reuniao.tipo,
        sdr_id: reuniao.sdr_id,
        closer_id: reuniao.closer_id,
        sdr_confirmado_id: reuniao.sdr_confirmado_id,
        closer_confirmado_id: reuniao.closer_confirmado_id,
        realizada: reuniao.realizada,
        show: reuniao.show,
        notas: reuniao.notas,
        kommo_id: reuniao.kommo_id,
      });
      setDataReuniaoLocal(toLocalDateTimeInput(reuniao.data_reuniao));
    }
  }, [reuniao?.id]);

  if (!reuniao) return null;

  const sdrs = members.filter(m => m.active && (m.role === 'sdr' || m.role === 'gestor'));
  const closers = members.filter(m => m.active && (m.role === 'closer' || m.role === 'gestor'));

  const handleSave = async () => {
    if (!isGestor) {
      toast.error('Somente gestor pode editar reunião');
      return;
    }
    setSaving(true);
    try {
      const payload: Partial<Reuniao> = {
        ...form,
        data_reuniao: fromLocalDateTimeInput(dataReuniaoLocal) || undefined,
      };
      // limpa campos vazios pra null
      if (!payload.sdr_id) (payload as any).sdr_id = null;
      if (!payload.closer_id) (payload as any).closer_id = null;
      if (!payload.sdr_confirmado_id) (payload as any).sdr_confirmado_id = null;
      if (!payload.closer_confirmado_id) (payload as any).closer_confirmado_id = null;

      // reunião passou a REALIZADA agora? (transição) -> avisa pra converter no mktlab
      const becameRealizada = !!payload.realizada && !reuniao.realizada;

      await updateReuniao(reuniao.id, payload);
      toast.success('Reunião atualizada');
      onClose();

      if (becameRealizada) {
        const lead = reuniao.lead_id ? leads.find((l) => l.id === reuniao.lead_id) : null;
        const url = mktlabUrl(lead);
        // Aviso com botão — NÃO abre sozinho (evita pop-up bloqueado); o clique abre.
        toast(
          (t) => (
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">
                Reunião realizada — converta o lead em <b>oportunidade no mktlab</b>.
                {lead?.mktlab_link || lead?.mktlab_id ? '' : ' (abre a lista geral — lead sem link mktlab salvo)'}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { window.open(url, '_blank', 'noopener,noreferrer'); toast.dismiss(t.id); }}
                  className="px-3 py-1.5 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-medium"
                >
                  Abrir mktlab ↗
                </button>
                <button onClick={() => toast.dismiss(t.id)} className="px-3 py-1.5 rounded-lg text-xs text-[var(--color-v4-text-muted)] hover:text-white">
                  Depois
                </button>
              </div>
            </div>
          ),
          { duration: 15000, icon: '🎯' },
        );
      }
    } catch (e: any) {
      toast.error(e.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!isGestor) return;
    if (!confirm(`Apagar reunião de "${reuniao.empresa || 'sem empresa'}"? Essa ação não pode ser desfeita.`)) return;
    const { error } = await supabase.from('reunioes').delete().eq('id', reuniao.id);
    if (error) return toast.error(error.message);
    toast.success('Reunião apagada');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[var(--color-v4-border)] sticky top-0 bg-[var(--color-v4-card)] z-10">
          <div className="flex-1 min-w-0">
            <h3 className="text-white font-semibold truncate">
              Editar Reunião · {reuniao.empresa || '—'}
            </h3>
            <p className="text-[10px] text-[var(--color-v4-text-muted)] mt-0.5">
              ID: <span className="font-mono">{reuniao.id.slice(0, 8)}</span> · Criada em {new Date(reuniao.created_at).toLocaleString('pt-BR')}
            </p>
          </div>
          <div className="flex gap-1">
            {isGestor && (
              <button onClick={handleDelete} title="Apagar reunião"
                      className="p-2 rounded hover:bg-red-500/10 text-[var(--color-v4-text-muted)] hover:text-red-400">
                <Trash2 size={14} />
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {!isGestor && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 text-xs text-amber-300">
              Somente gestor pode editar reuniões.
            </div>
          )}

          {/* Identificação */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Empresa">
              <input type="text" value={form.empresa || ''} disabled={!isGestor}
                     onChange={(e) => setForm({ ...form, empresa: e.target.value })}
                     className={inputClass}/>
            </Field>
            <Field label="Nome do contato">
              <input type="text" value={form.nome_contato || ''} disabled={!isGestor}
                     onChange={(e) => setForm({ ...form, nome_contato: e.target.value })}
                     className={inputClass}/>
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Canal">
              <input type="text" value={form.canal || ''} disabled={!isGestor}
                     onChange={(e) => setForm({ ...form, canal: e.target.value })}
                     className={inputClass}/>
            </Field>
            <Field label="Tipo">
              <select value={form.tipo || 'primeira_call'} disabled={!isGestor}
                      onChange={(e) => setForm({ ...form, tipo: e.target.value as TipoReuniao })}
                      className={inputClass}>
                <option value="primeira_call">Primeira call</option>
                <option value="retorno">Retorno</option>
              </select>
            </Field>
            <Field label="Kommo ID">
              <input type="text" value={form.kommo_id || ''} disabled={!isGestor}
                     onChange={(e) => setForm({ ...form, kommo_id: e.target.value })}
                     className={inputClass}/>
            </Field>
          </div>

          {/* Data */}
          <Field label="Data e hora da reunião">
            <input type="datetime-local" value={dataReuniaoLocal} disabled={!isGestor}
                   min="2020-01-01T00:00" max="2050-12-31T23:59"
                   onChange={(e) => {
                     const v = e.target.value;
                     if (v) {
                       const y = parseInt(v.slice(0, 4), 10);
                       if (!Number.isFinite(y) || y < 2020 || y > 2050) return;
                     }
                     setDataReuniaoLocal(v);
                   }}
                   className={inputClass}/>
          </Field>

          {/* Atribuições — agendamento */}
          <div className="border border-[var(--color-v4-border)] rounded-lg p-3 space-y-3">
            <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)] font-semibold">Atribuição original (agendamento)</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SDR (criou)">
                <select value={form.sdr_id || ''} disabled={!isGestor}
                        onChange={(e) => setForm({ ...form, sdr_id: e.target.value || undefined })}
                        className={inputClass}>
                  <option value="">— sem SDR —</option>
                  {sdrs.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Closer (agendado)">
                <select value={form.closer_id || ''} disabled={!isGestor}
                        onChange={(e) => setForm({ ...form, closer_id: e.target.value || undefined })}
                        className={inputClass}>
                  <option value="">— sem closer —</option>
                  {closers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
            </div>
          </div>

          {/* Atribuições — confirmadas */}
          <div className="border border-[var(--color-v4-border)] rounded-lg p-3 space-y-3">
            <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)] font-semibold">Quem realmente realizou (confirmação)</div>
            <p className="text-[10px] text-[var(--color-v4-text-muted)]">Preenchido quando a reunião é marcada como realizada. Usado pra atribuir o deal e relatórios.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SDR confirmado">
                <select value={form.sdr_confirmado_id || ''} disabled={!isGestor}
                        onChange={(e) => setForm({ ...form, sdr_confirmado_id: e.target.value || undefined })}
                        className={inputClass}>
                  <option value="">— mesmo do agendamento —</option>
                  {sdrs.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
              <Field label="Closer confirmado">
                <select value={form.closer_confirmado_id || ''} disabled={!isGestor}
                        onChange={(e) => setForm({ ...form, closer_confirmado_id: e.target.value || undefined })}
                        className={inputClass}>
                  <option value="">— mesmo do agendamento —</option>
                  {closers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
            </div>
          </div>

          {/* Status */}
          <div className="border border-[var(--color-v4-border)] rounded-lg p-3 space-y-3">
            <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)] font-semibold">Status</div>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                <input type="checkbox" checked={form.realizada || false} disabled={!isGestor}
                       onChange={(e) => setForm({ ...form, realizada: e.target.checked, show: e.target.checked ? form.show : undefined })}
                       className="accent-[var(--color-v4-red)] w-4 h-4"/>
                Realizada
              </label>
              {form.realizada && (
                <>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="show" checked={form.show === true} disabled={!isGestor}
                           onChange={() => setForm({ ...form, show: true })}
                           className="accent-green-500 w-4 h-4"/>
                    <span className="text-green-400">Show</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="radio" name="show" checked={form.show === false} disabled={!isGestor}
                           onChange={() => setForm({ ...form, show: false })}
                           className="accent-red-500 w-4 h-4"/>
                    <span className="text-red-400">No-show</span>
                  </label>
                </>
              )}
            </div>
          </div>

          {/* Notas */}
          <Field label="Notas / observação">
            <textarea value={form.notas || ''} disabled={!isGestor}
                      onChange={(e) => setForm({ ...form, notas: e.target.value })}
                      rows={3}
                      className={inputClass}/>
          </Field>
        </div>

        {/* Footer */}
        {isGestor && (
          <div className="flex gap-2 px-6 py-3 border-t border-[var(--color-v4-border)] bg-[var(--color-v4-card)] sticky bottom-0">
            <button onClick={onClose}
                    className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs">
              Cancelar
            </button>
            <button onClick={handleSave} disabled={saving}
                    className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50">
              <Save size={12} /> {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">{label}</label>
    {children}
  </div>
);
