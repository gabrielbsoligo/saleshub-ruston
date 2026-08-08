import { createClient } from '@supabase/supabase-js';

// Mesmo projeto Supabase do SalesHub: autenticação compartilhada (mesma sessão
// do navegador) e dados do enriquecedor em tabelas próprias com o prefixo
// `enriquecedor_` — criadas por `supabase/migration_136_enriquecedor.sql` (na
// raiz do repositório), isoladas das tabelas do SalesHub.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** `true` quando dá para autenticar (Supabase do SalesHub configurado). */
export const authConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'public-anon-key-placeholder',
);

/**
 * `true` quando as tabelas `enriquecedor_*` existem no banco (migration 136
 * aplicada). Enquanto `false`, os repositórios persistem em localStorage.
 * Export mutável (live binding): os repositórios leem o valor a cada chamada.
 */
export let supabaseConfigured = false;

/**
 * Detecta se a migration do enriquecedor já foi aplicada no banco do SalesHub.
 * Chamada uma vez no boot (main.tsx), antes de renderizar o app — assim todas
 * as operações da sessão usam o mesmo modo (banco ou local), sem meio-termo.
 */
export async function initDataMode(): Promise<void> {
  if (!authConfigured) return;
  try {
    // head+count não traz linhas; RLS sem sessão devolve 0 linhas SEM erro,
    // então erro aqui significa "tabela não existe" (migration não rodada).
    const { error } = await supabase
      .from('enriquecedor_leads')
      .select('id', { count: 'exact', head: true });
    supabaseConfigured = !error;
    if (error) {
      console.warn(
        '[enriquecedor] Tabelas enriquecedor_* não encontradas — usando modo local (localStorage). ' +
          'Para persistir no banco, rode supabase/migration_136_enriquecedor.sql no SQL Editor do Supabase.',
      );
    }
  } catch {
    supabaseConfigured = false;
  }
}
