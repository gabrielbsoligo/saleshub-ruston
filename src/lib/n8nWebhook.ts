// =============================================================
// n8n webhook emitter — "kommo-lead-ganho"
// =============================================================
// Quando um deal transiciona para contrato_assinado, o SalesHub
// dispara este webhook no MESMO formato que o Kommo mandaria
// (application/x-www-form-urlencoded, keys no estilo amoCRM),
// para que o workflow n8n existente não precise ser alterado.
//
// O n8n usa APENAS `leads[status][0][id]` pra buscar o lead na
// API do Kommo via get_lead_by_id. Sem kommo_id no deal, pular.
// =============================================================

import type { Deal } from '../types';

// URL do webhook (prod). Pode ser sobrescrita via env var.
const N8N_WEBHOOK_URL =
  (import.meta.env.VITE_N8N_GANHO_WEBHOOK_URL as string | undefined) ||
  'https://webhooks.rustontools.tech/webhook/kommo-lead-ganho';

// Constantes da conta Kommo (fixas para o Ruston Engenharia)
const KOMMO_ACCOUNT_ID = '34424367';
const KOMMO_SUBDOMAIN = 'financeirorustonengenhariacombr';
const KOMMO_PIPELINE_ID = '11010459';
const KOMMO_STATUS_GANHO_ID = '142'; // "won"

// Mapeamento SalesHub status → Kommo status_id (pra old_status_id)
// Valores coletados do pipeline real do Kommo Ruston.
const SALESHUB_TO_KOMMO_STATUS: Record<string, string> = {
  dar_feedback: '102577612',
  negociacao: '102577616',
  contrato_na_rua: '102577620',
  contrato_assinado: '142',
  follow_longo: '102577624',
  perdido: '143',
};

/**
 * Emite o webhook de "lead ganho" no formato amoCRM/Kommo.
 * Não bloqueia o fluxo principal — falhas são logadas e toleradas.
 */
export async function emitDealGanhoWebhook(
  deal: Partial<Deal>,
  oldStatus?: string
): Promise<void> {
  if (!deal.kommo_id) {
    console.warn(
      '[n8nWebhook] Deal sem kommo_id — webhook não disparado.',
      { dealId: deal.id, empresa: deal.empresa }
    );
    return;
  }

  const oldStatusId =
    (oldStatus && SALESHUB_TO_KOMMO_STATUS[oldStatus]) || '0';

  // Format amoCRM: application/x-www-form-urlencoded com keys aninhados
  const body = new URLSearchParams();
  body.append('leads[status][0][id]', String(deal.kommo_id));
  body.append('leads[status][0][status_id]', KOMMO_STATUS_GANHO_ID);
  body.append('leads[status][0][pipeline_id]', KOMMO_PIPELINE_ID);
  body.append('leads[status][0][old_status_id]', oldStatusId);
  body.append('leads[status][0][old_pipeline_id]', KOMMO_PIPELINE_ID);
  body.append('account[id]', KOMMO_ACCOUNT_ID);
  body.append('account[subdomain]', KOMMO_SUBDOMAIN);

  console.log('[n8nWebhook] Disparando pra', N8N_WEBHOOK_URL, 'kommo_id=', deal.kommo_id);

  try {
    // no-cors: navegador permite POST cross-origin pra webhook sem
    // CORS headers. Response fica opaque (status 0) mas o servidor
    // recebe o POST normalmente (fire-and-forget).
    await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    console.log('[n8nWebhook] POST enviado (resposta opaque por no-cors).');
  } catch (err) {
    console.error('[n8nWebhook] Erro de rede:', err);
  }
}
