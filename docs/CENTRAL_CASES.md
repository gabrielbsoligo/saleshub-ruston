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
- Reverter: cabeçalho da `migration_160_central_cases.sql`; front = remover `CasesPanel` do `PrepCallView`.
