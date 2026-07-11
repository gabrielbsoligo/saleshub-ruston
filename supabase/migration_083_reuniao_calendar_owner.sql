-- migration_083_reuniao_calendar_owner.sql
-- ADITIVA + IDEMPOTENTE. Rastreia em QUAL agenda o evento do Google Calendar
-- vive (o membro cujo token foi usado no create, incluindo o fallback pro
-- closer quando o SDR não tem Calendar conectado).
--
-- Bug: reagendar/cancelar apagava o evento mirando sdr_id||closer_id (palpite).
-- Se o evento foi criado na agenda do CLOSER (fallback), o delete errava o alvo
-- e falhava em silêncio => evento duplicado / lixo vivo. Com o dono persistido,
-- delete/patch acertam a agenda certa.

ALTER TABLE public.reunioes
  ADD COLUMN IF NOT EXISTS calendar_owner_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.reunioes.calendar_owner_id IS
  'Membro cuja agenda Google hospeda o calendar_event_id (organizer efetivo, inclui fallback pro closer). Usado por delete/patch do evento.';

-- Backfill leve, GO-FORWARD: reuniões FUTURAS com evento mas sem dono.
-- Inferência segura pela conexão atual: SDR conectado -> SDR; senão closer
-- conectado -> closer; senão deixa null (fix vale daqui pra frente).
UPDATE public.reunioes r
SET calendar_owner_id = sub.owner
FROM (
  SELECT r2.id,
         CASE
           WHEN ts.google_calendar_connected THEN r2.sdr_id
           WHEN tc.google_calendar_connected THEN r2.closer_id
           ELSE NULL
         END AS owner
  FROM public.reunioes r2
  LEFT JOIN public.team_members ts ON ts.id = r2.sdr_id
  LEFT JOIN public.team_members tc ON tc.id = r2.closer_id
  WHERE r2.calendar_event_id IS NOT NULL
    AND r2.calendar_owner_id IS NULL
    AND r2.data_reuniao >= now()
) sub
WHERE r.id = sub.id AND sub.owner IS NOT NULL;
