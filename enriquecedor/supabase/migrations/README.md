# Schema do enriquecedor → mudou de lugar

O banco do enriquecedor agora vive **dentro do Supabase do SalesHub**, com todas as
tabelas prefixadas com `enriquecedor_` (para não colidir com as tabelas do SalesHub e
facilitar a futura integração dos dados).

- Migration atual: [`../../../supabase/migration_136_enriquecedor.sql`](../../../supabase/migration_136_enriquecedor.sql)
  (rodar no SQL Editor do Supabase do SalesHub).
- Migrations futuras do enriquecedor seguem a numeração do SalesHub
  (`supabase/migration_1XX_*.sql` na raiz do repositório), sempre com tabelas
  prefixadas com `enriquecedor_`.
- A antiga `0001_init.sql` (projeto Supabase próprio, tabelas sem prefixo) foi
  substituída por essa migration e removida — está no histórico do git se precisar.
