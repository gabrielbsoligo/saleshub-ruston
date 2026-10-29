// Escolha do modelo de cada passo da cadência SDNA — sem nome de modelo no código.
//
// Tudo vem da tabela enriquecedor_cadencia_templates (+ vínculos por canal, migration_177):
// - disponível = pode sair pelo canal ativo: vínculo aprovado com bot confirmado e sem erro; sem
//   vínculo, o legado (review_status aprovado + algum bot na linha) — o mesmo critério
//   do carteiro (supabase/functions/enriquecedor-cadencia/vinculo.ts).
// - variáveis na ordem de chaves_vars (nome1, sdr, fantasia, fraseFalha, fraseImpacto,
//   rotuloSecundaria, pontos); modelo sem chaves_vars não é usado.
// - padrão do passo: entre os disponíveis, os marcados `padrao` (o da cidade do lead
//   antes do geral); sem nenhum, todos os disponíveis do passo. Empate = rotação 50/50
//   determinística por lead (rot), na ordem do nome.
// - passo 2: com 2ª falha, preferem-se os modelos que usam rotuloSecundaria; sem 2ª
//   falha, esses ficam de fora.

const normCidade = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();

export function chavesDe(t) {
  return Array.isArray(t?.chaves_vars) && t.chaves_vars.length ? t.chaves_vars : null;
}

export function usaSecundaria(t) {
  return (chavesDe(t) ?? []).includes('rotuloSecundaria');
}

export function disponibilidade(t, canalAtivo, vinculos) {
  if (!chavesDe(t)) return { disponivel: false, motivo: 'modelo sem chaves_vars (ordem das variáveis)', origem: null };
  const v = canalAtivo != null
    ? (vinculos ?? []).find((x) => x.template_id === t.id && Number(x.source_id) === Number(canalAtivo))
    : null;
  if (v) {
    if (v.review_status !== 'aprovado') return { disponivel: false, motivo: `sem aprovação da Meta no canal ${canalAtivo} (${v.review_status ?? 'nao_verificado'})`, origem: 'vinculo' };
    if (!v.kommo_bot_id) return { disponivel: false, motivo: `sem bot no canal ${canalAtivo}`, origem: 'vinculo' };
    if (v.erro) return { disponivel: false, motivo: v.erro, origem: 'vinculo' };
    if (!v.bot_verificado_em) return { disponivel: false, motivo: `bot ainda não confirmado no canal ${canalAtivo}`, origem: 'vinculo' };
    return { disponivel: true, motivo: null, origem: 'vinculo' };
  }
  const temBot = !!t.kommo_bot_id || Object.keys(t.kommo_bots_por_responsavel ?? {}).length > 0;
  if (t.review_status !== 'aprovado') return { disponivel: false, motivo: 'sem aprovação da Meta', origem: 'legado' };
  if (!temBot) return { disponivel: false, motivo: 'sem bot', origem: 'legado' };
  return { disponivel: true, motivo: null, origem: 'legado' };
}

const porNome = (a, b) => String(a.nome).localeCompare(String(b.nome));
const roda = (lista, rot) => (lista.length ? [...lista].sort(porNome)[rot % lista.length] : null);

/** Modelo padrão de um passo (ou null se nenhum disponível). `ok(t)` = disponível. */
export function escolherPadrao(templates, passo, { cidade = '', rot = 0, temSecundaria = false, ok = () => true } = {}) {
  let cands = (templates ?? []).filter((t) => Number(t.passo) === passo && ok(t));
  if (passo === 2) {
    const comSec = cands.filter(usaSecundaria);
    cands = temSecundaria && comSec.length ? comSec : cands.filter((t) => !usaSecundaria(t));
  }
  const c = normCidade(cidade);
  const daCidade = (t) => (t.cidades ?? []).some((x) => normCidade(x) === c);
  const geral = (t) => !(t.cidades ?? []).length;
  const padroes = cands.filter((t) => t.padrao);
  return roda(padroes.filter(daCidade), rot)
    ?? roda(padroes.filter(geral), rot)
    ?? roda(cands.filter(daCidade), rot)
    ?? roda(cands.filter(geral), rot);
}

/** Variáveis {{1}}..{{n}} de um modelo, pela ordem de chaves_vars. */
export function variaveisDe(t, valores) {
  return (chavesDe(t) ?? []).map((k) => String(valores?.[k] ?? ''));
}
