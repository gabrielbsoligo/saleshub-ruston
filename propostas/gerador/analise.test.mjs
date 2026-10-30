// node propostas/gerador/analise.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  citacaoNaTranscricao, datasNoTexto, extrairJson, formatarData, localizarCitacao, montarPrompt, normalizarComMapa, normalizarEscopo, normalizarTexto, valoresMonetarios,
} from '../../supabase/functions/_shared/propostas/analise.mjs';
import { validarEscopo } from '../../supabase/functions/_shared/propostas/slides.mjs';

const catalogo = JSON.parse(readFileSync(new URL('../../supabase/functions/_shared/propostas/catalogo-v0.json', import.meta.url), 'utf8'));

const transcricao = `Closer: Me conta como vocês vendem hoje.
Lead: Hoje quem vende sou eu, é tudo indicação, a gente controla tudo na planilha.
Lead: Queria muito usar o LinkedIn para chegar nos diretores de compras.
Closer: Perfeito. Pra estruturação fica 29.750 em 12 vezes no cartão, e a execução sai 5 mil por mês.
Closer: E de bônus eu incluo um treinamento do seu time comercial no processo novo.`;

const ctx = { catalogo, empresa: 'Empresa do Deal', transcricao };

const bruto = () => ({
  cliente: { empresa: 'Nome que o LLM inventou', modelo_venda: 'inside_sales' },
  contexto: { dores: [
    { texto: 'Vendas dependem do dono', origem: 'ia', citacao: 'hoje quem vende sou eu, é tudo indicação' },
    { texto: 'Dor inventada', origem: 'ia', citacao: 'isso nunca foi dito na reunião' },
  ] },
  escopo: {
    enfases: ['linkedin_b2b', 'enfase_que_nao_existe'],
    semanas: [
      { id: 's1', titulo: 'Semana 1', itens: [
        { catalogo_id: 's1_persona_icp', texto: 'Persona e ICP', origem: 'catalogo', citacao: null },
        { catalogo_id: 'li_icp_contas', texto: 'Contas-alvo no LinkedIn (diretores de compras)', origem: 'catalogo', citacao: null },
        { catalogo_id: 'id_inventado', texto: 'Item com id falso', origem: 'catalogo', citacao: null },
      ] },
      { id: 's3', titulo: 'Semana 3', itens: [] },
    ],
    overdeliveries: [
      { catalogo_id: null, texto: 'Treinamento do time comercial', origem: 'ia', citacao: 'eu incluo um treinamento do seu time comercial' },
    ],
  },
  plano_execucao: { incluido: true, faixa_midia: null, itens: [{ catalogo_id: 'ex_gestor_conta', texto: 'Gestor de Conta', origem: 'catalogo' }] },
  preco: {
    estruturacao: { valor_total: 29750, parcelas: 12, valor_parcela: null, condicao: null },
    execucao_mensal: { valor: 5000, valor_com_social: null, meses: null },
    evidencias: {
      valor_total: 'fica 29.750 em 12 vezes no cartão',
      parcelas: 'fica 29.750 em 12 vezes no cartão',
      execucao_valor: 'a execução sai 5 mil por mês',
    },
  },
  pendencias: ['faixa de mídia não foi falada'],
});

test('normalizarEscopo: resultado passa na validação do gerador', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.deepEqual(validarEscopo(e), []);
});

test('empresa vem do deal, não do LLM', () => {
  assert.equal(normalizarEscopo(bruto(), ctx).cliente.empresa, 'Empresa do Deal');
});

test('citação inexistente na transcrição: item sai e vira pendência', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.deepEqual(e.contexto.dores.map((d) => d.texto), ['Vendas dependem do dono']);
  assert.ok(e.pendencias.some((p) => p.includes('Dor inventada')));
});

test('catalogo_id inexistente sem citação é descartado; ênfase desconhecida some', () => {
  const e = normalizarEscopo(bruto(), ctx);
  const s1 = e.escopo.semanas.find((s) => s.id === 's1');
  assert.deepEqual(s1.itens.map((i) => i.catalogo_id), ['s1_persona_icp', 'li_icp_contas']);
  assert.ok(e.pendencias.some((p) => p.includes('Item com id falso')));
  assert.deepEqual(e.escopo.enfases, ['linkedin_b2b']);
});

test('overdelivery prometido com citação real fica', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.equal(e.escopo.overdeliveries.length, 1);
  assert.equal(e.escopo.overdeliveries[0].origem, 'ia');
});

test('preço: entra só com citação conferida', () => {
  const ok = normalizarEscopo(bruto(), ctx);
  assert.equal(ok.preco.estruturacao.valor_total, 29750);
  assert.equal(ok.preco.estruturacao.parcelas, 12);
  assert.equal(ok.preco.execucao_mensal.valor, 5000);

  const b = bruto();
  b.preco.evidencias.valor_total = 'o preço é 99 mil reais';
  const chute = normalizarEscopo(b, ctx);
  assert.equal(chute.preco.estruturacao.valor_total, null);
  assert.ok(chute.pendencias.some((p) => p.includes('preço da estruturação')));
});

test('Vedor F3 #1: citação real de outro assunto não libera números inventados', () => {
  const b = bruto();
  b.preco.evidencias = { valor_total: 'Hoje quem vende sou eu', parcelas: 'Hoje quem vende sou eu', valor_parcela: 'Hoje quem vende sou eu', execucao_valor: 'Hoje quem vende sou eu', meses: 'Hoje quem vende sou eu' };
  b.preco.estruturacao = { valor_total: 999999, parcelas: 12, valor_parcela: 88888, condicao: 'à vista com desconto' };
  b.preco.execucao_mensal = { valor: 77777, valor_com_social: null, meses: 6 };
  const e = normalizarEscopo(b, ctx);
  assert.deepEqual(e.preco.estruturacao, { valor_total: null, parcelas: null, valor_parcela: null, condicao: null });
  assert.deepEqual(e.preco.execucao_mensal, { valor: null, valor_com_social: null, meses: null });
  for (const r of ['preço da estruturação', 'parcelas', 'valor da parcela', 'condição', 'preço da execução', 'meses']) {
    assert.ok(e.pendencias.some((p) => p.startsWith(r)), r);
  }
});

test('Vedor F3 #1: cada campo é conferido sozinho (um certo, outro inventado)', () => {
  const b = bruto();
  b.preco.estruturacao.valor_total = 29750;  // dito
  b.preco.execucao_mensal.valor = 6000;      // não dito (foi 5 mil)
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.estruturacao.valor_total, 29750);
  assert.equal(e.preco.execucao_mensal.valor, null);
  assert.ok(e.pendencias.some((p) => p.startsWith('preço da execução')));
});

test('Vedor F3 R2 #1: expressão monetária completa (sem subvalor, centavos exatos)', () => {
  assert.deepEqual(valoresMonetarios('R$ 29.750,00'), [29750]);
  assert.deepEqual(valoresMonetarios('5 mil por mês'), [5000]);
  assert.deepEqual(valoresMonetarios('12x de 2.479,17'), [2479.17]);
  assert.deepEqual(valoresMonetarios('29,75 mil ou 29 mil e 750 ou 5k'), [29750, 29750, 5000]);
  assert.deepEqual(valoresMonetarios('em 12 vezes, 6 meses, 12x'), []);
  const casos = [
    ['valor_total', 750, 'fica 29.750 em 12 vezes no cartão'],         // subvalor
    ['execucao_valor', 5, 'a execução sai 5 mil por mês'],             // unidade mil ignorada
  ];
  for (const [campo, valor, evid] of casos) {
    const b = bruto();
    if (campo === 'valor_total') b.preco.estruturacao.valor_total = valor; else b.preco.execucao_mensal.valor = valor;
    b.preco.evidencias[campo] = evid;
    const e = normalizarEscopo(b, ctx);
    assert.equal(campo === 'valor_total' ? e.preco.estruturacao.valor_total : e.preco.execucao_mensal.valor, null, `${campo}=${valor}`);
  }
});

test('Vedor F3 R2 #1: centavos diferentes não conferem', () => {
  const t = transcricao + '\nCloser: no cartão fica 12x de 2.479,17.';
  const b = bruto();
  b.preco.estruturacao.valor_parcela = 2479.18;
  b.preco.evidencias.valor_parcela = 'no cartão fica 12x de 2.479,17';
  assert.equal(normalizarEscopo(b, { ...ctx, transcricao: t }).preco.estruturacao.valor_parcela, null);
  b.preco.estruturacao.valor_parcela = 2479.17;
  assert.equal(normalizarEscopo(b, { ...ctx, transcricao: t }).preco.estruturacao.valor_parcela, 2479.17);
});

test('Vedor F3 R2 #1: valor da execução não valida estruturação nem social (papel do campo)', () => {
  const b = bruto();
  b.preco.estruturacao.valor_total = 5000;
  b.preco.evidencias.valor_total = 'a execução sai 5 mil por mês';
  b.preco.execucao_mensal.valor_com_social = 5000;
  b.preco.evidencias.execucao_com_social = 'a execução sai 5 mil por mês';
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.estruturacao.valor_total, null, 'estruturação com trecho mensal');
  assert.equal(e.preco.execucao_mensal.valor_com_social, null, 'com social sem falar de social');
  assert.equal(e.preco.execucao_mensal.valor, 5000, 'a execução falada continua');
});

const fonteR3 = `Closer: A estruturação fica R$ 29.750,00 em 12 vezes de 2.479,17.
Lead: E a execução?
Closer: A execução sai 5 mil por mês. Com social media a execução com social fica 7 mil por mês.
Closer: Se quiser só tráfego são 5k por mês.`;
const ctxR3 = { catalogo, empresa: 'Empresa do Deal', transcricao: fonteR3 };
const brutoR3 = (preco) => ({ ...bruto(), preco });

test('Vedor F3 R3 #1: citação truncada não vira subvalor (o valor é lido na fonte)', () => {
  const casos = [
    [{ estruturacao: { valor_total: 29 }, evidencias: { valor_total: 'A estruturação fica R$ 29' } }, 'estruturacao', 'valor_total'],
    [{ estruturacao: { valor_total: 29750 }, evidencias: { valor_total: 'A estruturação fica R$ 29.750' } }, 'estruturacao', 'valor_total', 29750],
    [{ estruturacao: { valor_parcela: 2479 }, evidencias: { valor_parcela: 'em 12 vezes de 2.479' } }, 'estruturacao', 'valor_parcela'],
    [{ execucao_mensal: { valor: 5 }, evidencias: { execucao_valor: 'A execução sai 5' } }, 'execucao_mensal', 'valor'],
    [{ execucao_mensal: { valor: 5 }, evidencias: { execucao_valor: 'só tráfego são 5' } }, 'execucao_mensal', 'valor'],
  ];
  for (const [preco, grupo, campo, esperado = null] of casos) {
    const e = normalizarEscopo(brutoR3({ estruturacao: {}, execucao_mensal: {}, ...preco }), ctxR3);
    assert.equal(e.preco[grupo][campo], esperado, JSON.stringify(preco));
  }
});

test('Vedor F3 R3 #2: com social exige trecho do pacote com social', () => {
  const sem = normalizarEscopo(brutoR3({ estruturacao: {}, execucao_mensal: { valor_com_social: 5000 },
    evidencias: { execucao_com_social: 'A execução sai 5 mil por mês' } }), ctxR3);
  assert.equal(sem.preco.execucao_mensal.valor_com_social, null);
  const com = normalizarEscopo(brutoR3({ estruturacao: {}, execucao_mensal: { valor: 5000, valor_com_social: 7000 },
    evidencias: { execucao_valor: 'A execução sai 5 mil por mês', execucao_com_social: 'a execução com social fica 7 mil por mês' } }), ctxR3);
  assert.equal(com.preco.execucao_mensal.valor, 5000);
  assert.equal(com.preco.execucao_mensal.valor_com_social, 7000);
});

test('Vedor F3 R3 #2: citações sobrepostas sobre a MESMA expressão da fonte = ambíguo', () => {
  const e = normalizarEscopo(brutoR3({ estruturacao: {}, execucao_mensal: { valor: 7000, valor_com_social: 7000 },
    evidencias: { execucao_valor: 'Com social media a execução com social fica 7 mil por mês', execucao_com_social: 'a execução com social fica 7 mil' } }), ctxR3);
  // o valor-base não pode vir da frase do pacote com social (R4); o com social fica
  assert.equal(e.preco.execucao_mensal.valor, null);
  assert.equal(e.preco.execucao_mensal.valor_com_social, 7000);
  // reutilização da mesma expressão da fonte por dois campos = ambíguo
  const r = normalizarEscopo(brutoR3({ estruturacao: { valor_total: 29750, valor_parcela: 29750 }, execucao_mensal: {},
    evidencias: { valor_total: 'A estruturação fica R$ 29.750,00', valor_parcela: 'fica R$ 29.750,00 em 12 vezes' } }), ctxR3);
  assert.equal(r.preco.estruturacao.valor_total, null);
  assert.equal(r.preco.estruturacao.valor_parcela, null);
  assert.ok(r.pendencias.some((p) => p.includes('ambíguo')));
});

test('normalizarComMapa gera o mesmo texto que normalizarTexto e mapeia a fonte', () => {
  const m = normalizarComMapa(fonteR3);
  assert.equal(m.norm, normalizarTexto(fonteR3));
  const [[a, b]] = localizarCitacao('A estruturação fica R$ 29.750,00', m);
  assert.equal(fonteR3.slice(a, b), 'A estruturação fica R$ 29.750,00');
});

test('preço em texto ou negativo vira null', () => {
  const b = bruto();
  b.preco.estruturacao.valor_total = '29.750';
  b.preco.estruturacao.parcelas = -3;
  b.preco.execucao_mensal.valor = -1;
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.preco.estruturacao.valor_total, null);
  assert.equal(e.preco.estruturacao.parcelas, null);
  assert.equal(e.preco.execucao_mensal.valor, null);
  assert.deepEqual(validarEscopo(e), []);
});

test('modelo de venda: informado pelo chamador vence; ausente vira pendência', () => {
  assert.equal(normalizarEscopo(bruto(), { ...ctx, modeloVenda: 'pdv' }).cliente.modelo_venda, 'pdv');
  const b = bruto(); delete b.cliente.modelo_venda;
  const e = normalizarEscopo(b, ctx);
  assert.equal(e.cliente.modelo_venda, 'inside_sales');
  assert.ok(e.pendencias.some((p) => p.includes('modelo de venda')));
});

test('resposta vazia/lixo do LLM não quebra: escopo mínimo + pendências', () => {
  const e = normalizarEscopo({}, ctx);
  assert.deepEqual(validarEscopo(e), []);
  assert.deepEqual(e.escopo.semanas.map((s) => s.id), ['s1', 's2', 's3', 's4']);
  assert.ok(e.pendencias.some((p) => p.includes('Semana 1 não veio da análise')));
  assert.equal(e.preco.estruturacao.valor_total, null);
});

test('extrairJson aceita cerca ```json e recusa resposta sem JSON', () => {
  assert.deepEqual(extrairJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => extrairJson('não sei'), /sem JSON/);
  assert.throws(() => extrairJson(null), /vazia/);
});

test('citação: tolera acento/pontuação, exige tamanho mínimo', () => {
  const t = normalizarTexto(transcricao);
  assert.ok(citacaoNaTranscricao('Hoje quem vende sou EU — é tudo indicacao', t));
  assert.ok(!citacaoNaTranscricao('eu', t));
});

test('prompt traz regras, ids do catálogo, empresa e transcrição', () => {
  const p = montarPrompt({ transcricao, catalogo, empresa: 'Empresa do Deal' });
  for (const trecho of ['s3is_pipeline', 'li_cadencia_social_selling', 'od_cliente_oculto', 'Empresa do Deal', 'diretores de compras', 'Nunca invente']) {
    assert.ok(p.includes(trecho), trecho);
  }
  assert.ok(!p.includes('56000') && !p.includes('36120'), 'preço de referência não vai ao LLM');
});

const fonteR4 = `Closer: Sem social, a execução fica 5 mil por mês. Com social, a execução fica 7 mil por mês.
Closer: Outra opção: a execução não inclui social e sai 6 mil por mês.`;
const ctxR4 = { catalogo, empresa: 'Empresa do Deal', transcricao: fonteR4 };
const exec = (execucao_mensal, evidencias) => normalizarEscopo({ ...bruto(), preco: { estruturacao: {}, execucao_mensal, evidencias } }, ctxR4).preco.execucao_mensal;

test('Vedor F3 R4 #1: "sem social" não vale para o pacote com social', () => {
  assert.equal(exec({ valor_com_social: 5000 }, { execucao_com_social: 'Sem social, a execução fica 5 mil por mês' }).valor_com_social, null);
  assert.equal(exec({ valor_com_social: 6000 }, { execucao_com_social: 'a execução não inclui social e sai 6 mil por mês' }).valor_com_social, null);
});

test('Vedor F3 R4 #1: pacotes invertidos são recusados; os certos entram', () => {
  const inv = exec({ valor: 7000, valor_com_social: 5000 }, {
    execucao_valor: 'Com social, a execução fica 7 mil por mês',
    execucao_com_social: 'Sem social, a execução fica 5 mil por mês',
  });
  assert.equal(inv.valor, null);
  assert.equal(inv.valor_com_social, null);
  const ok = exec({ valor: 5000, valor_com_social: 7000 }, {
    execucao_valor: 'Sem social, a execução fica 5 mil por mês',
    execucao_com_social: 'Com social, a execução fica 7 mil por mês',
  });
  assert.equal(ok.valor, 5000);
  assert.equal(ok.valor_com_social, 7000);
  assert.equal(exec({ valor: 6000 }, { execucao_valor: 'a execução não inclui social e sai 6 mil por mês' }).valor, 6000);
});

test('Vedor F3 R4 #1: pacote ambíguo na fonte → nenhum dos dois', () => {
  const amb = normalizarEscopo({ ...bruto(), preco: { estruturacao: {}, execucao_mensal: { valor: 7000, valor_com_social: 7000 },
    evidencias: { execucao_valor: 'Social media: 7 mil por mês', execucao_com_social: 'Social media: 7 mil por mês' } } },
    { ...ctxR4, transcricao: 'Closer: Social media: 7 mil por mês.' }).preco.execucao_mensal;
  assert.equal(amb.valor, null);
  assert.equal(amb.valor_com_social, null);
});

test('Vedor F3 R5 #1: negação/exclusão no trecho nunca dá "com social"', async () => {
  const { pacoteDaExpressao, expressoesMonetarias } = await import('../../supabase/functions/_shared/propostas/analise.mjs');
  const pac = (f) => expressoesMonetarias(f).map((x) => pacoteDaExpressao(f, x));
  for (const f of [
    'A execução não vem com social e custa 5 mil por mês.',
    'A execução não é com social, sai 5 mil por mês.',
    'O plano sem o pacote com social sai 5 mil por mês.',
    'Fora o social, que fica com o cliente, a execução com social de conteúdo sai 5 mil por mês.',
  ]) {
    assert.ok(!pac(f).includes('com'), f);
    const e = normalizarEscopo({ ...bruto(), preco: { estruturacao: {}, execucao_mensal: { valor_com_social: 5000 },
      evidencias: { execucao_com_social: f.replace(/\.$/, '') } } }, { catalogo, empresa: 'X', transcricao: `Closer: ${f}` });
    assert.equal(e.preco.execucao_mensal.valor_com_social, null, f);
    assert.ok(e.pendencias.some((p) => p.startsWith('preço da execução com social')), f);
  }
  // positivos e pacotes distintos continuam
  assert.deepEqual(pac('Com social, a execução fica 7 mil por mês.'), ['com']);
  // mesma frase com negação: o lado 'com' fica ambíguo (conservador); o 'sem' segue
  assert.deepEqual(pac('Sem social fica 5 mil, com social 7 mil por mês.'), ['sem', 'ambiguo']);
  assert.deepEqual(pac('A execução não inclui social: 6 mil por mês.'), ['sem']);
  assert.deepEqual(pac('A execução sai 5 mil por mês.'), ['neutro']);
});

const fonteVal = `Closer: A estruturação fica R$ 29.750,00 em 12 vezes.
Closer: Essa condição vale até 05/11/2026, depois volta para a tabela.
Lead: Posso te dar retorno na sexta? Closer: Pode, a proposta fica válida até 7 de novembro.`;
const val = (validade, evid, t = fonteVal) => normalizarEscopo({ ...bruto(), preco: { estruturacao: {}, execucao_mensal: {}, validade, evidencias: { validade: evid } } },
  { catalogo, empresa: 'X', transcricao: t });

test('validade: data lida na fonte, com evidência de validade', () => {
  assert.equal(val('05/11/2026', 'Essa condição vale até 05/11/2026').preco.validade, '05/11/2026');
  assert.equal(val('07/11', 'a proposta fica válida até 7 de novembro').preco.validade, '07/11');
});

test('validade: data errada, cortada, sem mês ou sem falar de validade → null + pendência', () => {
  for (const [v, ev, t] of [
    ['06/11/2026', 'Essa condição vale até 05/11/2026'],      // data diferente
    ['05/11/2026', 'Essa condição vale até 05/1'],            // cortada (a fonte diz 05/11)
    ['05/11', 'Posso te dar retorno na sexta'],               // sem data na fonte
    ['29/11', 'A estruturação fica R$ 29.750,00 em 12 vezes'], // número que não é data
  ]) {
    const e = val(v, ev, t);
    assert.equal(e.preco.validade, null, `${v} | ${ev}`);
    assert.ok(e.pendencias.some((p) => p.startsWith('validade da proposta')), `${v} | ${ev}`);
  }
  const semPalavra = val('05/11/2026', 'o evento é dia 05/11/2026', 'Closer: o evento é dia 05/11/2026.');
  assert.equal(semPalavra.preco.validade, null);
});

test('Vedor (validade) #1: data de outro assunto, substring e fração não viram validade', () => {
  for (const [v, ev] of [
    ['05/11', 'a gente entrega a landing page até 05/11'],                   // prazo de entrega ("até" solto)
    ['05/11', 'mandei o material no dia 05/11'],                              // "material" contém "ate"
    ['10/11', 'próxima reunião fica dia 10/11 pra gente fechar os detalhes'], // fechar sem falar de preço
    ['01/02', 'fica garantido 1/2 do valor na entrada'],                      // fração
    ['05/11', 'o prazo de entrega é 05/11'],                                  // prazo de entrega
    ['05/11', 'vale a pena começar dia 05/11'],                               // "vale a pena"
  ]) {
    const e = val(v, ev, `Closer: ${ev}.`);
    assert.equal(e.preco.validade, null, ev);
    assert.ok(e.pendencias.some((p) => p.startsWith('validade da proposta')), ev);
  }
  // a evidência do LLM fala de condição, mas a oração da FONTE em volta da data é de entrega
  const t = 'Closer: essa condição é ótima, a entrega da landing page é 05/11.';
  assert.equal(val('05/11', 'essa condição é ótima, a entrega da landing page é 05/11', t).preco.validade, null);
});

test('Vedor (validade) #1(iv): aceita com fechar + preço e registra de onde a data saiu', () => {
  const t = 'Closer: consigo segurar esse valor se a gente fechar até 05/11.';
  const e = val('05/11', 'consigo segurar esse valor se a gente fechar até 05/11', t);
  assert.equal(e.preco.validade, '05/11');
  assert.ok(e.pendencias.some((p) => p.startsWith('validade 05/11 lida em: "') && p.includes('fechar até 05/11') && p.endsWith('— confira')));
  assert.ok(!e.pendencias.some((p) => p.startsWith('validade da proposta')));
});

test('Vedor (validade) #4: data só parcialmente dentro da citação não conta', () => {
  const e = val('05/11', 'Essa condição vale até 05/1', 'Closer: Essa condição vale até 05/11.');
  assert.equal(e.preco.validade, null);
});

test('datas: fração e "n/n do" não são datas; "5/11" sem ano e "1/2/2027" são', () => {
  assert.equal(datasNoTexto('fica 1/2 na entrada').length, 0);
  assert.equal(datasNoTexto('fica 10/12 do valor').length, 0);
  assert.deepEqual(datasNoTexto('vale até 5/11').map(formatarData), ['05/11']);
  assert.deepEqual(datasNoTexto('vale até 1/2/2027').map(formatarData), ['01/02/2027']);
});

test('Vedor (validade) obs. 2: entrega/início na mesma oração sem "válido" explícito → null', () => {
  for (const [v, ev] of [
    ['05/11', 'a estruturação vale 29.750 e a gente entrega até 05/11'],
    ['05/11', 'a condição é começar dia 05/11'],
    ['10/11', 'o prazo de entrega do valor da landing é 10/11'],
  ]) {
    const e = val(v, ev, `Closer: ${ev}.`);
    assert.equal(e.preco.validade, null, ev);
  }
  assert.equal(val('05/11/2026', 'condição vale até 05/11/2026', 'Closer: essa condição vale até 05/11/2026.').preco.validade, '05/11/2026');
  assert.equal(val('07/11', 'válida até 7 de novembro', 'Closer: a proposta fica válida até 7 de novembro.').preco.validade, '07/11');
});

test('Gabriel 30/10: semana omitida ou esvaziada pela análise entra com o padrão do catálogo', () => {
  const e = normalizarEscopo(bruto(), ctx);
  assert.deepEqual(e.escopo.semanas.map((s) => s.id), ['s1', 's2', 's3', 's4']);
  const s1 = e.escopo.semanas.find((s) => s.id === 's1');
  assert.ok(s1.itens.some((i) => i.catalogo_id === 'li_icp_contas'), 'a semana que veio fica como veio');
  const s3 = e.escopo.semanas.find((s) => s.id === 's3');
  assert.ok(s3.itens.length && s3.itens.every((i) => i.catalogo_id.startsWith('s3is_')), 'S3 vazia → variante inside sales');
  assert.match(s3.titulo, /Inside Sales/);
  for (const n of [2, 3, 4]) assert.ok(e.pendencias.some((p) => p.startsWith(`Semana ${n} não veio da análise`)));
  assert.ok(!e.pendencias.some((p) => p.startsWith('Semana 1 não veio')));
  assert.deepEqual(validarEscopo(e), []);
});

test('Gabriel 30/10: S3 padrão segue o modelo de venda; semana extra vai ao fim', () => {
  const b = bruto(); b.escopo.semanas.push({ id: 'extra', titulo: 'Semana bônus', itens: [{ catalogo_id: 's1_tam_sam_som', texto: 'TAM', origem: 'catalogo' }] });
  const e = normalizarEscopo(b, { ...ctx, modeloVenda: 'pdv' });
  assert.deepEqual(e.escopo.semanas.map((s) => s.id), ['s1', 's2', 's3', 's4', 'extra']);
  assert.ok(e.escopo.semanas.find((s) => s.id === 's3').itens.every((i) => i.catalogo_id.startsWith('s3pdv_')));
});

test('Gabriel 30/10: plano de execução traz o pacote padrão (texto adaptado mantido) e os extras depois', () => {
  const b = bruto();
  b.plano_execucao.itens.push({ catalogo_id: 'ex_social', texto: 'Social media', origem: 'catalogo' });
  const e = normalizarEscopo(b, ctx);
  assert.deepEqual(e.plano_execucao.itens.map((i) => i.catalogo_id), ['ex_gestor_conta', 'ex_trafego', 'ex_designer', 'ex_coord', 'ex_social']);
  assert.equal(e.plano_execucao.itens[0].texto, 'Gestor de Conta');
  b.plano_execucao.incluido = false;
  assert.equal(normalizarEscopo(b, ctx).plano_execucao.itens.length, 2, 'sem execução, nada é completado');
});
