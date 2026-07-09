-- migration_080_metas_atividade.sql
-- ADITIVA + IDEMPOTENTE. Estende public.metas com metas de ATIVIDADE (base DIÁRIA)
-- por SDR × indicador: ligações, conexões, agendados, realizados, fechados.
-- Não dropa/renomeia nada; defaults 0; não quebra a seção Metas atual.
-- Semanal = diária×5, Mensal = diária×dias úteis — derivado no cliente, NÃO gravado.

ALTER TABLE public.metas ADD COLUMN IF NOT EXISTS meta_ligacoes_dia   integer NOT NULL DEFAULT 0;
ALTER TABLE public.metas ADD COLUMN IF NOT EXISTS meta_conexoes_dia   integer NOT NULL DEFAULT 0;
ALTER TABLE public.metas ADD COLUMN IF NOT EXISTS meta_agendados_dia  integer NOT NULL DEFAULT 0;
ALTER TABLE public.metas ADD COLUMN IF NOT EXISTS meta_realizados_dia integer NOT NULL DEFAULT 0;
ALTER TABLE public.metas ADD COLUMN IF NOT EXISTS meta_fechados_dia   integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.metas.meta_ligacoes_dia   IS 'Meta de atividade base DIÁRIA — ligações. Semanal=×5, mensal=×dias úteis (derivado no cliente).';
COMMENT ON COLUMN public.metas.meta_conexoes_dia   IS 'Meta base DIÁRIA — conexões (proxy: ligações atendidas).';
COMMENT ON COLUMN public.metas.meta_agendados_dia  IS 'Meta base DIÁRIA — reuniões agendadas.';
COMMENT ON COLUMN public.metas.meta_realizados_dia IS 'Meta base DIÁRIA — reuniões realizadas (com show).';
COMMENT ON COLUMN public.metas.meta_fechados_dia   IS 'Meta base DIÁRIA — contratos fechados. Realizado por SDR sem fonte confiável (fonte externa/financeiro).';
