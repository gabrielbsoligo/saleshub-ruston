-- migration_125_roleta_reset_where.sql
-- BUG (report do Gabriel, 03/08): botão "Zerar rodízio" falha com
-- "UPDATE requires a WHERE clause". O banco roda com a proteção safeupdate
-- (bloqueia UPDATE/DELETE sem WHERE mesmo dentro de função) e o
-- roleta_reset() da migration_034 zera roleta_closers com UPDATE sem WHERE.
-- Fix: WHERE sempre-verdadeiro (member_id IS NOT NULL — PK, nunca nula) só
-- pra satisfazer o guard. Comportamento idêntico ao original.
-- Varredura: única função viva com UPDATE sem WHERE (o outro hit, na 096,
-- é um DO $$ one-time já executado).

CREATE OR REPLACE FUNCTION public.roleta_reset()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF get_user_role() <> 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode zerar o rodízio';
    END IF;
    UPDATE roleta_config  SET reset_ts = now(), updated_at = now() WHERE id = true;
    UPDATE roleta_closers SET base_count = 0,   updated_at = now() WHERE member_id IS NOT NULL;
END;
$$;
