import React, { useRef } from "react";
import { Calendar } from "lucide-react";

interface DateInputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  type?: 'date' | 'datetime-local';
  className?: string;
  minYear?: number;
  maxYear?: number;
}

// Valida e retorna a data se o ano estiver na faixa aceita.
// Caso contrario, retorna null — o onChange nao eh chamado,
// evitando salvar datas com ano bugado (ex: 0006-03-23).
function isValidYear(dateStr: string, minYear: number, maxYear: number): boolean {
  if (!dateStr) return true; // vazio eh valido (limpar campo)
  const yearStr = dateStr.slice(0, 4);
  const year = parseInt(yearStr, 10);
  if (!Number.isFinite(year)) return false;
  return year >= minYear && year <= maxYear;
}

export const DateInput: React.FC<DateInputProps> = ({
  value, onChange, label, type = 'date', className,
  minYear = 2020, maxYear = 2050,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    if (!isValidYear(next, minYear, maxYear)) {
      // rejeita silenciosamente — browser ainda mostra o valor anterior via controlled input
      return;
    }
    onChange(next);
  };

  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">{label}</label>}
      <div className="relative cursor-pointer" onClick={() => inputRef.current?.showPicker?.()}>
        <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)] pointer-events-none" />
        <input
          ref={inputRef}
          type={type}
          value={value}
          onChange={handleChange}
          min={type === 'date' ? `${minYear}-01-01` : undefined}
          max={type === 'date' ? `${maxYear}-12-31` : undefined}
          className="w-full px-3 py-2 pl-9 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)] cursor-pointer"
        />
      </div>
    </div>
  );
};
