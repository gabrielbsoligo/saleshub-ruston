// Validação de campos obrigatórios para transições de deal

export interface GanhoValidationResult {
  valid: boolean;
  missing: string[];
}

// Validação para mover para "Contrato na Rua" - precisa de produtos + preços
export function validateContratoNaRua(form: {
  produtos_ot: string[];
  produtos_mrr: string[];
  valor_escopo: number;
  valor_recorrente: number;
}): GanhoValidationResult {
  const missing: string[] = [];

  if (form.produtos_ot.length === 0 && form.produtos_mrr.length === 0) {
    missing.push('Pelo menos um produto (OT ou MRR)');
  }
  if (form.produtos_ot.length > 0 && (!form.valor_escopo || form.valor_escopo <= 0)) {
    missing.push('Valor do Escopo Fechado');
  }
  if (form.produtos_mrr.length > 0 && (!form.valor_recorrente || form.valor_recorrente <= 0)) {
    missing.push('Valor Recorrente');
  }

  return { valid: missing.length === 0, missing };
}

export function validateGanho(form: {
  produtos_ot: string[];
  produtos_mrr: string[];
  valor_escopo: number;
  valor_recorrente: number;
  data_inicio_escopo: string;
  data_pgto_escopo: string;
  data_inicio_recorrente: string;
  data_pgto_recorrente: string;
  link_call_vendas: string;
  link_transcricao: string;
  contrato_url: string;
  tier: string;
  closer_id?: string;
  temperatura?: string;
  bant?: number;
  kommo_id?: string;
}): GanhoValidationResult {
  const missing: string[] = [];

  // Precisa ter pelo menos OT ou MRR
  if (form.produtos_ot.length === 0 && form.produtos_mrr.length === 0) {
    missing.push('Pelo menos um produto (OT ou MRR)');
  }

  // Se tem produtos OT, precisa de valor e datas
  if (form.produtos_ot.length > 0) {
    if (!form.valor_escopo || form.valor_escopo <= 0) missing.push('Valor do Escopo Fechado');
    if (!form.data_inicio_escopo) missing.push('Data Início Escopo');
    if (!form.data_pgto_escopo) missing.push('Data 1º Pgto Escopo');
  }

  // Se tem produtos MRR, precisa de valor e datas
  if (form.produtos_mrr.length > 0) {
    if (!form.valor_recorrente || form.valor_recorrente <= 0) missing.push('Valor Recorrente');
    if (!form.data_inicio_recorrente) missing.push('Data Início Recorrente');
    if (!form.data_pgto_recorrente) missing.push('Data 1º Pgto Recorrente');
  }

  // Campos sempre obrigatórios para ganho
  if (!form.tier) missing.push('Tier');
  if (!form.link_call_vendas) missing.push('Link Call de Vendas');
  if (!form.link_transcricao) missing.push('Link Transcrição');
  if (!form.contrato_url) missing.push('Contrato PDF');

  // Campos de qualificação
  if (!form.closer_id) missing.push('Closer responsável');
  if (!form.temperatura) missing.push('Temperatura');
  if (!form.bant || form.bant < 1) missing.push('BANT');

  // Kommo ID obrigatório — necessário pro webhook de integração n8n
  if (!form.kommo_id || !String(form.kommo_id).trim()) {
    missing.push('Kommo ID (link ou ID do Kommo)');
  }

  return { valid: missing.length === 0, missing };
}
