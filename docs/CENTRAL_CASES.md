# Central de Cases (aba "Preparar reunião")

Sugere cases da rede V4 parecidos com o lead. Passada **leve** automática ao agendar a reunião;
o closer **aprofunda** na própria aba.

## Fluxo
1. `AFTER INSERT` em `reunioes` → trigger `trg_reunioes_central_cases` cria 1 linha em
   `cases_sugestoes` (profundidade `leve`) e chama a edge `central-cases` via `pg_net`
   (segredo `integracao_config.central_cases_secret`, header `x-central-cases-secret`).
2. A edge responde 202 e processa em segundo plano (`motor.ts`, puro e testado):
   - **termos**: nicho/segmento (briefing `inputs.segmento` > `leads.segmento_disparos` > custom field
     nicho/segmento) com sinônimos + tokens do nome do lead (sem LTDA/ME/…);
   - **base**: RPC `cases_buscar(termos, uf, limite)` em `cases_base_v4` (pg_trgm + LIKE; score por
     termos casados, similaridade, Ativo, porte, mesma UF, LT);
   - **web**: 1 busca por case nos N melhores (`"nome" cidade`) pelo motor do Enriquecedor
     (`POST /api/busca-web`, mesma `rawSearch`: Brave, cache 14 d, 1/s) → site + Instagram;
   - **anúncios**: 3 melhores pelo `/api/anuncios` do motor (Biblioteca de Anúncios, headless+proxy);
   - **final**: score + site/instagram/anúncios; `por_que` em texto. Leve = 12/6/3 → 5 finais;
     profunda = 30/12/3 → 8 finais.
3. A aba mostra: faixa "Cases sugeridos — últimas reuniões" e, na gaveta do briefing, o painel do
   lead com **Aprofundar** (edge com JWT do usuário; exige `team_members`).
4. Cron `central-cases-varrer` (*/10) retoma pendentes/travados (>5 min), até 3 tentativas.

## Relevância e qualidade (feedback do Gabriel, 26/10 — migration_167)
- A passada automática já é a **expandida** (40 candidatos → 15 na web → 5 na Biblioteca de Anúncios → 10 finais).
- **Relevância** (RPC `cases_buscar(p_nicho, p_nome, uf, limit)`): nicho (segmento/CNAE + sinônimos) pesa 60/termo
  + similaridade; nome 10/termo (só desempata); se o lead tem nicho, o candidato PRECISA casar o nicho; Ativo +25.
  Stopwords de termos genéricos (consultoria, gestão, serviços, ltda…) e de nomes de pessoa (lista + nome do
  contato do lead) nunca viram termo.
- **Qualidade 0–100** (`qualidadeDe`, mostrada no card e usada para ORDENAR): site no ar 25 (achado sem medir 10),
  Instagram confirmado 20 (não medido 15), anúncios Meta confirmados 15 (1–2) / 30 (3+), Google Business 10 +
  avaliações (≥10: +5, ≥50: +10) + nota ≥4,5: +5. Sinais via motor (`/api/ops/rede-existe`, `/api/google-negocio`)
  e GET direto no site (8 s), tudo com cache em `cases_web_cache`.

## Base do BI
`cases_base_v4` só tem colunas de EMPRESA (id, nome, razão social, CNPJ, cidade/UF, categoria, tier,
status, produto, tipo de serviço, canal, safras, LT, fee). Stakeholder/e-mail/telefone **não entram**.
Importar/atualizar: `python -I importar_cases.py` (scratchpad do Engenheiro; PostgREST upsert com
service_role, lotes de 1000). RLS: leitura para membros autenticados; escrita só service_role.

## Operação
- Secrets da edge: usa `ENRIQ_INTEG_EMAIL/SENHA` (já existentes) para falar com o motor; `ENRIQ_MOTOR_URL`
  opcional. Deploy: `supabase functions deploy central-cases --no-verify-jwt`.
- Motor: rota nova `/api/busca-web` (Railway, deploy pelo push na main; `versao` em `/api/health`).
- Testes: `deno test --allow-read` em `supabase/functions/central-cases` (6).
- Reverter (ordem): `SELECT cron.unschedule('central-cases-varrer'); DROP TRIGGER IF EXISTS trg_reunioes_central_cases ON public.reunioes;
  DROP FUNCTION IF EXISTS public.reunioes_central_cases_fire(), public.cases_buscar(TEXT[],TEXT,INT), public.cases_claim(UUID,INT,INT),
  public.cases_renovar(UUID,UUID,INT), public.cases_contexto_lead(UUID); ALTER PUBLICATION supabase_realtime DROP TABLE public.cases_sugestoes;
  DROP TABLE IF EXISTS public.cases_sugestoes, public.cases_web_cache, public.cases_base_v4; DROP FUNCTION IF EXISTS public.immutable_unaccent(TEXT);
  DELETE FROM public.integracao_config WHERE key='central_cases_secret';` — depois `supabase functions delete central-cases`; front = remover `CasesPanel`/`CasesRecentes` do `PrepCallView`.
- Posse: `cases_claim` (lease 5 min + token; `cases_renovar` a cada etapa); escritas só sob posse; 3ª tentativa interrompida vira `erro`.
