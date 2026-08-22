-- Migration 142 — vínculo dos templates de cadência com o Kommo.
-- A edge function enriquecedor-cadencia cria os templates WABA no Kommo via API
-- (POST /api/v4/chats/templates + /review) e guarda aqui o id e o status da
-- moderação da Meta. kommo_bot_id aponta pro Salesbot (criado 1x na UI) que
-- envia esse template — o disparador chama POST /api/v4/bots/{id}/run.

alter table enriquecedor_cadencia_templates
  add column if not exists kommo_template_id text,
  add column if not exists review_status text not null default 'nao_submetido',
    -- nao_submetido | em_revisao | aprovado | rejeitado
  add column if not exists kommo_bot_id bigint;

alter table enriquecedor_cadencia_envios
  add column if not exists kommo_campos jsonb; -- snapshot dos campos gravados no card
