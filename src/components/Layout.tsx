import React, { useState, ReactNode } from "react";
import { useAppStore } from "../store";
import {
  LogOut,
  LayoutDashboard,
  Users,
  Target,
  Calendar,
  BarChart3,
  DollarSign,
  Menu,
  X,
  Briefcase,
  Box,
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ROLE_LABELS } from "../types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type View = "pipeline" | "leads" | "reunioes" | "performance" | "metas" | "comissoes" | "equipe" | "dashboard" | "blackbox";

export const Layout: React.FC<{
  children: ReactNode;
  currentView: View;
  onViewChange: (v: View) => void;
}> = ({ children, currentView, onViewChange }) => {
  const { currentUser, logout } = useAppStore();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  if (!currentUser) return null;

  const navItems = [
    { id: "dashboard" as const, label: "Dashboard", icon: LayoutDashboard },
    { id: "pipeline" as const, label: "Pipeline", icon: Briefcase },
    { id: "leads" as const, label: "Leads", icon: Target },
    { id: "reunioes" as const, label: "Reuniões", icon: Calendar },
    { id: "performance" as const, label: "Performance", icon: BarChart3 },
    { id: "metas" as const, label: "Metas", icon: Target },
    { id: "comissoes" as const, label: "Comissões", icon: DollarSign },
    { id: "blackbox" as const, label: "BlackBox", icon: Box },
    { id: "equipe" as const, label: "Equipe", icon: Users },
  ];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--color-v4-bg)]">
      <div className="md:hidden fixed top-4 left-4 z-50">
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="p-2 bg-[var(--color-v4-card)] rounded-md text-white"
        >
          {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      <aside
        className={cn(
          "fixed md:static inset-y-0 left-0 z-40 w-64 bg-[var(--color-v4-card)] border-r border-[var(--color-v4-border)] flex flex-col transition-transform duration-300 ease-in-out",
          isMobileMenuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="p-6 flex items-center justify-center border-b border-[var(--color-v4-border)]">
          <h1 className="text-xl font-display font-bold text-white tracking-tight">
            Ruston <span className="text-[var(--color-v4-red)]">Comercial</span>
          </h1>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onViewChange(item.id);
                  setIsMobileMenuOpen(false);
                }}
                className={cn(
                  "flex items-center w-full gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors",
                  isActive
                    ? "bg-[var(--color-v4-red)] text-white shadow-md shadow-[var(--color-v4-red-muted)]"
                    : "text-[var(--color-v4-text-muted)] hover:bg-[var(--color-v4-card-hover)] hover:text-white",
                )}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-[var(--color-v4-border)]">
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="w-10 h-10 rounded-full bg-[var(--color-v4-red)] flex items-center justify-center text-white font-bold text-sm">
              {currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {currentUser.name}
              </p>
              <p className="text-xs text-[var(--color-v4-text-muted)] truncate">
                {ROLE_LABELS[currentUser.role]}
              </p>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex items-center justify-center w-full gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[var(--color-v4-text-muted)] hover:bg-[var(--color-v4-card-hover)] hover:text-white transition-colors"
          >
            <LogOut size={16} />
            Sair
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
};
