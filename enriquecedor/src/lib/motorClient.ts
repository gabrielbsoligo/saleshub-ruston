import { supabase } from './supabase';

// Cliente do MOTOR de enriquecimento.
// - Dev local: chama /api/* e o Vite faz proxy p/ :3011.
// - Produção: serviço no Railway (VITE_MOTOR_URL sobrepõe o padrão abaixo);
//   toda chamada leva o token de sessão do SalesHub (o motor recusa quem não
//   está logado).
const MOTOR_URL_PADRAO = import.meta.env.DEV
  ? ''
  : 'https://saleshub-ruston-production.up.railway.app';
const MOTOR_URL = (import.meta.env.VITE_MOTOR_URL ?? MOTOR_URL_PADRAO).replace(/\/$/, '');

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
