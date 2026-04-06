import React, { useState, useRef, useEffect } from 'react';
import { Calendar, X } from 'lucide-react';

export type DatePreset = '7d' | '30d' | '90d' | 'all' | 'custom';

interface DateFilterProps {
  value: DatePreset;
  customFrom?: string;
  customTo?: string;
  onChange: (preset: DatePreset, from?: string, to?: string) => void;
  label?: string;
}

const PRESET_LABELS: Record<DatePreset, string> = {
  '7d': '7 dias',
  '30d': '30 dias',
  '90d': '90 dias',
  'all': 'Todos',
  'custom': 'Personalizado',
};

export function getDateRange(preset: DatePreset, customFrom?: string, customTo?: string): { from: Date | null; to: Date | null } {
  if (preset === 'all') return { from: null, to: null };
  if (preset === 'custom') {
    return {
      from: customFrom ? new Date(customFrom + 'T00:00:00') : null,
      to: customTo ? new Date(customTo + 'T23:59:59') : null,
    };
  }
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);
  return { from, to: null };
}

export function filterByDate<T>(items: T[], getDate: (item: T) => string | undefined, preset: DatePreset, customFrom?: string, customTo?: string): T[] {
  if (preset === 'all') return items;
  const { from, to } = getDateRange(preset, customFrom, customTo);
  return items.filter(item => {
    const dateStr = getDate(item);
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

export const DateFilter: React.FC<DateFilterProps> = ({ value, customFrom, customTo, onChange, label = 'Período' }) => {
  const [showCustom, setShowCustom] = useState(false);
  const [localFrom, setLocalFrom] = useState(customFrom || '');
  const [localTo, setLocalTo] = useState(customTo || '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShowCustom(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const isActive = value !== 'all';
  const displayLabel = value === 'custom'
    ? `${localFrom ? new Date(localFrom + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '...'} — ${localTo ? new Date(localTo + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '...'}`
    : PRESET_LABELS[value];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setShowCustom(!showCustom)}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm transition-colors ${
          isActive
            ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-[var(--color-v4-red)]'
            : 'bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] text-white'
        }`}
      >
        <Calendar size={14} />
        <span>{displayLabel}</span>
        {isActive && (
          <X size={12} className="ml-1 hover:text-white" onClick={(e) => { e.stopPropagation(); onChange('all'); setShowCustom(false); }} />
        )}
      </button>

      {showCustom && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl shadow-xl p-3 min-w-[220px]">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {(['7d', '30d', '90d', 'all'] as DatePreset[]).map(p => (
              <button key={p} onClick={() => { onChange(p); setShowCustom(false); }}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  value === p
                    ? 'bg-[var(--color-v4-red)] text-white'
                    : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white'
                }`}>
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>
          <div className="border-t border-[var(--color-v4-border)] pt-2">
            <p className="text-[10px] text-[var(--color-v4-text-muted)] mb-1.5 font-medium uppercase tracking-wide">Personalizado</p>
            <div className="flex gap-2 items-center">
              <input type="date" value={localFrom} onChange={e => setLocalFrom(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs" />
              <span className="text-[var(--color-v4-text-muted)] text-xs">—</span>
              <input type="date" value={localTo} onChange={e => setLocalTo(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-white text-xs" />
            </div>
            <button onClick={() => { onChange('custom', localFrom, localTo); setShowCustom(false); }}
              className="mt-2 w-full py-1.5 rounded-lg bg-[var(--color-v4-red)] text-white text-xs font-medium hover:bg-[var(--color-v4-red-hover)]">
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
