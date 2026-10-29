-- 181 · Configuração da cadência (modelos, canais, vínculos): só a edge escreve.
--
-- Antes (140/177): authenticated FOR ALL USING(true) — qualquer login podia, direto pelo
-- PostgREST, trocar canal ativo, bot, aprovação e bot_verificado_em, contornando o
-- "só gestor" do painel. Agora:
--   * escrita: nenhuma para authenticated/anon — só a edge enriquecedor-cadencia
--     (service role), que confere gestor ativo;
--   * leitura: qualquer login, como nas demais tabelas enriquecedor_* — o motor lê com o
--     JWT do usuário de integração (integracao-enriquecedor@…), que NÃO é membro do time;
--     restringir a membro quebraria a escolha de modelos. São dados de configuração
--     (corpos de modelo, ids de bot/canal), sem dado de lead.
-- E a troca do canal ativo vira uma função numa transação só (desliga o antigo e liga
-- o novo juntos; em erro nada muda) — sem janela com zero canais ativos, em que o
-- carteiro cairia no legado.
-- Reverter: recriar as policies cad_*_all de 140/177, grant insert/update/delete a
--   authenticated nas 3 tabelas e drop function public.enriq_cadencia_ativar_canal(bigint);

do $$
declare t text;
begin
  foreach t in array array['enriquecedor_cadencia_templates', 'enriquecedor_cadencia_canais', 'enriquecedor_cadencia_vinculos'] loop
    execute format('drop policy if exists cad_templates_all on public.%I', t);
    execute format('drop policy if exists cad_canais_all on public.%I', t);
    execute format('drop policy if exists cad_vinculos_all on public.%I', t);
    execute format('drop policy if exists cad_config_leitura on public.%I', t);
    execute format('create policy cad_config_leitura on public.%I for select to authenticated using (true)', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;

create or replace function public.enriq_cadencia_ativar_canal(p_source_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from enriquecedor_cadencia_canais where source_id = p_source_id) then
    raise exception 'canal % não cadastrado', p_source_id;
  end if;
  update enriquecedor_cadencia_canais set ativo = false, updated_at = now() where ativo and source_id <> p_source_id;
  update enriquecedor_cadencia_canais set ativo = true, updated_at = now() where source_id = p_source_id;
end $$;
revoke all on function public.enriq_cadencia_ativar_canal(bigint) from public, anon, authenticated;
grant execute on function public.enriq_cadencia_ativar_canal(bigint) to service_role;
