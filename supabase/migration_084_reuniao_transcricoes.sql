-- migration_084_reuniao_transcricoes.sql
-- ADITIVA + IDEMPOTENTE. Transcrições 1-pra-muitos com a reunião (espelha o
-- molde de `recomendacoes`). Uma reunião do Meet tem N sessões (cliente cai e
-- reentra) => N Docs de transcrição no Drive. Antes só cabia 1 => resumo pós-call
-- pegava 1 sessão (às vezes a incompleta) e vinha vazio.
--
-- Fonte-da-verdade das transcrições passa a ser esta tabela. deals.link_transcricao
-- e post_meeting_automations.transcript_text ficam como legado/cache (preservados).

CREATE TABLE IF NOT EXISTS public.reuniao_transcricoes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reuniao_id     uuid NOT NULL REFERENCES public.reunioes(id) ON DELETE CASCADE,
  sessao         int,                       -- ordem cronológica (1,2,3…)
  fonte          text NOT NULL DEFAULT 'google_meet' CHECK (fonte IN ('google_meet','manual')),
  titulo         text,
  transcript_url text,
  transcript_text text,
  recording_url  text,
  drive_file_id  text,                       -- id do Doc no Drive (dedup); 'migrated:<pma_id>' no backfill
  started_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reuniao_id, drive_file_id)
);

CREATE INDEX IF NOT EXISTS idx_reuniao_transcricoes_reuniao ON public.reuniao_transcricoes(reuniao_id, sessao);

-- RLS: leitura pra qualquer membro autenticado (Fatia 2/UI); escrita via service_role
-- (edge google-drive, bypassa RLS) ou gestor.
ALTER TABLE public.reuniao_transcricoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reuniao_transcricoes_select ON public.reuniao_transcricoes;
CREATE POLICY reuniao_transcricoes_select ON public.reuniao_transcricoes
  FOR SELECT USING (get_member_id() IS NOT NULL);

DROP POLICY IF EXISTS reuniao_transcricoes_write ON public.reuniao_transcricoes;
CREATE POLICY reuniao_transcricoes_write ON public.reuniao_transcricoes
  FOR ALL USING (get_user_role() = 'gestor') WITH CHECK (get_user_role() = 'gestor');

COMMENT ON TABLE public.reuniao_transcricoes IS
  'Transcrições/gravações por SESSÃO de uma reunião (1-pra-muitos). Preenchida pela edge google-drive (auto-pull de todas as sessões do calendar_event_id). Fonte-da-verdade das transcrições.';

-- ------------------------------------------------------------------
-- BACKFILL (D): 1 linha por automation com transcript_text, sem perder nada.
-- Idempotente: drive_file_id sintético 'migrated:<pma_id>' + ON CONFLICT DO NOTHING,
-- e só quando ainda não há nenhuma transcrição pra aquela reunião.
-- ------------------------------------------------------------------
INSERT INTO public.reuniao_transcricoes
  (reuniao_id, sessao, fonte, titulo, transcript_url, transcript_text, recording_url, drive_file_id, started_at)
SELECT
  pma.reuniao_id,
  1,
  'google_meet',
  'Transcrição (migrada)',
  d.link_transcricao,
  pma.transcript_text,
  NULLIF(pma.actions_taken->>'recording_url',''),
  'migrated:' || pma.id::text,
  r.data_reuniao
FROM public.post_meeting_automations pma
JOIN public.reunioes r ON r.id = pma.reuniao_id
LEFT JOIN public.deals d ON d.id = pma.deal_id
WHERE pma.transcript_text IS NOT NULL
  AND length(btrim(pma.transcript_text)) > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.reuniao_transcricoes rt WHERE rt.reuniao_id = pma.reuniao_id
  )
ON CONFLICT (reuniao_id, drive_file_id) DO NOTHING;
