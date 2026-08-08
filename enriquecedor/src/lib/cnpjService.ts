import pRetry from 'p-retry';
import type { Socio } from '../types';
import { onlyDigits } from './validation';
import { motorFetch } from './motorClient';

export interface CnpjData {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnae: string | null;
  segmento: string | null; // descrição do CNAE
  cidade: string | null;
  uf: string | null;
  situacaoCadastral: string | null;
  socios: Socio[];
}

export type CnpjLookup =
  | { status: 'ok'; data: CnpjData }
  | { status: 'nao_encontrado' }
  | { status: 'falha' }; // rate limit / timeout / rede — reprocessar depois

function mapRaw(d: Record<string, unknown>, cnpj: string): CnpjData {
  const qsa = d.qsa as Array<Record<string, unknown>> | undefined;
  const socios: Socio[] = Array.isArray(qsa)
    ? qsa.map((s) => ({
        nome: String(s.nome_socio ?? s.nome ?? '').trim(),
        qualificacao:
          (s.qualificacao_socio as string) ?? (s.codigo_qualificacao_socio as string) ?? null,
      }))
    : [];
  return {
    cnpj,
    razaoSocial: (d.razao_social as string) ?? null,
    nomeFantasia: (d.nome_fantasia as string) || null,
    cnae: d.cnae_fiscal ? String(d.cnae_fiscal) : null,
    segmento: (d.cnae_fiscal_descricao as string) ?? null,
    cidade: (d.municipio as string) ?? null,
    uf: (d.uf as string) ?? null,
    situacaoCadastral: (d.descricao_situacao_cadastral as string) ?? null,
    socios,
  };
}

/**
 * Consulta os dados oficiais do CNPJ. Usa o backend local (que tem cache +
 * retry/backoff contra rate limit da BrasilAPI); se o backend não estiver no ar,
 * cai para consulta direta.
 */
export async function fetchCnpj(rawCnpj: string): Promise<CnpjLookup> {
  const cnpj = onlyDigits(rawCnpj);
  if (cnpj.length !== 14) return { status: 'nao_encontrado' };

  // 1) backend local
  try {
    const res = await motorFetch(`/api/cnpj/${cnpj}`);
    if (res.ok) {
      const j = await res.json();
      if (j.ok) return { status: 'ok', data: mapRaw(j.data, cnpj) };
      if (j.reason === 'nao_encontrado') return { status: 'nao_encontrado' };
      return { status: 'falha' };
    }
  } catch {
    /* backend fora do ar — tenta direto abaixo */
  }

  // 2) fallback direto na BrasilAPI, com retry em erro transitório (429/5xx/rede).
  // Só retenta em falha transitória; 404 e resultado válido não retentam.
  try {
    return await pRetry(
      async (): Promise<CnpjLookup> => {
        const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
        if (res.status === 404) return { status: 'nao_encontrado' };
        if (res.status === 429 || res.status >= 500) throw new Error(`transitório ${res.status}`);
        if (!res.ok) return { status: 'falha' };
        return { status: 'ok', data: mapRaw(await res.json(), cnpj) };
      },
      { retries: 2, minTimeout: 800 },
    );
  } catch {
    return { status: 'falha' };
  }
}
