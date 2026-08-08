import { useEffect, useState } from 'react';
import { Upload, Users2, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Lead, View } from '../types';
import { leadsRepo } from '../lib/leadsRepo';
import { STATUS_COLORS, STATUS_LABELS } from '../lib/labels';
import { useAuth } from '../lib/auth';

export function Dashboard({ onNavigate }: { onNavigate: (view: View) => void }) {
  const { permissions } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);

  useEffect(() => {
    leadsRepo.list().then(setLeads);
  }, []);

  const total = leads.length;
  const prontos = leads.filter((l) => l.status === 'enriquecido' || l.status === 'pronto').length;
  const suspeitos = leads.filter((l) => l.dataQuality === 'suspeito' || l.dataQuality === 'invalido').length;

  const byStatus = leads.reduce<Record<string, number>>((acc, l) => {
    acc[l.status] = (acc[l.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-6xl p-8">
      <h1 className="mb-1 font-display text-2xl font-bold text-v4-text">Dashboard</h1>
      <p className="mb-6 text-sm text-v4-text-muted">Visão geral do funil de enriquecimento.</p>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Stat icon={Users2} label="Leads na base" value={total} />
        <Stat icon={CheckCircle2} label="Enriquecidos" value={prontos} />
        <Stat icon={AlertTriangle} label="Dados a revisar" value={suspeitos} />
      </div>

      {total === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-v4-border bg-v4-card p-12 text-center text-v4-text-muted">
          <Upload size={36} />
          <p className="text-sm">Nenhum lead ainda.</p>
          {permissions?.canImport && (
            <button
              onClick={() => onNavigate('workflow')}
              className="rounded-lg bg-v4-red px-4 py-2 text-sm font-semibold text-white hover:bg-v4-red-hover"
            >
              Criar projeto e importar lista
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-v4-border bg-v4-card p-6">
          <h3 className="mb-4 font-display text-sm font-semibold text-v4-text">Funil por status</h3>
          <div className="space-y-2">
            {Object.entries(byStatus).map(([status, count]) => (
              <div key={status} className="flex items-center gap-3">
                <span
                  className={`w-44 rounded-full px-2 py-0.5 text-center text-xs font-medium ${
                    STATUS_COLORS[status as keyof typeof STATUS_COLORS]
                  }`}
                >
                  {STATUS_LABELS[status as keyof typeof STATUS_LABELS]}
                </span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-v4-surface">
                  <div className="h-full bg-v4-red" style={{ width: `${(count / total) * 100}%` }} />
                </div>
                <span className="w-10 text-right text-sm font-medium text-v4-text">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
      <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-v4-red-muted text-v4-red-hover">
        <Icon size={20} />
      </div>
      <p className="font-display text-2xl font-bold text-v4-text">{value}</p>
      <p className="text-sm text-v4-text-muted">{label}</p>
    </div>
  );
}
