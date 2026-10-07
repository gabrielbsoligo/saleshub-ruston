// Motivos de perda ao descartar um lead do funil (lista fechada, aprovada em
// 07/10/2026). "outro" exige observação. Gravado em enriquecedor_leads.motivo_descarte.
export interface MotivoDescarte {
  id: string;
  label: string;
  grupo: 'Fora do perfil' | 'Cadastro' | 'Qualificação' | 'Relação comercial' | 'Outro';
}

export const MOTIVOS_DESCARTE: MotivoDescarte[] = [
  { id: 'segmento_fora_icp', label: 'Segmento fora do ICP', grupo: 'Fora do perfil' },
  { id: 'porte_fora', label: 'Porte fora do alvo', grupo: 'Fora do perfil' },
  { id: 'regiao_fora', label: 'Região fora de atuação', grupo: 'Fora do perfil' },
  { id: 'inativa', label: 'Empresa inativa / baixada', grupo: 'Cadastro' },
  { id: 'duplicado', label: 'Duplicado / mesmo grupo econômico', grupo: 'Cadastro' },
  { id: 'dados_invalidos', label: 'Dados inválidos', grupo: 'Cadastro' },
  { id: 'sem_decisor', label: 'Sem decisor identificado', grupo: 'Qualificação' },
  { id: 'sem_contato', label: 'Sem contato utilizável', grupo: 'Qualificação' },
  { id: 'sem_presenca_digital', label: 'Sem presença digital para auditar', grupo: 'Qualificação' },
  { id: 'ja_cliente', label: 'Já é cliente / em negociação', grupo: 'Relação comercial' },
  { id: 'concorrente', label: 'Concorrente / agência', grupo: 'Relação comercial' },
  { id: 'optout', label: 'Pediu para não ser contatado', grupo: 'Relação comercial' },
  { id: 'outro', label: 'Outro (descreva)', grupo: 'Outro' },
];

export const GRUPOS_DESCARTE = ['Fora do perfil', 'Cadastro', 'Qualificação', 'Relação comercial', 'Outro'] as const;

export function motivoLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return MOTIVOS_DESCARTE.find((m) => m.id === id)?.label ?? id;
}
