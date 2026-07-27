-- migration_122_espelho_todos_os_deals.sql
-- Caso Escave (2º round): o sync Kommo->SH FUNCIONOU (webhook 00:01:16, cópia 00:01:17), mas o
-- lead tem DOIS deals e o gatilho espelhava só o mais recente (LIMIT 1, herdado do padrão da
-- cadência). O card duplicado antigo ficava parado na etapa velha no kanban — parecia sync
-- quebrado. Fix: T1 espelha TODOS os deals casados com o lead (as guardas G1/G2 continuam
-- valendo POR deal — um ganho nunca é rebaixado mesmo que o irmão duplicado se mova).
-- A causa raiz (deal duplicado no mesmo lead) é limpeza de dado à parte — lista pro Gabriel em
-- get_deals_duplicados(). Reverter: reaplicar kommo.trg_lead_espelho da migration_120/121.

CREATE OR REPLACE FUNCTION kommo.trg_lead_espelho()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE v_deal uuid;
BEGIN
  IF NEW.pipeline_id <> 11010459 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN RETURN NEW; END IF;
  -- TODOS os deals do lead (duplicatas inclusas) — cada um passa pelas próprias guardas
  FOR v_deal IN
    SELECT d.id FROM public.deals d
     WHERE kommo.norm_kommo_id(d.kommo_id) = NEW.id
     ORDER BY d.created_at DESC NULLS LAST
  LOOP
    PERFORM kommo.espelhar_deal(v_deal, true);
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- espelho nunca derruba o sync do Kommo
END $$;

-- lista de leads com deal duplicado (a causa raiz, pra decidir o que apagar/fundir)
CREATE OR REPLACE FUNCTION public.get_deals_duplicados()
RETURNS TABLE(kommo_id bigint, empresa text, n_deals bigint, statuses text, valores text, link_kommo text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  SELECT kommo.norm_kommo_id(d.kommo_id) AS kid,
         MAX(d.empresa),
         COUNT(*),
         string_agg(d.status, ' | ' ORDER BY d.created_at),
         string_agg(((COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
                    + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::bigint)::text, ' | ' ORDER BY d.created_at),
         'https://financeirorustonengenhariacombr.kommo.com/leads/detail/'||kommo.norm_kommo_id(d.kommo_id)
  FROM deals d
  WHERE kommo.norm_kommo_id(d.kommo_id) IS NOT NULL
  GROUP BY kommo.norm_kommo_id(d.kommo_id)
  HAVING COUNT(*) > 1
  ORDER BY COUNT(*) DESC, MAX(d.empresa);
$$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION public.get_deals_duplicados() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.get_deals_duplicados() TO authenticated, service_role;
END $$;
