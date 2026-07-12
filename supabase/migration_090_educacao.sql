-- migration_090_educacao.sql
-- Seção "Educação" (ex-Playbook): biblioteca de materiais (HTML/PDF/MD) com título,
-- descrição, data de atualização e busca full-text (conteudo_texto extraído no upload).
-- ADITIVO. RLS desabilitado na tabela (mesmo padrão das tabelas do app / anon key).
-- Reverter: DROP TABLE public.materiais_educacao; + remover bucket/policies 'educacao'.

CREATE TABLE IF NOT EXISTS public.materiais_educacao (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo         text NOT NULL,
  descricao      text,
  tipo           text NOT NULL CHECK (tipo IN ('html','pdf','md')),
  storage_path   text,                 -- caminho no bucket 'educacao' (null p/ o playbook estático)
  file_url       text NOT NULL,        -- URL pública p/ visualizar (iframe)
  conteudo_texto text,                 -- texto extraído (busca full-text): md=cru, html/pdf=texto
  tamanho_bytes  bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_materiais_educacao_updated ON public.materiais_educacao (updated_at DESC);
-- busca por título/descrição/conteúdo (trigram p/ ilike rápido)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_materiais_educacao_busca ON public.materiais_educacao
  USING gin ((coalesce(titulo,'')||' '||coalesce(descricao,'')||' '||coalesce(conteudo_texto,'')) gin_trgm_ops);

-- bucket público (mesmo padrão do 'contracts')
INSERT INTO storage.buckets (id, name, public) VALUES ('educacao','educacao',true)
ON CONFLICT (id) DO NOTHING;

-- policies de storage escopadas ao bucket (espelham contracts_*)
DROP POLICY IF EXISTS educacao_select ON storage.objects;
DROP POLICY IF EXISTS educacao_insert ON storage.objects;
DROP POLICY IF EXISTS educacao_update ON storage.objects;
DROP POLICY IF EXISTS educacao_delete ON storage.objects;
CREATE POLICY educacao_select ON storage.objects FOR SELECT USING (bucket_id='educacao');
CREATE POLICY educacao_insert ON storage.objects FOR INSERT WITH CHECK (bucket_id='educacao');
CREATE POLICY educacao_update ON storage.objects FOR UPDATE USING (bucket_id='educacao');
CREATE POLICY educacao_delete ON storage.objects FOR DELETE USING (bucket_id='educacao');

-- migra o Playbook de Pré-Vendas atual como primeiro material (HTML estático em public/)
INSERT INTO public.materiais_educacao (titulo, descricao, tipo, storage_path, file_url, conteudo_texto)
SELECT 'Playbook de Pré-Vendas V4',
       'Cadências, scripts e regras do time SDR/BDR.',
       'html', NULL, '/playbook_pre_vendas_v4.html',
       'Playbook de Pré-Vendas V4 cadências scripts regras SDR BDR pré-vendas'
WHERE NOT EXISTS (SELECT 1 FROM public.materiais_educacao WHERE file_url='/playbook_pre_vendas_v4.html');
