-- migration_130_recomendacao_contexto.sql
-- Pedido do Gabriel (04/08): campo opcional CONTEXTO ao adicionar recomendação no modal de
-- negociação. Quando preenchido, vira NOTA no lead do Kommo DEPOIS que o lead é criado lá.
-- O kommo_id chega assíncrono (sync_lead_to_kommo -> edge -> UPDATE leads.kommo_id), então a
-- nota é disparada por gatilho quando o vínculo aparecer. Dois gatilhos cobrem a corrida:
--   T-A em public.leads (UPDATE OF kommo_id): kommo_id chegou -> posta contexto pendente.
--   T-B em public.recomendacoes (INSERT/UPDATE OF contexto): recomendação chegou depois e o
--        lead JÁ tem kommo_id -> posta na hora.
-- Idempotência: recomendacoes.contexto_nota_req_id (id do net.http_post) marca o que já foi.
-- Envio: edge kommo-writeback v3 ({note_text} -> POST /api/v4/leads/{id}/notes).
-- Reverter: DROP TRIGGER trg_lead_contexto_nota ON leads; DROP TRIGGER trg_rec_contexto_nota
--   ON recomendacoes; DROP FUNCTION fn_postar_contexto_recomendacao(uuid), fn_lead_contexto_nota(),
--   fn_rec_contexto_nota(); (colunas ficam).

ALTER TABLE public.recomendacoes ADD COLUMN IF NOT EXISTS contexto TEXT;
ALTER TABLE public.recomendacoes ADD COLUMN IF NOT EXISTS contexto_nota_req_id BIGINT;

-- núcleo: posta a nota de contexto de todas as recomendações pendentes de um lead criado
CREATE OR REPLACE FUNCTION public.fn_postar_contexto_recomendacao(p_lead_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, kommo AS $$
DECLARE v_kid BIGINT; v_secret TEXT; v_req BIGINT; r RECORD; v_texto TEXT;
BEGIN
  SELECT kommo.norm_kommo_id(l.kommo_id) INTO v_kid FROM public.leads l WHERE l.id = p_lead_id;
  IF v_kid IS NULL THEN RETURN; END IF;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  IF v_secret IS NULL THEN RETURN; END IF;
  FOR r IN SELECT rc.id, rc.contexto, d.empresa AS deal_empresa, tm.name AS closer
           FROM public.recomendacoes rc
           LEFT JOIN public.deals d ON d.id = rc.deal_id
           LEFT JOIN public.team_members tm ON tm.id = rc.closer_id
           WHERE rc.lead_criado_id = p_lead_id
             AND NULLIF(btrim(rc.contexto),'') IS NOT NULL
             AND rc.contexto_nota_req_id IS NULL
  LOOP
    v_texto := '💬 Contexto da recomendação (SalesHub)'
            || COALESCE(' — indicado por '||r.deal_empresa, '')
            || COALESCE(' · coletado por '||r.closer, '')
            || E'\n\n' || r.contexto;
    SELECT net.http_post(
      url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-writeback',
      body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kid, 'note_text', v_texto),
      headers := jsonb_build_object('Content-Type','application/json')
    ) INTO v_req;
    UPDATE public.recomendacoes SET contexto_nota_req_id = v_req WHERE id = r.id;
  END LOOP;
END $$;

-- T-A: kommo_id acabou de chegar no lead
CREATE OR REPLACE FUNCTION public.fn_lead_contexto_nota()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.kommo_id IS NOT NULL AND (OLD.kommo_id IS NULL OR OLD.kommo_id = '') THEN
    PERFORM public.fn_postar_contexto_recomendacao(NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_lead_contexto_nota ON public.leads;
CREATE TRIGGER trg_lead_contexto_nota
  AFTER UPDATE OF kommo_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.fn_lead_contexto_nota();

-- T-B: recomendação com contexto entrou (ou ganhou contexto) e o lead já tem kommo_id
CREATE OR REPLACE FUNCTION public.fn_rec_contexto_nota()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_criado_id IS NOT NULL AND NULLIF(btrim(NEW.contexto),'') IS NOT NULL
     AND NEW.contexto_nota_req_id IS NULL THEN
    PERFORM public.fn_postar_contexto_recomendacao(NEW.lead_criado_id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_rec_contexto_nota ON public.recomendacoes;
CREATE TRIGGER trg_rec_contexto_nota
  AFTER INSERT OR UPDATE OF contexto ON public.recomendacoes
  FOR EACH ROW EXECUTE FUNCTION public.fn_rec_contexto_nota();
