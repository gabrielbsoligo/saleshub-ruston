import React, { useRef } from "react";
import { Calendar } from "lucide-react";

interface DateInputProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  type?: 'date' | 'datetime-local';
  className?: string;
}

export const DateInput: React.FC<DateInputProps> = ({ value, onChange, label, type = 'date', className }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">{label}</label>}
      <div className="relative cursor-pointer" onClick={() => inputRef.current?.showPicker?.()}>
        <Calendar size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)] pointer-events-none" />
        <input
          ref={inputRef}
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full px-3 py-2 pl-9 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)] cursor-pointer"
        />
      </div>
    </div>
  );
};
