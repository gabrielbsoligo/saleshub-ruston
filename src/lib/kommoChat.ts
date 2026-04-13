// =============================================
// Kommo Chat/WhatsApp Integration
// Busca mensagens do WhatsApp de um lead para complementar dados de indicacoes
// =============================================

const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com';

// Reutiliza o padrao de auth do kommo.ts
let cachedToken: string | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const { supabase } = await import('./supabase');
  const { data } = await supabase.from('integracao_config').select('value').eq('key', 'kommo_access_token').single();
  if (data?.value) { cachedToken = data.value; return cachedToken; }
  throw new Error('Kommo access token not configured');
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

  const { supabase: sb } = await import('./supabase');
  await sb.from('integracao_config').upsert([
    { key: 'kommo_access_token', value: tokens.access_token },
    { key: 'kommo_refresh_token', value: tokens.refresh_token },
  ], { onConflict: 'key' });
  cachedToken = tokens.access_token;
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
    throw new Error(`Kommo Chat API ${resp.status}: ${err}`);
  }
  return resp.json();
}

export interface KommoMessage {
  id: number;
  text: string;
  created_at: number; // unix timestamp
  author?: { name?: string };
}

export interface ReferralComplement {
  nome?: string;
  empresa?: string;
  telefone?: string;
}

/**
 * Busca as mensagens recentes de um lead no Kommo (chats/WhatsApp).
 * Usa a API /api/v4/leads/{id}/chats para encontrar chats do lead,
 * depois busca as mensagens mais recentes.
 *
 * @param kommoLeadId - O ID do lead no Kommo (numero)
 * @param maxMessages - Numero maximo de mensagens para buscar (padrao: 50)
 * @returns Array de mensagens com texto e metadata
 */
export async function getLeadMessages(kommoLeadId: string | number, maxMessages: number = 50): Promise<KommoMessage[]> {
  try {
    // Kommo API v4: buscar chats associados ao lead
    // Endpoint: GET /api/v4/leads/{id}?with=chats
    const leadData = await kommoFetch(`/api/v4/leads/${kommoLeadId}?with=contacts`);

    if (!leadData) return [];

    // Buscar contatos vinculados ao lead para encontrar chats
    const contacts = leadData._embedded?.contacts || [];
    if (contacts.length === 0) return [];

    const contactId = contacts[0]?.id;
    if (!contactId) return [];

    // Buscar chats do contato
    // Kommo API: GET /api/v4/contacts/{id}/chats
    let chats;
    try {
      chats = await kommoFetch(`/api/v4/contacts/chats?contact_id=${contactId}`);
    } catch (e) {
      // API de chats pode nao estar disponivel - fallback gracioso
      console.warn('Kommo Chats API nao disponivel:', e);
      return [];
    }

    const chatList = chats?._embedded?.chats || [];
    if (chatList.length === 0) return [];

    // Pegar o chat mais recente (provavelmente WhatsApp)
    const chat = chatList[0];

    // Buscar mensagens do chat
    const messagesData = await kommoFetch(`/api/v4/chats/${chat.id}/messages?limit=${maxMessages}&order=desc`);
    const messages = messagesData?._embedded?.messages || [];

    return messages.map((m: any) => ({
      id: m.id,
      text: m.text || '',
      created_at: m.created_at || 0,
      author: m.author ? { name: m.author.name } : undefined,
    }));
  } catch (error) {
    console.error('Erro ao buscar mensagens do Kommo:', error);
    return [];
  }
}

/**
 * Analisa as mensagens do WhatsApp para complementar dados de indicacoes.
 * Usa Gemini para extrair nomes e telefones de potenciais indicacoes.
 *
 * @param messages - Mensagens do WhatsApp
 * @param indicacoes - Indicacoes ja extraidas da transcricao (pode ter dados incompletos)
 * @returns Indicacoes complementadas com dados do WhatsApp
 */
export async function complementReferralsFromChat(
  messages: KommoMessage[],
  indicacoes: Array<{ nome: string; empresa: string; telefone?: string }>,
): Promise<Array<{ nome: string; empresa: string; telefone?: string }>> {
  if (messages.length === 0 || indicacoes.length === 0) return indicacoes;

  // Filtrar apenas indicacoes que precisam de complemento (sem telefone)
  const needsComplement = indicacoes.filter(i => !i.telefone);
  if (needsComplement.length === 0) return indicacoes;

  // Montar texto das mensagens para analise
  const chatText = messages
    .filter(m => m.text && m.text.trim().length > 0)
    .slice(0, 30) // Limitar a 30 mensagens mais recentes
    .map(m => m.text)
    .join('\n');

  if (!chatText.trim()) return indicacoes;

  try {
    // Usar Gemini para extrair dados de contato das mensagens
    const { GoogleGenAI } = await import('@google/genai');

    const apiKey = (process.env as any).GEMINI_API_KEY;
    if (!apiKey) return indicacoes;

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `Analise as mensagens de WhatsApp abaixo e extraia APENAS numeros de telefone e nomes de pessoas que correspondam as indicacoes listadas.

Indicacoes que precisam de telefone:
${needsComplement.map(i => `- ${i.nome} (${i.empresa})`).join('\n')}

Mensagens do WhatsApp:
${chatText}

Retorne um JSON array com os dados encontrados. Para cada indicacao, retorne o telefone se encontrado.
Formato: [{"nome": "...", "telefone": "..."}]
Se nao encontrar nenhum dado, retorne [].`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const text = response.text;
    if (!text) return indicacoes;

    const complements: Array<{ nome: string; telefone?: string }> = JSON.parse(text);

    // Merge: complementar indicacoes com dados do WhatsApp
    return indicacoes.map(ind => {
      if (ind.telefone) return ind; // ja tem telefone, nao precisa complementar

      const match = complements.find(c =>
        c.nome && ind.nome &&
        c.nome.toLowerCase().includes(ind.nome.toLowerCase().split(' ')[0])
      );

      if (match?.telefone) {
        return { ...ind, telefone: match.telefone };
      }
      return ind;
    });
  } catch (error) {
    console.error('Erro ao complementar indicacoes com WhatsApp:', error);
    return indicacoes; // graceful degradation
  }
}
