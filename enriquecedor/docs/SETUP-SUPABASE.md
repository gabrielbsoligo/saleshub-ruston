# Banco do enriquecedor — dentro do Supabase do SalesHub

O enriquecedor usa o **mesmo projeto Supabase do SalesHub**:

- **Login/usuários:** compartilhados (Supabase Auth + tabela `team_members`). Nada a criar.
- **Dados:** tabelas próprias com prefixo `enriquecedor_` (leads, decisores, auditorias, fila,
  briefings, cadência, kommo_sync…), isoladas das tabelas do SalesHub e prontas para futura
  integração/junção.

## Ativar o modo banco (~2 min)

1. Abra o Supabase do SalesHub → **SQL Editor** → **New query**.
2. Cole todo o conteúdo de
   [`supabase/migration_136_enriquecedor.sql`](../../supabase/migration_136_enriquecedor.sql)
   (raiz do repositório) e **Run**. Deve criar as tabelas `enriquecedor_*` sem erro.
3. Pronto. Não precisa mudar env nem fazer redeploy: ao abrir, o app detecta que as tabelas
   existem e sai do modo local sozinho (veja o aviso no console do navegador enquanto não
   existirem).

## Observações

- **Enquanto a migration não rodar**, o app funciona em modo local (dados no `localStorage`
  de cada navegador) — nada quebra.
- Os **projetos/funil** (agrupamento de leads por lista e estágio do workflow) ainda são
  estado local por navegador; centralizá-los é um passo futuro.
- O **motor de enriquecimento** (`npm run server`) continua rodando local; não depende do
  Supabase.
- Migrations futuras do enriquecedor seguem a numeração do SalesHub
  (`supabase/migration_1XX_*.sql`), sempre com tabelas prefixadas `enriquecedor_`.
- RLS atual: qualquer usuário autenticado do time lê/escreve; papéis finos são aplicados na
  camada do app (refinar no banco quando a integração evoluir).
