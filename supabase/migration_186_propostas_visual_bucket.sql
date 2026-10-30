-- migration_186: bucket público dos ícones da camada visual das propostas.
-- PNGs sem dado de cliente (Lucide, ISC), servidos em
-- storage/v1/object/public/propostas-visual/icones/<versao>/. O Slides baixa a
-- imagem uma vez, na inserção; o deck não depende do bucket depois.
-- Leitura pública (bucket public); escrita só com service_role (sem policy de insert).
-- Upload dos arquivos: node propostas/visual/publicar-icones.mjs (não cria bucket).
--
-- Rollback:
--   delete from storage.objects where bucket_id = 'propostas-visual';
--   delete from storage.buckets where id = 'propostas-visual';

insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values ('propostas-visual', 'propostas-visual', true, '{image/png}', 1048576)
on conflict (id) do update
  set public = excluded.public,
      allowed_mime_types = excluded.allowed_mime_types,
      file_size_limit = excluded.file_size_limit;
