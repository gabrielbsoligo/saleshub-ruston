import React, { useState } from "react";
import { useAppStore } from "../store";
import { LogIn } from "lucide-react";
import toast from "react-hot-toast";

export const LoginView: React.FC = () => {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAppStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      if (!email.endsWith("@v4company.com")) {
        throw new Error("Acesso restrito a emails @v4company.com");
      }
      await login(email);
      toast.success("Link enviado! Verifique seu email para acessar o sistema.");
      setEmail("");
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
            V4 <span className="text-[var(--color-v4-red)]">Rokko</span>
          </h1>
          <p className="text-[var(--color-v4-text-muted)]">
            Gestão de Onboarding
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-[var(--color-v4-text-muted)] mb-2"
            >
              Email Corporativo
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu.nome@v4company.com"
              className="w-full px-4 py-3 rounded-xl bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white focus:outline-none focus:ring-2 focus:ring-[var(--color-v4-red)] focus:border-transparent transition-all"
              required
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
            {isLoading ? "Enviando..." : "Enviar Login"}
          </button>
        </form>

        <div className="mt-8 text-center text-xs text-[var(--color-v4-text-muted)]">
          <p>Acesso restrito a colaboradores V4 Company.</p>
          <p className="mt-2">
            Emails de teste: ruston@v4company.com, tiago@v4company.com,
            ana@v4company.com
          </p>
        </div>
      </div>
    </div>
  );
};
