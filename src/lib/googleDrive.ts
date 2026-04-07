// Google Drive Integration
// Busca transcricoes e gravacoes de reunioes do Google Meet via Edge Function

const SUPABASE_FUNCTIONS_URL = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

function getAuthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  };
}

export interface TranscriptResult {
  status: 'found' | 'not_found';
  transcript_text?: string;
  transcript_url?: string;
  recording_url?: string;
  message?: string;
  needs_reauth?: boolean;
}

/**
 * Busca a transcricao de uma reuniao no Google Drive.
 * Retorna o texto da transcricao se encontrado, ou status 'not_found' se ainda nao esta disponivel.
 */
export async function fetchMeetingTranscript(reuniaoId: string): Promise<TranscriptResult> {
  const headers = getAuthHeaders();
  const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/google-drive`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'fetch_transcript', data: { reuniao_id: reuniaoId } }),
  });

  if (!resp.ok) {
    let errMsg = `Erro ${resp.status}`;
    try {
      const err = await resp.json();
      if (err.needs_reauth) {
        return { status: 'not_found', message: err.error, needs_reauth: true };
      }
      errMsg = err.error || errMsg;
    } catch {
      errMsg = await resp.text().catch(() => errMsg);
    }
    throw new Error(errMsg);
  }

  return await resp.json();
}

/**
 * Busca a transcricao com polling automatico.
 * Tenta a cada `intervalMs` milissegundos, ate `maxAttempts` tentativas.
 * Chama `onStatusUpdate` a cada tentativa para atualizar a UI.
 *
 * @param reuniaoId - ID da reuniao
 * @param onStatusUpdate - callback com numero da tentativa e total
 * @param intervalMs - intervalo entre tentativas (padrao: 2 minutos)
 * @param maxAttempts - numero maximo de tentativas (padrao: 30 = 60 minutos)
 * @returns TranscriptResult com status 'found' e texto, ou 'not_found' se esgotou tentativas
 */
export async function fetchTranscriptWithPolling(
  reuniaoId: string,
  onStatusUpdate?: (attempt: number, maxAttempts: number) => void,
  intervalMs: number = 2 * 60 * 1000, // 2 minutos
  maxAttempts: number = 30, // 30 tentativas = 60 minutos
): Promise<TranscriptResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (onStatusUpdate) onStatusUpdate(attempt, maxAttempts);

    try {
      const result = await fetchMeetingTranscript(reuniaoId);

      if (result.status === 'found' && result.transcript_text) {
        return result;
      }

      // Se precisa re-autorizacao, nao adianta continuar polling
      if (result.needs_reauth) {
        return result;
      }
    } catch (error) {
      console.error(`Tentativa ${attempt}/${maxAttempts} falhou:`, error);
    }

    // Esperar antes da proxima tentativa (exceto na ultima)
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return {
    status: 'not_found',
    message: `Transcricao nao encontrada apos ${maxAttempts} tentativas (${Math.round(maxAttempts * intervalMs / 60000)} minutos)`,
  };
}
