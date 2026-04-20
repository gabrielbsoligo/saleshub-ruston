// =============================================================
// useRecomendacoesDraft — centraliza coleta de recomendacoes
// =============================================================
// Antes: logica duplicada em FeedbackDrawer.tsx e DealDrawer.tsx.
// Atualizacao num lugar nao replicava no outro (bug recente: campos
// "Quem Recomendou" + "Closer que Coletou" so funcionavam no Feedback).
//
// Interface pequena (7 exports), implementacao profunda:
// - carrega existentes da tabela `recomendacoes` (useEffect em dealId)
// - mantem drafts locais
// - saveDrafts(ctx) monta recomendado_por/coletado_por_closer_nome e
//   faz INSERT de lead + recomendacao pra cada draft valida
// - recarrega existentes apos save
// =============================================================

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Lead } from '../types';

export interface Draft {
  empresa: string;
  nome_contato: string;
  telefone: string;
}

// Recomendacao existente ja vem com o lead criado em JOIN.
// Se o lead foi apagado (lead_criado_id IS NULL), a recomendacao nao
// aparece — aponta pra "recomendacoes orfas" que nao servem mais.
export interface ExistingRecomendacao {
  id: string;
  created_at: string;
  lead_criado_id: string;
  lead: {
    id: string;
    empresa: string;
    nome_contato: string | null;
    telefone: string | null;
    status: string;
    kommo_link: string | null;
  };
}

export interface SaveContext {
  dealId: string;
  dealEmpresa: string;
  dealSdrId?: string | null;
  closerId?: string | null;     // closer que coletou (pra recomendacoes.closer_id)
  closerName?: string | null;   // nome do closer (pra kommo "Closer que Coletou")
  leadOrigem?: Lead | null;     // lead original do deal (pra pegar nome_contato)
}

export interface UseRecomendacoesDraftResult {
  existing: ExistingRecomendacao[];
  drafts: Draft[];
  addDraft: () => void;
  updateDraft: (index: number, patch: Partial<Draft>) => void;
  removeDraft: (index: number) => void;
  setDrafts: (drafts: Draft[]) => void;  // bulk replace (usado por AI auto-fill)
  saveDrafts: (ctx: SaveContext) => Promise<number>;
  reloadExisting: () => Promise<void>;
}

const EMPTY_DRAFT: Draft = { empresa: '', nome_contato: '', telefone: '' };

export function useRecomendacoesDraft(dealId: string | null | undefined): UseRecomendacoesDraftResult {
  const [existing, setExisting] = useState<ExistingRecomendacao[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const reloadExisting = useCallback(async () => {
    if (!dealId) {
      setExisting([]);
      return;
    }
    // JOIN com leads via FK lead_criado_id. Inner join (not null) garante
    // que so retorna recomendacoes cujo lead ainda existe — se alguem
    // apagou o lead, a recomendacao some daqui.
    const { data } = await supabase
      .from('recomendacoes')
      .select('id, created_at, lead_criado_id, lead:leads!lead_criado_id(id, empresa, nome_contato, telefone, status, kommo_link)')
      .eq('deal_id', dealId)
      .not('lead_criado_id', 'is', null)
      .order('created_at', { ascending: false });

    // Descarta linhas em que o JOIN devolveu null (lead deletado mesmo com FK set null)
    const valid = (data || []).filter((r: any) => r.lead);
    setExisting(valid as unknown as ExistingRecomendacao[]);
  }, [dealId]);

  useEffect(() => {
    reloadExisting();
  }, [reloadExisting]);

  const addDraft = useCallback(() => {
    setDrafts(prev => [...prev, { ...EMPTY_DRAFT }]);
  }, []);

  const updateDraft = useCallback((index: number, patch: Partial<Draft>) => {
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }, []);

  const removeDraft = useCallback((index: number) => {
    setDrafts(prev => prev.filter((_, i) => i !== index));
  }, []);

  const saveDrafts = useCallback(async (ctx: SaveContext): Promise<number> => {
    const valid = drafts.filter(r => r.empresa.trim());
    if (valid.length === 0) return 0;

    // Monta strings pro Kommo uma vez so (todas as recs do mesmo deal sao do mesmo origem)
    const contatoOrigem = ctx.leadOrigem?.nome_contato?.trim();
    const recomendadoPor = contatoOrigem
      ? `${contatoOrigem} - ${ctx.dealEmpresa}`
      : ctx.dealEmpresa;
    const coletorNome = ctx.closerName?.trim() || null;

    for (const rec of valid) {
      const empresa = rec.empresa.trim();
      const nomeContato = rec.nome_contato.trim() || null;
      const telefone = rec.telefone.trim() || null;

      const { data: newLead } = await supabase
        .from('leads')
        .insert({
          empresa,
          nome_contato: nomeContato,
          telefone,
          canal: 'recomendacao',
          status: 'sem_contato',
          sdr_id: ctx.dealSdrId || null,
          recomendado_por: recomendadoPor,
          coletado_por_closer_nome: coletorNome,
        })
        .select('id')
        .single();

      await supabase.from('recomendacoes').insert({
        deal_id: ctx.dealId,
        closer_id: ctx.closerId || null,
        sdr_id: ctx.dealSdrId || null,
        empresa,
        nome_contato: nomeContato,
        telefone,
        lead_criado_id: newLead?.id || null,
      });
    }

    setDrafts([]);
    await reloadExisting();
    return valid.length;
  }, [drafts, reloadExisting]);

  return {
    existing,
    drafts,
    addDraft,
    updateDraft,
    removeDraft,
    setDrafts,
    saveDrafts,
    reloadExisting,
  };
}
