import { supabase } from './supabase';

// Cliente do MOTOR de enriquecimento.
// - Dev local: chama /api/* e o Vite faz proxy p/ :3011.
// - Produção: serviço no Railway (VITE_MOTOR_URL sobrepõe o padrão abaixo);
//   toda chamada leva o token de sessão do SalesHub (o motor recusa quem não
//   está logado).
// - Timeout padrão (90 s; `timeoutMs` por chamada) — antes uma rota travada
//   segurava a fase indefinidamente. 401 tenta renovar a sessão UMA vez e, se
//   persistir, lança MotorAuthError (antes parecia "fonte instável" e disparava
//   retrabalho pago).
const MOTOR_URL_PADRAO = import.meta.env.DEV
  ? ''
  : 'https://saleshub-ruston-production.up.railway.app';
const MOTOR_URL = (import.meta.env.VITE_MOTOR_URL ?? MOTOR_URL_PADRAO).replace(/\/$/, '');

export class MotorAuthError extends Error {
  constructor() {
    super('sessão expirada — faça login de novo no SalesHub');
    this.name = 'MotorAuthError';
  }
}

async function tokenSessao(renovar = false): Promise<string | null> {
  try {
    if (renovar) {
      const { data } = await supabase.auth.refreshSession();
      return data.session?.access_token ?? null;
    }
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null; // sem sessão (modo local) — o motor local não exige token
  }
}

export async function motorFetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 90_000, signal: sinalExterno, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  const token = await tokenSessao();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout do motor', 'TimeoutError')), timeoutMs);
  if (sinalExterno) {
    if (sinalExterno.aborted) ctrl.abort(sinalExterno.reason);
    else sinalExterno.addEventListener('abort', () => ctrl.abort(sinalExterno.reason), { once: true });
  }
  const url = `${MOTOR_URL}${path}`;
  try {
    let res = await fetch(url, { ...rest, headers, signal: ctrl.signal });
    if (res.status === 401 && token) {
      const novo = await tokenSessao(true);
      if (novo && novo !== token) {
        headers.set('Authorization', `Bearer ${novo}`);
        res = await fetch(url, { ...rest, headers, signal: ctrl.signal });
      }
    }
    if (res.status === 401 && token) throw new MotorAuthError();
    return res;
  } finally {
    clearTimeout(timer);
  }
}
