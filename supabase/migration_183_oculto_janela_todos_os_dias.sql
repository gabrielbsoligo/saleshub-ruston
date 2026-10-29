-- migration_183 — Cliente oculto: janela de atendimento da persona = todos os dias 07:00–22:00 (só não de madrugada).
-- Pedido do Gabriel (29/10): "um cliente normal responde a qualquer hora, só não de madrugada".
-- ADITIVA e idempotente.
--   * janela_dias  (TEXT '0,1,2,3,4,5,6'; 0=dom … 6=sáb): dias ativos, configuráveis no botão Ritmo da tela.
--   * padrões de janela_inicio/janela_fim passam a 07:00/22:00 e a linha atual (id=1) é atualizada para isso.
--   * janela_sabado_fim (migration_182) sai: os dias ativos cobrem sábado e domingo com a mesma janela.
--   Madrugada (22:00–07:00) continua esperando a manhã, com a folga aleatória de 0–15 min na abertura da janela.
-- Reverter: ALTER TABLE public.oculto_config ADD COLUMN janela_sabado_fim TEXT DEFAULT NULL;
--   UPDATE public.oculto_config SET janela_inicio='08:00', janela_fim='18:00' WHERE id=1;
--   ALTER TABLE public.oculto_config DROP COLUMN janela_dias; (e restaurar os DEFAULT 08:00/18:00)

ALTER TABLE public.oculto_config
  ADD COLUMN IF NOT EXISTS janela_dias TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6' CHECK (janela_dias ~ '^[0-6](,[0-6])*$');

ALTER TABLE public.oculto_config ALTER COLUMN janela_inicio SET DEFAULT '07:00';
ALTER TABLE public.oculto_config ALTER COLUMN janela_fim    SET DEFAULT '22:00';

ALTER TABLE public.oculto_config DROP CONSTRAINT IF EXISTS oculto_config_janela_ordem;
ALTER TABLE public.oculto_config ADD CONSTRAINT oculto_config_janela_ordem CHECK (janela_fim > janela_inicio);
ALTER TABLE public.oculto_config DROP COLUMN IF EXISTS janela_sabado_fim;

-- só troca os padrões antigos (08–18 da migration_182): reaplicar não desfaz um Ritmo ajustado pelo gestor
UPDATE public.oculto_config SET janela_inicio = '07:00', janela_fim = '22:00', janela_dias = '0,1,2,3,4,5,6', atualizado_em = now() WHERE id = 1 AND janela_inicio = '08:00' AND janela_fim = '18:00';
