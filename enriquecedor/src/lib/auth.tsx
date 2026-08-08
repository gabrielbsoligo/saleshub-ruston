import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Permissions, Role, UserProfile } from '../types';
import { mergePermissions } from './permissions';
import { authConfigured, supabaseAuth } from './supabase';

interface AuthContextValue {
  profile: UserProfile | null;
  permissions: Permissions | null;
  loading: boolean;
  /** true quando rodando sem Supabase (dev local). */
  demoMode: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Perfil usado quando não há Supabase configurado, para permitir explorar a
// ferramenta localmente (dev). Não concede acesso a nenhum dado real.
const DEMO_PROFILE: UserProfile = {
  id: 'demo-admin',
  email: 'demo@v4company.com',
  name: 'Admin (modo local)',
  role: 'admin',
  customPermissions: null,
  active: true,
};

// Os usuários são os do SalesHub (tabela team_members, mesma sessão Supabase).
// Mapeia o papel do SalesHub para o papel equivalente aqui.
const SALESHUB_ROLE_MAP: Record<string, Role> = {
  gestor: 'admin',
  sdr: 'sdr',
  closer: 'sdr',
  financeiro: 'viewer',
};

async function loadProfile(userId: string, email: string): Promise<UserProfile | null> {
  // 1) Vínculo direto com o usuário autenticado; 2) fallback por e-mail
  // (primeiro login, antes do trigger do SalesHub vincular auth_user_id).
  let { data } = await supabaseAuth
    .from('team_members')
    .select('id, name, email, role, active')
    .eq('auth_user_id', userId)
    .maybeSingle();

  if (!data && email) {
    ({ data } = await supabaseAuth
      .from('team_members')
      .select('id, name, email, role, active')
      .eq('email', email)
      .maybeSingle());
  }

  if (!data || data.active === false) return null;

  return {
    id: data.id,
    email: data.email ?? email,
    name: data.name ?? email,
    role: SALESHUB_ROLE_MAP[data.role] ?? 'viewer',
    customPermissions: null,
    active: data.active ?? true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const demoMode = !authConfigured;

  useEffect(() => {
    if (demoMode) {
      setProfile(DEMO_PROFILE);
      setLoading(false);
      return;
    }

    let active = true;

    supabaseAuth.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      const session = data.session;
      if (session?.user) {
        setProfile(await loadProfile(session.user.id, session.user.email ?? ''));
      }
      setLoading(false);
    });

    const { data: sub } = supabaseAuth.auth.onAuthStateChange(async (_event, session) => {
      if (!active) return;
      if (session?.user) {
        setProfile(await loadProfile(session.user.id, session.user.email ?? ''));
      } else {
        setProfile(null);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [demoMode]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (demoMode) {
        setProfile(DEMO_PROFILE);
        return { error: null };
      }
      // Mesmas credenciais do SalesHub (mesmo Supabase Auth).
      const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };

      if (data.user) {
        const loaded = await loadProfile(data.user.id, data.user.email ?? email);
        if (!loaded) {
          await supabaseAuth.auth.signOut();
          return { error: 'Este e-mail não está cadastrado (ou está inativo) na equipe do SalesHub.' };
        }
      }
      return { error: null };
    },
    [demoMode],
  );

  const signOut = useCallback(async () => {
    if (demoMode) {
      setProfile(null);
      return;
    }
    // Sessão é compartilhada com o SalesHub — sair aqui também sai de lá.
    await supabaseAuth.auth.signOut();
    setProfile(null);
  }, [demoMode]);

  const permissions = useMemo(
    () => (profile ? mergePermissions(profile.role, profile.customPermissions) : null),
    [profile],
  );

  const value: AuthContextValue = {
    profile,
    permissions,
    loading,
    demoMode,
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  return ctx;
}
