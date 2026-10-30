// =============================================================
// Gerador de Propostas — camada visual v2 aplicada depois da geração
// =============================================================
// Decisões do Gabriel (30/10): capa do cliente SUBSTITUI a capa institucional;
// case V4 desligado por padrão (só com opt-in do closer, com o aviso de
// Estruturação no slide); ícones, grades, números, fecho e wireframes ligados.
// A camada nunca derruba a proposta: falha vira pendência e log redigido
// (sem nome de cliente nem texto do deck).
// =============================================================
import { aplicarVisualV2, assetsDoProjeto } from './visual-v2.mjs';
import { redigir } from './redigir.mjs';

export const PENDENCIA_CASE = 'case V4 incluído a pedido do closer: confirme com a franqueadora o uso das fotos e números antes de enviar';

// dd/mm/aaaa no fuso de Brasília (data da capa).
export const dataBR = (d = new Date()) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });

export async function aplicarCamadaVisual({
  token, apresentacaoId, supabaseUrl, tipo = null, modeloVenda = null, incluirCase = false,
  hoje = new Date(), aplicar = aplicarVisualV2, log = console.error,
}) {
  const pendencias = [];
  const seguro = (t) => redigir(String(t ?? '').slice(0, 300), [token]);
  try {
    const r = await aplicar({
      token, apresentacaoId, assets: assetsDoProjeto(supabaseUrl), data: dataBR(hoje),
      capa: 'substituir', caso: incluirCase ? 'sim' : 'nao', tipo, modeloVenda,
    });
    if (r?.semIcones) {
      log(`proposta visual: aplicada sem imagens: ${seguro(r.erroIcones)}`);
      pendencias.push(`camada visual sem imagens: ${seguro(r.erroIcones)}`);
    }
    // Sem imagens, o plano B da v2 descarta o slide do case (sem a foto ele não serve).
    const comCase = (r?.resumo || []).some((s) => (s.feito || []).some((f) => String(f).startsWith('case:')));
    if (incluirCase && !comCase) pendencias.push('case V4 pedido, mas nenhum case oficial combina com esta proposta: ficou de fora');
    else if (incluirCase && r?.semIcones) pendencias.push('case V4 pedido, mas ficou de fora: a foto não carregou');
    else if (incluirCase) pendencias.push(PENDENCIA_CASE);
    return { aplicado: !!r?.aplicado, pendencias };
  } catch (e) {
    log(`proposta visual: camada não aplicada: ${seguro(e?.message)}`);
    pendencias.push(`camada visual não aplicada: ${seguro(e?.message)}`);
    return { aplicado: false, pendencias };
  }
}
