import type { DecisionMaker, Lead, SiteAudit, WhatsappButtonCheck } from '../types';

// Campos mínimos de uma auditoria de WhatsApp (serve para o site e para as LPs).
type WaAuditable = {
  whatsappButtons: WhatsappButtonCheck[];
  hasWhatsappWidget: boolean;
  isOnline: boolean;
};

export interface WhatsappAudit {
  status: 'ok' | 'broken' | 'missing' | 'widget' | 'none';
  problemas: string[]; // pontos com problema (site / LP / Google), já descritos
}

/**
 * Auditoria de WhatsApp CONSOLIDADA: engloba o site, TODAS as LPs dos
 * empreendimentos e o Google Meu Negócio. É a fonte única do status de WhatsApp
 * (usada no KPI e nas dores) — garante que um botão quebrado numa LP apareça.
 */
export function whatsappAudit(lead: Lead, audit: SiteAudit | null): WhatsappAudit {
  const fontes: { label: string; a: WaAuditable | null | undefined }[] = [
    { label: 'site', a: audit },
    ...(lead.empreendimentos ?? [])
      .filter((e) => e.lpAudit)
      .map((e) => ({ label: `LP ${e.nome}`, a: e.lpAudit as WaAuditable })),
  ];

  const problemas: string[] = [];
  let anyBroken = false;
  let anyMissing = false;
  let anyWidget = false;
  let okCount = 0;

  for (const { label, a } of fontes) {
    if (!a || !a.isOnline) continue;
    const broken = (a.whatsappButtons ?? []).filter((b) => !b.working);
    const working = (a.whatsappButtons ?? []).filter((b) => b.working);
    if (broken.length > 0) {
      anyBroken = true;
      const num = broken.find((b) => b.numberFound)?.numberFound;
      problemas.push(`${label}: WhatsApp quebrado${num ? ` (${num})` : ''}`);
    } else if (working.length > 0) {
      okCount += 1;
    } else if (a.hasWhatsappWidget) {
      anyWidget = true;
      problemas.push(`${label}: WhatsApp via widget (não validado)`);
    } else {
      anyMissing = true;
      problemas.push(`${label}: sem botão de WhatsApp`);
    }
  }

  // Google Meu Negócio — canal de contato/WhatsApp.
  if (lead.googleBusiness && !lead.googleBusiness.phone) {
    problemas.push('Google Meu Negócio: sem telefone/WhatsApp');
  }

  const status: WhatsappAudit['status'] = anyBroken
    ? 'broken'
    : anyMissing
      ? 'missing'
      : anyWidget
        ? 'widget'
        : okCount > 0
          ? 'ok'
          : 'none';
  return { status, problemas };
}

/**
 * Dores para abordagem, derivadas dos dados enriquecidos. É uma primeira versão
 * heurística — o briefing por IA (Fase 2) refina/prioriza. O WhatsApp é
 * consolidado (site + LPs + Google) e vem sempre em primeiro.
 */
export function computeDores(
  lead: Lead,
  audit: SiteAudit | null,
  people: DecisionMaker[],
): string[] {
  const dores: string[] = [];

  // WhatsApp consolidado (site + LPs + Google) — gancho mais forte, vem primeiro.
  const wa = whatsappAudit(lead, audit);
  if (wa.problemas.length > 0) {
    dores.push(`WhatsApp com problema — ${wa.problemas.join(' · ')}: perde contato de cliente quente.`);
  }

  // Site
  if (audit) {
    if (!audit.isOnline && audit.source === 'nao_encontrado') {
      dores.push('Sem site encontrado — presença digital fraca.');
    } else if (!audit.isOnline) {
      dores.push('Site fora do ar ou instável.');
    }
    if (audit.isOnline && !audit.httpsValid) {
      dores.push('Site sem HTTPS válido — passa insegurança ao visitante.');
    }
    if (audit.isOnline && audit.loadTimeMs != null && audit.loadTimeMs >= 3000) {
      dores.push(`Site lento (${(audit.loadTimeMs / 1000).toFixed(1)}s) — derruba conversão, sobretudo vindo de anúncio.`);
    }
    if (audit.pagespeed?.performance != null && audit.pagespeed.performance < 50) {
      dores.push(`Performance do site baixa (${audit.pagespeed.performance}/100 no PageSpeed mobile).`);
    }
    if (audit.isOnline && !audit.hasMetaPixel && !audit.hasGoogleTag) {
      dores.push('Sem pixel/tag no site — provavelmente não faz (nem otimiza) tráfego pago.');
    }
  }

  // Empreendimentos ativos — momento de vender.
  const ativos = lead.empreendimentos.filter(
    (e) => e.status === 'em_obra' || e.status === 'lancamento',
  );
  if (ativos.length > 0) {
    const nomes = ativos.slice(0, 2).map((e) => e.nome).join(' e ');
    dores.push(`Empreendimento ${nomes} em ${ativos[0].status === 'lancamento' ? 'lançamento' : 'obra'} — momento de vender unidades.`);
  }

  // Google Meu Negócio (reputação)
  if (!lead.googleBusiness) {
    dores.push('Sem perfil no Google Meu Negócio — invisível em buscas locais.');
  } else {
    if (lead.googleBusiness.rating !== null && lead.googleBusiness.rating < 4) {
      dores.push(`Reputação baixa no Google (${lead.googleBusiness.rating}★).`);
    }
    if (lead.googleBusiness.reviews !== null && lead.googleBusiness.reviews < 20) {
      dores.push(`Poucas avaliações no Google (${lead.googleBusiness.reviews}).`);
    }
  }

  // Redes
  if (!lead.companyInstagram) {
    dores.push('Sem Instagram institucional identificado.');
  }

  // Contactabilidade do decisor
  const comContato = people.some((p) => p.phonePersonal || p.emailPersonal);
  if (people.length > 0 && !comContato) {
    dores.push('Sem contato direto do decisor — abordar pelas redes.');
  }

  return dores.slice(0, 8);
}
