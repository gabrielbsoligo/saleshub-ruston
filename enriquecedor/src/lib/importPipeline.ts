import pLimit from 'p-limit';
import type { DataQuality, Lead } from '../types';
import { fetchCnpj } from './cnpjService';
import type { RawLeadRow } from './parseSpreadsheet';
import {
  checkEmail,
  checkPhone,
  isValidCnpj,
  normalizeCnpjDigits,
  normalizeRevenueBand,
} from './validation';
import { computeScore } from './leadScore';

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `lead_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  );
}

// Roda `worker` sobre `items` com no máximo `limit` em paralelo (p-limit, mesma
// concorrência e ordem por índice do map).
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const lim = pLimit(Math.max(1, limit || 1));
  return Promise.all(items.map((item, i) => lim(() => worker(item, i))));
}

export interface ImportProgress {
  done: number;
  total: number;
}

/**
 * Valida cada linha (checagens locais + consulta ao CNPJ na Receita) e monta
 * os leads. A Receita é a fonte de verdade: se o nome da planilha divergir da
 * razão social, marca a divergência e usa o dado oficial.
 */
export async function buildLeadsFromRows(
  rows: RawLeadRow[],
  onProgress?: (p: ImportProgress) => void,
): Promise<Lead[]> {
  let done = 0;

  return mapLimit(rows, 5, async (row) => {
    const notes: string[] = [];
    const now = new Date().toISOString();
    const cnpjDigits = normalizeCnpjDigits(row.cnpj);

    // --- Checagens locais ---
    const cnpjFormatOk = isValidCnpj(cnpjDigits);
    if (!cnpjFormatOk) notes.push('CNPJ inválido (dígito verificador).');

    // Alertas informativos (não são "correção", entram como "atenção").
    const alerts: string[] = [];
    const phone = checkPhone(row.phone);
    if (row.phone && !phone.valid) alerts.push('Telefone com formato inválido.');
    else if (phone.valid && !phone.isMobile)
      alerts.push('Telefone não é celular — pode não ter WhatsApp.');

    const email = checkEmail(row.email);
    if (row.email && !email.valid) alerts.push('E-mail com formato inválido.');
    else if (email.disposable) alerts.push('E-mail de domínio descartável.');

    // --- Fonte de verdade: Receita ---
    const lookup = cnpjFormatOk
      ? await fetchCnpj(cnpjDigits)
      : ({ status: 'nao_encontrado' } as const);
    const cnpjData = lookup.status === 'ok' ? lookup.data : null;
    if (cnpjFormatOk && lookup.status === 'falha') {
      alerts.push('Não foi possível consultar a Receita agora (reprocessar).');
    } else if (cnpjFormatOk && lookup.status === 'nao_encontrado') {
      alerts.push('CNPJ não encontrado na Receita.');
    }

    let corrected = false; // true só quando um dado é de fato trocado pelo oficial
    if (cnpjData && row.companyName) {
      const planilha = row.companyName.trim().toLowerCase();
      const oficial = (cnpjData.razaoSocial ?? '').toLowerCase();
      const fantasia = (cnpjData.nomeFantasia ?? '').toLowerCase();
      if (oficial && !oficial.includes(planilha) && !fantasia.includes(planilha)) {
        notes.push(
          `Nome da planilha ("${row.companyName}") substituído pelo oficial ("${cnpjData.razaoSocial}").`,
        );
        corrected = true;
      }
    }
    if (cnpjData?.situacaoCadastral && cnpjData.situacaoCadastral.toUpperCase() !== 'ATIVA') {
      alerts.push(`Situação cadastral: ${cnpjData.situacaoCadastral}.`);
    }

    // Classificação: inválido > suspeito (falha) > corrigido > atenção > válido
    const quality: DataQuality = !cnpjFormatOk
      ? 'invalido'
      : lookup.status === 'falha'
        ? 'suspeito'
        : corrected
          ? 'corrigido'
          : alerts.length > 0
            ? 'atencao'
            : 'valido';

    const lead: Lead = {
      id: newId(),
      cnpjRaw: row.cnpj,
      companyNameRaw: row.companyName,
      revenueBandRaw: row.revenueBand ? normalizeRevenueBand(row.revenueBand) : null,
      phoneRaw: row.phone || null,
      emailRaw: row.email || null,
      siteUrl: row.site || null,
      cnpj: cnpjData?.cnpj ?? (cnpjFormatOk ? cnpjDigits : null),
      razaoSocial: cnpjData?.razaoSocial ?? null,
      nomeFantasia: cnpjData?.nomeFantasia ?? null,
      cnae: cnpjData?.cnae ?? null,
      segmento: cnpjData?.segmento ?? null,
      cidade: cnpjData?.cidade ?? null,
      uf: cnpjData?.uf ?? null,
      situacaoCadastral: cnpjData?.situacaoCadastral ?? null,
      socios: cnpjData?.socios ?? [],
      companyInstagram: null,
      companyFacebook: null,
      empreendimentos: [],
      googleBusiness: null,
      lemitCompany: null,
      organograma: null,
      datastone: null,
      briefing: null,
      dataQuality: quality,
      validationNotes: [...notes, ...alerts],
      status: 'importado',
      score: null,
      kommoLeadId: null,
      createdAt: now,
      updatedAt: now,
    };
    lead.score = computeScore(lead);

    done += 1;
    onProgress?.({ done, total: rows.length });
    return lead;
  });
}
