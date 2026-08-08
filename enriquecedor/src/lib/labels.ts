import type { DataQuality, LeadStatus } from '../types';

export const STATUS_LABELS: Record<LeadStatus, string> = {
  importado: 'Importado',
  validando: 'Validando',
  enriquecendo: 'Enriquecendo empresa',
  incompleto: 'Incompleto (reprocessar)',
  enriquecido: 'Enriquecido',
  descobrindo_decisor: 'Descobrindo decisor',
  cliente_oculto: 'Cliente oculto',
  briefing_gerado: 'Briefing gerado',
  pronto: 'Pronto p/ abordagem',
  em_abordagem: 'Em abordagem',
  respondido: 'Respondido',
  descartado: 'Descartado',
};

export const STATUS_COLORS: Record<LeadStatus, string> = {
  importado: 'bg-slate-100 text-slate-600',
  validando: 'bg-blue-100 text-blue-700',
  enriquecendo: 'bg-blue-100 text-blue-700',
  incompleto: 'bg-orange-100 text-orange-700',
  enriquecido: 'bg-teal-100 text-teal-700',
  descobrindo_decisor: 'bg-violet-100 text-violet-700',
  cliente_oculto: 'bg-amber-100 text-amber-700',
  briefing_gerado: 'bg-cyan-100 text-cyan-700',
  pronto: 'bg-emerald-100 text-emerald-700',
  em_abordagem: 'bg-indigo-100 text-indigo-700',
  respondido: 'bg-green-100 text-green-700',
  descartado: 'bg-rose-100 text-rose-600',
};

export const QUALITY_LABELS: Record<DataQuality, string> = {
  valido: 'Válido',
  corrigido: 'Corrigido',
  atencao: 'Atenção',
  suspeito: 'Suspeito',
  invalido: 'Inválido',
};

export const QUALITY_COLORS: Record<DataQuality, string> = {
  valido: 'bg-emerald-100 text-emerald-700',
  corrigido: 'bg-sky-100 text-sky-700',
  atencao: 'bg-amber-100 text-amber-700',
  suspeito: 'bg-orange-100 text-orange-700',
  invalido: 'bg-rose-100 text-rose-600',
};
