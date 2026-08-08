import { useState } from 'react';
import toast from 'react-hot-toast';
import { Radar } from 'lucide-react';
import { useAuth } from '../lib/auth';

export function Login() {
  const { signIn, demoMode } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) toast.error(error);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-v4-bg p-4">
      <div className="w-full max-w-sm rounded-2xl border border-v4-border bg-v4-card p-8">
        <div className="mb-6 flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-v4-red text-white">
            <Radar size={26} />
          </div>
          <h1 className="font-display text-xl font-bold text-v4-text">SDNA Outbound</h1>
          <p className="text-sm text-v4-text-muted">V4 Ruston &amp; Co</p>
        </div>

        {demoMode ? (
          <div className="mb-4 rounded-lg bg-v4-surface p-3 text-xs text-v4-warning">
            Modo local (sem Supabase). Clique em entrar para explorar a ferramenta.
          </div>
        ) : (
          <div className="mb-4 rounded-lg bg-v4-surface p-3 text-xs text-v4-text-muted">
            Use o mesmo e-mail e senha do SalesHub. Se você já estiver logado lá, entra aqui automaticamente.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-v4-text-muted">E-mail</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required={!demoMode}
              className="w-full rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none focus:border-v4-red"
              placeholder="voce@v4company.com"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-v4-text-muted">Senha</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required={!demoMode}
              className="w-full rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none focus:border-v4-red"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-v4-red py-2.5 text-sm font-semibold text-white transition hover:bg-v4-red-hover disabled:opacity-60"
          >
            {loading ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      </div>
    </div>
  );
}
