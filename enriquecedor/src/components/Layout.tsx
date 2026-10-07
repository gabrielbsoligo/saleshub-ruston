import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Users2,
  Radar,
  Filter,
  Send,
  UserSearch,
  Settings,
  LogOut,
  Sparkles,
  Plus,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
import { jobsRepo } from '../lib/jobsRepo';
import type { Permissions, View } from '../types';
import { useAuth } from '../lib/auth';

interface NavItem {
  id: View;
  label: string;
  icon: LucideIcon;
  permission: keyof Permissions;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'canViewDashboard' },
  { id: 'leads', label: 'Leads', icon: Users2, permission: 'canViewLeads' },
  { id: 'workflow', label: 'Workflow', icon: Filter, permission: 'canViewWorkflow' },
  { id: 'arquiteto', label: 'Arquiteto', icon: Sparkles, permission: 'canViewArquiteto' },
  { id: 'cadencia', label: 'Cadência', icon: Send, permission: 'canViewCadencia' },
  { id: 'cliente_oculto', label: 'Cliente oculto', icon: UserSearch, permission: 'canViewClienteOculto' },
  { id: 'usuarios', label: 'Usuários', icon: Users2, permission: 'canManageUsers' },
  { id: 'configuracoes', label: 'Configurações', icon: Settings, permission: 'canManageConfig' },
];

// Chip "Motor · N rodando · M na fila" — a fila de enriquecimento é global
// (todos os projetos), então mora na navegação e leva pro Workflow.
function MotorChip({ onClick }: { onClick: () => void }) {
  const [n, setN] = useState({ run: 0, fila: 0 });
  useEffect(
    () => jobsRepo.subscribeAtivos((jobs) => setN({ run: jobs.filter((j) => j.status === 'running').length, fila: jobs.filter((j) => j.status === 'pending').length })),
    [],
  );
  if (!n.run && !n.fila) return null;
  return (
    <button
      onClick={onClick}
      title="Fila do motor de enriquecimento — abrir o Workflow"
      className="mt-2 flex w-full items-center gap-2 rounded-lg border border-[#3b82f6]/50 bg-[rgba(59,130,246,0.10)] px-3 py-2 text-left text-xs text-v4-text transition hover:bg-[rgba(59,130,246,0.18)]"
    >
      <Loader2 size={14} className="shrink-0 animate-spin text-[#3b82f6]" />
      <span><b>Motor</b> · {n.run} rodando · {n.fila} na fila</span>
    </button>
  );
}

// Telas que ainda são maquete (o Arquiteto da aba é uma entrega fictícia):
// ficam no menu em cinza, desativadas, com "em breve".
const EM_BREVE = new Set<View>(['arquiteto']);

interface LayoutProps {
  currentView: View;
  onNavigate: (view: View) => void;
  onNovoProjeto: () => void;
  children: React.ReactNode;
}

export function Layout({ currentView, onNavigate, onNovoProjeto, children }: LayoutProps) {
  const { profile, permissions, signOut } = useAuth();
  if (!permissions) return null;

  const items = NAV_ITEMS.filter((item) => permissions[item.permission]);
  const activeTop = currentView === 'lead_detalhe' ? 'leads' : currentView;

  return (
    <div className="flex min-h-screen bg-v4-bg">
      <aside className="flex w-60 flex-col border-r border-v4-border bg-v4-card">
        <div className="flex items-center gap-2 border-b border-v4-border px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-v4-red text-white">
            <Radar size={20} />
          </div>
          <div>
            <p className="font-display text-sm font-bold leading-tight text-v4-text">SDNA Outbound</p>
            <p className="text-xs text-v4-text-muted">V4 Ruston &amp; Co</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          <button
            onClick={onNovoProjeto}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg bg-v4-red px-3 py-2.5 text-sm font-semibold text-white shadow-[0_4px_16px_rgba(230,57,70,0.45)] transition hover:bg-v4-red-hover hover:shadow-[0_6px_20px_rgba(230,57,70,0.6)]"
          >
            <Plus size={18} /> NOVO PROJETO
          </button>
          {items.map((item) => {
            const Icon = item.icon;
            const active = activeTop === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                disabled={EM_BREVE.has(item.id)}
                title={EM_BREVE.has(item.id) ? 'Em breve — por enquanto o caminho é o F7 do Workflow' : undefined}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  EM_BREVE.has(item.id)
                    ? 'cursor-not-allowed text-v4-text-muted opacity-40 grayscale blur-[0.5px]'
                    : active ? 'bg-v4-red-muted text-v4-red-hover' : 'text-v4-text-muted hover:bg-v4-surface hover:text-v4-text'
                }`}
              >
                <Icon size={18} />
                {item.label}
                {EM_BREVE.has(item.id) && <span className="ml-auto rounded border border-v4-border px-1.5 text-[10px] font-semibold uppercase tracking-wide">em breve</span>}
              </button>
            );
          })}
          <MotorChip onClick={() => onNavigate('workflow')} />
        </nav>

        <div className="border-t border-v4-border p-3">
          <div className="mb-2 px-2">
            <p className="truncate text-sm font-medium text-v4-text">{profile?.name}</p>
            <p className="truncate text-xs capitalize text-v4-text-muted">{profile?.role}</p>
          </div>
          <button
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-v4-text-muted transition hover:bg-v4-surface hover:text-v4-text"
          >
            <LogOut size={16} />
            Sair
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-hidden text-v4-text">{children}</main>
    </div>
  );
}
