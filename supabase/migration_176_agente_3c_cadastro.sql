-- migration_176_agente_3c_cadastro.sql — responsável da tabulação do 3C vem SÓ do cadastro do usuário.
-- Caso real (28/10): lead 24372899 (HESA 95) tabulado "Conectei/Follow No Kommo" pela Arielle; ela não tinha
-- team_members.agente_3c_id nem estava no mapa fixo AGENTE_3C_KOMMO do webhook-3c-calls → o lead foi movido e o
-- responsável ficou o antigo, sem aviso. Agora:
--   * resolve_member(provider, tipo, ref): a MESMA assinatura/semântica da migration_172 (fluxo novo de ligações,
--     F4) — aqui lendo team_members direto; a 172, quando aplicada, a substitui pela versão com provider_identities
--     e o webhook continua funcionando. Identidade em 2+ membros ativos → NULL (nunca escolhe).
--   * índice único parcial: o mesmo agente do 3C não pode estar em dois membros ativos (validação no banco; a tela
--     de Equipe mostra o conflito antes de salvar).
--   * ligacoes_agente_pendencias: toda tabulação "Follow" de agente sem usuário vinculado fica registrada
--     (agente_sem_cadastro | agente_duplicado | membro_sem_kommo) e aparece na tela de Equipe até ser resolvida.
--     O lead segue sendo movido; só o responsável não é trocado. Nada de chutar por nome.
--   * ligacoes_resolver_agente_3c(...): o que o webhook-3c-calls chama (service_role).
-- Checagem antes (não pode voltar linha — senão o índice falha; resolva os duplicados na tela de Equipe):
--   select btrim(agente_3c_id) ag, array_agg(name) from team_members
--    where coalesce(active, true) and coalesce(btrim(agente_3c_id), '') <> '' group by 1 having count(*) > 1;
-- Reverter:
--   DROP VIEW IF EXISTS public.ligacoes_agente_pendencias_abertas;
--   DROP FUNCTION IF EXISTS public.ligacoes_resolver_agente_3c(text, text, bigint, text, boolean);
--   DROP TABLE IF EXISTS public.ligacoes_agente_pendencias;
--   DROP INDEX IF EXISTS public.ux_team_members_agente_3c_ativo;
--   DROP FUNCTION IF EXISTS public.resolve_member(text, text, text);   -- só se a 172 ainda não foi aplicada

CREATE UNIQUE INDEX IF NOT EXISTS ux_team_members_agente_3c_ativo
  ON public.team_members (btrim(agente_3c_id))
  WHERE COALESCE(active, true) AND COALESCE(btrim(agente_3c_id), '') <> '';

-- mesma assinatura da 172; NULL quando não há membro ativo ou quando a identidade é duplicada
CREATE OR REPLACE FUNCTION public.resolve_member(p_provider text, p_tipo text, p_ref text) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid; v_n int;
BEGIN
  IF COALESCE(btrim(p_ref), '') = '' THEN RETURN NULL; END IF;
  SELECT count(*), min(tm.id::text)::uuid INTO v_n, v FROM public.team_members tm
   WHERE COALESCE(tm.active, true)
     AND ((p_provider = 'api4com' AND p_tipo = 'extension' AND btrim(COALESCE(tm.ramal_4com, '')) = btrim(p_ref))
       OR (p_provider = '3c' AND p_tipo = 'agent_id' AND btrim(COALESCE(tm.agente_3c_id, '')) = btrim(p_ref))
       OR (p_provider = 'kommo' AND p_tipo = 'kommo_user' AND tm.kommo_user_id::text = btrim(p_ref)));
  IF v_n <> 1 THEN RETURN NULL; END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.resolve_member(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_member(text, text, text) TO authenticated, service_role;  -- a view abaixo é security_invoker

CREATE TABLE IF NOT EXISTS public.ligacoes_agente_pendencias (
  provider              text NOT NULL DEFAULT '3c',
  agent_ref             text NOT NULL,
  agent_nome            text,
  motivo                text NOT NULL CHECK (motivo IN ('agente_sem_cadastro', 'agente_duplicado', 'membro_sem_kommo')),
  ocorrencias           int NOT NULL DEFAULT 1,
  primeira_em           timestamptz NOT NULL DEFAULT now(),
  ultima_em             timestamptz NOT NULL DEFAULT now(),
  ultimo_lead_kommo_id  bigint,
  ultima_call_id        text,
  resolvida_em          timestamptz,
  PRIMARY KEY (provider, agent_ref)
);
ALTER TABLE public.ligacoes_agente_pendencias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ligacoes_agente_pendencias_select ON public.ligacoes_agente_pendencias;
CREATE POLICY ligacoes_agente_pendencias_select ON public.ligacoes_agente_pendencias
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.ligacoes_agente_pendencias FROM anon;

-- Resolve o agente do 3C → membro → usuário do Kommo. Sem resolução, registra a pendência (p_registrar).
-- Com resolução, fecha a pendência daquele agente (se havia).
CREATE OR REPLACE FUNCTION public.ligacoes_resolver_agente_3c(
  p_agent_id text, p_agent_nome text, p_lead bigint, p_call text, p_registrar boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ref text := btrim(COALESCE(p_agent_id, '')); v_member uuid; v_kommo bigint; v_nome text; v_n int; v_motivo text;
BEGIN
  IF v_ref = '' OR v_ref = '0' THEN RETURN jsonb_build_object('ok', false, 'motivo', 'sem_agente'); END IF;
  v_member := public.resolve_member('3c', 'agent_id', v_ref);
  IF v_member IS NOT NULL THEN
    SELECT kommo_user_id, name INTO v_kommo, v_nome FROM public.team_members WHERE id = v_member;
    IF v_kommo IS NOT NULL THEN
      IF p_registrar THEN
        UPDATE public.ligacoes_agente_pendencias SET resolvida_em = now()
         WHERE provider = '3c' AND agent_ref = v_ref AND resolvida_em IS NULL;
      END IF;
      RETURN jsonb_build_object('ok', true, 'member_id', v_member, 'membro', v_nome, 'kommo_user_id', v_kommo);
    END IF;
    v_motivo := 'membro_sem_kommo';
  ELSE
    SELECT count(*) INTO v_n FROM public.team_members
     WHERE COALESCE(active, true) AND btrim(COALESCE(agente_3c_id, '')) = v_ref;
    v_motivo := CASE WHEN v_n > 1 THEN 'agente_duplicado' ELSE 'agente_sem_cadastro' END;
  END IF;
  IF p_registrar THEN
    INSERT INTO public.ligacoes_agente_pendencias AS p (provider, agent_ref, agent_nome, motivo, ultimo_lead_kommo_id, ultima_call_id)
    VALUES ('3c', v_ref, NULLIF(btrim(COALESCE(p_agent_nome, '')), ''), v_motivo, p_lead, p_call)
    ON CONFLICT (provider, agent_ref) DO UPDATE SET
      agent_nome = COALESCE(excluded.agent_nome, p.agent_nome),
      motivo = excluded.motivo,
      ocorrencias = CASE WHEN p.resolvida_em IS NULL THEN p.ocorrencias + 1 ELSE 1 END,
      primeira_em = CASE WHEN p.resolvida_em IS NULL THEN p.primeira_em ELSE now() END,
      ultima_em = now(),
      ultimo_lead_kommo_id = excluded.ultimo_lead_kommo_id,
      ultima_call_id = excluded.ultima_call_id,
      resolvida_em = NULL;
  END IF;
  RETURN jsonb_build_object('ok', false, 'motivo', v_motivo, 'member_id', v_member, 'membro', v_nome);
END $$;
REVOKE ALL ON FUNCTION public.ligacoes_resolver_agente_3c(text, text, bigint, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ligacoes_resolver_agente_3c(text, text, bigint, text, boolean) TO service_role;

-- O que a tela de Equipe mostra: pendência aberta E que continua sem resolução hoje (se o gestor já cadastrou o
-- agente, some na hora, sem esperar a próxima tabulação).
CREATE OR REPLACE VIEW public.ligacoes_agente_pendencias_abertas WITH (security_invoker = true) AS
SELECT p.*
  FROM public.ligacoes_agente_pendencias p
 WHERE p.resolvida_em IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.team_members tm
      WHERE tm.id = public.resolve_member(p.provider, 'agent_id', p.agent_ref) AND tm.kommo_user_id IS NOT NULL);
GRANT SELECT ON public.ligacoes_agente_pendencias_abertas TO authenticated;
