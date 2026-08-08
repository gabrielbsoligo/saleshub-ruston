import type { SiteAudit } from '../types';

// Campos mínimos para calcular a nota — servem tanto para o site quanto para a LP.
type Auditable = Pick<
  SiteAudit,
  'isOnline' | 'httpsValid' | 'loadTimeMs' | 'hasMetaPixel' | 'hasGoogleTag' | 'whatsappButtons' | 'hasWhatsappWidget'
>;

// Classificação do tempo de carregamento.
export function loadTimeInfo(ms: number | null): { label: string; cls: string } | null {
  if (ms == null) return null;
  const s = ms / 1000;
  if (s < 1.5) return { label: 'rápido', cls: 'text-v4-success' };
  if (s < 3) return { label: 'moderado', cls: 'text-v4-warning' };
  if (s < 5) return { label: 'lento', cls: 'text-v4-warning' };
  return { label: 'muito lento', cls: 'text-v4-error' };
}

/**
 * Nota do site (0–10) combinando disponibilidade, HTTPS, performance,
 * rastreamento (pixel/tag) e WhatsApp. Serve para priorizar/abordar.
 */
export function siteGrade(audit: Auditable | null): { nota: number; label: string; cls: string } {
  if (!audit || !audit.isOnline) {
    return { nota: 0, label: 'sem site / fora do ar', cls: 'text-v4-error' };
  }
  let nota = 0;
  nota += 2; // está no ar
  if (audit.httpsValid) nota += 2;
  // performance (0–2)
  if (audit.loadTimeMs != null) {
    const s = audit.loadTimeMs / 1000;
    nota += s < 3 ? 2 : s < 5 ? 1 : 0;
  } else {
    nota += 1;
  }
  if (audit.hasMetaPixel || audit.hasGoogleTag) nota += 2; // faz rastreamento
  const waOk = audit.whatsappButtons.some((b) => b.working);
  if (waOk) nota += 2;
  else if (audit.hasWhatsappWidget) nota += 1;

  const label = nota >= 8 ? 'ótimo' : nota >= 6 ? 'bom' : nota >= 4 ? 'regular' : 'fraco';
  const cls = nota >= 8 ? 'text-v4-success' : nota >= 6 ? 'text-v4-warning' : 'text-v4-error';
  return { nota, label, cls };
}
