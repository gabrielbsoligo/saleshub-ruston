// =============================================================
// CompromissoCard — card no topo do Dashboard com progresso
// =============================================================
// Mostra compromisso pessoal + barra de progresso de cada item.
// Botão pra editar (reabre CompromissoModal).
// =============================================================
import React from 'react';
import { ListChecks, Edit2, AlertCircle } from 'lucide-react';
import { useCompromissoDia, CompromissoComProgresso } from '../hooks/compromissos/useCompromissos';
import { useAppStore } from '../store';

interface Props {
  onEdit: () => void;
}

export const CompromissoCard: React.FC<Props> = ({ onEdit }) => {
  const { currentUser } = useAppStore();
  const prog = useCompromissoDia(currentUser?.id);
  if (!currentUser) return null;

  if (!prog.compromisso) {
    return (
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AlertCircle size={20} className="text-amber-400 flex-shrink-0" />
          <div>
            <div className="text-sm text-white font-medium">Você ainda não declarou seu compromisso de hoje</div>
            <div className="text-xs text-[var(--color-v4-text-muted)]">Diz quanto vai entregar e o time vê em tempo real.</div>
          </div>
        </div>
        <button onClick={onEdit} className="px-3 py-1.5 rounded-lg bg-amber-500 text-black text-xs font-bold hover:bg-amber-400">
          Declarar agora
        </button>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ListChecks size={16} className="text-[var(--color-v4-red)]" />
          <h3 className="text-sm font-bold text-white">Meu compromisso de hoje</h3>
          <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${badgeClass(prog.percentual_total)}`}>
            {prog.percentual_total}%
          </span>
        </div>
        <button onClick={onEdit} title="Editar" className="p-1.5 rounded hover:bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white">
          <Edit2 size={12} />
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        <Cell label="Ligações" prog={prog} field="ligacoes" />
        <Cell label="Reun. marcadas" prog={prog} field="reunioes_marcadas" />
        <Cell label="Reun. realizadas" prog={prog} field="reunioes_realizadas" />
        <Cell label="Pra rua" prog={prog} field="contratos_rua" />
        <Cell label="Fechados" prog={prog} field="contratos_fechados" />
      </div>

      {prog.compromisso.observacao && (
        <div className="mt-3 text-[11px] text-[var(--color-v4-text-muted)] italic">
          “{prog.compromisso.observacao}”
        </div>
      )}
    </div>
  );
};

const Cell: React.FC<{ label: string; prog: CompromissoComProgresso; field: keyof CompromissoComProgresso['campos'] }> = ({ label, prog, field }) => {
  const c = prog.campos[field];
  if (c.meta === 0 && c.real === 0) {
    return (
      <div className="bg-[var(--color-v4-bg)]/50 rounded p-2 opacity-40">
        <div className="text-[9px] uppercase text-[var(--color-v4-text-muted)]">{label}</div>
        <div className="text-xs text-[var(--color-v4-text-muted)]">—</div>
      </div>
    );
  }
  return (
    <div className="bg-[var(--color-v4-bg)] rounded p-2">
      <div className="text-[9px] uppercase text-[var(--color-v4-text-muted)]">{label}</div>
      <div className="text-base font-bold text-white">
        {c.real}<span className="text-[var(--color-v4-text-muted)] text-xs">/{c.meta}</span>
      </div>
      <div className="h-1 bg-[var(--color-v4-border)] rounded mt-1 overflow-hidden">
        <div className={`h-full ${barClass(c.pct)}`} style={{ width: `${c.pct}%` }} />
      </div>
    </div>
  );
};

function badgeClass(pct: number) {
  if (pct >= 100) return 'bg-green-500/20 text-green-400';
  if (pct >= 70) return 'bg-blue-500/20 text-blue-400';
  if (pct >= 40) return 'bg-amber-500/20 text-amber-400';
  return 'bg-red-500/20 text-red-400';
}

function barClass(pct: number) {
  if (pct >= 100) return 'bg-green-500';
  if (pct >= 70) return 'bg-blue-500';
  if (pct >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}
