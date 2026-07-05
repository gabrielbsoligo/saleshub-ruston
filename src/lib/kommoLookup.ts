// =============================================================
// Cliente do kommo-lookup (read-only) + kommo-users.
// Usado pela tela de trabalho manual do 3C.
// =============================================================
import type { KommoLeadState, KommoUser } from './threeC';

const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

function fnHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

export interface LookupResponse {
  byId: KommoLeadState | null;
  byIdStatus: 'found' | 'not_found' | 'skipped' | 'error';
  byPhone: KommoLeadState[];
  byQuery: KommoLeadState[];
}

// Busca principal da ligação: por Identificador (id) e por Telefone.
export async function lookupCall(input: { kommo_id?: string; telefone?: string }): Promise<LookupResponse> {
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/kommo-lookup`, {
    method: 'POST',
    headers: fnHeaders(),
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error || `kommo-lookup respondeu ${resp.status}`);
  }
  return resp.json();
}

// Busca manual (fallback quando id/telefone não acham nada).
export async function lookupQuery(query: string): Promise<KommoLeadState[]> {
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/kommo-lookup`, {
    method: 'POST',
    headers: fnHeaders(),
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error || `kommo-lookup respondeu ${resp.status}`);
  }
  const data: LookupResponse = await resp.json();
  return data.byQuery || [];
}

// Lista TODOS os usuários do Kommo (pra escolher o responsável).
export async function fetchKommoUsers(): Promise<KommoUser[]> {
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/kommo-users`, {
    headers: fnHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error || `kommo-users respondeu ${resp.status}`);
  }
  const data = await resp.json();
  return data.users || [];
}
