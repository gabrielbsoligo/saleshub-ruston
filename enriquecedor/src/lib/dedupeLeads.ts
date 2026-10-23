// Deduplicação de leads que ENTRAM num projeto (lista inicial, lista nova ou
// cadastro manual) contra os que o projeto já tem, e mesclagem de três vias do
// projeto entre abas. Módulo puro (sem Supabase), coberto por testes.
//
// Regras de dedupe, nesta ordem:
//   1. CNPJ repetido dentro do próprio lote: fica a primeira ocorrência (o upsert
//      em lote do Postgres derruba o lote com "cannot affect row a second time").
//   2. CNPJ que já está no projeto (mesmo descartado): não entra de novo.
//   3. Só com `porTelefone` (adição a projeto aberto): telefone válido igual ao de
//      um lead do projeto, ou de outro lead do lote, não entra — é a mesma empresa
//      com outro CNPJ (filial/MEI do sócio) ou lista repetida. A importação INICIAL
//      não usa esta regra (duas empresas podem dividir uma central).
import type { Lead } from '../types';
import type { AuditStatus, WfLead } from './projectsStore';
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

export const chaveCnpj = (v: string | null | undefined) => normalizeCnpjDigits(v) || null;
export const chaveFone = (v: string | null | undefined) => checkPhone(v).normalized;

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

// ── Mesclagem de três vias do projeto (esta aba × banco × base) ──────────────
// `base` é o último estado que ESTA aba leu ou gravou. Para cada lead presente
// nos dois lados: se só o banco mudou desde a base, vale o banco (outra aba
// avançou/descartou); se só esta aba mudou, vale esta aba; se os dois mudaram,
// vale o mais adiantado (descartado > maior etapa > banco). Leads que só existem
// de um lado entram sempre (o banco pode ter leads que outra aba acrescentou).
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const maisAdiantado = (a: WfLead, b: WfLead): WfLead => {
  if (!!a.descartado !== !!b.descartado) return a.descartado ? a : b;
  if (a.etapa !== b.etapa) return a.etapa > b.etapa ? a : b;
  return b; // empate: o do banco (confirmado)
};
// Status: 'ok'/'erro' (terminou) vence 'run'/'fila' (em andamento).
const FINAL = new Set<AuditStatus>(['ok', 'erro']);
const statusMaisAdiantado = (local: AuditStatus | undefined, remoto: AuditStatus | undefined) =>
  FINAL.has(remoto as AuditStatus) || !local ? remoto : FINAL.has(local) ? local : remoto;

export interface EstadoProjeto {
  leads: WfLead[];
  leadStatus: Record<string, AuditStatus>;
}

export function mesclarProjeto(local: EstadoProjeto, remoto: EstadoProjeto, base: EstadoProjeto, novos: WfLead[]): EstadoProjeto {
  const porIdBase = new Map(base.leads.map((l) => [l.id, l]));
  const porIdRemoto = new Map(remoto.leads.map((l) => [l.id, l]));
  const porId = new Map<string, WfLead>();
  for (const l of local.leads) {
    const r = porIdRemoto.get(l.id);
    if (!r) { porId.set(l.id, l); continue; }
    const b = porIdBase.get(l.id);
    const localMudou = !igual(l, b);
    const remotoMudou = !igual(r, b);
    porId.set(l.id, !remotoMudou ? l : !localMudou ? r : maisAdiantado(l, r));
  }
  for (const r of remoto.leads) if (!porId.has(r.id)) porId.set(r.id, r);
  for (const n of novos) if (!porId.has(n.id)) porId.set(n.id, n);

  const leadStatus: Record<string, AuditStatus> = {};
  for (const k of new Set([...Object.keys(remoto.leadStatus), ...Object.keys(local.leadStatus)])) {
    const l = local.leadStatus[k], r = remoto.leadStatus[k], b = base.leadStatus[k];
    const localMudou = l !== b, remotoMudou = r !== b;
    const v = !remotoMudou ? l : !localMudou ? r : statusMaisAdiantado(l, r);
    if (v) leadStatus[k] = v;
  }
  return { leads: [...porId.values()], leadStatus };
}
