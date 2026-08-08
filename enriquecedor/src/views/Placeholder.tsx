import { Construction } from 'lucide-react';

export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center text-v4-text-muted">
      <Construction size={40} />
      <h2 className="font-display text-lg font-semibold text-v4-text">{title}</h2>
      <p className="text-sm">Este módulo entra na {phase}.</p>
    </div>
  );
}
