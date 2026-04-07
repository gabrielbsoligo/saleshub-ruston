// Kommo API Integration Service
// Cria leads no Kommo quando criados no SalesHub

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com';

// Pipeline por canal
const CANAL_TO_PIPELINE: Record<string, { pipeline_id: number; status_id: number }> = {
  blackbox:     { pipeline_id: 10897863, status_id: 83673167 },  // PV - Inbound > ENTRADA
  leadbroker:   { pipeline_id: 10897863, status_id: 83673167 },  // PV - Inbound > ENTRADA
  outbound:     { pipeline_id: 13250384, status_id: 102173864 }, // PV - Outbound > RICHLIST
  recomendacao: { pipeline_id: 13250384, status_id: 102173864 }, // PV - Outbound > RICHLIST
  indicacao:    { pipeline_id: 13250384, status_id: 102173864 }, // PV - Outbound > RICHLIST
  recovery:     { pipeline_id: 13250384, status_id: 102173864 }, // PV - Outbound > RICHLIST
};

// Custom Field IDs
const FIELDS = {
  CNPJ: 508460,
  FATURAMENTO: 508510,
  ORIGEM_LEAD: 975168,
  PRODUTO_LB: 986814,
  TELEFONE: 399272,
  EMAIL: 399274,
  ORIGEM_ENUM: {
    recomendacao: 823304,
    outbound: 823306,
    leadbroker: 823308,
    indicacao: 823330,
    blackbox: 863643,
    recovery: 863727,
  } as Record<string, number>,
  PRODUTO_ENUM: {
    'Assessoria': 839446,
    'Estruturação Estratégica': 839448,
    'Alavancagem Comercial': 839450,
    'Soluções Comerciais': 847003,
    'V4Food': 847426,
    'Destrava Receita': 863669,
  } as Record<string, number>,
};

// Token management
let cachedToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const { supabase } = await import('./supabase');
  const { data } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_access_token').single();
  if (data?.value) { cachedToken = data.value; return cachedToken; }
  throw new Error('Kommo access token not configured');
}

async function saveTokens(accessToken: string, refreshToken: string) {
  const { supabase } = await import('./supabase');
  await supabase.from('integracao_config').upsert([
    { key: 'kommo_access_token', value: accessToken },
    { key: 'kommo_refresh_token', value: refreshToken },
  ], { onConflict: 'key' });
  cachedToken = accessToken;
}

async function refreshAccessToken(): Promise<string> {
  const { supabase } = await import('./supabase');
  const { data } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_refresh_token').single();
  if (!data?.value) throw new Error('No refresh token');

  const resp = await fetch(`${KOMMO_BASE}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: '5cb13c31-8c62-4bc9-9bd4-47f09a67b0c0',
      client_secret: 'ezXsO24SuX8sNsRexwMtOhRCNthcnlwUsGlE0hrwQfNTmEACmwlHOasLy5RSaO2O',
      grant_type: 'refresh_token',
      refresh_token: data.value,
      redirect_uri: 'https://gestao-comercial-rosy.vercel.app',
    }),
  });
  if (!resp.ok) throw new Error('Failed to refresh Kommo token');
  const tokens = await resp.json();
  await saveTokens(tokens.access_token, tokens.refresh_token);
  return tokens.access_token;
}

async function kommoFetch(path: string, options: RequestInit = {}): Promise<any> {
  let token = await getAccessToken();
  let resp = await fetch(`${KOMMO_BASE}${path}`, {
    ...options,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });

  if (resp.status === 401) {
    token = await refreshAccessToken();
    resp = await fetch(`${KOMMO_BASE}${path}`, {
      ...options,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
    });
  }

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Kommo API ${resp.status}: ${err}`);
  }
  return resp.json();
}

// =============================================
// PUBLIC API
// =============================================

export interface KommoLeadData {
  empresa: string;
  nome_contato?: string;
  telefone?: string;
  email?: string;
  cnpj?: string;
  faturamento?: string;
  canal?: string;
  produto?: string;
  kommo_user_id?: number; // responsible_user_id no Kommo
}

export async function createKommoLead(data: KommoLeadData): Promise<{ kommo_id: string; kommo_link: string } | null> {
  try {
    const customFields: any[] = [];

    if (data.cnpj) customFields.push({ field_id: FIELDS.CNPJ, values: [{ value: data.cnpj }] });
    if (data.faturamento) customFields.push({ field_id: FIELDS.FATURAMENTO, values: [{ value: data.faturamento }] });
    if (data.canal && FIELDS.ORIGEM_ENUM[data.canal]) {
      customFields.push({ field_id: FIELDS.ORIGEM_LEAD, values: [{ enum_id: FIELDS.ORIGEM_ENUM[data.canal] }] });
    }
    if (data.produto && FIELDS.PRODUTO_ENUM[data.produto]) {
      customFields.push({ field_id: FIELDS.PRODUTO_LB, values: [{ enum_id: FIELDS.PRODUTO_ENUM[data.produto] }] });
    }

    // Pipeline based on canal
    const pipelineConfig = data.canal ? CANAL_TO_PIPELINE[data.canal] : undefined;

    const leadPayload = [{
      name: data.empresa,
      pipeline_id: pipelineConfig?.pipeline_id,
      status_id: pipelineConfig?.status_id,
      responsible_user_id: data.kommo_user_id || undefined,
      custom_fields_values: customFields.length > 0 ? customFields : undefined,
    }];

    const result = await kommoFetch('/api/v4/leads', {
      method: 'POST',
      body: JSON.stringify(leadPayload),
    });

    const createdLead = result?._embedded?.leads?.[0];
    if (!createdLead) return null;

    const kommoId = String(createdLead.id);
    const kommoLink = `${KOMMO_BASE}/leads/detail/${kommoId}`;

    // Create + link contact
    if (data.nome_contato || data.telefone || data.email) {
      const contactFields: any[] = [];
      if (data.telefone) contactFields.push({ field_id: FIELDS.TELEFONE, values: [{ value: data.telefone, enum_code: 'WORK' }] });
      if (data.email) contactFields.push({ field_id: FIELDS.EMAIL, values: [{ value: data.email, enum_code: 'WORK' }] });

      try {
        const contactResult = await kommoFetch('/api/v4/contacts', {
          method: 'POST',
          body: JSON.stringify([{
            name: data.nome_contato || data.empresa,
            responsible_user_id: data.kommo_user_id || undefined,
            custom_fields_values: contactFields.length > 0 ? contactFields : undefined,
          }]),
        });

        const contactId = contactResult?._embedded?.contacts?.[0]?.id;
        if (contactId) {
          await kommoFetch(`/api/v4/leads/${kommoId}/link`, {
            method: 'POST',
            body: JSON.stringify([{ to_entity_id: contactId, to_entity_type: 'contacts' }]),
          });
        }
      } catch (e) {
        console.error('Kommo contact link failed:', e);
      }
    }

    return { kommo_id: kommoId, kommo_link: kommoLink };
  } catch (e) {
    console.error('Kommo createLead failed:', e);
    return null;
  }
}
