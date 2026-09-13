// ============================================================================
// Chaves de busca — os identificadores que alimentam as auditorias de cada fase
// (marca, site, Instagram/Facebook da empresa, ficha do Google, termo da Meta).
// O operador vê, valida, corrige ou apaga ANTES de rodar a fase; a lógica de
// enriquecimento (enrichService) respeita: validado não é sobrescrito, rejeitado
// nunca volta, manual vira o termo de busca. Lógica compartilhada — a UI
// (components/ChavesBusca) só chama estes helpers.
// ============================================================================
import type { ChaveBuscaEstado, ChaveBuscaId, ChavesBusca, Lead, SiteAudit } from '../types';
import { redeHandle } from './contactSelection';

export const CHAVE_INFO: Record<ChaveBuscaId, { label: string; ajuda: string; editavel: boolean }> = {
  marca: { label: 'Nome de busca (marca)', ajuda: 'Como a empresa é conhecida — usado pra achar site, Google Meu Negócio, redes e anúncios. Fantasia da Receita ou razão social limpa.', editavel: true },
  site: { label: 'Site institucional', ajuda: 'URL auditada no F3 (HTTPS, WhatsApp, pixels, PageSpeed). Corrigir aqui faz o F3 auditar o site certo.', editavel: true },
  instagram: { label: 'Instagram da empresa', ajuda: 'Perfil institucional. Vem do link no próprio site (mais confiável) ou da busca.', editavel: true },
  facebook: { label: 'Facebook da empresa', ajuda: 'Página institucional. O @ dela é a "conta oficial" que valida os anúncios no F4.', editavel: true },
  gmn: { label: 'Google Meu Negócio', ajuda: 'Ficha do Google (nota, avaliações, telefone). Se veio a ficha errada, apague e informe o nome exato pra buscar.', editavel: true },
  meta_termo: { label: 'Termo de busca na Meta', ajuda: 'O que o F4 digita na Meta Ad Library. Padrão: @ do Facebook ou a marca.', editavel: true },
};

// Chaves relevantes por fase do funil (índices das ETAPAS do Workflow).
export const CHAVES_POR_FASE: Record<number, ChaveBuscaId[]> = {
  0: ['marca'],
  1: ['marca', 'instagram', 'facebook'],
  2: ['marca', 'site', 'instagram', 'facebook', 'gmn'],
  3: ['meta_termo', 'facebook', 'site', 'gmn'],
  4: [],
  5: [],
  6: ['site', 'instagram', 'facebook', 'gmn'],
};
export const TODAS_CHAVES: ChaveBuscaId[] = ['marca', 'site', 'instagram', 'facebook', 'gmn', 'meta_termo'];

const estado = (lead: Lead, chave: ChaveBuscaId): ChaveBuscaEstado => lead.chavesBusca?.[chave] ?? {};
const comEstado = (lead: Lead, chave: ChaveBuscaId, patch: ChaveBuscaEstado): Lead => ({
  ...lead,
  chavesBusca: { ...(lead.chavesBusca ?? {}), [chave]: { ...estado(lead, chave), ...patch } },
  updatedAt: new Date().toISOString(),
});

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// Nome "de marca" derivado: fantasia da Receita ou razão social sem sufixos
// jurídicos, com siglas soltas juntadas ("R. D. C. Construtora" → "RDC Construtora").
export function marcaPadrao(lead: Lead): string {
  const nome = (lead.nomeFantasia || lead.razaoSocial || lead.companyNameRaw || '').trim();
  let t = nome.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(ltda|limitada|s\/?a|eireli|epp|mei|me)\b/gi, '').replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let acc = '';
  for (const w of t.split(' ').filter(Boolean)) {
    if (w.length === 1) acc += w;
    else { if (acc) { out.push(acc); acc = ''; } out.push(w); }
  }
  if (acc) out.push(acc);
  return out.join(' ').trim() || nome;
}
export function marcaAtual(lead: Lead): string {
  return estado(lead, 'marca').valor?.trim() || marcaPadrao(lead);
}

// Handle do Facebook institucional (facebook.com/<handle>), se houver.
export function facebookHandle(url: string | null | undefined): string | null {
  const h = url?.match(/facebook\.com\/([^/?#]+)/i)?.[1] ?? null;
  return h && !/^\d+$/.test(h) && h.length > 2 ? h.toLowerCase() : null;
}

// Termo padrão da Meta Ad Library: handle do Facebook (como a empresa se anuncia)
// ou a marca. O operador pode sobrescrever (chaves.meta_termo.valor).
export function metaTermoPadrao(lead: Lead): string {
  const h = facebookHandle(lead.companyFacebook);
  if (h) return h.replace(/[._-]+/g, ' ').trim();
  return marcaAtual(lead);
}
export function metaTermoAtual(lead: Lead): string {
  return estado(lead, 'meta_termo').valor?.trim() || metaTermoPadrao(lead);
}

export interface ChaveAtual {
  chave: ChaveBuscaId;
  valor: string | null; // texto exibido
  link: string | null; // URL clicável, quando faz sentido
  origem: string; // de onde veio o valor atual
  validado: boolean;
  padrao: boolean; // valor derivado (marca/meta_termo sem override)
  rejeitados: string[];
  consulta?: string | null; // gmn: termo manual de busca
}

// Valor atual de cada chave (o que a PRÓXIMA execução vai usar), com origem.
export function chaveAtual(lead: Lead, audit: SiteAudit | null, chave: ChaveBuscaId): ChaveAtual {
  const e = estado(lead, chave);
  const validado = e.validacao === 'validado';
  const rejeitados = e.rejeitados ?? [];
  switch (chave) {
    case 'marca': {
      const manual = e.valor?.trim();
      return {
        chave, valor: manual || marcaPadrao(lead), link: null, validado, rejeitados,
        origem: manual ? 'manual' : lead.nomeFantasia ? 'Receita (nome fantasia)' : 'razão social limpa',
        padrao: !manual,
      };
    }
    case 'site': {
      const url = lead.siteUrl ?? audit?.siteUrl ?? null;
      const src = e.origem ?? audit?.source ?? (lead.siteUrl ? 'planilha' : null);
      const rot: Record<string, string> = { gmn: 'site da ficha do Google', email: 'domínio do e-mail', planilha: 'planilha', busca: 'busca web', manual: 'manual', validado: 'validado', nao_encontrado: 'não encontrado' };
      return { chave, valor: url ? hostOf(url) ?? url : null, link: url, validado, rejeitados, origem: (src && rot[src]) ?? src ?? '—', padrao: false };
    }
    case 'instagram':
    case 'facebook': {
      const url = chave === 'instagram' ? lead.companyInstagram : lead.companyFacebook;
      const noSite = chave === 'instagram' ? audit?.siteInstagram : audit?.siteFacebook;
      const origem = e.origem ?? (url && noSite && hostOf(url) === hostOf(noSite) && url.replace(/\/$/, '') === noSite.replace(/\/$/, '') ? 'link no próprio site' : url ? 'busca web' : '—');
      const handle = chave === 'instagram' ? redeHandle('instagram', url) : facebookHandle(url);
      return { chave, valor: url ? (handle ? `@${handle}` : url) : null, link: url, validado, rejeitados, origem, padrao: false };
    }
    case 'gmn': {
      const gb = lead.googleBusiness;
      const link = gb?.cid ? `https://maps.google.com/?cid=${gb.cid}` : null;
      return {
        chave, valor: gb?.title ?? null, link, validado, rejeitados,
        origem: e.origem ?? (gb ? `busca "${e.consulta ?? marcaAtual(lead)}"` : '—'),
        padrao: false, consulta: e.consulta ?? null,
      };
    }
    case 'meta_termo': {
      const manual = e.valor?.trim();
      return { chave, valor: manual || metaTermoPadrao(lead), link: null, validado, rejeitados, origem: manual ? 'manual' : facebookHandle(lead.companyFacebook) ? '@ do Facebook' : 'marca', padrao: !manual };
    }
  }
}

export function validarChave(lead: Lead, chave: ChaveBuscaId): Lead {
  return comEstado(lead, chave, { validacao: 'validado' });
}

// Apaga o valor atual e guarda o identificador em rejeitados (nunca volta).
// marca/meta_termo: só limpa o override (volta ao padrão derivado).
export function apagarChave(lead: Lead, chave: ChaveBuscaId): Lead {
  const e = estado(lead, chave);
  const rej = new Set(e.rejeitados ?? []);
  switch (chave) {
    case 'marca':
    case 'meta_termo':
      return comEstado(lead, chave, { valor: null, validacao: null, origem: null });
    case 'site': {
      const h = hostOf(lead.siteUrl);
      if (h) rej.add(h);
      return { ...comEstado(lead, chave, { validacao: null, origem: null, rejeitados: [...rej] }), siteUrl: null };
    }
    case 'instagram': {
      const h = redeHandle('instagram', lead.companyInstagram);
      if (h) rej.add(h);
      return { ...comEstado(lead, chave, { validacao: null, origem: null, rejeitados: [...rej] }), companyInstagram: null };
    }
    case 'facebook': {
      const h = facebookHandle(lead.companyFacebook);
      if (h) rej.add(h);
      return { ...comEstado(lead, chave, { validacao: null, origem: null, rejeitados: [...rej] }), companyFacebook: null };
    }
    case 'gmn': {
      const cid = lead.googleBusiness?.cid;
      if (cid) rej.add(String(cid));
      return { ...comEstado(lead, chave, { validacao: null, origem: null, rejeitados: [...rej] }), googleBusiness: null };
    }
  }
}

// Define o valor manualmente (vira validado, origem manual). Para gmn, `valor` é
// o termo de busca no Google: limpa a ficha atual e o F3 busca de novo com ele.
export function definirChave(lead: Lead, chave: ChaveBuscaId, valor: string): Lead {
  const v = valor.trim();
  if (!v) return lead;
  const url = (s: string) => (s.startsWith('http') ? s : `https://${s}`);
  switch (chave) {
    case 'marca':
    case 'meta_termo':
      return comEstado(lead, chave, { valor: v, validacao: 'validado', origem: 'manual' });
    case 'site':
      return { ...comEstado(lead, chave, { validacao: 'validado', origem: 'manual' }), siteUrl: url(v) };
    case 'instagram':
      return { ...comEstado(lead, chave, { validacao: 'validado', origem: 'manual' }), companyInstagram: /instagram\.com/i.test(v) ? url(v) : `https://www.instagram.com/${v.replace(/^@/, '')}` };
    case 'facebook':
      return { ...comEstado(lead, chave, { validacao: 'validado', origem: 'manual' }), companyFacebook: /facebook\.com/i.test(v) ? url(v) : `https://www.facebook.com/${v.replace(/^@/, '')}` };
    case 'gmn':
      return { ...comEstado(lead, chave, { consulta: v, validacao: null, origem: null }), googleBusiness: null };
  }
}

export function chavesPendentes(lead: Lead, audit: SiteAudit | null, ids: ChaveBuscaId[]): number {
  return ids.filter((id) => !chaveAtual(lead, audit, id).validado).length;
}

// O que o enrichService manda pro motor / usa pra decidir sobrescrever.
export function overridesBusca(lead: Lead) {
  const cb: ChavesBusca = lead.chavesBusca ?? {};
  const val = (c: ChaveBuscaId) => cb[c]?.validacao === 'validado';
  return {
    marca: marcaAtual(lead),
    siteValidado: val('site') && !!lead.siteUrl,
    siteRejeitados: cb.site?.rejeitados ?? [],
    instagramValidado: val('instagram') && !!lead.companyInstagram,
    facebookValidado: val('facebook') && !!lead.companyFacebook,
    redesRejeitadas: { instagram: cb.instagram?.rejeitados ?? [], facebook: cb.facebook?.rejeitados ?? [] },
    gmnValidado: val('gmn') && !!lead.googleBusiness,
    gmnConsulta: cb.gmn?.consulta?.trim() || null,
    gmnRejeitados: cb.gmn?.rejeitados ?? [],
    metaTermo: metaTermoAtual(lead),
  };
}
