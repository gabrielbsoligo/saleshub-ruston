// Deduplicação de leads que ENTRAM num projeto (lista nova ou cadastro manual)
// contra os que o projeto já tem. Módulo puro (sem Supabase) pra ser testável.
//
// Regras, nesta ordem:
//   1. CNPJ repetido dentro do próprio lote: fica a primeira ocorrência (o upsert
//      em lote do Postgres derruba o lote com "cannot affect row a second time").
//   2. CNPJ que já está no projeto (mesmo descartado): não entra de novo.
//   3. Telefone válido igual ao de um lead que já está no projeto: não entra —
//      é a mesma empresa com outro CNPJ (filial/MEI do sócio) ou lista repetida.
import type { Lead } from '../types';
import type { WfLead } from './projectsStore';
import { checkPhone, formatCnpj, normalizeCnpjDigits } from './validation';

export interface LeadExistente {
  cnpj: string | null | undefined;
  phone: string | null | undefined;
}

export interface Dedupe {
  aceitos: Lead[];
  repetidosNoLote: number;
  jaNoProjeto: number;
  telefoneRepetido: number;
}

const chaveCnpj = (v: string | null | undefined) => normalizeCnpjDigits(v) || null;
const chaveFone = (v: string | null | undefined) => checkPhone(v).normalized;

export function deduplicar(lote: Lead[], existentes: LeadExistente[]): Dedupe {
  const cnpjsProjeto = new Set(existentes.map((e) => chaveCnpj(e.cnpj)).filter((k): k is string => !!k));
  const fonesProjeto = new Set(existentes.map((e) => chaveFone(e.phone)).filter((k): k is string => !!k));
  const vistos = new Set<string>();
  const out: Dedupe = { aceitos: [], repetidosNoLote: 0, jaNoProjeto: 0, telefoneRepetido: 0 };
  for (const lead of lote) {
    const k = chaveCnpj(lead.cnpj ?? lead.cnpjRaw);
    if (!k || vistos.has(k)) { out.repetidosNoLote += 1; continue; }
    vistos.add(k);
    if (cnpjsProjeto.has(k)) { out.jaNoProjeto += 1; continue; }
    const f = chaveFone(lead.phoneRaw);
    if (f && fonesProjeto.has(f)) { out.telefoneRepetido += 1; continue; }
    if (f) fonesProjeto.add(f); // dois leads do lote com o mesmo telefone: fica o primeiro
    out.aceitos.push(lead);
  }
  return out;
}

// Projeção de um Lead real para o card do funil. Todo lead entra na Triagem (F1,
// etapa 0) — a validação na Receita que o importador fez É o F1.
export function toWf(lead: Lead): WfLead {
  return {
    id: lead.id,
    score: lead.score ?? 0,
    empresa: lead.razaoSocial ?? lead.nomeFantasia ?? lead.companyNameRaw,
    cnpj: formatCnpj(lead.cnpj ?? lead.cnpjRaw),
    uf: lead.uf ?? '',
    segmento: lead.segmento ?? null,
    etapa: 0,
  };
}
