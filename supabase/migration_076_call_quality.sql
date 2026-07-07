-- migration_076_call_quality.sql
-- Análise de qualidade de ligação (n8n -> edge callquality-ingest). Guarda a análise da API4COM
-- amarrada por call_id ao ligacoes_4com. Só a edge (service_role) escreve (upsert). Leitura via RPC.

CREATE TABLE IF NOT EXISTS public.call_quality (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id             text UNIQUE NOT NULL,          -- amarra c/ ligacoes_4com.call_id
  kommo_lead_id       bigint,
  sdr_kommo_user_id   bigint,
  sdr_id              uuid REFERENCES public.team_members(id),
  nota_final          int,                            -- 0-10
  pontos_positivos    jsonb DEFAULT '[]'::jsonb,
  pontos_negativos    jsonb DEFAULT '[]'::jsonb,      -- negativos OU oportunidades
  transcricao         text,
  analisado_em        timestamptz DEFAULT now(),
  created_at          timestamptz DEFAULT now(),
  raw                 jsonb                           -- payload cru inteiro (4com + transcricao + analise)
);
CREATE INDEX IF NOT EXISTS idx_call_quality_sdr ON public.call_quality (sdr_id);
CREATE INDEX IF NOT EXISTS idx_call_quality_analisado ON public.call_quality (analisado_em);

-- leitura p/ a tela (join com ligacoes_4com p/ duração/áudio/data; team_members p/ nome).
-- p_pendentes=true -> também retorna ligações do período SEM análise (marca visual "sem análise").
CREATE OR REPLACE FUNCTION public.get_call_quality(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL)
RETURNS TABLE(
  call_id text, sdr_id uuid, sdr_name text, nota_final int,
  pontos_positivos jsonb, pontos_negativos jsonb, transcricao text,
  record_url text, duration int, direction text, started_at timestamptz,
  kommo_lead_id bigint, analisado_em timestamptz, tem_analise boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT lg.call_id,
         COALESCE(cq.sdr_id, lg.member_id) AS sdr_id,
         tm.name AS sdr_name,
         cq.nota_final,
         COALESCE(cq.pontos_positivos,'[]'::jsonb), COALESCE(cq.pontos_negativos,'[]'::jsonb),
         cq.transcricao, lg.record_url, lg.duration, lg.direction, lg.started_at,
         cq.kommo_lead_id, cq.analisado_em,
         (cq.call_id IS NOT NULL) AS tem_analise
  FROM ligacoes_4com lg
  LEFT JOIN call_quality cq ON cq.call_id = lg.call_id
  LEFT JOIN team_members tm ON tm.id = COALESCE(cq.sdr_id, lg.member_id)
  WHERE lg.started_at >= p_from AND lg.started_at < (p_to + 1)
    AND (p_sdrs IS NULL OR COALESCE(cq.sdr_id, lg.member_id) = ANY(p_sdrs))
    AND lg.duration > 0                      -- ligações com conversa (candidatas a análise)
  ORDER BY (cq.call_id IS NOT NULL) DESC, lg.started_at DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_call_quality(date,date,uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_call_quality(date,date,uuid[]) TO authenticated, service_role;
