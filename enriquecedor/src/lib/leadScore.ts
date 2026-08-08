import type { DecisionMaker, DecisorLevel, Lead, SiteAudit } from '../types';
import { checkEmail, checkPhone } from './validation';

/**
 * Nível de decisor: quanto mais empresas o sócio tem no nome (Lemit) e sendo
 * administrador, maior o peso dele como tomador de decisão.
 */
export function decisorLevel(dm: DecisionMaker): DecisorLevel {
  const admin = /administrador/i.test(dm.cargo ?? '') || dm.isPrimary;
  const n = dm.companiesCount ?? 0;
  if (n >= 4 || (admin && n >= 2)) return 'alto';
  if (n >= 2 || admin) return 'medio';
  return 'baixo';
}

export function isSituacaoAtiva(situacao: string | null): boolean {
  return (situacao ?? '').trim().toUpperCase() === 'ATIVA';
}

/**
 * Score de 0 a 100 combinando situação cadastral + contactabilidade + presença
 * digital. Usado para priorizar quem o SDR aborda primeiro.
 */
export function computeScore(lead: Lead, audit?: SiteAudit | null): number {
  let score = 50;

  // Situação cadastral
  const sit = (lead.situacaoCadastral ?? '').toUpperCase();
  if (sit === 'ATIVA') score += 20;
  else if (sit === 'SUSPENSA' || sit === 'INAPTA') score -= 25;
  else if (sit === 'BAIXADA' || sit === 'NULA') score -= 40;

  // Contactabilidade do decisor
  if (checkPhone(lead.phoneRaw).isMobile) score += 12;
  else if (checkPhone(lead.phoneRaw).valid) score += 5;
  if (checkEmail(lead.emailRaw).valid) score += 10;

  // Presença digital
  if (audit?.isOnline) score += 5;
  if (audit && audit.whatsappButtons.some((b) => !b.working)) score += 3; // gancho

  // Qualidade do dado
  if (lead.dataQuality === 'invalido') score -= 30;
  else if (lead.dataQuality === 'suspeito') score -= 10;

  return Math.max(0, Math.min(100, Math.round(score)));
}
