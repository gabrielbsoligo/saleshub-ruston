// =============================================
// Types - Sistema de Gestão Comercial Ruston
// =============================================

export type TeamRole = 'sdr' | 'closer' | 'gestor';

export type LeadStatus =
  | 'sem_contato'
  | 'em_follow'
  | 'reuniao_marcada'
  | 'reuniao_realizada'
  | 'noshow'
  | 'perdido'
  | 'estorno'
  | 'aguardando_feedback'
  | 'convertido';

export type DealStatus =
  | 'dar_feedback'
  | 'negociacao'
  | 'contrato_na_rua'
  | 'contrato_assinado'
  | 'follow_longo'
  | 'perdido';

export type LeadCanal =
  | 'blackbox'
  | 'leadbroker'
  | 'outbound'
  | 'recomendacao'
  | 'indicacao';

export type LeadFonte = 'GOOGLE' | 'FACEBOOK' | 'ORGANICO' | 'OUTRO';

export type Temperatura = 'quente' | 'morno' | 'frio';

export type CloserCanal =
  | 'inbound'
  | 'outbound'
  | 'indicacao'
  | 'recomendacao'
  | 'outros';

// Produtos MRR (recorrentes)
export const PRODUTOS_MRR = [
  'Gestor de Tráfego',
  'Designer',
  'Social Media',
  'IA',
  'Landing Page Recorrente',
  'CRM',
  'Email Mkt',
] as const;

// Produtos OT (one-time / pontuais)
export const PRODUTOS_OT = [
  'Estruturação Estratégica',
  'Site',
  'MIV',
  'DRX',
  'LP One Time',
  'Implementação CRM',
  'Implementação IA',
] as const;

export const ALL_PRODUTOS = [...PRODUTOS_MRR, ...PRODUTOS_OT] as const;
export type Produto = (typeof ALL_PRODUTOS)[number];

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  active: boolean;
  avatar_url?: string;
  auth_user_id?: string;
  created_at: string;
}

export interface Lead {
  id: string;
  empresa: string;
  nome_contato?: string;
  telefone?: string;
  cnpj?: string;
  faturamento?: string;
  canal: LeadCanal;
  fonte?: LeadFonte;
  produto?: string;
  sdr_id?: string;
  sdr?: TeamMember;
  kommo_id?: string;
  kommo_link?: string;
  status: LeadStatus;
  data_cadastro?: string;
  mes_referencia?: string;
  valor_lead?: number;
  created_at: string;
  updated_at: string;
}

export type DealTier = 'tiny' | 'small' | 'medium' | 'large' | 'enterprise';

export const TIER_LABELS: Record<DealTier, string> = {
  tiny: 'Tiny (51k - 100k)',
  small: 'Small (101k - 400k)',
  medium: 'Medium (401k - 4MM)',
  large: 'Large (4MM - 40MM)',
  enterprise: 'Enterprise (40MM+)',
};

export interface Deal {
  id: string;
  lead_id?: string;
  lead?: Lead;
  empresa: string;
  kommo_id?: string;
  kommo_link?: string;
  closer_id?: string;
  closer?: TeamMember;
  sdr_id?: string;
  sdr?: TeamMember;
  data_call?: string;
  data_fechamento?: string;
  data_primeiro_pagamento?: string;
  data_retorno?: string;
  valor_mrr: number;
  valor_ot: number;
  status: DealStatus;
  produto?: string;
  origem?: string;
  temperatura?: Temperatura;
  bant?: number;
  motivo_perda?: string;
  curva_dias?: number;

  // Multi-produto
  produtos_ot: string[];
  produtos_mrr: string[];
  valor_escopo: number;
  valor_recorrente: number;
  data_inicio_escopo?: string;
  data_pgto_escopo?: string;
  data_inicio_recorrente?: string;
  data_pgto_recorrente?: string;

  // Campos de ganho
  link_call_vendas?: string;
  link_transcricao?: string;
  contrato_url?: string;
  contrato_filename?: string;
  tier?: DealTier;
  observacoes?: string;

  created_at: string;
  updated_at: string;
}

export interface Reuniao {
  id: string;
  lead_id?: string;
  deal_id?: string;
  sdr_id?: string;
  sdr?: TeamMember;
  closer_id?: string;
  closer?: TeamMember;
  closer_confirmado_id?: string;
  empresa?: string;
  nome_contato?: string;
  canal?: string;
  kommo_id?: string;
  data_agendamento?: string;
  data_reuniao?: string;
  realizada: boolean;
  show?: boolean;
  notas?: string;
  created_at: string;
}

export interface Meta {
  id: string;
  member_id: string;
  member?: TeamMember;
  mes: string;
  meta_mrr: number;
  meta_ot: number;
  meta_reunioes: number;
  meta_leads: number;
  meta_projetos: number;
  created_at: string;
}

export interface ComissaoConfig {
  id: string;
  role: TeamRole;
  tipo_origem: 'inbound' | 'outbound';
  tipo_valor: 'mrr' | 'ot';
  percentual: number;
  active: boolean;
}

export interface PerformanceSdr {
  id: string;
  member_id: string;
  member?: TeamMember;
  data: string;
  ligacoes: number;
  ligacoes_atendidas: number;
  conversas_whatsapp: number;
  reunioes_agendadas: number;
  reunioes_realizadas: number;
  no_shows: number;
  indicacoes_coletadas: number;
  created_at: string;
}

export interface PerformanceCloser {
  id: string;
  member_id: string;
  member?: TeamMember;
  mes: string;
  canal: CloserCanal;
  shows: number;
  no_shows: number;
  vendas: number;
  created_at: string;
}

export interface CustoComercial {
  id: string;
  descricao: string;
  mes: string;
  valor: number;
  categoria?: string;
  created_at: string;
}

// Labels para exibição na UI
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  sem_contato: 'Sem Contato',
  em_follow: 'Em Follow',
  reuniao_marcada: 'Reunião Marcada',
  reuniao_realizada: 'Reunião Realizada',
  aguardando_feedback: 'Aguardando Feedback',
  noshow: 'No Show',
  perdido: 'Perdido',
  estorno: 'Estorno',
  convertido: 'Convertido',
};

export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  dar_feedback: '🔔 Dar Feedback',
  negociacao: 'Negociação',
  contrato_na_rua: 'Contrato na Rua',
  contrato_assinado: 'Contrato Assinado',
  follow_longo: 'Follow Longo',
  perdido: 'Perdido',
};

export const CANAL_LABELS: Record<LeadCanal, string> = {
  blackbox: 'BlackBox',
  leadbroker: 'LeadBroker',
  outbound: 'Outbound',
  recomendacao: 'Recomendação',
  indicacao: 'Indicação',
};

export const ROLE_LABELS: Record<TeamRole, string> = {
  sdr: 'SDR',
  closer: 'Closer',
  gestor: 'Gestor',
};

export const TEMPERATURA_LABELS: Record<Temperatura, string> = {
  quente: 'Quente',
  morno: 'Morno',
  frio: 'Frio',
};
