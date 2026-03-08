import React, { useState, ReactNode } from "react";
import { useAppStore } from "../store";
import {
  LogOut,
  LayoutDashboard,
  Users,
  FolderKanban,
  Contact,
  Building2,
  Menu,
  X,
} from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type View = "dashboard" | "projects" | "members" | "stakeholders" | "company";

export const Layout: React.FC<{
  children: ReactNode;
  currentView: View;
  onViewChange: (v: View) => void;
}> = ({ children, currentView, onViewChange }) => {
  const { currentUser, logout } = useAppStore();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  if (!currentUser) return null;

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "projects", label: "Projetos", icon: FolderKanban },
    { id: "members", label: "Colaboradores", icon: Users },
    { id: "stakeholders", label: "Stakeholders", icon: Contact },
    { id: "company", label: "Empresa", icon: Building2 },
  ] as const;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[var(--color-v4-bg)]">
      {/* Mobile Menu Toggle */}
      <div className="md:hidden fixed top-4 left-4 z-50">
        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className="p-2 bg-[var(--color-v4-card)] rounded-md text-white"
        >
          {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed md:static inset-y-0 left-0 z-40 w-64 bg-[var(--color-v4-card)] border-r border-[var(--color-v4-border)] flex flex-col transition-transform duration-300 ease-in-out",
          isMobileMenuOpen
            ? "translate-x-0"
            : "-translate-x-full md:translate-x-0",
        )}
      >
        <div className="p-6 flex items-center justify-center border-b border-[var(--color-v4-border)]">
          <h1 className="text-xl font-display font-bold text-white tracking-tight">
            V4 <span className="text-[var(--color-v4-red)]">Rokko</span>
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
            <img
              src={currentUser.avatarUrl}
              alt={currentUser.name}
              className="w-10 h-10 rounded-full bg-[var(--color-v4-surface)]"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {currentUser.name}
              </p>
              <p className="text-xs text-[var(--color-v4-text-muted)] truncate">
                {currentUser.role}
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </main>
    </div>
  );
};
