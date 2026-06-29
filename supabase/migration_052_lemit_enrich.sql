-- migration_052_lemit_enrich.sql
-- Enriquecimento Lemit na importação: marca leads p/ buscar sócios e criar contatos no Kommo.
-- Aditivo/reversível. O lead é criado no Kommo normalmente; o enriquecimento roda assíncrono.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS enriquecer_lemit BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS lemit_enriched_at TIMESTAMPTZ;     -- null = pendente
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS lemit_socios_count INT;            -- nº de sócios processados
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS lemit_erro TEXT;                   -- último erro (se houver)

-- índice p/ a fila de enriquecimento (pendentes com cnpj e já criados no Kommo)
CREATE INDEX IF NOT EXISTS ix_leads_enrich_fila ON public.leads (enriquecer_lemit, lemit_enriched_at)
  WHERE enriquecer_lemit AND lemit_enriched_at IS NULL;
