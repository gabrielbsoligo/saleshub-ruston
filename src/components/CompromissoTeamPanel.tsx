// =============================================================
// CompromissoTeamPanel — quadro do time pra gestor (e TV mode)
// =============================================================
// Lista todos os membros que declararam compromisso hoje +
// progresso. Quem nao declarou aparece em chip "sem compromisso".
// =============================================================
import React from 'react';
import { Users } from 'lucide-react';
import { useCompromissosDoDia, CompromissoComProgresso } from '../hooks/compromissos/useCompromissos';
import { useAppStore } from '../store';

interface Props {
  /** Quando true, layout grandao pra TV mode */
  big?: boolean;
}

export const CompromissoTeamPanel: React.FC<Props> = ({ big = false }) => {
  const { members } = useAppStore();
  const { rows, isLoading } = useCompromissosDoDia();

  // Junta membro
  const enriched = rows.map(r => ({ ...r, member: members.find(m => m.id === (r as any).member_id) })).filter(r => r.member);

  // Membros ativos sem compromisso
  const ativosSemCompromisso = members.filter(m =>
    m.active && !rows.some(r => (r as any).member_id === m.id)
  );

  return (
    <div className={`bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-${big ? '6' : '4'} mb-4`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users size={big ? 22 : 16} className="text-[var(--color-v4-red)]" />
          <h3 className={`font-bold text-white ${big ? 'text-2xl' : 'text-sm'}`}>Compromisso do time</h3>
          <span className={`text-[var(--color-v4-text-muted)] ${big ? 'text-base' : 'text-xs'}`}>({enriched.length} declararam)</span>
        </div>
      </div>

      {isLoading && enriched.length === 0 ? (
        <p className={`text-[var(--color-v4-text-muted)] py-4 text-center ${big ? 'text-base' : 'text-xs'}`}>Carregando…</p>
      ) : enriched.length === 0 ? (
        <p className={`text-[var(--color-v4-text-muted)] py-4 text-center ${big ? 'text-base' : 'text-xs'}`}>Ninguém declarou compromisso hoje ainda.</p>
      ) : (
        <div className={`space-y-${big ? '3' : '2'}`}>
          {enriched
            .sort((a, b) => b.percentual_total - a.percentual_total)
            .map(r => (
              <Row key={(r as any).member_id} member={r.member!} prog={r} big={big} />
            ))}
        </div>
      )}

      {ativosSemCompromisso.length > 0 && !big && (
        <div className="mt-3 pt-3 border-t border-[var(--color-v4-border)]/50">
          <div className="text-[10px] uppercase text-[var(--color-v4-text-muted)] mb-1">Ainda não declararam</div>
          <div className="flex flex-wrap gap-1">
            {ativosSemCompromisso.map(m => (
              <span key={m.id} className="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">
                {m.name.split(' ')[0]}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Row: React.FC<{ member: any; prog: CompromissoComProgresso; big: boolean }> = ({ member, prog, big }) => {
  const initials = member.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className={`flex items-center gap-${big ? '4' : '3'} bg-[var(--color-v4-bg)] rounded-lg p-${big ? '3' : '2'}`}>
      <div className={`rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold flex-shrink-0 ${
        big ? 'w-12 h-12 text-base' : 'w-7 h-7 text-[10px]'
      }`}>
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-white font-medium truncate ${big ? 'text-lg' : 'text-xs'}`}>
          {member.name.split(' ')[0]}
        </div>
        <div className={`flex flex-wrap gap-${big ? '3' : '2'} mt-1 ${big ? 'text-sm' : 'text-[10px]'} text-[var(--color-v4-text-muted)]`}>
          <Mini label="Lig" c={prog.campos.ligacoes} />
          <Mini label="Reun.M" c={prog.campos.reunioes_marcadas} />
          <Mini label="Reun.R" c={prog.campos.reunioes_realizadas} />
          <Mini label="Rua" c={prog.campos.contratos_rua} />
          <Mini label="Fech." c={prog.campos.contratos_fechados} />
        </div>
      </div>
      <div className={`text-right flex-shrink-0 ${big ? 'min-w-[80px]' : 'min-w-[50px]'}`}>
        <div className={`font-bold ${
          prog.percentual_total >= 100 ? 'text-green-400' :
          prog.percentual_total >= 70 ? 'text-blue-400' :
          prog.percentual_total >= 40 ? 'text-amber-400' :
          'text-red-400'
        } ${big ? 'text-3xl' : 'text-sm'}`}>
          {prog.percentual_total}%
        </div>
      </div>
    </div>
  );
};

const Mini: React.FC<{ label: string; c: { meta: number; real: number } }> = ({ label, c }) => {
  if (c.meta === 0 && c.real === 0) return null;
  const ok = c.meta > 0 && c.real >= c.meta;
  return (
    <span className={ok ? 'text-green-400' : ''}>
      {label} <strong>{c.real}{c.meta > 0 ? `/${c.meta}` : ''}</strong>
    </span>
  );
};
