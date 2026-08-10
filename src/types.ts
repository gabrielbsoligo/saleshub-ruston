// =============================================
// Types - Sistema de Gestão Comercial Ruston
// =============================================

export type TeamRole = 'sdr' | 'closer' | 'gestor' | 'financeiro';

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

// Etapas canônicas = as MESMAS do funil Closer no Kommo (pipeline 11010459).
// A ordem aqui é a ordem do funil. `negociacao` e `follow_longo` foram extintos:
// viraram os baldes de prioridade, decididos pela TEMPERATURA (ver statusFromTemperatura).
export type DealStatus =
  | 'incoming_leads'
  | 'dar_feedback'            // Feedback reunião
  | 'marcar_call_proposta'
  | 'call_proposta_agendada'  // Call de proposta marcada (retorno agendado)
  | 'baixa_prioridade'
  | 'media_prioridade'
  | 'alta_prioridade'
  | 'contrato_na_rua'         // Contrato
  | 'contrato_assinado'       // Assinou (aquisição) — ainda NÃO pagou
  | 'ganho'                   // Won/ATIVADO — pagou entrada ou tudo (indicador principal)
  | 'perdido';                // Lost

export const DEAL_STATUS_ORDER: DealStatus[] = [
  'incoming_leads', 'dar_feedback', 'marcar_call_proposta', 'call_proposta_agendada',
  'baixa_prioridade', 'media_prioridade', 'alta_prioridade',
  'contrato_na_rua', 'contrato_assinado', 'ganho', 'perdido',
];

/**
 * FONTE ÚNICA de ordem/rótulo/cor/sigla das etapas — espelha kommo.funil_etapas.
 * Antes isso vivia duplicado em 5 lugares (PipelineView, PipelineTableColumns,
 * ResumoDoDia, PerfCloserView, types) e saía de sincronia. Mexer só aqui.
 */
export interface DealStageMeta {
  slug: DealStatus; rotulo: string; curto: string; abrev: string;
  borda: string; badge: string;
  /** aparece como coluna do kanban (Incoming leads vive só no Kommo) */
  kanban: boolean;
  /** etapa ativa = ainda em jogo (nem ganho nem perdido) */
  ativa: boolean;
}

export const DEAL_STAGES: DealStageMeta[] = [
  { slug: 'incoming_leads',       rotulo: 'Incoming leads',            curto: 'Incoming',    abrev: 'IN',  borda: 'border-slate-500',  badge: 'bg-slate-500/20 text-slate-300',  kanban: false, ativa: true },
  { slug: 'dar_feedback',         rotulo: '🔔 Feedback reunião',       curto: 'Feedback',    abrev: 'FB',  borda: 'border-amber-400',  badge: 'bg-amber-500/20 text-amber-400',  kanban: true,  ativa: true },
  { slug: 'marcar_call_proposta', rotulo: 'Marcar call proposta',      curto: 'Call prop.',  abrev: 'CP',  borda: 'border-cyan-500',   badge: 'bg-cyan-500/20 text-cyan-400',    kanban: true,  ativa: true },
  { slug: 'call_proposta_agendada', rotulo: 'Call proposta agendada',  curto: 'Prop. agend.',abrev: 'CPA', borda: 'border-teal-400',   badge: 'bg-teal-400/20 text-teal-300',    kanban: true,  ativa: true },
  // ordem dos baldes = a mesma do Kommo (Baixa sort 40 · Média 50 · Alta 60)
  { slug: 'baixa_prioridade',     rotulo: 'Baixa prioridade (+30d)',   curto: 'Baixa',       abrev: 'BAI', borda: 'border-orange-500', badge: 'bg-orange-500/20 text-orange-400',kanban: true,  ativa: true },
  { slug: 'media_prioridade',     rotulo: 'Média prioridade (11-30d)', curto: 'Média',       abrev: 'MED', borda: 'border-blue-500',   badge: 'bg-blue-500/20 text-blue-400',    kanban: true,  ativa: true },
  { slug: 'alta_prioridade',      rotulo: 'Alta prioridade (1-10d)',   curto: 'Alta',        abrev: 'ALT', borda: 'border-red-400',    badge: 'bg-red-400/20 text-red-300',      kanban: true,  ativa: true },
  { slug: 'contrato_na_rua',      rotulo: 'Contrato',                  curto: 'Contrato',    abrev: 'CTR', borda: 'border-yellow-500', badge: 'bg-yellow-500/20 text-yellow-400',kanban: true,  ativa: true },
  { slug: 'contrato_assinado',    rotulo: '✍️ Contrato assinado',      curto: 'Assinado',    abrev: 'ASS', borda: 'border-lime-400',   badge: 'bg-lime-400/20 text-lime-300',    kanban: true,  ativa: false },
  { slug: 'ganho',                rotulo: '🏆 Ganho (ativado)',        curto: 'Ganho',       abrev: 'WON', borda: 'border-green-500',  badge: 'bg-green-500/20 text-green-400',  kanban: true,  ativa: false },
  { slug: 'perdido',              rotulo: 'Venda perdida',             curto: 'Perdida',     abrev: 'LOST',borda: 'border-red-500',    badge: 'bg-red-500/20 text-red-400',      kanban: true,  ativa: false },
];

/** Deal FECHADO (assinou o contrato): assinado OU já ativado. Use para "vendido/assinados". */
export const isDealFechado = (s?: string | null): boolean => s === 'contrato_assinado' || s === 'ganho';
/** Deal ATIVADO (pagou entrada ou tudo) — o INDICADOR PRINCIPAL da meta. */
export const isDealAtivado = (s?: string | null): boolean => s === 'ganho';

export const DEAL_STAGE_BY_SLUG: Record<string, DealStageMeta> =
  Object.fromEntries(DEAL_STAGES.map(s => [s.slug, s]));
/** etapas ATIVAS (pipe em jogo) — usar em vez de listas hardcoded */
export const DEAL_STATUS_ATIVOS: DealStatus[] = DEAL_STAGES.filter(s => s.ativa).map(s => s.slug);

/** Balde de prioridade que a temperatura determina (regra do espelhamento). */
export function statusFromTemperatura(t?: string | null): DealStatus | null {
  const v = (t || '').toLowerCase();
  return v === 'quente' ? 'alta_prioridade'
       : v === 'morno'  ? 'media_prioridade'
       : v === 'frio'   ? 'baixa_prioridade' : null;
}

/**
 * Aceita valores LEGADOS (negociacao/follow_longo) que ainda possam vir de análise antiga
 * em cache ou de payload velho, e converte para as etapas canônicas.
 * `negociacao` = deal ativo -> o balde vem da temperatura.
 */
export function normalizeDealStatus(v?: string | null, temperatura?: string | null): DealStatus | null {
  if (!v) return null;
  if (v === 'negociacao') return statusFromTemperatura(temperatura) ?? 'dar_feedback';
  if (v === 'follow_longo') return 'baixa_prioridade';
  return (DEAL_STATUS_ORDER as string[]).includes(v) ? (v as DealStatus) : null;
}

export type LeadCanal =
  | 'blackbox'
  | 'leadbroker'
  | 'outbound'
  | 'recomendacao'
  | 'indicacao'
  | 'recovery'
  | 'reativacao';

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
  'ISAAS',
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
  kommo_user_id?: number;
  ramal_4com?: string;
  /** id do AGENTE no 3C Plus (chega no webhook em callHistory.agent.id — ex.: 234399) */
  agente_3c_id?: string | null;
  google_calendar_connected?: boolean;
  meta_ligacoes_diaria?: number;
  cor_grafico?: string | null;
  created_at: string;
}

export interface Ligacao4com {
  id: string;
  call_id: string;
  direction: string;
  caller: string;
  called: string;
  started_at: string;
  ended_at: string;
  duration: number;
  hangup_cause: string;
  record_url?: string;
  member_id?: string;
  atendida: boolean;
  created_at: string;
}

export interface Lead {
  id: string;
  empresa: string;
  nome_contato?: string;
  telefone?: string;
  email?: string;
  cnpj?: string;
  faturamento?: string;
  canal: LeadCanal;
  fonte?: LeadFonte;
  produto?: string;
  sdr_id?: string;
  sdr?: TeamMember;
  kommo_id?: string;
  kommo_link?: string;
  kommo_pipeline_id?: number | null;
  kommo_status_id?: number | null;
  kommo_tags?: string[] | null;
  mktlab_link?: string;
  mktlab_id?: string;
  status: LeadStatus;
  data_cadastro?: string;
  mes_referencia?: string;
  valor_lead?: number;
  // Contexto de recomendacao (preenchido quando canal='recomendacao',
  // repassado pro Kommo pelos campos "Quem Recomendou" + "Closer que coletou")
  recomendado_por?: string;
  coletado_por_closer_nome?: string;
  // Segmento da lista (disparos) — repassado pro Kommo no campo "Segmento Disparos" (1041897)
  segmento_disparos?: string;
  // Marca o lead p/ enriquecimento Lemit (sócios -> contatos no Kommo) — assíncrono
  enriquecer_lemit?: boolean;
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
  reuniao_id?: string; // FK pra reuniao que originou este deal (fonte-da-verdade p/ closer/sdr)
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

  // Fechamento (ativação)
  valor_pago_ato?: number;          // quanto o cliente já pagou no ato do fechamento
  comprovante_url?: string;         // comprovante de pagamento (imagem, opcional)
  comprovante_filename?: string;
  rokko_enviado_em?: string;        // disparo manual pro Rokko (botão no Fechamento)

  created_at: string;
  updated_at: string;
}

export type TipoReuniao = 'primeira_call' | 'retorno';

export interface Reuniao {
  id: string;
  lead_id?: string;
  deal_id?: string;
  sdr_id?: string;
  sdr?: TeamMember;
  closer_id?: string;
  closer?: TeamMember;
  closer_confirmado_id?: string;
  sdr_confirmado_id?: string;
  empresa?: string;
  nome_contato?: string;
  canal?: string;
  kommo_id?: string;
  tipo: TipoReuniao;
  data_agendamento?: string;
  data_reuniao?: string;
  realizada: boolean;
  show?: boolean;
  notas?: string;
  calendar_event_id?: string | null;
  calendar_owner_id?: string | null;   // agenda Google que hospeda o evento (migration_083)
  meet_link?: string | null;
  participantes_extras?: string[];
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
  // Metas de atividade — base DIÁRIA (migration_080). Semanal=×5, mensal=×dias úteis.
  meta_ligacoes_dia?: number;
  meta_conexoes_dia?: number;
  meta_agendados_dia?: number;
  meta_realizados_dia?: number;
  meta_fechados_dia?: number;
  created_at: string;
}

// Roleta de reuniões (rodízio de closers)
export interface RoletaCloser {
  member_id: string;
  ativo: boolean;
  ordem: number;
  base_count: number;
  updated_at: string;
}

// Linha retornada por get_roleta_status() — 1ª linha = próximo
export interface RoletaStatusRow {
  member_id: string;
  name: string;
  ordem: number;
  base_count: number;
  recebidas: number;
  total: number;
  ativo?: boolean;   // roleta SDR: membro disponível on/off (get_roleta_status_sdr)
}

// Roleta SDR — visão granular (read-only via RPC)
export type RoletaOrigem = 'roleta' | 'manual' | 'pre_roleta';

export type RoletaSinal = 'log' | 'reuniao' | 'kommo_atual' | 'sem_sdr';

// balanço lead-level (get_roleta_sdr_balanco): 1 linha por lead. member_id = SDR-que-passou
// (log > reunião > responsável-atual-se-SDR); null = SEM SDR. Contador = tamanho da lista.
export interface RoletaSdrBalancoLead {
  member_id: string | null;
  member_name: string | null;
  lead_id: string | null;
  empresa: string | null;
  nome_contato: string | null;
  kommo_id: string | null;
  canal: string | null;
  created_at: string;
  origem: RoletaOrigem;
  sinal: RoletaSinal;      // qual sinal resolveu o SDR
  no_closer: boolean;      // dono atual no Kommo é closer (conta pro SDR mesmo assim)
}

export interface RoletaSdrCiclo {
  mes: string;          // date (primeiro dia do mês)
  total: number;
  total_roleta: number;
  total_manual: number;
  total_pre: number;
  primeira: string;
  ultima: string;
  is_atual: boolean;
}

export interface CompromissoDia {
  id: string;
  member_id: string;
  data: string; // YYYY-MM-DD
  declarado_em: string;
  meta_ligacoes: number;
  meta_reunioes_marcadas: number;
  meta_reunioes_realizadas: number;
  meta_contratos_rua: number;
  meta_contratos_fechados: number;
  observacao?: string;
  fechado_em?: string;
}

export interface EntregaDia {
  ligacoes: number;
  reunioes_marcadas: number;
  reunioes_realizadas: number;
  contratos_rua: number;
  contratos_fechados: number;
}

export type ComissaoRole = 'closer' | 'sdr' | 'account' | 'designer' | 'gt' | 'levantou' | 'fechou' | 'indicador';
export type ComissaoCategoria = 'inbound' | 'outbound' | 'upsell' | 'ee_assessoria' | 'ee_ot' | 'indicacao' | 'recomendacao' | 'variavel';
export type ComissaoTipoValor = 'mrr' | 'ot' | 'variavel';

export interface ComissaoConfig {
  id: string;
  role: ComissaoRole;
  categoria: ComissaoCategoria;
  tipo_valor: ComissaoTipoValor;
  percentual: number;
  active: boolean;
}

export type RecebimentoStatus = 'aguardando' | 'pago' | 'cancelado';

export interface DealRecebimento {
  id: string;
  deal_id: string;
  tipo: 'mrr' | 'ot' | 'variavel';
  numero_parcela: number;
  data_prevista: string;
  data_pgto_real?: string | null;
  valor_contrato: number;
  valor_recebido?: number | null;
  status: RecebimentoStatus;
  confirmado_por?: string | null;
  observacao?: string | null;
  created_at: string;
  updated_at: string;
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

// =============================================
// AUDITORIA
// =============================================

export type AuditoriaCategoria =
  | 'campos_vazios'
  | 'falta_followup'
  | 'temperatura_desatualizada'
  | 'sem_proximos_passos'
  | 'pronto_pra_avancar'
  | 'dados_inconsistentes'
  | 'lead_perdido_nao_marcado'
  | 'valor_desatualizado'
  | 'bant_incompleto'
  | 'whatsapp_sem_resposta'
  | 'qualidade_conversa'
  | 'outro';

export const CATEGORIA_LABELS: Record<AuditoriaCategoria, string> = {
  campos_vazios: 'Campos vazios',
  falta_followup: 'Falta de follow-up',
  temperatura_desatualizada: 'Temperatura desatualizada',
  sem_proximos_passos: 'Sem próximos passos',
  pronto_pra_avancar: 'Pronto pra avançar',
  dados_inconsistentes: 'Dados inconsistentes',
  lead_perdido_nao_marcado: 'Lead perdido não marcado',
  valor_desatualizado: 'Valor desatualizado',
  bant_incompleto: 'BANT incompleto',
  whatsapp_sem_resposta: 'WhatsApp sem resposta',
  qualidade_conversa: 'Qualidade da conversa',
  outro: 'Outro',
};

export type AuditoriaSeveridade = 'alta' | 'media' | 'baixa';
export type AuditoriaItemTipo = 'lead' | 'deal';
export type AuditoriaSessaoOrigem = 'leads_view' | 'pipeline_view' | 'manual';
export type AuditoriaSessaoStatus = 'aberta' | 'concluida' | 'arquivada';
export type AuditoriaRegistroStatus = 'pendente' | 'auditado' | 'skipado';

export interface AuditoriaSessao {
  id: string;
  criado_por: string;
  nome: string;
  origem: AuditoriaSessaoOrigem;
  filtros_aplicados?: any;
  status: AuditoriaSessaoStatus;
  total_itens: number;
  total_auditados: number;
  total_skipados: number;
  created_at: string;
  completed_at?: string;
}

export interface AuditoriaRegistro {
  id: string;
  sessao_id: string;
  item_tipo: AuditoriaItemTipo;
  item_id: string;
  posicao: number;
  status: AuditoriaRegistroStatus;
  categoria?: AuditoriaCategoria;
  severidade?: AuditoriaSeveridade;
  observacao?: string;
  motivo_skip?: string;
  responsavel_id?: string;
  snapshot_saleshub?: any;
  kommo_snapshot_id?: string;
  mensagem_gerada?: string;
  resolvido_em?: string;
  criado_em: string;
  auditado_em?: string;
}

export interface AuditoriaKommoSnapshot {
  id: string;
  kommo_lead_id: number;
  kommo_account_subdomain?: string;
  capturado_por?: string;
  capturado_em: string;
  payload: any;
  bridge_version?: string;
  source: 'auto' | 'manual_command';
}

export interface BridgeToken {
  id: string;
  team_member_id: string;
  token: string;
  label?: string;
  created_at: string;
  last_used_at?: string;
  revoked_at?: string;
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

// Rótulos espelhando o funil Closer do Kommo (mesma nomenclatura que o Gabriel vê lá).
export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  incoming_leads: 'Incoming leads',
  dar_feedback: '🔔 Feedback reunião',
  marcar_call_proposta: 'Marcar call proposta',
  call_proposta_agendada: 'Call proposta agendada',
  baixa_prioridade: 'Baixa prioridade (+30d)',
  media_prioridade: 'Média prioridade (11-30d)',
  alta_prioridade: 'Alta prioridade (1-10d)',
  contrato_na_rua: 'Contrato',
  contrato_assinado: '✍️ Contrato assinado',
  ganho: '🏆 Ganho (ativado)',
  perdido: 'Venda perdida',
};

export const CANAL_LABELS: Record<LeadCanal, string> = {
  blackbox: 'BlackBox',
  leadbroker: 'LeadBroker',
  outbound: 'Outbound',
  recomendacao: 'Recomendação',
  indicacao: 'Indicação',
  recovery: 'Recovery',
  reativacao: 'Reativação',
};

export const ROLE_LABELS: Record<TeamRole, string> = {
  sdr: 'SDR',
  closer: 'Closer',
  gestor: 'Gestor',
  financeiro: 'Financeiro',
};

export const TEMPERATURA_LABELS: Record<Temperatura, string> = {
  quente: 'Quente',
  morno: 'Morno',
  frio: 'Frio',
};

// =============================================
// Post-Meeting Automation Types
// =============================================

export type AutomationStatus = 'pending' | 'fetching_transcript' | 'analyzing' | 'applying' | 'completed' | 'error';

export interface CallAnalysisResult {
  temperatura: Temperatura;
  // etapas canônicas; os legados ('negociacao'/'follow_longo') seguem aceitos na leitura
  // (análise antiga em cache) e são convertidos por normalizeDealStatus.
  proximo_passo: DealStatus | 'negociacao' | 'follow_longo';
  valor_escopo: number;
  valor_recorrente: number;
  produtos_ot: string[];
  produtos_mrr: string[];
  bant: number;
  tier: DealTier;
  resumo_executivo: string;
  indicacoes: Array<{ nome: string; empresa: string; telefone?: string }>;
  proxima_reuniao: { data: string; hora: string } | null;
  perfil_cadencia?: PerfilCadencia | null;
  plano_cadencia?: PlanoCadencia | null;
}

// Perfil do lead extraido da call para personalizar a cadencia do closer
export interface PerfilCadencia {
  nome?: string | null;
  segmento?: string | null;
  dores?: string[];
  deadline?: string | null;
  plano?: string | null;
  preco?: number | null;
  desconto?: string | null;
  metas?: string[];
  objecoes?: string[];
  decisor?: string | null;
}

// Plano personalizado de follow-up do closer (datas absolutas acordadas na call)
export interface PlanoCadencia {
  datas_acordadas?: string[];
  tarefas_especificas?: Array<{ quando: string; o_que: string }>;
}

// =============================================
// Prep Call (analise pre-reuniao via Claude Code Routine)
// =============================================

export type PrepBriefingStatus = 'pending' | 'processing' | 'completed' | 'error';

export type PrepBriefingProgressStage =
  | 'queued'
  | 'dispatched'
  | 'scraping'
  | 'calling_routine'
  | 'analyzing'
  | 'completed'
  | 'error';

export interface PrepBriefingInputs {
  site?: string;
  instagram?: string;
  segmento?: string;
  faturamento_atual?: string;
  meta_faturamento?: string;
  concorrentes_conhecidos?: string;
  contexto?: string;
  // V2: links opcionais pra analise profunda de midia paga
  meta_ads_library_url?: string;
  google_ads_transparency_url?: string;
}

export interface PrepBriefing {
  id: string;
  requested_by_id: string;
  requested_by?: TeamMember;
  lead_id?: string;
  lead?: Lead;
  empresa: string;
  inputs: PrepBriefingInputs;
  status: PrepBriefingStatus;
  progress_stage?: PrepBriefingProgressStage;
  failed_stage?: string;
  github_run_url?: string;
  scraped_data?: Record<string, any>;
  routine_session_id?: string;
  routine_session_url?: string;
  briefing_markdown?: string;
  briefing_json?: Record<string, any> | null;
  schema_version?: string | null;
  version?: number;
  error_message?: string;
  created_at: string;
  completed_at?: string;
}

export interface PrepBriefingVersion {
  id: string;
  briefing_id: string;
  version: number;
  briefing_markdown?: string;
  briefing_json?: Record<string, any> | null;
  schema_version?: string | null;
  scraped_data?: Record<string, any>;
  created_at: string;
}

export interface PrepBriefingView {
  id: string;
  briefing_id: string;
  session_token: string;
  ip_hash?: string;
  user_agent?: string;
  referrer?: string;
  viewed_at: string;
}

export interface PostMeetingAutomation {
  id: string;
  reuniao_id: string;
  deal_id?: string;
  status: AutomationStatus;
  transcript_text?: string;
  ai_result?: CallAnalysisResult;
  actions_taken?: Record<string, any>;
  leads_created?: string[];
  next_reuniao_id?: string;
  error_message?: string;
  created_at: string;
  completed_at?: string;
}
