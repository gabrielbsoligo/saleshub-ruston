-- =============================================================
-- 185 — Gerador de Propostas: tipo de oferta e deck curto (P1/P6, 30/10/2026)
-- =============================================================
-- propostas.tipo_oferta: escolhido pelo closer ao gerar (null = a IA classifica).
-- propostas_config.slides_curto: objectIds dos slides institucionais do template
-- que ficam no deck curto (implementação / execução); o resto é apagado na cópia.
-- Reverter: ver o bloco no fim.
-- =============================================================

ALTER TABLE public.propostas
  ADD COLUMN IF NOT EXISTS tipo_oferta text
  CHECK (tipo_oferta IS NULL OR tipo_oferta IN ('estruturacao', 'implementacao', 'execucao', 'implementacao_e_execucao'));

ALTER TABLE public.propostas_config
  ADD COLUMN IF NOT EXISTS slides_curto text[] NOT NULL DEFAULT '{}';

-- Template EE 2026 preparado do teste: capa, "maior assessoria", clientes, método V4.
UPDATE public.propostas_config
   SET slides_curto = ARRAY['g3f5a32b911e_0_1', 'g3f5a32b911e_0_33', 'g3653abf4b20_0_133', 'g3f5a32b911e_0_45']
 WHERE id = true AND template_id = '1AziIiaKNXC_x7CIIOJ_O1tMM7uwyoP08f_Crm7B4N5A';

-- Reverter:
-- ALTER TABLE public.propostas DROP COLUMN IF EXISTS tipo_oferta;
-- ALTER TABLE public.propostas_config DROP COLUMN IF EXISTS slides_curto;
