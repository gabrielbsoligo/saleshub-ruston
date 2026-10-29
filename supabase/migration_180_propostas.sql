-- migration_180_propostas.sql
-- ADITIVA + IDEMPOTENTE. Gerador de Propostas para Closers (teste, 29/10/2026).
--
-- propostas_config: chave única (linha id=true). auto_ativo liga/desliga o gatilho
--   automático pós-análise (começa DESLIGADO). template_id = Slides preparado
--   (cópia de teste do deck EE 2026). conta_reserva_member_id = conta Google usada
--   se a do closer falhar (Gabriel, decisão de 29/10).
-- propostas: fila + histórico. Envio ao cliente é SEMPRE manual (status 'enviada'
--   só por ação do closer na UI); nada aqui envia nada.
-- Gatilho automático: quando a automação pós-reunião termina a análise
--   (status 'applying' ou 'completed'), e auto_ativo = true, entra uma proposta
--   'pendente' (origem 'auto'). Quem processa é a edge proposta-gerar, chamada no
--   tick que já existe da edge google-drive (sem cron novo).

CREATE TABLE IF NOT EXISTS public.propostas_config (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  auto_ativo              boolean NOT NULL DEFAULT false,
  template_id             text,
  dominio                 text NOT NULL DEFAULT 'v4company.com',
  conta_reserva_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  pasta_id                text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.propostas_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.propostas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               uuid NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  reuniao_id            uuid REFERENCES public.reunioes(id) ON DELETE SET NULL,
  origem                text NOT NULL CHECK (origem IN ('manual', 'auto')),
  status                text NOT NULL DEFAULT 'pendente'
                          CHECK (status IN ('pendente', 'analisando', 'gerando', 'revisao', 'erro', 'enviada', 'descartada')),
  solicitado_por        uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  transcricao_manual    text,
  escopo                jsonb,
  pendencias            jsonb NOT NULL DEFAULT '[]'::jsonb,
  provedor_llm          text,
  presentation_id       text,
  url                   text,
  gerado_com_member_id  uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  erro                  text,
  visto_em              timestamptz,
  enviada_em            timestamptz,
  enviada_por           uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_propostas_deal ON public.propostas(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_propostas_pendentes ON public.propostas(created_at) WHERE status IN ('pendente', 'analisando', 'gerando');
-- uma proposta automática por reunião
CREATE UNIQUE INDEX IF NOT EXISTS uq_propostas_auto_reuniao ON public.propostas(reuniao_id) WHERE origem = 'auto';

-- RLS: membros leem; closer do deal e gestor atualizam (enviar/descartar/visto).
-- Inserção e processamento: só pela edge (service_role).
ALTER TABLE public.propostas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.propostas_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS propostas_select ON public.propostas;
CREATE POLICY propostas_select ON public.propostas
  FOR SELECT USING (get_member_id() IS NOT NULL);

DROP POLICY IF EXISTS propostas_update ON public.propostas;
CREATE POLICY propostas_update ON public.propostas
  FOR UPDATE USING (
    get_user_role() = 'gestor'
    OR EXISTS (SELECT 1 FROM public.deals d WHERE d.id = propostas.deal_id AND d.closer_id = get_member_id())
  );

DROP POLICY IF EXISTS propostas_config_select ON public.propostas_config;
CREATE POLICY propostas_config_select ON public.propostas_config
  FOR SELECT USING (get_member_id() IS NOT NULL);

DROP POLICY IF EXISTS propostas_config_update ON public.propostas_config;
CREATE POLICY propostas_config_update ON public.propostas_config
  FOR UPDATE USING (get_user_role() = 'gestor') WITH CHECK (get_user_role() = 'gestor');

-- Pela UI (usuário logado) só mudam: status (revisao→enviada; revisao/erro/enviada→
-- descartada) e visto_em (uma vez). Allowlist: qualquer outra coluna diferente é
-- recusada. enviada_em/enviada_por/visto_em são calculados aqui, não aceitos do cliente.
-- service_role (edge) não tem auth.uid() e passa.
CREATE OR REPLACE FUNCTION public.propostas_guarda_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  livres text[] := ARRAY['status', 'visto_em', 'enviada_em', 'enviada_por', 'updated_at'];
BEGIN
  NEW.updated_at := now();
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;

  IF (to_jsonb(NEW) - livres) IS DISTINCT FROM (to_jsonb(OLD) - livres) THEN
    RAISE EXCEPTION 'propostas: pela UI só é possível marcar enviada/descartada ou visto';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((NEW.status = 'enviada' AND OLD.status = 'revisao')
            OR (NEW.status = 'descartada' AND OLD.status IN ('revisao', 'erro', 'enviada'))) THEN
      RAISE EXCEPTION 'propostas: transição % -> % não permitida pela UI', OLD.status, NEW.status;
    END IF;
  END IF;

  IF NEW.status = 'enviada' AND OLD.status IS DISTINCT FROM 'enviada' THEN
    NEW.enviada_em := now();
    NEW.enviada_por := get_member_id();
  ELSE
    NEW.enviada_em := OLD.enviada_em;
    NEW.enviada_por := OLD.enviada_por;
  END IF;

  NEW.visto_em := CASE
    WHEN OLD.visto_em IS NULL AND NEW.visto_em IS NOT NULL THEN now()
    ELSE OLD.visto_em
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_propostas_guarda_update ON public.propostas;
CREATE TRIGGER trg_propostas_guarda_update BEFORE UPDATE ON public.propostas
  FOR EACH ROW EXECUTE FUNCTION public.propostas_guarda_update();

-- Gatilho automático: análise pós-reunião concluída → proposta pendente.
CREATE OR REPLACE FUNCTION public.propostas_enfileirar_auto()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status NOT IN ('applying', 'completed') OR NEW.deal_id IS NULL OR NEW.reuniao_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('applying', 'completed') THEN
    RETURN NEW;  -- já enfileirada na primeira transição
  END IF;
  IF NOT COALESCE((SELECT auto_ativo FROM public.propostas_config WHERE id), false) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.propostas (deal_id, reuniao_id, origem, status)
  VALUES (NEW.deal_id, NEW.reuniao_id, 'auto', 'pendente')
  ON CONFLICT (reuniao_id) WHERE origem = 'auto' DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_propostas_enfileirar_auto ON public.post_meeting_automations;
CREATE TRIGGER trg_propostas_enfileirar_auto
  AFTER INSERT OR UPDATE OF status ON public.post_meeting_automations
  FOR EACH ROW EXECUTE FUNCTION public.propostas_enfileirar_auto();

COMMENT ON TABLE public.propostas IS
  'Propostas geradas no Google Slides (gerador de propostas). Envio ao cliente é manual (status enviada só pela UI do closer).';
