// Team Availability — consulta disponibilidade do time via Google FreeBusy/events.list
// Reusa o mesmo fluxo OAuth/edge function da criação de eventos (google-calendar).

const SUPABASE_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

function getAuthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

export type RsvpStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export interface EventAttendee {
  email: string;
  name?: string | null;
  responseStatus: RsvpStatus;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
}

export interface BusyBlock {
  start: string;
  end: string;
  title?: string;
  all_day?: boolean;
  status?: RsvpStatus;
  meet_link?: string | null;
  html_link?: string | null;
  location?: string | null;
  description?: string | null;
  organizer?: { email?: string | null; name?: string | null; self?: boolean } | null;
  attendees?: EventAttendee[];
}

export interface PersonAvailability {
  email: string;
  member_id?: string;
  name?: string;
  connected: boolean;
  source: 'events' | 'freebusy';
  busy: BusyBlock[];
  error?: string;
}

export interface FreeWindow {
  start: string;
  end: string;
}

export interface TeamAvailability {
  timeMin: string;
  timeMax: string;
  timeZone: string;
  people: PersonAvailability[];
  common_free: FreeWindow[];
}

export interface QueryTeamAvailabilityData {
  emails: string[];
  timeMin: string;
  timeMax: string;
  timeZone?: string;
}

export async function queryTeamAvailability(data: QueryTeamAvailabilityData): Promise<TeamAvailability> {
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-calendar`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ action: 'query_availability', data }),
  });

  if (!resp.ok) {
    let errMsg = `Erro ${resp.status}`;
    try {
      const err = await resp.json();
      errMsg = err.error || errMsg;
    } catch {
      const text = await resp.text().catch(() => '');
      errMsg = text || errMsg;
    }
    throw new Error(errMsg);
  }

  return await resp.json();
}
