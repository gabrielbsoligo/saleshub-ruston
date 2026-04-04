// Google Calendar Integration
// Uses Supabase Edge Functions for OAuth and event management

const SUPABASE_FUNCTIONS_URL = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1';

export async function getGoogleAuthUrl(memberId: string): Promise<string> {
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-auth?action=auth_url&member_id=${memberId}`);
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
  lead_email?: string;
  participantes_extras?: string[];
}

export async function createCalendarEvent(data: CreateCalendarEventData): Promise<{
  event_id: string;
  meet_link: string | null;
  html_link: string;
} | null> {
  try {
    const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_event', data }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      if (err.error?.includes('não conectado')) {
        throw new Error('GOOGLE_NOT_CONNECTED');
      }
      throw new Error(err.error || 'Calendar error');
    }

    return await resp.json();
  } catch (e) {
    console.error('Calendar event creation failed:', e);
    throw e;
  }
}

export async function deleteCalendarEvent(memberId: string, eventId: string): Promise<void> {
  await fetch(`${SUPABASE_FUNCTIONS_URL}/google-calendar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete_event', data: { member_id: memberId, event_id: eventId } }),
  });
}
