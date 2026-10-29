// =============================================================
// Gerador de Propostas — orquestração
// =============================================================
// gerarProposta: copia o template → confere que é um template preparado →
// insere slides de escopo antes do slide de investimento → preenche
// {{placeholders}} de preço → confere as trocas → só então compartilha
// (link + editor) e exporta PDF/PPTX opcionalmente.
// prepararTemplate: transforma uma CÓPIA do deck original em template
// (literais de preço → placeholders, só nos slides de preço).
// Nunca rode no deck original.
// =============================================================
import {
  PLACEHOLDERS_TEMPLATE, acharIndicePreco, idsExistentes, montarValores, novoPrefixo,
  planejarPreparar, requestsPreencher, requestsSlidesEscopo, secoesEscopo,
  validarEscopo, verificarTemplate,
} from './slides.mjs';

export function nomeProposta(escopo, hoje = new Date()) {
  const d = hoje.toISOString().slice(0, 10);
  return `Proposta V4 — ${escopo.cliente.empresa} — ${d}`;
}

function falhar(titulo, erros) {
  throw new Error(`${titulo}:\n- ${erros.join('\n- ')}`);
}

// Monta tudo o que o batchUpdate vai receber, sem rede (usado também no --dry-run).
export function planejar(escopo, apresentacao, { conferirTemplate = true, prefixo = novoPrefixo() } = {}) {
  const erros = validarEscopo(escopo);
  if (erros.length) falhar('escopo inválido', erros);
  if (conferirTemplate) {
    const errosTpl = verificarTemplate(apresentacao);
    if (errosTpl.length) falhar('template incompatível', errosTpl);
  }
  const existentes = idsExistentes(apresentacao);
  const indice = acharIndicePreco(apresentacao);
  const secoes = secoesEscopo(escopo);
  const { valores, pendencias } = montarValores(escopo);
  const requests = [
    ...requestsSlidesEscopo(secoes, { indice, pageSize: apresentacao.pageSize, prefixo }),
    ...requestsPreencher(valores),
  ];
  const novos = requests.flatMap((r) => [r.createSlide?.objectId, r.createShape?.objectId]).filter(Boolean);
  const colisao = novos.filter((id) => existentes.has(id));
  if (colisao.length) falhar('objectId já existe no template', colisao);
  return { indice, secoes, valores, pendencias, requests };
}

// Placeholders de preço que precisam ter sido trocados ao menos uma vez.
function conferirTrocas(requests, replies) {
  const faltando = [];
  requests.forEach((req, i) => {
    const ph = req.replaceAllText?.containsText?.text;
    if (!ph || !PLACEHOLDERS_TEMPLATE.includes(ph)) return;
    if (!(replies?.[i]?.replaceAllText?.occurrencesChanged > 0)) faltando.push(ph);
  });
  return faltando;
}

export async function gerarProposta(cliente, { templateId, escopo, pastaId, editores = [], link = 'reader', exportar = [], hoje }) {
  const erros = validarEscopo(escopo);
  if (erros.length) falhar('escopo inválido', erros);

  const copia = await cliente.copiar(templateId, nomeProposta(escopo, hoje), pastaId);
  let plano;
  try {
    const apresentacao = await cliente.apresentacao(copia.id);
    plano = planejar(escopo, apresentacao);
    const r = await cliente.batchUpdate(copia.id, plano.requests);
    const faltando = conferirTrocas(plano.requests, r.replies);
    if (faltando.length) falhar('placeholders sem troca (proposta não compartilhada)', faltando);
  } catch (e) {
    // Cópia inválida não fica parada no Drive nem é compartilhada. Se a remoção
    // falhar, o erro original segue junto com o id da cópia (não compartilhada).
    try {
      await cliente.apagar(copia.id);
      e.limpeza = { copiaId: copia.id, apagada: true };
    } catch (eDel) {
      e.limpeza = { copiaId: copia.id, apagada: false, erro: eDel.message };
      e.message += `\n(atenção: a cópia ${copia.id} NÃO foi apagada — ${eDel.message}; ela não foi compartilhada, apague à mão)`;
    }
    throw e;
  }

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
  const apresentacao = await cliente.apresentacao(templateId);
  const { erros, requests, pageObjectIds } = planejarPreparar(apresentacao);
  if (erros.length) falhar('deck não pode ser preparado (nada alterado)', erros);
  const r = await cliente.batchUpdate(templateId, requests);
  return {
    slidesDePreco: pageObjectIds.length,
    trocas: requests.map((req, i) => ({
      literal: req.replaceAllText.containsText.text,
      trocas: r.replies?.[i]?.replaceAllText?.occurrencesChanged || 0,
    })),
  };
}
