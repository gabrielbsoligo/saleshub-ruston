import { authConfigured, supabase } from './supabase';

// Log persistente de erros (tabela enriquecedor_error_log no banco do
// SalesHub) — permite auditar depois o que falhou, por lead e etapa, e
// corrigir os erros recorrentes. Registrar NUNCA pode quebrar o fluxo:
// tudo aqui é best-effort.
export async function registrarErro(e: {
  etapa: string;
  empresa?: string | null;
  cnpj?: string | null;
  mensagem: string;
  detalhe?: unknown;
}): Promise<void> {
  console.warn(`[erro] ${e.etapa}${e.empresa ? ` · ${e.empresa}` : ''}: ${e.mensagem}`);
  if (!authConfigured) return; // dev sem Supabase: só console
  try {
    let detalhe: unknown = null;
    try {
      detalhe = e.detalhe == null ? null : JSON.parse(JSON.stringify(e.detalhe));
    } catch {
      detalhe = String(e.detalhe);
    }
    await supabase.from('enriquecedor_error_log').insert({
      origem: 'app',
      etapa: e.etapa,
      empresa: e.empresa ?? null,
      cnpj: e.cnpj ?? null,
      mensagem: e.mensagem.slice(0, 2000),
      detalhe,
    });
  } catch {
    // sem rede/sem sessão — o erro original já está no console
  }
}
