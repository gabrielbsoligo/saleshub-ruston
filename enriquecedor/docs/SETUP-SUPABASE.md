# Guia — criar o projeto Supabase do SDNA Outbound

> **Atualização (integração com o SalesHub):** o **login já é o do SalesHub** — mesma
> sessão/usuários (`team_members`), via `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`.
> Este guia agora vale só para o banco de **DADOS** próprio do enriquecedor, que usa as
> variáveis `VITE_ENRIQUECEDOR_SUPABASE_URL`/`VITE_ENRIQUECEDOR_SUPABASE_ANON_KEY`.
> O passo 5 (usuário admin em `user_profiles`) ficou obsoleto.

Enquanto não há projeto Supabase de dados, a ferramenta roda em **modo local** (dados no navegador). Para persistir de verdade, siga este passo a passo (~10 min). **Não faz deploy** — só cria o banco.

## 1. Criar o projeto
1. Acesse https://supabase.com e faça login.
2. **New project** → nome `sdna-outbound`, escolha uma senha forte de banco, região **South America (São Paulo)**.
3. Aguarde ~2 min provisionar.

## 2. Rodar o schema
1. No projeto: menu **SQL Editor** → **New query**.
2. Cole todo o conteúdo de [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql).
3. **Run**. Deve criar todas as tabelas sem erro.

## 3. Pegar as credenciais
1. Menu **Project Settings → API**.
2. Copie **Project URL** e a chave **anon public**.

## 4. Configurar a ferramenta
1. Na pasta do projeto, copie `.env.example` para `.env.local`.
2. Preencha:
   ```
   VITE_ENRIQUECEDOR_SUPABASE_URL="https://SEU_PROJETO.supabase.co"
   VITE_ENRIQUECEDOR_SUPABASE_ANON_KEY="sua_anon_key"
   ```
3. Reinicie o `npm run dev`. A ferramenta detecta as credenciais e passa a usar o Postgres (sai do modo local).

## 5. Criar o primeiro usuário admin
1. No Supabase: **Authentication → Users → Add user** (e-mail + senha).
2. No **SQL Editor**, rode (troque o e-mail):
   ```sql
   insert into public.user_profiles (id, email, name, role, active)
   select id, email, 'Ruston', 'admin', true
   from auth.users where email = 'voce@v4company.com'
   on conflict (id) do update set role = 'admin', active = true;
   ```
3. Agora você loga na ferramenta com esse e-mail/senha, como admin.

## Observações
- O **backend de enriquecimento** (`npm run server`) continua rodando local; ele não depende do Supabase.
- Migrations futuras entram como `supabase/migrations/000X_*.sql`, rodadas do mesmo jeito.
- **Deploy** (produção) é a Fase 5, só quando você pedir.
