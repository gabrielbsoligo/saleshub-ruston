// =============================================================
// MemberDrawer — painel lateral para editar membro da equipe
// =============================================================
// Abre no click do card de membro em EquipeView.
// Permissao: somente gestor (ja garantido por RLS tm_update e UI).
// Campos editaveis: nome, email, role, ramal_4com, kommo_user_id, ativo.
// =============================================================
import React, { useEffect, useState } from 'react';
import { X, Save, UserX, UserCheck, Calendar, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../store';
import { ROLE_LABELS, type TeamMember, type TeamRole } from '../types';
import { getGoogleAuthUrl } from '../lib/googleCalendar';

interface Props {
  member: TeamMember | null;
  onClose: () => void;
}

const inputClass = "w-full px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)] disabled:opacity-60";

export const MemberDrawer: React.FC<Props> = ({ member, onClose }) => {
  const { updateMember, currentUser } = useAppStore();
  const isGestor = currentUser?.role === 'gestor';

  const [form, setForm] = useState<Partial<TeamMember>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (member) {
      setForm({
        name: member.name,
        email: member.email,
        role: member.role,
        ramal_4com: member.ramal_4com || '',
        kommo_user_id: member.kommo_user_id,
        meta_ligacoes_diaria: member.meta_ligacoes_diaria ?? 100,
        active: member.active,
      });
    }
  }, [member?.id]);

  if (!member) return null;

  const handleSave = async () => {
    if (!isGestor) {
      toast.error('Somente gestor pode editar membros');
      return;
    }
    if (!form.name || !form.email) {
      toast.error('Nome e email são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      const payload: Partial<TeamMember> = {
        name: form.name,
        email: form.email,
        role: form.role,
        ramal_4com: form.ramal_4com?.trim() || undefined,
        kommo_user_id: form.kommo_user_id || undefined,
        meta_ligacoes_diaria: form.meta_ligacoes_diaria ?? 100,
      };
      await updateMember(member.id, payload);
      toast.success('Membro atualizado');
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    if (!isGestor) return;
    const next = !member.active;
    if (!next && !confirm(`Desativar ${member.name}?`)) return;
    await updateMember(member.id, { active: next });
    toast.success(next ? 'Membro reativado' : 'Membro desativado');
    onClose();
  };

  const connectGoogle = async () => {
    try {
      const url = await getGoogleAuthUrl(member.id);
      window.open(url, '_blank', 'width=500,height=600');
    } catch {
      toast.error('Erro ao gerar link do Google');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div
        className="bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] w-full max-w-md h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-10 h-10 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
              {member.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h3 className="text-white font-semibold truncate">{member.name}</h3>
              <p className="text-xs text-[var(--color-v4-text-muted)]">{ROLE_LABELS[member.role]}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!isGestor && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 text-xs text-amber-300">
              Você está em modo somente leitura. Somente gestor pode editar membros.
            </div>
          )}

          <Field label="Nome">
            <input
              type="text"
              value={form.name || ''}
              disabled={!isGestor}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <Field label="Email">
            <input
              type="email"
              value={form.email || ''}
              disabled={!isGestor}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <Field label="Função">
            <select
              value={form.role || 'sdr'}
              disabled={!isGestor}
              onChange={(e) => setForm((p) => ({ ...p, role: e.target.value as TeamRole }))}
              className={inputClass}
            >
              <option value="sdr">SDR</option>
              <option value="closer">Closer</option>
              <option value="gestor">Gestor</option>
              <option value="financeiro">Financeiro</option>
            </select>
          </Field>

          <Field
            label="Ramal 4com"
            hint="Identificador do ramal usado no PABX. Ex: 1019. Sem isso ligações chegam sem dono."
          >
            <input
              type="text"
              value={form.ramal_4com || ''}
              disabled={!isGestor}
              placeholder="ex: 1019"
              onChange={(e) => setForm((p) => ({ ...p, ramal_4com: e.target.value }))}
              className={inputClass}
            />
          </Field>

          <Field label="Kommo User ID" hint="Numérico. Para mapeamento do Kommo (opcional).">
            <input
              type="number"
              value={form.kommo_user_id || ''}
              disabled={!isGestor}
              placeholder="ex: 12345678"
              onChange={(e) => setForm((p) => ({ ...p, kommo_user_id: e.target.value ? Number(e.target.value) : undefined }))}
              className={inputClass}
            />
          </Field>

          <Field label="Meta de ligações por dia" hint="Default 100. Usado no dashboard pra calcular % e disparar marco quando bater.">
            <input
              type="number"
              min={0}
              value={form.meta_ligacoes_diaria ?? 100}
              disabled={!isGestor}
              onChange={(e) => setForm((p) => ({ ...p, meta_ligacoes_diaria: e.target.value ? Number(e.target.value) : 0 }))}
              className={inputClass}
            />
          </Field>

          {/* Google Calendar status */}
          <div className="pt-3 border-t border-[var(--color-v4-border)]">
            <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-2">Integrações</div>
            {member.google_calendar_connected ? (
              <div className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded p-3">
                <div className="flex items-center gap-2 text-xs text-green-400">
                  <Calendar size={14} /> Google Calendar conectado
                </div>
                <button onClick={connectGoogle} className="text-[10px] text-[var(--color-v4-text-muted)] hover:text-yellow-400 underline">
                  reconectar
                </button>
              </div>
            ) : (
              <button onClick={connectGoogle} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-yellow-400 hover:border-yellow-400/50 text-xs">
                <Calendar size={14} /> Conectar Google Calendar
              </button>
            )}
          </div>

          {/* Audit info */}
          <div className="pt-3 border-t border-[var(--color-v4-border)] text-[10px] text-[var(--color-v4-text-muted)] space-y-0.5">
            <div>ID: <span className="text-white font-mono">{member.id}</span></div>
            <div>Auth user: <span className="text-white font-mono">{member.auth_user_id || '—'}</span></div>
            <div>Criado em: {member.created_at ? new Date(member.created_at).toLocaleDateString('pt-BR') : '—'}</div>
          </div>
        </div>

        {/* Footer */}
        {isGestor && (
          <div className="flex gap-2 px-5 py-3 border-t border-[var(--color-v4-border)]">
            <button
              onClick={toggleActive}
              className={`flex items-center gap-1 px-3 py-2 rounded text-xs ${
                member.active
                  ? 'border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-red-400'
                  : 'border border-green-500/30 text-green-400 hover:bg-green-500/10'
              }`}
            >
              {member.active ? <><UserX size={12} /> Desativar</> : <><UserCheck size={12} /> Reativar</>}
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              <Save size={12} /> {saving ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">{label}</label>
    {children}
    {hint && <p className="text-[10px] text-[var(--color-v4-text-muted)]/70 mt-1">{hint}</p>}
  </div>
);
