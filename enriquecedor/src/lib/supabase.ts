import { createClient } from '@supabase/supabase-js';

// ── Autenticação: Supabase do SalesHub ──────────────────────────────────────
// O sub-app roda no mesmo domínio do SalesHub e o build recebe as mesmas
// VITE_SUPABASE_*. Mesmo projeto + mesma origem ⇒ a sessão de login do
// SalesHub (localStorage) é compartilhada automaticamente: quem já está
// logado no SalesHub entra aqui sem digitar senha.
const authUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const authAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** `true` quando dá para autenticar via Supabase do SalesHub. */
export const authConfigured = Boolean(authUrl && authAnonKey);

export const supabaseAuth = createClient(
  authUrl || 'http://localhost:54321',
  authAnonKey || 'public-anon-key-placeholder',
);

// ── Dados: projeto Supabase PRÓPRIO do enriquecedor (quando existir) ────────
// As tabelas daqui (leads, enrichment_jobs…) colidem com as do SalesHub, então
// os dados NÃO podem morar no mesmo projeto. Enquanto as variáveis abaixo não
// forem configuradas, os repositórios usam o modo local (localStorage).
const dataUrl = import.meta.env.VITE_ENRIQUECEDOR_SUPABASE_URL ?? '';
const dataAnonKey = import.meta.env.VITE_ENRIQUECEDOR_SUPABASE_ANON_KEY ?? '';

/** `true` quando o projeto de DADOS do enriquecedor está configurado. */
export const supabaseConfigured = Boolean(dataUrl && dataAnonKey);

export const supabase = createClient(
  dataUrl || 'http://localhost:54321',
  dataAnonKey || 'public-anon-key-placeholder',
);
