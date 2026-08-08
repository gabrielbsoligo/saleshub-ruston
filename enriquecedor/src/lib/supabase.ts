import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/**
 * `true` quando as credenciais do Supabase estão configuradas no .env.local.
 * Enquanto o projeto Supabase próprio não existir, a UI ainda renderiza
 * (login/telas), mas chamadas ao banco vão falhar de forma controlada.
 */
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'public-anon-key-placeholder',
);
