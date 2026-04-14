import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, X, Check } from "lucide-react";

interface MultiSelectProps {
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
  label?: string;
  placeholder?: string;
}

export const MultiSelect: React.FC<MultiSelectProps> = ({ options, selected, onChange, label, placeholder = "Selecionar..." }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (opt: string) => {
    onChange(selected.includes(opt) ? selected.filter(s => s !== opt) : [...selected, opt]);
  };

  const filtered = options.filter(o => o.toLowerCase().includes(search.toLowerCase()));

  return (
    <div ref={ref} className="relative">
      {label && <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">{label}</label>}
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)] min-h-[38px]">
        <div className="flex flex-wrap gap-1 flex-1">
          {selected.length === 0 && <span className="text-[var(--color-v4-text-muted)]">{placeholder}</span>}
          {selected.map(s => (
            <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-v4-surface)] text-[10px] text-white">
              {s}
              <X size={10} className="cursor-pointer hover:text-red-400" onClick={e => { e.stopPropagation(); toggle(s); }} />
            </span>
          ))}
        </div>
        <ChevronDown size={14} className="text-[var(--color-v4-text-muted)] ml-2 flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-lg shadow-xl max-h-48 overflow-hidden">
          <div className="p-2 border-b border-[var(--color-v4-border)]">
            <input type="text" placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)}
              className="w-full px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none" autoFocus />
          </div>
          <div className="overflow-y-auto max-h-36">
            {filtered.map(opt => (
              <button key={opt} type="button" onClick={() => toggle(opt)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--color-v4-card-hover)] transition-colors">
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                  selected.includes(opt) ? 'bg-[var(--color-v4-red)] border-[var(--color-v4-red)]' : 'border-[var(--color-v4-border)]'
                }`}>
                  {selected.includes(opt) && <Check size={10} className="text-white" />}
                </div>
                <span className="text-white">{opt}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// MultiSelectFilter — compact variant for filter bars
// Supports value/label pairs (e.g. member IDs → names)
// ============================================================

export interface FilterOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  options: FilterOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  className?: string;
}

export const MultiSelectFilter: React.FC<MultiSelectFilterProps> = ({ options, selected, onChange, placeholder = "Todos", className = '' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (val: string) => {
    onChange(selected.includes(val) ? selected.filter(s => s !== val) : [...selected, val]);
  };

  const getLabel = (val: string) => options.find(o => o.value === val)?.label || val;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-sm hover:border-[var(--color-v4-border-strong)] transition-colors min-w-[120px]">
        {selected.length === 0 ? (
          <span className="text-[var(--color-v4-text-muted)] text-xs">{placeholder}</span>
        ) : selected.length === 1 ? (
          <span className="text-white text-xs truncate">{getLabel(selected[0])}</span>
        ) : (
          <span className="text-white text-xs">{selected.length} selecionados</span>
        )}
        <ChevronDown size={12} className="text-[var(--color-v4-text-muted)] ml-auto flex-shrink-0" />
      </button>

      {selected.length > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onChange([]); }}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center z-10">
          <X size={8} className="text-white" />
        </button>
      )}

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-lg shadow-xl max-h-56 overflow-hidden min-w-[180px]">
          {options.length > 6 && (
            <div className="p-2 border-b border-[var(--color-v4-border)]">
              <input type="text" placeholder="Buscar..."
                className="w-full px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs focus:outline-none" autoFocus />
            </div>
          )}
          <div className="overflow-y-auto max-h-44">
            {options.map(opt => (
              <button key={opt.value} type="button" onClick={() => toggle(opt.value)}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--color-v4-card-hover)] transition-colors">
                <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                  selected.includes(opt.value) ? 'bg-[var(--color-v4-red)] border-[var(--color-v4-red)]' : 'border-[var(--color-v4-border)]'
                }`}>
                  {selected.includes(opt.value) && <Check size={8} className="text-white" />}
                </div>
                <span className="text-white">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
