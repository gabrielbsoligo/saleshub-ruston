import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Permissions, UserProfile } from '../types';
import { mergePermissions } from './permissions';
import { supabase, supabaseConfigured } from './supabase';

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

async function loadProfile(userId: string, email: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !data) return null;

  return {
    id: data.id,
    email: data.email ?? email,
    name: data.name ?? email,
    role: data.role,
    customPermissions: data.custom_permissions ?? null,
    active: data.active ?? true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const demoMode = !supabaseConfigured;

  useEffect(() => {
    if (demoMode) {
      setProfile(DEMO_PROFILE);
      setLoading(false);
      return;
    }

    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      const session = data.session;
      if (session?.user) {
        setProfile(await loadProfile(session.user.id, session.user.email ?? ''));
      }
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
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
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message ?? null };
    },
    [demoMode],
  );

  const signOut = useCallback(async () => {
    if (demoMode) {
      setProfile(null);
      return;
    }
    await supabase.auth.signOut();
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
