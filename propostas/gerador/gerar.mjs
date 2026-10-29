// =============================================================
// Gerador de Propostas — orquestração
// =============================================================
// gerarProposta: copia o template → insere slides de escopo antes do
// slide de investimento → preenche {{placeholders}} de preço →
// compartilha (link + editor) → exporta PDF/PPTX opcionalmente.
// prepararTemplate: transforma uma CÓPIA do deck original em template
// (literais de preço → placeholders). Nunca rode no deck original.
// =============================================================
import {
  acharIndicePreco, montarValores, requestsPreencher, requestsPreparar,
  requestsSlidesEscopo, secoesEscopo, validarEscopo,
} from './slides.mjs';

export function nomeProposta(escopo, hoje = new Date()) {
  const d = hoje.toISOString().slice(0, 10);
  return `Proposta V4 — ${escopo.cliente.empresa} — ${d}`;
}

// Monta tudo o que o batchUpdate vai receber, sem rede (usado também no --dry-run).
export function planejar(escopo, apresentacao) {
  const erros = validarEscopo(escopo);
  if (erros.length) throw new Error(`escopo inválido:\n- ${erros.join('\n- ')}`);
  const indice = acharIndicePreco(apresentacao);
  const secoes = secoesEscopo(escopo);
  const { valores, pendencias } = montarValores(escopo);
  const requests = [
    ...requestsSlidesEscopo(secoes, { indice, pageSize: apresentacao.pageSize }),
    ...requestsPreencher(valores),
  ];
  return { indice, secoes, valores, pendencias, requests };
}

export async function gerarProposta(cliente, { templateId, escopo, pastaId, editores = [], link = 'reader', exportar = [], hoje }) {
  const erros = validarEscopo(escopo);
  if (erros.length) throw new Error(`escopo inválido:\n- ${erros.join('\n- ')}`);

  const copia = await cliente.copiar(templateId, nomeProposta(escopo, hoje), pastaId);
  const apresentacao = await cliente.apresentacao(copia.id);
  const plano = planejar(escopo, apresentacao);
  await cliente.batchUpdate(copia.id, plano.requests);

  if (link && link !== 'nenhum') await cliente.compartilhar(copia.id, { type: 'anyone', role: link });
  for (const email of editores) {
    await cliente.compartilhar(copia.id, { type: 'user', role: 'writer', emailAddress: email });
  }

  const arquivos = {};
  for (const formato of exportar) {
    arquivos[formato] = await cliente.exportar(copia.id, formato, copia.exportLinks);
  }

  return {
    id: copia.id,
    url: copia.webViewLink || `https://docs.google.com/presentation/d/${copia.id}/edit`,
    slidesInseridos: plano.secoes.length,
    pendencias: plano.pendencias,
    arquivos,
  };
}

export async function prepararTemplate(cliente, templateId) {
  const r = await cliente.batchUpdate(templateId, requestsPreparar());
  // occurrencesChanged por literal: 0 indica que o deck mudou e o mapa precisa revisão.
  return (r.replies || []).map((rep, i) => ({
    literal: requestsPreparar()[i].replaceAllText.containsText.text,
    trocas: rep?.replaceAllText?.occurrencesChanged || 0,
  }));
}
