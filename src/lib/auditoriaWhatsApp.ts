// Modulo profundo: gera mensagem WhatsApp para auditoria.
// Funcao pura — fluxo: dado item + observacao + categoria + severidade + responsavel,
// retorna string formatada. Sem efeito colateral.

import type {
  AuditoriaCategoria,
  AuditoriaSeveridade,
  Lead,
  Deal,
  TeamMember,
} from '../types';
import { CATEGORIA_LABELS } from '../types';

export interface WhatsAppMessageInput {
  item: Lead | Deal;
  itemTipo: 'lead' | 'deal';
  observacao: string;
  categoria?: AuditoriaCategoria;
  severidade?: AuditoriaSeveridade;
  responsavel?: TeamMember | null;
  saleshubBaseUrl?: string;
}

const SEVERIDADE_LABEL: Record<AuditoriaSeveridade, string> = {
  alta: '🔴 Alta',
  media: '🟡 Média',
  baixa: '🟢 Baixa',
};

function fmt(v: any): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function fmtDate(v: any): string {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(v);
  }
}

export function gerarMensagemWhatsApp(input: WhatsAppMessageInput): string {
  const { item, itemTipo, observacao, categoria, severidade, responsavel, saleshubBaseUrl } = input;

  const tipoLabel = itemTipo === 'lead' ? 'Lead' : 'Negociação';
  const categoriaLabel = categoria ? CATEGORIA_LABELS[categoria] : '—';
  const severidadeLabel = severidade ? SEVERIDADE_LABEL[severidade] : '—';
  const responsavelLabel = responsavel ? responsavel.name : '—';

  const empresa = (item as any).empresa || 'Sem nome';
  const kommoLink = (item as any).kommo_link || '';
  const baseUrl = saleshubBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  const saleshubLink = `${baseUrl}/?audit_${itemTipo}=${item.id}`;

  // Dados específicos por tipo
  let dadosBlock = '';
  if (itemTipo === 'lead') {
    const l = item as Lead;
    dadosBlock = [
      `• Status: ${fmt((l as any).status)}`,
      `• Canal: ${fmt(l.canal)}`,
      `• Contato: ${fmt(l.nome_contato)}`,
      `• Telefone: ${fmt(l.telefone)}`,
      `• Cadastrado: ${fmtDate(l.created_at)}`,
    ].join('\n');
  } else {
    const d = item as Deal;
    const valorTotal = (d.valor_mrr || 0) + (d.valor_ot || 0);
    dadosBlock = [
      `• Status: ${fmt(d.status)}`,
      `• Temperatura: ${fmt(d.temperatura)}`,
      `• Valor: R$ ${valorTotal.toLocaleString('pt-BR')} (MRR ${(d.valor_mrr || 0).toLocaleString('pt-BR')} + OT ${(d.valor_ot || 0).toLocaleString('pt-BR')})`,
      `• BANT: ${fmt(d.bant)}`,
      `• Última call: ${fmtDate(d.data_call)}`,
    ].join('\n');
  }

  const linksBlock = [
    kommoLink ? `• Kommo: ${kommoLink}` : null,
    `• SalesHub: ${saleshubLink}`,
  ].filter(Boolean).join('\n');

  return [
    `🔍 *Auditoria SalesHub — ${empresa}*`,
    ``,
    `*Tipo:* ${tipoLabel}`,
    `*Responsável:* ${responsavelLabel}`,
    `*Categoria:* ${categoriaLabel}`,
    `*Severidade:* ${severidadeLabel}`,
    ``,
    `*Links:*`,
    linksBlock,
    ``,
    `*Dados:*`,
    dadosBlock,
    ``,
    `*Observação:*`,
    `\`${observacao || '(sem observação)'}\``,
    ``,
    `Por favor, atualize/responda. 🙏`,
  ].join('\n');
}

// =============================================
// Mensagem consolidada (pós-sessão)
// =============================================

const SEV_EMOJI: Record<string, string> = { alta: '🔴', media: '🟡', baixa: '🟢' };

export interface ConsolidadoItem {
  empresa: string;
  tipo: 'lead' | 'deal';
  observacao: string;
  severidade?: AuditoriaSeveridade;
  responsavel: string;
  kommoLink: string;
}

export function gerarMensagemConsolidada(sessaoNome: string, items: ConsolidadoItem[]): string {
  if (items.length === 0) return '(nenhum item auditado)';

  const header = `🔍 *Auditoria SalesHub — ${sessaoNome}*\n${items.length} item(s) auditado(s)\n`;

  const lines = items.map((it, i) => {
    const sev = it.severidade ? ` ${SEV_EMOJI[it.severidade] || ''}` : '';
    const link = it.kommoLink ? `\n   Kommo: ${it.kommoLink}` : '';
    const obs = it.observacao ? `\`${it.observacao}\`` : '`(sem observação)`';
    return `*${i + 1}. ${it.empresa}*${sev}\n   Resp: ${it.responsavel}\n   ${obs}${link}`;
  });

  return [
    header,
    lines.join('\n\n'),
    '',
    'Por favor, atualizem/respondam. 🙏',
  ].join('\n');
}
