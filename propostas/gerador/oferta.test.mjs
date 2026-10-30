// node --test propostas/gerador/oferta.test.mjs
// Tipo de oferta (P1), entregáveis e preço da oferta (P2/P3), validade relativa (P4),
// etapa 2 (P5), deck curto (P6) e contexto (P7). Transcrição fictícia no padrão do
// 1º teste real (call de implementação pontual, 30/10): números como o Meet escreve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  montarPrompt, normalizarEscopo, normalizarTexto, resolverValidadeRelativa,
} from '../../supabase/functions/_shared/propostas/analise.mjs';
import { validarEscopo } from '../../supabase/functions/_shared/propostas/slides.mjs';
import { secoesCurto, requestsDeckCurto } from '../../supabase/functions/_shared/propostas/deck-curto.mjs';
import { ehDeckCurto, gerarProposta, nomeProposta, planejar } from '../../supabase/functions/_shared/propostas/gerar.mjs';

const catalogo = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/catalogo-v1.json', import.meta.url), 'utf8'));
const catalogoV0 = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/catalogo-v0.json', import.meta.url), 'utf8'));

const transcricao = `Closer: Hoje quem atende os clientes é só você?
Lead: Sou eu que faço o atendimento comercial, somente eu, e não tenho CRM nenhum.
Lead: Os clientes da região de Taubaté são o meu público principal.
Closer: Para vocês eu faria uma landing page focada em conversão, ela seria 2500 só ela.
Closer: E para eu implementar o CRM com essa IA de atendimento, ele é um valor de 4.000.
Closer: Ele tem um valor de ferramenta que é direto com eles, que é de R$ 140.
Closer: Então essa implementação ali, ela seria 6,500. O que eu consigo fazer para esse fechamento hoje, agora nesse final de mês? Eu consigo tirar 20%, tá? Então ficaria 52,200.
Closer: Então fica 12 vezes de 433.
Lead: Eu tenho as fotos dos projetos no Google Drive.
Closer: De janeiro para frente a gente iria aumentar o investimento, uns R$ 2.000 em Google Ads.
Closer: Então mais uns R$ 800 vamos colocar ali em Instagram para o remarketing.
Closer: Seria uma assessoria contínua do gestor de tráfego, a gente estaria falando de um mensal de uns 4.000.
Lead: Preciso conversar com meu sócio e te dou um retorno até as 4 horas da tarde.`;

const brutoImpl = () => ({
  oferta: { tipo: 'implementacao', citacao: 'eu faria uma landing page focada em conversão' },
  cliente: { modelo_venda: null },
  contexto: {
    dores: [{ texto: 'Atendimento só da dona, sem CRM', origem: 'ia', citacao: 'sou eu que faço o atendimento comercial, somente eu' }],
    publico: [{ texto: 'Clientes da região de Taubaté', origem: 'ia', citacao: 'Os clientes da região de Taubaté são o meu público principal' }],
    concorrentes: [{ texto: 'Concorrente inventado', origem: 'ia', citacao: 'isso não foi dito' }],
    cliente_fornece: [{ texto: 'Fotos dos projetos', origem: 'ia', citacao: 'Eu tenho as fotos dos projetos no Google Drive' }],
    proximos_passos: [{ texto: 'Alinhar com o sócio e retornar até 16h', origem: 'ia', citacao: 'Preciso conversar com meu sócio e te dou um retorno' }],
  },
  escopo: { semanas: [{ id: 's1', titulo: 'Semana 1', itens: [{ catalogo_id: 's1_persona_icp', texto: 'Persona', origem: 'catalogo' }] }] },
  entregaveis: [
    { produto_id: 'p_implementacao_de_landing_page', texto: 'Landing page focada em conversão', citacao: 'eu faria uma landing page focada em conversão', recorrencia: 'unico', valor: 2500, evidencia_valor: 'ela seria 2500 só ela' },
    { produto_id: 'p_inexistente', texto: 'CRM com IA de atendimento', citacao: 'para eu implementar o CRM com essa IA de atendimento', recorrencia: 'unico', valor: 4000, evidencia_valor: 'ele é um valor de 4.000' },
    { produto_id: null, texto: 'Site completo de 10 páginas', citacao: 'um site completo de dez páginas', valor: 9000 },
  ],
  plano_execucao: { incluido: true, itens: [] },
  preco: {
    estruturacao: { valor_total: 6500 },
    oferta: {
      valor_tabela: 6500, desconto_percentual: 20, valor_final: 5200, parcelas: 12, valor_parcela: 433, recorrencia: 'unico',
      evidencias: {
        valor_tabela: 'Então essa implementação ali, ela seria 6,500',
        desconto: 'Eu consigo tirar 20%, tá?',
        valor_final: 'Então ficaria 52,200',
        parcelas: 'Então fica 12 vezes de 433',
        valor_parcela: 'Então fica 12 vezes de 433',
      },
    },
    validade: 'hoje',
    evidencias: { validade: 'O que eu consigo fazer para esse fechamento hoje, agora nesse final de mês?' },
  },
  custos_terceiros: [{ texto: 'Ferramenta do CRM', valor: 140, periodicidade: 'mensal', evidencia: 'Ele tem um valor de ferramenta que é direto com eles, que é de R$ 140' }],
  etapa2: {
    incluida: true,
    itens: [{ texto: 'Assessoria contínua de tráfego', origem: 'ia', citacao: 'Seria uma assessoria contínua do gestor de tráfego' }],
    valor_mensal: 4000,
    verba_midia: [
      { canal: 'Google Ads', valor: 2000, evidencia: 'uns R$ 2.000 em Google Ads' },
      { canal: 'Meta Ads (Instagram)', valor: 800, evidencia: 'Então mais uns R$ 800 vamos colocar ali em Instagram' },
      { canal: 'TikTok', valor: 500, evidencia: 'uns R$ 2.000 em Google Ads' },
    ],
    evidencias: { quando: 'De janeiro para frente a gente iria aumentar o investimento', valor_mensal: 'a gente estaria falando de um mensal de uns 4.000' },
  },
});

const ctx = { catalogo, empresa: 'Marcenaria Exemplo', transcricao, dataReuniao: '2026-10-30' };

test('catálogo v1: portfólio V4 com ids únicos e categorias STEP; quatro tipos de oferta', () => {
  const ids = catalogo.produtos.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(catalogo.produtos.length >= 70);
  assert.ok(catalogo.produtos.every((p) => ['saber', 'ter', 'executar', 'potencializar', 'destrava_receita'].includes(p.step)));
  assert.ok(ids.includes('p_implementacao_de_landing_page'));
  assert.deepEqual(catalogo.tipos_oferta.map((t) => t.id), ['estruturacao', 'implementacao', 'execucao', 'implementacao_e_execucao']);
  // o resto do v0 segue igual (Estruturação não muda)
  assert.deepEqual(catalogo.semanas, catalogoV0.semanas);
  assert.deepEqual(catalogo.execucao, catalogoV0.execucao);
});

test('prompt: pede o tipo antes do escopo, lista o portfólio sem valor base e respeita o tipo do closer', () => {
  const p = montarPrompt({ transcricao, catalogo, empresa: 'X' });
  assert.match(p, /PASSO 1 — TIPO DE OFERTA/);
  assert.match(p, /p_implementacao_de_landing_page: Implementação de Landing Page/);
  assert.doesNotMatch(p, /3\.348|valor_base/);
  assert.doesNotMatch(p, /O closer já escolheu/);
  assert.match(montarPrompt({ transcricao, catalogo, empresa: 'X', tipoOferta: 'execucao' }), /O closer já escolheu o tipo: execucao/);
  // catálogo v0: sem passo de tipo (comportamento antigo)
  assert.doesNotMatch(montarPrompt({ transcricao, catalogo: catalogoV0, empresa: 'X' }), /TIPO DE OFERTA/);
});

test('implementação: sem semanas nem pacote de execução da Estruturação; entregáveis só com citação', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.equal(e.schema_version, 'proposta-escopo/v1');
  assert.deepEqual(e.oferta, { tipo: 'implementacao', origem: 'ia', citacao: 'eu faria uma landing page focada em conversão' });
  assert.deepEqual(e.escopo.semanas, []);
  assert.equal(e.plano_execucao.incluido, false);
  assert.deepEqual(e.plano_execucao.itens, []);
  assert.deepEqual(e.entregaveis.map((i) => [i.texto, i.produto_id, i.valor]), [
    ['Landing page focada em conversão', 'p_implementacao_de_landing_page', 2500],
    ['CRM com IA de atendimento', null, 4000],
  ]);
  assert.ok(e.pendencias.some((p) => p.includes('Site completo de 10 páginas')));
  assert.ok(!e.pendencias.some((p) => /Semana|modelo de venda|plano de execução/.test(p)), e.pendencias.join('\n'));
  assert.ok(e.pendencias.some((p) => p.startsWith('tipo de oferta identificado pela IA: Implementação pontual')));
  // preço da Estruturação não vale fora dela
  assert.equal(e.preco.estruturacao.valor_total, null);
  assert.deepEqual(validarEscopo(e), []);
});

test('preço da oferta: tabela "6,500", desconto 20%, final calculado quando o Meet escreve "52,200"; 12x de 433', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.deepEqual(e.preco.oferta, {
    recorrencia: 'unico', valor_tabela: 6500, desconto_percentual: 20, valor_final: 5200, valor_final_calculado: true, parcelas: 12, valor_parcela: 433,
  });
  assert.ok(e.pendencias.some((p) => p.startsWith('valor com desconto calculado (preço de tabela − 20%)')));
});

test('preço da oferta: final falado limpo é aceito sem cálculo; desconto sem "%" no trecho é recusado', () => {
  const b = brutoImpl();
  b.preco.oferta.evidencias.valor_final = 'Então ficaria 52,200';
  const t2 = `${transcricao}\nLead: Então é 5200, é isso.`;
  b.preco.oferta.evidencias.valor_final = 'Então é 5200, é isso.';
  const e = normalizarEscopo(b, { ...ctx, transcricao: t2 });
  assert.equal(e.preco.oferta.valor_final, 5200);
  assert.equal(e.preco.oferta.valor_final_calculado, false);

  const b2 = brutoImpl();
  b2.preco.oferta.evidencias.desconto = 'Então essa implementação ali, ela seria 6,500';
  const e2 = normalizarEscopo(b2, ctx);
  assert.equal(e2.preco.oferta.desconto_percentual, null);
  assert.equal(e2.preco.oferta.valor_final, null);
  assert.ok(e2.pendencias.some((p) => p.startsWith('desconto: a análise sugeriu')));
  assert.ok(e2.pendencias.some((p) => p.startsWith('valor com desconto: a análise sugeriu')));
});

test('P4: validade relativa vira data pela data da reunião ("hoje" vence "fim do mês"); sem data, pendência', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.equal(e.preco.validade, '30/10/2026');
  assert.ok(e.pendencias.some((p) => p.startsWith('validade 30/10/2026 calculada de "hoje" pela data da reunião (30/10/2026)')));

  const sem = normalizarEscopo(brutoImpl(), { ...ctx, dataReuniao: null });
  assert.equal(sem.preco.validade, null);
  assert.ok(sem.pendencias.includes('validade da proposta: prazo relativo sem a data da reunião — preencha'));

  const assumida = normalizarEscopo(brutoImpl(), { ...ctx, dataAssumida: true });
  assert.ok(assumida.pendencias.some((p) => p.includes('data do pedido (a reunião não estava vinculada)')));
});

test('P4: termos relativos', () => {
  const r = (t, d = '2026-10-30') => resolverValidadeRelativa(normalizarTexto(t), d)?.data ?? null;
  assert.equal(r('condição válida só hoje'), '30/10/2026');
  assert.equal(r('vale até amanhã'), '31/10/2026');
  assert.equal(r('fechando até o fim do mês'), '31/10/2026');
  assert.equal(r('fechando até o final de mês', '2026-02-10'), '28/02/2026');
  assert.equal(r('vale até sexta-feira'), '30/10/2026'); // 30/10/2026 é sexta
  assert.equal(r('vale até sexta-feira', '2026-10-31'), '06/11/2026');
  assert.equal(r('condição para fechar essa semana', '2026-10-27'), '30/10/2026');
  assert.equal(r('na segunda etapa a gente vê'), null); // "segunda" ordinal
  assert.equal(r('vale até hoje', 'sem-data'), null);
});

test('P4: data de entrega relativa não vira validade', () => {
  const b = brutoImpl();
  b.preco.evidencias.validade = 'Eu tenho as fotos dos projetos no Google Drive';
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.validade, null);
});

test('custos de terceiros: valor conferido; periodicidade "mensal" sem dizer mensal no trecho vira pendência', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.deepEqual(e.custos_terceiros.map((c) => [c.texto, c.valor, c.periodicidade]), [['Ferramenta do CRM', 140, null]]);
  assert.ok(e.pendencias.includes('custo "Ferramenta do CRM": periodicidade não falada — confira'));
});

test('P5: etapa 2 com mês, valor mensal e verba por canal (canal precisa estar no trecho)', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.equal(e.etapa2.quando, 'a partir de janeiro');
  assert.equal(e.etapa2.valor_mensal, 4000);
  assert.deepEqual(e.etapa2.verba_midia, [{ canal: 'Google Ads', valor: 2000 }, { canal: 'Meta Ads (Instagram)', valor: 800 }]);
  assert.ok(e.pendencias.includes('verba de mídia "TikTok" não confirmada na transcrição — confira'));
  assert.equal(e.etapa2.itens.length, 1);
});

test('P7: contexto (público, concorrentes, o que o cliente fornece, próximos passos) só com citação conferida', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.equal(e.contexto.publico.length, 1);
  assert.equal(e.contexto.concorrentes.length, 0);
  assert.equal(e.contexto.cliente_fornece.length, 1);
  assert.equal(e.contexto.proximos_passos.length, 1);
});

test('tipo: o do closer vence o da IA; inválido vira Estruturação com pendência; Estruturação segue igual', () => {
  const b = brutoImpl();
  const fe = normalizarEscopo(b, { ...ctx, tipoOferta: 'execucao' });
  assert.equal(fe.oferta.tipo, 'execucao');
  assert.equal(fe.oferta.origem, 'closer');

  const b2 = brutoImpl();
  b2.oferta.tipo = 'outra_coisa';
  const e2 = normalizarEscopo(b2, ctx);
  assert.equal(e2.oferta.tipo, 'estruturacao');
  assert.ok(e2.pendencias.some((p) => p.startsWith('tipo de oferta não identificado')));
  assert.equal(e2.escopo.semanas.length, 4); // regra S1–S4 só na Estruturação
  assert.ok(!('entregaveis' in e2));
  assert.deepEqual(validarEscopo(e2), []);

  // catálogo v0: sem oferta no escopo (compatível com o que já existe)
  const v0 = normalizarEscopo(brutoImpl(), { ...ctx, catalogo: catalogoV0 });
  assert.equal(v0.schema_version, 'proposta-escopo/v0');
  assert.ok(!('oferta' in v0));
});

test('validarEscopo: deck curto aceita sem semanas; recusa valores inválidos da oferta', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.deepEqual(validarEscopo(e), []);
  const ruim = structuredClone(e);
  ruim.preco.oferta.desconto_percentual = 120;
  ruim.entregaveis[0].valor = -1;
  ruim.entregaveis[1].citacao = null;
  ruim.custos_terceiros.push({ texto: '', valor: 1 });
  const erros = validarEscopo(ruim);
  assert.ok(erros.some((x) => x.includes('desconto_percentual')));
  assert.ok(erros.some((x) => x.includes('entregaveis[0].valor')));
  assert.ok(erros.some((x) => x.includes('item da IA sem citação em entregaveis')));
  assert.ok(erros.some((x) => x.includes('custos_terceiros[1] sem texto')));
  const tipoRuim = structuredClone(e);
  tipoRuim.oferta.tipo = 'x';
  assert.ok(validarEscopo(tipoRuim).includes('oferta.tipo inválido'));
});

test('P6: seções do deck curto na ordem, com investimento (desconto, de/por, parcelas) e etapa 2', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  const s = secoesCurto(e);
  assert.deepEqual(s.map((x) => x.titulo), [
    'O que ouvimos da Marcenaria Exemplo', 'Contexto do projeto', 'O que entregamos', 'Qual é o investimento?',
    'A partir de janeiro: próxima etapa', 'Próximos passos',
  ]);
  const inv = s.find((x) => x.tipo === 'investimento');
  assert.deepEqual(inv.linhas, [
    { texto: 'Landing page focada em conversão', valor: 'R$ 2.500' },
    { texto: 'CRM com IA de atendimento', valor: 'R$ 4.000' },
    { texto: 'Valor de tabela', valor: 'R$ 6.500', destaque: true },
  ]);
  assert.equal(inv.condicao, 'CONDIÇÃO PARA FECHAMENTO ATÉ 30/10');
  assert.equal(inv.desconto, '20% DE DESCONTO');
  assert.equal(inv.valor, 'R$ 5.200');
  assert.equal(inv.parcelas, 'ou 12x de R$ 433');
  assert.equal(inv.dePor, 'de R$ 6.500 por R$ 5.200');
  assert.equal(inv.rodape, 'Não incluso, pago direto ao fornecedor: Ferramenta do CRM (R$ 140).');
  const e2 = s.find((x) => x.rotulo === 'Próxima etapa · opcional');
  assert.deepEqual(e2.itens.slice(1), ['Investimento: R$ 4.000 por mês', 'Verba de mídia, paga direto às plataformas: R$ 2.000 em Google Ads e R$ 800 em Meta Ads (Instagram)']);
  assert.equal(s.at(-1).itens.at(-1), 'Condição de 20% válida para fechamento até 30/10');
});

test('P6: sem preço nem entregáveis, o deck mostra [PREENCHER] em vez de inventar', () => {
  const e = normalizarEscopo({ oferta: { tipo: 'implementacao' }, preco: {} }, ctx);
  const s = secoesCurto(e);
  assert.deepEqual(s.find((x) => x.titulo === 'O que entregamos').itens, ['[PREENCHER] entregáveis combinados']);
  const inv = s.find((x) => x.tipo === 'investimento');
  assert.equal(inv.valor, '[PREENCHER]');
  assert.equal(inv.condicao, 'INVESTIMENTO');
  assert.ok(e.pendencias.includes('preço da oferta não confirmado na transcrição: preencha'));
  assert.ok(e.pendencias.includes('nenhum entregável confirmado na transcrição: preencha o que foi oferecido'));
});

test('P6: execução mensal mostra "/mês"; listas longas quebram em (cont.)', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  e.oferta.tipo = 'execucao';
  e.preco.oferta = { recorrencia: 'mensal', valor_tabela: 4000, desconto_percentual: null, valor_final: null, parcelas: null, valor_parcela: null };
  e.entregaveis = Array.from({ length: 10 }, (_, i) => ({ texto: `Item ${i + 1}`, origem: 'closer', citacao: null, valor: null, recorrencia: 'mensal' }));
  const s = secoesCurto(e);
  assert.equal(s.find((x) => x.tipo === 'investimento').valor, 'R$ 4.000/mês');
  assert.deepEqual(s.filter((x) => x.rotulo.startsWith('Proposta')).map((x) => [x.titulo, x.itens.length]), [['O que fazemos todo mês', 8], ['O que fazemos todo mês (cont.)', 2]]);
});

const deck = () => ({
  pageSize: { width: { magnitude: 9144000 }, height: { magnitude: 5143500 } },
  slides: ['capa', 'maior', 'semanas', 'clientes', 'preco1'].map((objectId) => ({ objectId, pageElements: [] })),
});

test('P6: requestsDeckCurto apaga o que não é institucional e insere as seções depois dos mantidos', () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  const { requests, secoes, mantidos } = requestsDeckCurto(e, deck(), { manter: ['capa', 'clientes', 'nao_existe'], prefixo: 'gpX' });
  assert.deepEqual(mantidos, ['capa', 'clientes']);
  assert.deepEqual(requests.filter((r) => r.deleteObject).map((r) => r.deleteObject.objectId), ['maior', 'semanas', 'preco1']);
  const criados = requests.filter((r) => r.createSlide).map((r) => [r.createSlide.objectId, r.createSlide.insertionIndex]);
  assert.deepEqual(criados, secoes.map((_, k) => [`gpX_k${k}`, 2 + k]));
  const textos = requests.filter((r) => r.insertText).map((r) => r.insertText.text).join('\n');
  assert.match(textos, /R\$ 5\.200/);
  assert.doesNotMatch(textos, /Semana|56 mil|Estruturação/);
  // nenhum id configurado: fica só a capa
  assert.deepEqual(requestsDeckCurto(e, deck(), { manter: [], prefixo: 'gpY' }).mantidos, ['capa']);
});

test('P6: planejar/gerarProposta usam o deck curto (sem exigir placeholders do EE) e o nome traz o tipo', async () => {
  const e = normalizarEscopo(brutoImpl(), ctx);
  assert.equal(ehDeckCurto(e), true);
  assert.equal(nomeProposta(e, new Date('2026-10-30T12:00:00Z')), 'Proposta V4 — Marcenaria Exemplo — Implementação — 2026-10-30');
  const p = planejar(e, deck(), { slidesCurto: ['capa'], prefixo: 'gpZ' });
  assert.equal(p.indice, null);
  assert.ok(p.pendencias.length > 0);

  const chamadas = [];
  const cliente = {
    copiar: async () => ({ id: 'copia1', webViewLink: 'https://x/copia1' }),
    permissoes: async () => ({ permissions: [{ id: 'o', type: 'user', role: 'owner' }, ...(chamadas.includes('dominio') ? [{ id: 'd', type: 'domain', role: 'reader', domain: 'v4company.com' }] : [])] }),
    apresentacao: async () => deck(),
    batchUpdate: async (id, reqs) => { chamadas.push(['batch', reqs.length]); return { replies: [] }; },
    compartilhar: async () => { chamadas.push('dominio'); },
    removerPermissao: async () => { throw new Error('não deveria remover'); },
    apagar: async () => { throw new Error('não deveria apagar'); },
  };
  const r = await gerarProposta(cliente, { templateId: 't', escopo: e, dominio: 'v4company.com', slidesCurto: ['capa', 'clientes'] });
  assert.equal(r.id, 'copia1');
  assert.equal(r.slidesInseridos, secoesCurto(e).length);
  assert.ok(chamadas.includes('dominio'));
});
