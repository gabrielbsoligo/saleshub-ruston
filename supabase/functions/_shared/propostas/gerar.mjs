// =============================================================
// Gerador de Propostas — orquestração
// =============================================================
// gerarProposta: copia o template → confere que é um template preparado →
// insere slides de escopo antes do slide de investimento → preenche
// {{placeholders}} de preço → confere as trocas → só então compartilha
// (leitura para o domínio V4 + closer como editor) e exporta PDF/PPTX opcionalmente.
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
    ...requestsSlidesEscopo(secoes, { indice, pageSize: apresentacao.pageSize, prefixo, cliente: escopo.cliente.empresa }),
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

// Acesso permitido no arquivo final (decisão do Gabriel, 29/10): o dono, os
// editores pedidos (closer) e leitura para o domínio. Nada de "qualquer pessoa
// com o link", domínio com edição ou acesso herdado de pasta.
export function permissaoPermitida(p, { dominio, editores }) {
  if (p.role === 'owner') return true;
  const eds = editores.map((e) => e.toLowerCase());
  if (p.type === 'user' && p.role === 'writer' && eds.includes(String(p.emailAddress || '').toLowerCase())) return true;
  if (dominio && p.type === 'domain' && p.role === 'reader' && p.domain === dominio) return true;
  return false;
}

const herdada = (p) => (p.permissionDetails || []).some((d) => d.inherited);

// Remove o que não é permitido; acesso herdado não dá para remover → recusa.
export async function garantirAcesso(cliente, fileId, regra) {
  const { permissions = [] } = await cliente.permissoes(fileId);
  const herdadas = permissions.filter((p) => !permissaoPermitida(p, regra) && herdada(p));
  if (herdadas.length) {
    falhar('acesso herdado incompatível no destino (use uma pasta privada)', herdadas.map((p) => `${p.type}:${p.role}`));
  }
  for (const p of permissions) {
    if (!permissaoPermitida(p, regra)) await cliente.removerPermissao(fileId, p.id);
  }
  const { permissions: finais = [] } = await cliente.permissoes(fileId);
  const sobrando = finais.filter((p) => !permissaoPermitida(p, regra));
  if (sobrando.length) falhar('acesso incompatível após ajuste', sobrando.map((p) => `${p.type}:${p.role}`));
}

// dominio: leitura para quem é do domínio (decisão do Gabriel, 29/10: nunca 'qualquer pessoa com o link').
// Sequência segura:
//   1. pasta de destino (se houver) validada ANTES da cópia: só pode ter acessos permitidos;
//   2. cópia na raiz de quem gera, sem visibilidade padrão, e deixada PRIVADA (só o dono)
//      antes de receber escopo/preço;
//   3. preenche → compartilha (domínio leitor + closer) → confere a ACL;
//   4. só então move para a pasta validada e confere de novo.
// Tudo depois da cópia é compensado: em qualquer falha a cópia é apagada; se nem
// isso der, o erro diz o id.
export async function gerarProposta(cliente, { templateId, escopo, pastaId, editores = [], dominio = null, exportar = [], hoje }) {
  const erros = validarEscopo(escopo);
  if (erros.length) falhar('escopo inválido', erros);
  const regra = { dominio, editores };

  if (pastaId) {
    const { permissions = [] } = await cliente.permissoes(pastaId);
    const ruins = permissions.filter((p) => !permissaoPermitida(p, regra));
    if (ruins.length) falhar('pasta de destino com acesso incompatível (nada foi copiado)', ruins.map((p) => `${p.type}:${p.role}`));
  }

  const copia = await cliente.copiar(templateId, nomeProposta(escopo, hoje), 'root');
  let plano;
  try {
    await garantirAcesso(cliente, copia.id, { dominio: null, editores: [] });

    const apresentacao = await cliente.apresentacao(copia.id);
    plano = planejar(escopo, apresentacao);
    const r = await cliente.batchUpdate(copia.id, plano.requests);
    const faltando = conferirTrocas(plano.requests, r.replies);
    if (faltando.length) falhar('placeholders sem troca (proposta não compartilhada)', faltando);

    if (dominio) await cliente.compartilhar(copia.id, { type: 'domain', role: 'reader', domain: dominio, allowFileDiscovery: false });
    for (const email of editores) {
      await cliente.compartilhar(copia.id, { type: 'user', role: 'writer', emailAddress: email });
    }
    await garantirAcesso(cliente, copia.id, regra);

    if (pastaId) {
      const { parents = [] } = await cliente.pais(copia.id);
      await cliente.mover(copia.id, pastaId, parents);
      await garantirAcesso(cliente, copia.id, regra);
    }
  } catch (e) {
    try {
      await cliente.apagar(copia.id);
      e.limpeza = { copiaId: copia.id, apagada: true };
    } catch (eDel) {
      e.limpeza = { copiaId: copia.id, apagada: false, erro: eDel.message };
      e.message += `\n(atenção: a cópia ${copia.id} NÃO foi apagada — ${eDel.message}; confira o acesso e apague à mão)`;
    }
    throw e;
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
