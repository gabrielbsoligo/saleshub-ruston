// Store de PROJETOS (modo local/localStorage) — cada projeto tem sua lista de leads
// e roda o funil de workflow por dentro. Fictício por enquanto (valida a UX).
import { useSyncExternalStore } from 'react';

export type AuditStatus = 'ok' | 'run' | 'erro';

export interface WfLead {
  id: string;
  score: number;
  empresa: string;
  cnpj: string;
  uf: string;
  etapa: number;
  descartado?: boolean;
  parcial?: boolean; // enviado ao arquiteto antes de completar o funil
  auditadoAte?: number; // maior fase REALMENTE auditada (≠ etapa quando pulou pro arquiteto)
}

export interface Projeto {
  id: string;
  nome: string;
  criadoEm: number;
  importada: boolean;
  leads: WfLead[];
  leadStatus: Record<string, AuditStatus>;
  doneF: number[];
}

export const ARQ = 6; // índice do F7 (Pronto p/ arquiteto)

const KEY = 'sdna_projects';
let cache: Projeto[] | null = null;
const listeners = new Set<() => void>();

function read(): Projeto[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    cache = [];
  }
  return cache as Projeto[];
}
function write(next: Projeto[]) {
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const uid = () => Math.random().toString(36).slice(2, 9);

export const SEGMENTO = 'Incorporação de empreendimentos imobiliários';

export function useProjetos(): Projeto[] {
  return useSyncExternalStore(subscribe, read, () => [] as Projeto[]);
}

export function criarProjeto(nome: string): Projeto {
  const p: Projeto = { id: uid(), nome: nome.trim(), criadoEm: Date.now(), importada: false, leads: [], leadStatus: {}, doneF: [] };
  write([...read(), p]);
  return p;
}
// Finaliza a importação REAL: recebe a projeção (WfLead) dos leads já validados e
// enriquecidos (ids reais do leadsRepo) e marca o projeto como importado.
export function finalizarImportacao(id: string, leads: WfLead[], leadStatus: Record<string, AuditStatus> = {}) {
  write(read().map((p) => (p.id === id ? { ...p, importada: true, leads, leadStatus, doneF: [] } : p)));
}
export function atualizarProjeto(id: string, patch: Partial<Projeto>) {
  write(read().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}
export function excluirProjeto(id: string) {
  write(read().filter((p) => p.id !== id));
}
