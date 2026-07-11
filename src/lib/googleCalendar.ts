// Google Calendar Integration
// Uses Supabase Edge Functions for OAuth and event management

const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

function getAuthHeaders(): Record<string, string> {
  // Edge functions use service_role internally — anon key is sufficient to pass gateway
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

export async function getGoogleAuthUrl(memberId: string): Promise<string> {
  const headers = getAuthHeaders();
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-auth?action=auth_url&member_id=${memberId}`, { headers });
  if (!resp.ok) throw new Error('Failed to get auth URL');
  const data = await resp.json();
  return data.auth_url;
}

export interface CreateCalendarEventData {
  empresa: string;
  nome_contato?: string;
  canal?: string;
  data_reuniao: string;
  closer_id?: string;
  sdr_id?: string;
  lead_id?: string;
  reuniao_id?: string;
  lead_email?: string;
  participantes_extras?: string[];
}

export interface CalendarEventResult {
  event_id: string;
  meet_link: string | null;
  html_link: string;
  owner_id: string;   // agenda que hospeda o evento (SDR ou closer via fallback)
}

export async function createCalendarEvent(data: CreateCalendarEventData): Promise<CalendarEventResult | null> {
  try {
    const headers = getAuthHeaders();
    const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-calendar`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'create_event', data }),
    });

    if (!resp.ok) {
      let errMsg = `Erro ${resp.status}`;
      try {
        const err = await resp.json();
        if (err.error?.includes('não conectado')) {
          throw new Error('Google Calendar não conectado. Peça pro SDR ou Closer reconectar na tela de Equipe.');
        }
        errMsg = err.error || errMsg;
      } catch (parseErr) {
        // Response wasn't JSON (e.g. gateway error)
        const text = await resp.text().catch(() => '');
        errMsg = text || errMsg;
      }
      throw new Error(errMsg);
    }

    return await resp.json();
  } catch (e) {
    console.error('Calendar event creation failed:', e);
    throw e;
  }
}

export async function deleteCalendarEvent(memberId: string, eventId: string): Promise<void> {
  const headers = getAuthHeaders();
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-calendar`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'delete_event', data: { member_id: memberId, event_id: eventId } }),
  });
  // Não engolir falha: se o delete não deu certo, o chamador precisa saber
  // (senão volta a falhar em silêncio e deixa evento órfão).
  if (!resp.ok) {
    let msg = `Erro ${resp.status} ao apagar evento`;
    try { const e = await resp.json(); msg = e.error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
}

// Marker de erro quando o evento não existe mais na agenda (caller cai no fallback).
export const EVENT_NOT_FOUND = 'EVENT_NOT_FOUND';

export interface UpdateCalendarEventData extends CreateCalendarEventData {
  event_id: string;
  owner_id: string;
}

// Move (PATCH) o evento existente. Lança EVENT_NOT_FOUND se o evento sumiu.
export async function updateCalendarEvent(data: UpdateCalendarEventData): Promise<CalendarEventResult | null> {
  const headers = getAuthHeaders();
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-calendar`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'update_event', data }),
  });
  if (resp.status === 404) throw new Error(EVENT_NOT_FOUND);
  if (!resp.ok) {
    let msg = `Erro ${resp.status}`;
    try { const e = await resp.json(); msg = e.error || msg; } catch { /* noop */ }
    throw new Error(msg);
  }
  return await resp.json();
}
