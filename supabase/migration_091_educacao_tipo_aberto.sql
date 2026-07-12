-- migration_091_educacao_tipo_aberto.sql
-- Educação: abre p/ QUALQUER tipo de arquivo — remove o CHECK que limitava tipo a html/pdf/md.
-- Agora `tipo` guarda a extensão crua (docx, xlsx, png, zip, …); a categoria/preview é decidida no front.
-- ADITIVO/REVERSIVEL. Reverter: recriar o CHECK se quiser voltar a restringir.
ALTER TABLE public.materiais_educacao DROP CONSTRAINT IF EXISTS materiais_educacao_tipo_check;
