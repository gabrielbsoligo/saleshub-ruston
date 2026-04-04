import React, { useState } from "react";
import { useAppStore } from "../store";
import { LogIn } from "lucide-react";
import toast from "react-hot-toast";

export const LoginView: React.FC = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAppStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      await login(email, password);
      toast.success("Login realizado com sucesso!");
    } catch (err: any) {
      setError(err.message || "Erro ao tentar fazer login.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-v4-bg)] p-4">
      <div className="w-full max-w-md bg-[var(--color-v4-card)] rounded-2xl shadow-2xl border border-[var(--color-v4-border)] p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-display font-bold text-white tracking-tight mb-2">
            Ruston <span className="text-[var(--color-v4-red)]">Comercial</span>
          </h1>
          <p className="text-[var(--color-v4-text-muted)]">
            Gestão do Time Comercial
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              className="w-full px-4 py-3 rounded-xl bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white focus:outline-none focus:ring-2 focus:ring-[var(--color-v4-red)] focus:border-transparent transition-all"
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2">
              Senha
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Sua senha"
              className="w-full px-4 py-3 rounded-xl bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white focus:outline-none focus:ring-2 focus:ring-[var(--color-v4-red)] focus:border-transparent transition-all"
              required
              minLength={6}
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-[var(--color-v4-red-muted)] border border-[var(--color-v4-error)] text-[var(--color-v4-error)] text-sm text-center">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors shadow-lg shadow-[var(--color-v4-red-muted)]"
          >
            <LogIn size={18} />
            {isLoading ? "Entrando..." : "Entrar"}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-[var(--color-v4-text-muted)]">
          <p>Primeiro acesso? Use seu email cadastrado e crie uma senha.</p>
          <p className="mt-1">O sistema criará sua conta automaticamente.</p>
        </div>
      </div>
    </div>
  );
};
