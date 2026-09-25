// Store de PROJETOS (workflows) — cada projeto tem sua lista de leads e roda o
// funil por dentro. Persistido no banco (enriquecedor_projetos) e cacheado no
// localStorage; ver carregar()/persistir() abaixo.
import { useSyncExternalStore } from 'react';
import type { PerfilAuditoria } from '../types';
import { supabase, supabaseConfigured } from './supabase';

// Perfis de auditoria disponíveis na criação do projeto. O perfil define os
// prompts de IA (briefing/scripts) e as etapas específicas de segmento.
export const PERFIS: Record<PerfilAuditoria, { label: string; desc: string }> = {
  construtoras: {
    label: 'Construtoras & Incorporadoras',
    desc: 'Especializado em incorporação imobiliária: empreendimentos, lançamentos, LPs e discurso do setor.',
  },
  geral: {
    label: 'Versátil — qualquer empresa',
    desc: 'Auditoria e discursos genéricos: produtos/serviços e presença digital, sem etapas específicas de setor.',
  },
};

export type AuditStatus = 'ok' | 'run' | 'erro';

export interface WfLead {
  id: string;
  score: number;
  empresa: string;
  cnpj: string;
  uf: string;
  segmento?: string | null; // CNAE/segmento real do lead (Receita)
  etapa: number;
  descartado?: boolean;
  parcial?: boolean; // enviado ao arquiteto antes de completar o funil
  auditadoAte?: number; // maior fase REALMENTE auditada (≠ etapa quando pulou pro arquiteto)
}

export interface Projeto {
  id: string;
  nome: string;
  /** Perfil de auditoria — projetos antigos (sem o campo) são 'construtoras'. */
  perfil: PerfilAuditoria;
  criadoEm: number;
  importada: boolean;
  leads: WfLead[];
  leadStatus: Record<string, AuditStatus>;
  doneF: number[];
}

export const ARQ = 6; // índice do F7 (Pronto p/ arquiteto)

const KEY = 'sdna_projects';
const MIGRATED_KEY = 'sdna_projects_migrated_v1';
let cache: Projeto[] | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// Projetos vivem no BANCO (enriquecedor_projetos, migration_150) para o funil
// montado pelo gestor aparecer pro SDR em outro navegador. O localStorage vira
// só cache/offline. Leitura síncrona (useSyncExternalStore) sobre o cache; a
// carga do banco é assíncrona e notifica quando chega; gravação é write-through
// com debounce por projeto (o Workflow grava a cada mudança de etapa).
type Row = { id: string; nome: string; perfil: string; criado_em: number; importada: boolean; leads: WfLead[]; lead_status: Record<string, AuditStatus>; done_f: number[] };
const fromRow = (r: Row): Projeto => ({ id: r.id, nome: r.nome, perfil: (r.perfil as PerfilAuditoria) ?? 'construtoras', criadoEm: Number(r.criado_em), importada: !!r.importada, leads: r.leads ?? [], leadStatus: r.lead_status ?? {}, doneF: r.done_f ?? [] });
const toRow = (p: Projeto): Row => ({ id: p.id, nome: p.nome, perfil: p.perfil, criado_em: p.criadoEm, importada: p.importada, leads: p.leads, lead_status: p.leadStatus, done_f: p.doneF });

function readLocal(): Projeto[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as Projeto[];
    return raw.map((p) => ({ ...p, perfil: p.perfil ?? 'construtoras' }));
  } catch {
    return [];
  }
}
function read(): Projeto[] {
  if (cache) return cache;
  cache = readLocal();
  if (supabaseConfigured) void carregar();
  return cache;
}

let carregando: Promise<void> | null = null;
export function carregar(): Promise<void> {
  if (!supabaseConfigured) return Promise.resolve();
  if (carregando) return carregando;
  carregando = (async () => {
    try {
      const { data, error } = await supabase.from('enriquecedor_projetos').select('*').order('criado_em', { ascending: false });
      if (error) throw error;
      const doBanco = (data ?? []).map((r) => fromRow(r as Row));
      // Migração única: projetos que só existiam neste navegador sobem pro banco.
      if (!localStorage.getItem(MIGRATED_KEY)) {
        const ids = new Set(doBanco.map((p) => p.id));
        const locais = readLocal().filter((p) => !ids.has(p.id));
        if (locais.length) {
          const { error: e2 } = await supabase.from('enriquecedor_projetos').upsert(locais.map(toRow));
          if (!e2) doBanco.push(...locais);
        }
        localStorage.setItem(MIGRATED_KEY, '1');
      }
      cache = doBanco;
      localStorage.setItem(KEY, JSON.stringify(cache));
      notify();
    } catch (e) {
      console.warn('[projetos] falha ao carregar do banco — usando cache local', e);
    } finally {
      carregando = null;
    }
  })();
  return carregando;
}
// Atualiza quando a aba volta ao foco (o gestor mexeu no funil em outro lugar).
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => { if (cache) void carregar(); });
}

const pendentes = new Map<string, ReturnType<typeof setTimeout>>();
function persistir(p: Projeto) {
  if (!supabaseConfigured) return;
  const t = pendentes.get(p.id);
  if (t) clearTimeout(t);
  pendentes.set(p.id, setTimeout(() => {
    pendentes.delete(p.id);
    void supabase.from('enriquecedor_projetos').upsert({ ...toRow(p), updated_at: new Date().toISOString() }).then(({ error }) => {
      if (error) console.warn('[projetos] falha ao gravar', p.nome, error.message);
    });
  }, 600));
}
function write(next: Projeto[], mudou?: Projeto, removidoId?: string) {
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  if (mudou) persistir(mudou);
  if (removidoId && supabaseConfigured) void supabase.from('enriquecedor_projetos').delete().eq('id', removidoId);
  notify();
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

export function criarProjeto(nome: string, perfil: PerfilAuditoria = 'construtoras'): Projeto {
  const p: Projeto = { id: uid(), nome: nome.trim(), perfil, criadoEm: Date.now(), importada: false, leads: [], leadStatus: {}, doneF: [] };
  write([p, ...read()], p);
  return p;
}
// Finaliza a importação REAL: recebe a projeção (WfLead) dos leads já validados e
// enriquecidos (ids reais do leadsRepo) e marca o projeto como importado.
export function finalizarImportacao(id: string, leads: WfLead[], leadStatus: Record<string, AuditStatus> = {}) {
  let mudou: Projeto | undefined;
  write(read().map((p) => (p.id === id ? (mudou = { ...p, importada: true, leads, leadStatus, doneF: [] }) : p)), mudou);
}
export function atualizarProjeto(id: string, patch: Partial<Projeto>) {
  let mudou: Projeto | undefined;
  write(read().map((p) => (p.id === id ? (mudou = { ...p, ...patch }) : p)), mudou);
}
export function excluirProjeto(id: string) {
  write(read().filter((p) => p.id !== id), undefined, id);
}
