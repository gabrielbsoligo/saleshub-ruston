// =============================================================
// 3C — Trabalho manual de ligação (tela temporária)
// =============================================================
// Lógica pura da tela: normalização de telefone (reusa a regra do
// dedup), cruzamento id × telefone, heurística de "registro podre"
// e montagem do payload de writeback (Conexão Realizada).
//
// IMPORTANTE: nada aqui escreve no Kommo. buildWritebackPayload só
// MONTA o corpo do PATCH que seria enviado — a gravação fica atrás
// de WRITEBACK_ENABLED (false até liberação pós-migração).
// =============================================================

// -------- Destino fixo: Novo-Pré Vendas · Conexão Realizada --------
export const TARGET_PIPELINE_ID = 14062096; // Novo-Pré Vendas
export const TARGET_STATUS_ID = 108545100; // Conexão Realizada
export const KOMMO_BASE = 'https://financeirorustonengenhariacombr.kommo.com';

// Trava de segurança: quando false, a tela NUNCA grava no Kommo — só
// mostra o payload que enviaria (dry-run). true = escrita real via
// kommo-3c-move → kommo-writeback.
export const WRITEBACK_ENABLED = true;

export const kommoLeadUrl = (id: number | string) => `${KOMMO_BASE}/leads/detail/${id}`;

// Estado vivo de um lead, como o kommo-lookup devolve.
export interface KommoLeadState {
  id: number;
  name: string;
  pipeline_id: number | null;
  status_id: number | null;
  pipeline_name: string;
  status_name: string;
  tags: string[];
  responsible_user_id: number | null;
  is_lost: boolean; // etapa 143 (perdido)
  is_deleted: boolean; // GET direto voltou 404/204
  contact_name: string | null;
  phones: string[];
  updated_at: number | null;
}

export interface KommoUser {
  id: number;
  name: string;
  email?: string;
}

// -------- Normalização de telefone (reusa a regra do dedup) --------
// digits(): tira tudo que não é dígito — mesma função de ImportLeadsModal.
export const phoneDigits = (s?: string | null): string => (s || '').replace(/\D/g, '');

// Casa pelos últimos 8 dígitos: absorve +55 (DDI) e o nono dígito do
// celular, que variam entre migração/base. 8 é o núcleo estável do número.
export function phoneMatches(a?: string | null, b?: string | null): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (da.length < 8 || db.length < 8) return false;
  return da.slice(-8) === db.slice(-8);
}

// -------- Heurística de "registro podre" --------
// Sinaliza (mas não bloqueia) o card cujo id parece apontar pra um
// registro suspeito pós-dedup/migração. A decisão continua sendo do SDR.
const ROTTEN_TAG = /(^|[^a-z])_?(dupe?|duplicad[ao]|legado|legacy|antigo|old|lixo|migrad[ao])\b/i;

export function rottenReasons(s: KommoLeadState): string[] {
  const reasons: string[] = [];
  if (s.is_deleted) reasons.push('deletado no Kommo');
  if (s.is_lost) reasons.push('perdido');
  const bad = (s.tags || []).filter((t) => ROTTEN_TAG.test(t));
  if (bad.length) reasons.push(`tags ${bad.join(', ')}`);
  return reasons;
}

export function isRotten(s: KommoLeadState): boolean {
  return rottenReasons(s).length > 0;
}

// -------- Cruzamento id × telefone --------
export type SearchResult =
  | { mode: 'match'; lead: KommoLeadState } // id e telefone no mesmo lead → confiança alta
  | { mode: 'divergence'; byId: KommoLeadState; byPhone: KommoLeadState[] } // apontam leads diferentes
  | { mode: 'multiple'; leads: KommoLeadState[]; idMatchId?: number } // vários por telefone
  | { mode: 'single'; lead: KommoLeadState; source: 'id' | 'phone' } // só uma fonte achou um
  | { mode: 'none' };

export interface CrossInput {
  byId: KommoLeadState | null;
  byPhone: KommoLeadState[];
}

export function crossReference({ byId, byPhone }: CrossInput): SearchResult {
  const phone = byPhone || [];

  if (byId && phone.length) {
    const sameLead = phone.find((l) => l.id === byId.id);
    if (sameLead) {
      // id e telefone convergem → confiança alta (usa o do id, tem estado completo)
      return { mode: 'match', lead: byId };
    }
    // divergem → mostra os dois lados, SDR decide
    return { mode: 'divergence', byId, byPhone: phone };
  }

  if (byId && !phone.length) return { mode: 'single', lead: byId, source: 'id' };

  if (!byId && phone.length === 1) return { mode: 'single', lead: phone[0], source: 'phone' };

  if (!byId && phone.length > 1) return { mode: 'multiple', leads: phone };

  return { mode: 'none' };
}

// -------- Payload do writeback (só MONTA, não envia) --------
export interface WritebackPayload {
  pipeline_id: number;
  status_id: number;
  responsible_user_id: number;
}

export function buildWritebackPayload(kommoUserId: number): WritebackPayload {
  return {
    pipeline_id: TARGET_PIPELINE_ID,
    status_id: TARGET_STATUS_ID,
    responsible_user_id: kommoUserId,
  };
}

// Endpoint que a ponte kommo-writeback chamaria (mostrado no dry-run).
export function writebackEndpoint(leadId: number | string): string {
  return `PATCH ${KOMMO_BASE}/api/v4/leads/${leadId}`;
}
