-- =============================================================
-- 187 — Gerador de Propostas: opt-in do case V4 (camada visual v2, 30/10/2026)
-- =============================================================
-- Decisão do Gabriel: o case V4 sai desligado em qualquer tipo de oferta até
-- confirmar com a franqueadora o uso das fotos e números. O closer liga por
-- proposta na aba Proposta; a automática nunca inclui.
-- =============================================================

ALTER TABLE public.propostas
  ADD COLUMN IF NOT EXISTS incluir_case boolean NOT NULL DEFAULT false;

-- Reverter:
-- ALTER TABLE public.propostas DROP COLUMN IF EXISTS incluir_case;
