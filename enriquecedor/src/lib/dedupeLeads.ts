// Deduplicação de leads que ENTRAM num projeto (lista inicial, lista nova ou
// cadastro manual) contra os que o projeto já tem. Módulo puro (sem Supabase).
//
// Regras, nesta ordem:
//   1. CNPJ repetido dentro do próprio lote: fica a primeira ocorrência (o upsert
//      em lote do Postgres derruba o lote com "cannot affect row a second time").
//   2. CNPJ que já está no projeto (mesmo descartado): não entra de novo.
//   3. Só com `porTelefone` (adição a projeto aberto): telefone válido igual ao de
//      um lead do projeto, ou de outro lead do lote, não entra — é a mesma empresa
//      com outro CNPJ (filial/MEI do sócio) ou lista repetida. A importação INICIAL
//      não usa esta regra (duas empresas podem dividir uma central).
import type { Lead } from '../types';
import type { WfLead } from './projectsStore';
import { checkPhone, formatCnpj, normalizeCnpjDigits } from './validation';

export interface LeadExistente {
  cnpj: string | null | undefined;
  phone: string | null | undefined;
}

export interface Dedupe {
  aceitos: Lead[];
  repetidosNoLote: number; // CNPJ repetido na própria lista
  jaNoProjeto: number; // CNPJ que o projeto já tem
  telefoneNoProjeto: number; // telefone de um lead que já está no projeto
  telefoneNoLote: number; // telefone repetido dentro da própria lista
}

const chaveCnpj = (v: string | null | undefined) => normalizeCnpjDigits(v) || null;
const chaveFone = (v: string | null | undefined) => checkPhone(v).normalized;

export function deduplicar(lote: Lead[], existentes: LeadExistente[], opts: { porTelefone?: boolean } = {}): Dedupe {
  const cnpjsProjeto = new Set(existentes.map((e) => chaveCnpj(e.cnpj)).filter((k): k is string => !!k));
  const fonesProjeto = new Set(existentes.map((e) => chaveFone(e.phone)).filter((k): k is string => !!k));
  const fonesLote = new Set<string>();
  const vistos = new Set<string>();
  const out: Dedupe = { aceitos: [], repetidosNoLote: 0, jaNoProjeto: 0, telefoneNoProjeto: 0, telefoneNoLote: 0 };
  for (const lead of lote) {
    const k = chaveCnpj(lead.cnpj ?? lead.cnpjRaw);
    if (!k || vistos.has(k)) { out.repetidosNoLote += 1; continue; }
    vistos.add(k);
    if (cnpjsProjeto.has(k)) { out.jaNoProjeto += 1; continue; }
    if (opts.porTelefone) {
      const f = chaveFone(lead.phoneRaw);
      if (f && fonesProjeto.has(f)) { out.telefoneNoProjeto += 1; continue; }
      if (f && fonesLote.has(f)) { out.telefoneNoLote += 1; continue; }
      if (f) fonesLote.add(f);
    }
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

// Junta a lista de leads do projeto vinda do BANCO (pode ter leads que outra aba
// acrescentou) com a desta aba (etapas mais recentes) e os novos. Ordem: os desta
// aba, depois os que só existem no banco, depois os novos. Nunca perde ninguém.
export function mesclarLeads(locais: WfLead[], remotos: WfLead[], novos: WfLead[]): WfLead[] {
  const porId = new Map<string, WfLead>();
  for (const l of locais) porId.set(l.id, l);
  for (const l of remotos) if (!porId.has(l.id)) porId.set(l.id, l);
  for (const l of novos) if (!porId.has(l.id)) porId.set(l.id, l);
  return [...porId.values()];
}
