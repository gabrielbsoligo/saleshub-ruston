export type StatusComissao = 'aguardando_pgto' | 'liberada' | 'paga';

export const STATUS_LABELS: Record<StatusComissao, string> = {
  aguardando_pgto: 'Aguardando Pgto',
  liberada: 'Liberada',
  paga: 'Paga',
};

export const STATUS_COLORS: Record<StatusComissao, string> = {
  aguardando_pgto: 'bg-yellow-500/20 text-yellow-400',
  liberada: 'bg-blue-500/20 text-blue-400',
  paga: 'bg-green-500/20 text-green-400',
};

export const CATEGORIA_LABELS: Record<string, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound',
  upsell_mrr: 'Upsell',
  upsell_ot: 'Upsell',
  ee_assessoria: 'EE Assess.',
  ee_ot: 'EE OT',
};

export interface ComissaoRegistro {
  id: string;
  deal_id?: string;
  member_id?: string;
  member_name: string;
  role_comissao: string;
  tipo: 'mrr' | 'ot' | 'variavel';
  categoria: string;
  valor_base: number;
  percentual: number;
  valor_comissao: number;
  data_pgto?: string;
  data_liberacao?: string;
  empresa: string;
  origem?: string;
  observacao?: string;
  editado_manualmente: boolean;
  status_comissao: StatusComissao;
  data_pgto_real?: string;
  valor_recebido?: number;
  data_pgto_vendedor?: string;
  confirmado_por?: string;
  // v2
  recebimento_id?: string;
  numero_parcela?: number;
}
