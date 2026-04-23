// =============================================================
// ComissaoDrawer — painel lateral para editar uma comissao
// =============================================================
// Substitui o edit inline por um drawer consistente com DealDrawer.
// Campos: empresa, colaborador, role, tipo, categoria, %, valor_base,
// valor_comissao, data_pgto, data_liberacao, observacao, parcela.
// Tambem expõe historico de audit (comissoes_registros_audit).
// =============================================================
import React, { useEffect, useState } from 'react';
import { X, Save, Trash2, History } from 'lucide-react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase';
import { ComissaoRegistro, STATUS_LABELS, STATUS_COLORS } from '../hooks/comissoes/types';

interface Props {
  comissao: ComissaoRegistro | null;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  canEdit: boolean;
}

interface AuditEntry {
  id: string;
  acao: string;
  mudado_em: string;
  snapshot_antes: any;
  snapshot_depois: any;
}

function fmtBRL(v: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v);
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export const ComissaoDrawer: React.FC<Props> = ({ comissao, onClose, onSaved, onDeleted, canEdit }) => {
  const [form, setForm] = useState<Partial<ComissaoRegistro>>({});
  const [saving, setSaving] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  useEffect(() => {
    if (comissao) setForm({ ...comissao });
  }, [comissao?.id]);

  // Recalcula comissao quando valor_base ou % muda
  useEffect(() => {
    const base = Number(form.valor_base) || 0;
    const pct = Number(form.percentual) || 0;
    setForm((prev) => ({ ...prev, valor_comissao: base * pct }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.valor_base, form.percentual]);

  useEffect(() => {
    if (!comissao?.id || !showAudit) return;
    (async () => {
      const { data } = await supabase
        .from('comissoes_registros_audit')
        .select('id, acao, mudado_em, snapshot_antes, snapshot_depois')
        .eq('comissao_id', comissao.id)
        .order('mudado_em', { ascending: false })
        .limit(30);
      setAudit(data || []);
    })();
  }, [comissao?.id, showAudit]);

  if (!comissao) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        empresa: form.empresa,
        member_name: form.member_name,
        role_comissao: form.role_comissao,
        tipo: form.tipo,
        categoria: form.categoria,
        valor_base: Number(form.valor_base) || 0,
        percentual: Number(form.percentual) || 0,
        valor_comissao: Number(form.valor_comissao) || 0,
        data_pgto: form.data_pgto || null,
        data_liberacao: form.data_liberacao || null,
        observacao: form.observacao || null,
        numero_parcela: form.numero_parcela ?? 1,
        editado_manualmente: true,
      };
      const { error } = await supabase.from('comissoes_registros').update(payload).eq('id', comissao.id);
      if (error) throw error;
      toast.success('Comissão atualizada');
      onSaved();
      onClose();
    } catch (e: any) {
      toast.error(e.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Apagar comissão de "${comissao.empresa}" para ${comissao.member_name}?`)) return;
    const { error } = await supabase.from('comissoes_registros').delete().eq('id', comissao.id);
    if (error) return toast.error(error.message);
    toast.success('Comissão apagada');
    onDeleted();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={onClose}>
      <div className="bg-[var(--color-v4-card)] border-l border-[var(--color-v4-border)] w-full max-w-md h-full flex flex-col"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex-1 min-w-0">
            <h3 className="text-white font-semibold truncate">{comissao.empresa}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-[var(--color-v4-text-muted)]">{comissao.member_name}</span>
              <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${STATUS_COLORS[comissao.status_comissao] || ''}`}>
                {STATUS_LABELS[comissao.status_comissao] || comissao.status_comissao}
              </span>
              {comissao.editado_manualmente && (
                <span className="text-[10px] text-amber-400" title="Blindada contra regeneração automática">🔒</span>
              )}
            </div>
          </div>
          <div className="flex gap-1 ml-3">
            <button onClick={() => setShowAudit(!showAudit)} title="Histórico"
                    className={`p-2 rounded hover:bg-[var(--color-v4-surface)] ${showAudit ? 'text-[var(--color-v4-red)]' : 'text-[var(--color-v4-text-muted)] hover:text-white'}`}>
              <History size={14} />
            </button>
            {canEdit && (
              <button onClick={handleDelete} title="Apagar"
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
        <div className="flex-1 overflow-y-auto p-5 space-y-3 text-xs">
          {showAudit ? (
            <div>
              <h4 className="text-white font-semibold mb-3 flex items-center gap-2">
                <History size={14} /> Histórico de alterações
              </h4>
              {audit.length === 0 ? (
                <p className="text-[var(--color-v4-text-muted)] text-center py-8">Sem histórico registrado</p>
              ) : (
                <div className="space-y-2">
                  {audit.map((a) => (
                    <div key={a.id} className="p-3 rounded border border-[var(--color-v4-border)] bg-[var(--color-v4-bg)]">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          a.acao === 'INSERT' ? 'bg-green-500/15 text-green-400' :
                          a.acao === 'UPDATE' ? 'bg-blue-500/15 text-blue-400' :
                          'bg-red-500/15 text-red-400'
                        }`}>{a.acao}</span>
                        <span className="text-[10px] text-[var(--color-v4-text-muted)]">{fmtDateTime(a.mudado_em)}</span>
                      </div>
                      {a.acao === 'UPDATE' && a.snapshot_antes && a.snapshot_depois && (
                        <div className="space-y-0.5 mt-1">
                          {Object.keys(a.snapshot_depois).filter((k) => {
                            const before = a.snapshot_antes?.[k];
                            const after = a.snapshot_depois?.[k];
                            if (k === 'updated_at') return false;
                            return JSON.stringify(before) !== JSON.stringify(after);
                          }).slice(0, 8).map((k) => (
                            <div key={k} className="text-[10px] flex gap-2">
                              <span className="text-[var(--color-v4-text-muted)] w-24 truncate">{k}:</span>
                              <span className="line-through text-red-400/70">{String(a.snapshot_antes?.[k] ?? '—').slice(0, 20)}</span>
                              <span className="text-green-400">→ {String(a.snapshot_depois?.[k] ?? '—').slice(0, 20)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Preview de comissao calculada */}
              <div className="p-3 rounded border border-[var(--color-v4-border)] bg-[var(--color-v4-bg)]">
                <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)]">Comissão</div>
                <div className="text-lg font-bold text-white">{fmtBRL(Number(form.valor_comissao) || 0)}</div>
                <div className="text-[10px] text-[var(--color-v4-text-muted)]">
                  {fmtBRL(Number(form.valor_base) || 0)} × {((Number(form.percentual) || 0) * 100).toFixed(2)}%
                </div>
              </div>

              <Field label="Empresa">
                <input type="text" value={form.empresa || ''} disabled={!canEdit}
                       onChange={(e) => setForm({ ...form, empresa: e.target.value })}
                       className={inputClass}/>
              </Field>

              <Field label="Colaborador">
                <input type="text" value={form.member_name || ''} disabled={!canEdit}
                       onChange={(e) => setForm({ ...form, member_name: e.target.value })}
                       className={inputClass}/>
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Role">
                  <input type="text" value={form.role_comissao || ''} disabled={!canEdit}
                         onChange={(e) => setForm({ ...form, role_comissao: e.target.value })}
                         className={inputClass}/>
                </Field>
                <Field label="Tipo">
                  <select value={form.tipo || 'mrr'} disabled={!canEdit}
                          onChange={(e) => setForm({ ...form, tipo: e.target.value as any })}
                          className={inputClass}>
                    <option value="mrr">MRR</option>
                    <option value="ot">OT</option>
                    <option value="variavel">Variável</option>
                  </select>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Categoria">
                  <select value={form.categoria || 'inbound'} disabled={!canEdit}
                          onChange={(e) => setForm({ ...form, categoria: e.target.value })}
                          className={inputClass}>
                    <option value="inbound">Inbound</option>
                    <option value="outbound">Outbound</option>
                    <option value="upsell">Upsell</option>
                    <option value="ee_assessoria">EE Assessoria</option>
                    <option value="ee_ot">EE OT</option>
                    <option value="indicacao">Indicação</option>
                    <option value="recomendacao">Recomendação</option>
                  </select>
                </Field>
                <Field label="Parcela">
                  <input type="number" min={1} value={form.numero_parcela ?? 1} disabled={!canEdit}
                         onChange={(e) => setForm({ ...form, numero_parcela: Number(e.target.value) })}
                         className={inputClass}/>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Valor Base (R$)">
                  <input type="number" step="0.01" value={form.valor_base ?? 0} disabled={!canEdit}
                         onChange={(e) => setForm({ ...form, valor_base: Number(e.target.value) })}
                         className={inputClass}/>
                </Field>
                <Field label="% (decimal, ex 0.2)">
                  <input type="number" step="0.001" value={form.percentual ?? 0} disabled={!canEdit}
                         onChange={(e) => setForm({ ...form, percentual: Number(e.target.value) })}
                         className={inputClass}/>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Pgto Contrato">
                  <input type="date" value={form.data_pgto || ''} disabled={!canEdit}
                         min="2020-01-01" max="2050-12-31"
                         onChange={(e) => {
                           const v = e.target.value;
                           if (v) {
                             const y = parseInt(v.slice(0, 4), 10);
                             if (!Number.isFinite(y) || y < 2020 || y > 2050) return;
                           }
                           setForm({ ...form, data_pgto: v });
                         }}
                         className={inputClass}/>
                </Field>
                <Field label="Liberação">
                  <input type="date" value={form.data_liberacao || ''} disabled={!canEdit}
                         min="2020-01-01" max="2050-12-31"
                         onChange={(e) => {
                           const v = e.target.value;
                           if (v) {
                             const y = parseInt(v.slice(0, 4), 10);
                             if (!Number.isFinite(y) || y < 2020 || y > 2050) return;
                           }
                           setForm({ ...form, data_liberacao: v });
                         }}
                         className={inputClass}/>
                </Field>
              </div>

              <Field label="Observação">
                <input type="text" value={form.observacao || ''} disabled={!canEdit}
                       onChange={(e) => setForm({ ...form, observacao: e.target.value })}
                       placeholder="ex: Parcela 2/5, Upsell OT"
                       className={inputClass}/>
              </Field>

              {/* Campos readonly - populados por trigger / confirm pgto */}
              {(comissao.data_pgto_real || comissao.valor_recebido || comissao.data_pgto_vendedor) && (
                <div className="mt-4 p-3 rounded border border-[var(--color-v4-border)] bg-[var(--color-v4-bg)]/50">
                  <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-2">Registros de pagamento</div>
                  {comissao.data_pgto_real && (
                    <div className="flex justify-between text-[11px]"><span className="text-[var(--color-v4-text-muted)]">Pgto real:</span>
                      <span className="text-white">{new Date(comissao.data_pgto_real + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                    </div>
                  )}
                  {comissao.valor_recebido != null && (
                    <div className="flex justify-between text-[11px]"><span className="text-[var(--color-v4-text-muted)]">Valor recebido:</span>
                      <span className="text-white">{fmtBRL(comissao.valor_recebido)}</span>
                    </div>
                  )}
                  {comissao.data_pgto_vendedor && (
                    <div className="flex justify-between text-[11px]"><span className="text-[var(--color-v4-text-muted)]">Pago ao vendedor:</span>
                      <span className="text-white">{new Date(comissao.data_pgto_vendedor + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {canEdit && !showAudit && (
          <div className="flex gap-2 px-5 py-3 border-t border-[var(--color-v4-border)]">
            <button onClick={onClose}
                    className="flex-1 py-2 rounded border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-xs">
              Cancelar
            </button>
            <button onClick={handleSave} disabled={saving}
                    className="flex-1 py-2 rounded bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-bold flex items-center justify-center gap-1 disabled:opacity-50">
              <Save size={12} /> {saving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const inputClass = "w-full px-2 py-1.5 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs disabled:opacity-60 disabled:cursor-not-allowed";

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">{label}</label>
    {children}
  </div>
);
