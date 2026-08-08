import { supabase } from './supabase';

// Cliente do MOTOR de enriquecimento.
// - Dev local: VITE_MOTOR_URL vazio → chama /api/* e o Vite faz proxy p/ :3011.
// - Produção: VITE_MOTOR_URL aponta o serviço no Railway; toda chamada leva o
//   token de sessão do SalesHub (o motor recusa quem não está logado).
const MOTOR_URL = (import.meta.env.VITE_MOTOR_URL ?? '').replace(/\/$/, '');

export async function motorFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
  } catch {
    // sem sessão (modo local) — o motor local não exige token
  }
  return fetch(`${MOTOR_URL}${path}`, { ...init, headers });
}
