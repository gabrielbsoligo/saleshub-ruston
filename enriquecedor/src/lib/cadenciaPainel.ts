// Painel "Modelos & Canal" da cadência SDNA — edge enriquecedor-cadencia com o JWT da sessão
// (ler = membro ativo; alterar = gestor). Nada aqui escreve no Kommo: só no banco do hub.
import { supabase } from './supabase';

export interface CanalCadencia {
  source_id: number; nome: string | null; telefone: string | null; ativo: boolean; vivo: boolean | null;
  limite_24h: number; verificado_em: string | null; erro: string | null;
}
export interface ModeloCadencia {
  id: string; nome: string; passo: number; versao: number; ativo: boolean; padrao: boolean; cidades: string[] | null;
  chaves_vars: string[] | null; corpo: string | null; botoes: string[]; review_status: string | null;
  kommo_template_id: string | null; kommo_bot_id: number | null; kommo_bots_por_responsavel: Record<string, number> | null;
}
export interface VinculoCadencia {
  template_id: string; source_id: number; kommo_template_id: string | null; kommo_bot_id: number | null;
  review_status: string; verificado_em: string | null; bot_verificado_em: string | null; erro: string | null;
}
export interface PainelCadencia {
  canais: CanalCadencia[]; modelos: ModeloCadencia[]; vinculos: VinculoCadencia[];
  /** conversas (cards distintos) nas últimas 24 h por source_id; 'sem_canal' = envios antigos sem canal gravado */
  volume24h: Record<string, number>;
}
export interface ResultadoSync {
  canais: { canal: number; vinculos: { nome: string; kommo_template_id: string | null; review: string; erro: string | null; sugestao: string | null; mudou: boolean }[]; sem_vinculo: { nome: string; kommo_template_id: string | null; review: string }[] }[];
  bots_conferidos: boolean;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

async function edge<T = any>(body: Record<string, unknown>): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error('faça login no SalesHub');
  const r = await fetch(`${SUPABASE_URL}/functions/v1/enriquecedor-cadencia`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await r.text(); let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = { raw: txt }; }
  if (!r.ok || j?.ok === false) throw new Error(j?.error || j?.erro || `HTTP ${r.status}`);
  return j as T;
}

export const cadenciaPainel = {
  carregar: () => edge<PainelCadencia>({ acao: 'painel' }),
  sincronizar: (source_id?: number) => edge<ResultadoSync>({ acao: 'sync-vinculos', ...(source_id ? { source_id } : {}) }),
  vincular: (p: { template: string; source_id: number; bot_id?: number | null; kommo_template_id?: string | null }) => edge<ResultadoSync>({ acao: 'vincular', ...p }),
  desvincular: (template: string, source_id: number) => edge({ acao: 'desvincular', template, source_id }),
  canal: (p: Partial<CanalCadencia> & { source_id: number }) => edge({ acao: 'canal', ...p }),
  modelo: (p: { nome: string; ativo?: boolean; padrao?: boolean; cidades?: string[] }) => edge({ acao: 'modelo', ...p }),
  importar: (nome: string, passo: number) => edge<{ modelo: { corpo: string; chaves_vars: string[] }; kommo_template_id: string }>({ acao: 'importar-modelo', nome, passo }),
};

export type Sinal = 'verde' | 'amarelo' | 'vermelho' | 'cinza';
export interface EstadoModelo { sinal: Sinal; texto: string; vinculo: VinculoCadencia | null }

/**
 * Situação de um modelo no canal ativo — mesmo critério do carteiro (vinculo.ts) e do motor
 * (cadenciaModelos.mjs): vínculo do canal manda; sem vínculo, o legado (amarelo: sai, mas o
 * hub não sabe por qual número).
 */
export function estadoModelo(m: ModeloCadencia, canalAtivo: number | null, vinculos: VinculoCadencia[]): EstadoModelo {
  const v = canalAtivo != null ? vinculos.find((x) => x.template_id === m.id && Number(x.source_id) === canalAtivo) ?? null : null;
  if (!m.chaves_vars?.length) return { sinal: 'vermelho', texto: 'sem ordem das variáveis (chaves_vars)', vinculo: v };
  if (v) {
    if (v.review_status !== 'aprovado') return { sinal: 'vermelho', texto: `Meta: ${v.review_status.replace('_', ' ')} neste número`, vinculo: v };
    if (!v.kommo_bot_id) return { sinal: 'vermelho', texto: 'sem bot neste número', vinculo: v };
    if (v.erro) return { sinal: 'vermelho', texto: v.erro, vinculo: v };
    return { sinal: m.ativo ? 'verde' : 'cinza', texto: m.ativo ? 'pronto neste número' : 'pronto, mas inativo', vinculo: v };
  }
  const temBot = !!m.kommo_bot_id || Object.keys(m.kommo_bots_por_responsavel ?? {}).length > 0;
  if (m.review_status === 'aprovado' && temBot) return { sinal: m.ativo ? 'amarelo' : 'cinza', texto: 'sem vínculo: sai pelo bot antigo (número não conferido)', vinculo: null };
  return { sinal: m.ativo ? 'vermelho' : 'cinza', texto: 'sem vínculo e sem bot/aprovação no legado', vinculo: null };
}
