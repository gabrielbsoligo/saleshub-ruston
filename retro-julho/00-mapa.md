# 00 · Mapa de capacidade dos dados — retrospectiva julho/2026
> Gerado em 2026-08-03 ~08:20 America/Sao_Paulo. Somente leitura. Julho está FECHADO no relógio.
> Colunas `timestamptz` estão em UTC; janelas filtradas com offset `-03` (America/Sao_Paulo).

## 1 · Tabelas relevantes (contagem exata + cobertura temporal do campo principal)

| Tabela | Linhas | Data mín | Data máx | Campo |
|---|---:|---|---|---|
| `public.deals` | 1.127 | 2024-07-01 | 2026-07-31 | created_at |
| `public.leads` | 5.959 | 2023-11-09 | 2026-07-30 | created_at |
| `public.reunioes` | 509 | 2026-03-02 | 2026-08-12 | data_reuniao |
| `public.deal_status_log` | 2.608 | 2024-07-01 | 2026-07-31 | mudou_em |
| `public.deal_recebimentos` | 342 | 2026-04-23 | 2026-07-31 | created_at |
| `public.ligacoes_4com` | 18.024 | 2026-04-03 | 2026-07-31 | started_at |
| `public.call_quality` | 181 | 2026-07-07 | 2026-07-31 | created_at |
| `public.recomendacoes` | 69 | 2026-04-07 | 2026-07-24 | created_at |
| `public.comissoes_registros` | 436 | 2026-04-04 | 2026-07-31 | created_at |
| `public.custos_comercial` | **0** | — | — | mes |
| `kommo.leads` | 11.440 | 2024-04-22 | 2026-07-30 | kommo_created_at |
| `kommo.lead_stage_log` | 17.613 | **2026-06-10** | 2026-08-02 | mudou_em |
| `kommo.events` | 76.609 | **2026-03-03** | 2026-08-03 | kommo_created_at |
| `kommo.notes` | 26.390 | 2025-05-07 | 2026-07-31 | kommo_created_at |
| `kommo.tasks` | 54.320 | 2025-05-07 | 2026-08-02 | kommo_created_at |
| `kommo.mensagens` | 15.540 | 2025-05-07 | 2026-07-12 | occurred_at |
| `kommo.custom_fields` | 73 | — | — | — |
| `kommo.pipelines` / `kommo.stages` / `kommo.users` | 12 / 129 / 19 | — | — | — |
| `kommo.espelho_log` | 435 | 2026-07-27 | 2026-07-31 | criado_em |

```sql
SELECT 'public.deals', COUNT(*), MIN(created_at)::date, MAX(created_at)::date FROM public.deals
UNION ALL ... -- (uma linha por tabela; campo principal declarado na coluna "Campo")
```

## 2 · Colunas de `public.deals` (1.127 linhas) — tipo, % preenchimento, exemplos

| Coluna | Tipo | % preench. | Exemplos (até 5 distintos) |
|---|---|---:|---|
| `id` | uuid | 100.0% | 00ca4829-b87b-4b2b-a566-f2c43cf2e9ac · 0234436c-eae3-4e61-9b6c-b4a62d7912d1 · 2e4aca78-ef4e-427b-9f8f-f738ef6a |
| `lead_id` | uuid | 21.7% | 00ade7d8-55cb-4966-a380-f5e36731580e · 07682dce-fe94-43d8-a90c-47f7a2f27e90 · 0a8871ec-9d48-4135-b93a-f8a3f8c2 |
| `empresa` | text | 100.0% | Agilita · Alianza jeans · Brandz · Casablanca Restaurante- · Central Point |
| `kommo_id` | text | 77.9% | 10853898 · 10933369 · 17587922.0 · 17814730.0 · 20240926.0 |
| `kommo_link` | text | 99.2% | https://financeirorustonengenhariacombr.kommo.com/leads/detail/ · https://financeirorustonengenhariacombr.komm |
| `closer_id` | uuid | 93.0% | 22b46ff4-348b-45bd-aee0-67ae011137e1 · 26888625-9734-4e2d-89c8-59e90ee77a78 · 3259a765-b5de-4623-94ae-70c0c3ba |
| `sdr_id` | uuid | 23.2% | 135ccd9e-6d70-4ece-9d39-4b1cd9403ead |
| `data_call` | date | 99.7% | 2024-07-22 · 2024-08-30 · 2024-09-20 · 2024-10-01 · 2024-11-07 |
| `data_fechamento` | date | 24.7% | 2024-07-17 · 2024-10-18 · 2024-11-15 · 2025-03-27 · 2025-04-04 |
| `data_primeiro_pagamento` | date | 18.7% | 2024-10-20 · 2024-11-16 · 2024-12-03 · 2024-12-11 · 2025-01-24 |
| `data_retorno` | date | 14.2% | 2025-10-27 · 2025-12-02 · 2026-03-18 · 2026-03-23 · 2026-03-24 |
| `valor_mrr` | numeric | 100.0% | 0 · 2500.0 · 3500.0 · 3618.0 · 3900.0 |
| `valor_ot` | numeric | 100.0% | 0 · 12000.0 · 15000.0 · 16800 · 22480.0 |
| `status` | text | 100.0% | baixa_prioridade · contrato_assinado · marcar_call_proposta · media_prioridade · perdido |
| `produto` | text | 79.1% | Assessoria · ASSESSORIA · Assessoria, Estruturação Estratégica · DR-X · Estruturação Estratégica |
| `origem` | text | 99.7% | blackbox · indicacao · leadbroker · outbound · recomendacao |
| `temperatura` | text | 95.1% | frio · morno · quente |
| `bant` | integer | 87.2% | 2 · 3 · 4 |
| `motivo_perda` | text | 42.7% | Comprado do concorrente · devolvido a outro pipeline: Nutrição · devolvido a outro pipeline: Outbound Disparo  |
| `curva_dias` | integer | 18.0% | 0 · 1 · 10 · 105 · 12 |
| `created_at` | timestamp with time zone | 100.0% | 2024-07-22 15:00:00+00 · 2024-08-30 15:00:00+00 · 2024-09-20 15:00:00+00 · 2024-10-01 15:00:00+00 · 2024-11-07 |
| `updated_at` | timestamp with time zone | 100.0% | 2026-04-16 00:34:45.468916+00 · 2026-05-05 11:42:38.26258+00 · 2026-06-10 13:58:59.524138+00 · 2026-06-10 14:0 |
| `produtos_ot` | ARRAY | 100.0% | {"Estruturação Estratégica","Implementação CRM"} · {"Estruturação Estratégica"} · {"Implementação CRM","Implem |
| `produtos_mrr` | ARRAY | 100.0% | {"Gestor de Tráfego","Email Mkt"} · {"Gestor de Tráfego","Social Media"} · {"Gestor de Tráfego",CRM} · {} · {C |
| `valor_escopo` | numeric | 100.0% | 0 · 12000.0 · 15000.0 · 16800 · 22480.0 |
| `valor_recorrente` | numeric | 100.0% | 0 · 2500.0 · 3500.0 · 3618.0 · 3900.0 |
| `data_inicio_escopo` | date | 5.6% | 2026-04-09 · 2026-04-11 · 2026-04-15 · 2026-04-20 · 2026-05-04 |
| `data_pgto_escopo` | date | 6.9% | 2026-04-07 · 2026-04-09 · 2026-04-11 · 2026-04-13 · 2026-04-15 |
| `data_inicio_recorrente` | date | 3.4% | 2026-04-10 · 2026-04-15 · 2026-04-17 · 2026-04-20 · 2026-04-23 |
| `data_pgto_recorrente` | date | 4.4% | 2026-02-25 · 2026-03-10 · 2026-03-23 · 2026-04-01 · 2026-04-10 |
| `link_call_vendas` | text | 10.9% | , · . · ... · ..... · https://drive.google.com/file/d/1_i8_HfCQ6_1yMtd2oMmvqamwFCGrJLGO/view?usp=drivesdk |
| `link_transcricao` | text | 17.8% | , · ..... · https://docs.google.com/document/d/1-pBEVyb-Apkiw09h5Ec11Bebt062M5DR4gwnH-i07pc/edit?tab=t.f3a7q4c |
| `contrato_url` | text | 4.7% | https://cdn.rustontools.tech/contratos-clientes/619d1133-822a-48f5-97d0-91cb223a971a/contrato_1779919438766.pd |
| `contrato_filename` | text | 4.7% | 01142789000188 - Urano Prom - [2026-05-14T21_53_31.092Z].pdf · 03555771000133 - ITCE SOLUC - [2026-04-17T19_15 |
| `tier` | text | 20.5% | enterprise · large · medium · small · tiny |
| `observacoes` | text | 16.2% | Academia multidisciplinar na Praia Brava com 100 alunos atuais busca crescer para 150 através de tráfego pago  |
| `reuniao_id` | uuid | 19.3% | 0079667a-4430-42aa-b62a-454d24f91a9a · 00e8fd79-8efa-41dd-a312-77071fffe30f · 013e76f5-7903-4e9e-a024-fedafdbc |
| `cadencia_perfil` | jsonb | 4.8% | {"nome": "Aguinaldo Soares", "dores": ["Agências anteriores falharam: erros em campanhas pagas (anúncios para  |
| `cadencia_closer_plan` | jsonb | 4.8% | {"datas_acordadas": ["2026-07-08T16:00:00"], "tarefas_especificas": [{"o_que": "Enviar proposta formal por esc |
| `cadencia_closer_task_ids` | jsonb | 100.0% | {"B1": 3634575, "BW1": 3634577, "BW2": 3634579, "BW3": 3634583, "BW4": 3634585, "BW5": 3634589, "BW6": 3634593 |
| `cadencia_closer_balde` | text | 7.0% | ALTA · BAIXA · CONTRATO · MARCAR_CALL · MEDIA |
| `cadencia_closer_ancora` | timestamp with time zone | 7.0% | 2026-07-13 12:39:16+00 · 2026-07-13 12:39:33+00 · 2026-07-15 13:08:26+00 · 2026-07-16 13:10:36+00 · 2026-07-17 |

Colunas de `public.leads` (5.959 linhas) — mesmas métricas:

| Coluna | Tipo | % preench. | Exemplos |
|---|---|---:|---|
| `id` | uuid | 100.0% | 00061bc1-fe8e-46eb-a7e5-6c5f17f850a6 · 035e3cca-2cd2-43c5-af3b-0e9bdd3ed80c · 18ab2440-bb98-4392-9420-9b1a5eaf |
| `empresa` | text | 100.0% | A & G · AGL LOCADORA VEÍCULOS · Agroaves Agropecuária · AMALF - ADMINISTRADORA DE BENS LTDA · AMERICA RENTAL E |
| `nome_contato` | text | 52.7% | +55 11 9 4021 9081 · Agnaldo · Ana Carolina · Anderson · Antonio Carlos Pinto Habaeb |
| `telefone` | text | 97.2% | (66) 98420-9552 · +55 (11) 95910-6328 · +55 (11) 99662-0303 · +55 (16) 99706-0222 · +55 (31) 99547-2228 |
| `cnpj` | text | 65.1% | 03434448000101 · 04495101000131 · 05.865.146/0004-66 · 08147152000123 · 10572 |
| `faturamento` | text | 39.6% | Acima de 40 milhões · De 1 a 4 milhões · De 1 à 4 milhões · De 101 mil à 200 mil · De 101 mil à 400 mil |
| `canal` | text | 100.0% | blackbox · leadbroker · outbound · recovery |
| `fonte` | text | 18.7% | FACEBOOK · GOOGLE · INSTITUCIONAL · LINKEDIN · ORGANICO |
| `produto` | text | 24.3% | Alavancagem Comercial · Assessoria · ASSESSORIA · Estruturação Estratégica · ESTRUTURAÇÃO ESTRATÉGICA |
| `sdr_id` | uuid | 50.1% | 05b2397d-4f46-49ac-b2bd-1666775650bd |
| `kommo_id` | text | 96.2% | 17814730.0 · 20365312.0 · 22732813 · 22801985 · 22937321 |
| `kommo_link` | text | 97.0% | https://financeirorustonengenhariacombr.kommo.com/leads/detail/17814730 · https://financeirorustonengenhariaco |
| `status` | text | 100.0% | em_follow · noshow · reuniao_marcada · reuniao_realizada · sem_contato |
| `data_cadastro` | date | 46.1% | 2025-11-06 · 2026-01-08 · 2026-03-26 · 2026-04-10 · 2026-04-15 |
| `mes_referencia` | text | 17.5% | 2026-04 · 2026-05 · 2026-06 · 2026-07 · ago./25 |
| `valor_lead` | numeric | 23.0% | 1000.8 · 1076.4 · 1144 · 1206 · 1544.4 |
| `created_at` | timestamp with time zone | 100.0% | 2025-11-06 15:00:00+00 · 2026-01-08 15:00:00+00 · 2026-04-13 14:44:23.785848+00 · 2026-04-16 12:15:46.783691+0 |
| `updated_at` | timestamp with time zone | 100.0% | 2026-05-06 23:34:18.417423+00 · 2026-05-08 13:37:29.280943+00 · 2026-05-12 18:12:24.832346+00 · 2026-06-05 16: |
| `email` | text | 35.4% | agnaldo_rocha82@yahoo.com.br · agroavesro@hotmail.com · anderson-carlesso@hotmail.com · andreslares36@gmail.co |
| `kommo_request_id` | bigint | 0.6% | 24454 · 24455 · 24457 · 24458 · 24459 |
| `mktlab_link` | text | 32.4% | ,.,.,. · . · .. · ... · https://gestao-comercial-rosy.vercel.app/extensao |
| `indicado_por` | text | 0.0% | — |
| `indicado_por_email` | text | 0.0% | — |
| `mktlab_id` | text | 32.2% | 002b77a7-1642-415d-ac71-def544e10f86 · 003aa05f-1adc-4f4b-b543-f97af7b1afb4 · 00740fa0-b990-4ade-b35c-cb216bba |
| `recomendado_por` | text | 0.9% | Alessandro - Penafrote Imobiliária  · Anderson - JIB RENTAL · Andres Madrid - Fumagalli contabilidade e perfec |
| `coletado_por_closer_nome` | text | 0.9% | Nathan · Sandro · Yuri |
| `kommo_contact_synced_at` | timestamp with time zone | 95.3% | 2026-04-13 21:50:12.711287+00 · 2026-04-16 00:34:45.468916+00 · 2026-04-20 20:37:50.596486+00 · 2026-04-23 12: |
| `kommo_pipeline_id` | bigint | 46.3% | 13815136 · 14062116 |
| `kommo_status_id` | bigint | 46.3% | 106594528 · 108545252 |
| `kommo_tags` | ARRAY | 46.3% | {"OUT FRIO CONSTRUTORA"} · {DS-100a250} |
| `segmento_disparos` | text | 42.5% | CONSTRUTORA |
| `enriquecer_lemit` | boolean | 100.0% | false · true |
| `lemit_enriched_at` | timestamp with time zone | 42.5% | 2026-07-15 14:44:02.992+00 · 2026-07-15 14:44:11.069+00 · 2026-07-15 14:44:11.313+00 · 2026-07-15 14:44:13.744 |
| `lemit_socios_count` | integer | 42.5% | 0 · 1 · 2 · 3 · 4 |
| `lemit_erro` | text | 36.7% | empresa status 401 · empresa status 422 |

```sql
-- por coluna (gerado a partir de information_schema.columns):
SELECT '<col>' AS col, ROUND(100.0*COUNT(<col>)/COUNT(*),1) AS pct,
       (SELECT string_agg(DISTINCT v,' | ') FROM (SELECT <col>::text v FROM public.deals WHERE <col> IS NOT NULL LIMIT 40) s) AS exemplos
FROM public.deals  -- UNION ALL por coluna; idem public.leads
```

## 3 · Campos customizados do Kommo (universo: 146 leads do pipeline Closer criados 01/04–31/07/2026)

Top por preenchimento (lista completa tem 34 campos com ≥1 ocorrência; catálogo total: 73):

| Campo | Tipo | Preench. | % |
|---|---|---:|---:|
| Origem do lead | select | 136/146 | 93,2% |
| Dor que precisa resolver | textarea | 109/146 | 74,7% |
| Resumo da Empresa | textarea | 104/146 | 71,2% |
| Quem vem para a reunião? / Objetivos / Como Investe? / Como Funciona o Marketing? / Tem CRM? | textarea | 103/146 | 70,5% |
| Timming para fechamento / Ticket Médio / Como é o processo comercial? | textarea | 102/146 | 69,9% |
| **Faturamento (bant)** | textarea (texto livre) | 83/146 | 56,8% |
| Reunião (texto) / Data da Reunião / Lembrete 5min | text/date_time | 47/146 | 32,2% |
| CNPJ | text | 23/146 | 15,8% |
| Faturamento (receita federal) | text | 22/146 | 15,1% |
| Produto LB | select | 1/146 | 0,7% |

**Nenhum campo customizado de pagamento/parcela/entrada/boleto/pix/cartão existe no catálogo** (busca no nome dos 73 campos).

```sql
WITH base AS (SELECT id, custom_fields FROM kommo.leads
  WHERE pipeline_id=11010459 AND kommo_created_at >= '2026-04-01T00:00:00-03' AND kommo_created_at < '2026-08-01T00:00:00-03')
SELECT (e->>'field_id')::bigint, cf.name, cf.type, COUNT(DISTINCT b.id),
       ROUND(100.0*COUNT(DISTINCT b.id)/(SELECT COUNT(*) FROM base),1)
FROM base b, jsonb_array_elements(COALESCE(b.custom_fields,'[]')) e
LEFT JOIN kommo.custom_fields cf ON cf.id=(e->>'field_id')::bigint GROUP BY 1,2,3 ORDER BY 4 DESC;
-- 146 leads no universo; 34 campos com ocorrência
```

## 4 · Pipeline e etapas (funil Closer, pipeline 11010459) — GANHO = 142 · PERDIDO = 143

| status_id Kommo | Ordem | Etapa (Kommo) | Slug no SalesHub |
|---:|---:|---|---|
| 84456015 | 1 | Incoming leads | incoming_leads |
| 84456019 | 2 | Feedback reunião | dar_feedback |
| 103523344 | 3 | Marcar call proposta | marcar_call_proposta |
| 102174776 | 4 | Baixa prioridade (+30d) | baixa_prioridade |
| 102174780 | 5 | Média prioridade (11–30d) | media_prioridade |
| 102174784 | 6 | Alta prioridade (1–10d) | alta_prioridade |
| 84456095 | 7 | Contrato | contrato_na_rua |
| **142** | 8 | **Won (= GANHO)** | contrato_assinado |
| **143** | 9 | **Lost (= PERDIDO)** | perdido |

```sql
SELECT kommo_status_id, ordem, slug, rotulo, sh_legado FROM kommo.funil_etapas ORDER BY ordem;  -- 9 linhas
```

## 5 · Histórico de mudança de etapa — EXISTE, com origem e destino

**`public.deal_status_log`** (2.608 linhas): `deal_id, status_anterior, status_novo, mudou_em, mudou_por, motivo_perda, valor_recorrente, valor_escopo`. Cobertura 2024-07 → 2026-07-31 (linhas ≤mar/2026 têm cara de backfill; densidade real-time a partir de abr/2026). Registra **de/para** ✓.

Densidade (recorte 2026): abr 481 transições (11 → ganho) · mai 165 (14 → ganho, 1 saiu de ganho) · jun 191 (9 → ganho) · jul 679 (24 → ganho, **10 saíram de ganho**). Os picos de abr e jul incluem higienizações em massa (limpezas de base documentadas).

Complementos: `kommo.lead_stage_log` (17.613; de/para; só desde **10/06/2026**) e `kommo.events type='lead_status_changed'` (52.478; desde 03/03/2026; **sem** de/para — só quando e quem).

```sql
SELECT to_char(date_trunc('month', mudou_em AT TIME ZONE 'America/Sao_Paulo'),'YYYY-MM'), COUNT(*),
       COUNT(*) FILTER (WHERE status_novo='contrato_assinado'),
       COUNT(*) FILTER (WHERE status_anterior='contrato_assinado')
FROM public.deal_status_log GROUP BY 1 ORDER BY 1;
```

## 6 · Registro de pagamento — EXISTE A ESTRUTURA, NÃO EXISTE O DADO

- `public.deal_recebimentos` (342 parcelas; tipo, nº parcela, data_prevista, **data_pgto_real**, valor_contrato, **valor_recebido**, status): **339 "aguardando" e só 3 "pago"** (todas de mar/2026). 
- Dos **45 deals ganhos entre abr e jul/2026**: 45 têm parcelas cadastradas, **0 têm pagamento registrado** (`data_pgto_real`/`valor_recebido`).
- `deals.data_primeiro_pagamento` 18,7% preench. (legado), `data_pgto_escopo` 6,9%, `data_pgto_recorrente` 4,4% — sem preenchimento recente.
- Kommo: nenhum campo customizado de pagamento (item 3).

```sql
SELECT status, COUNT(*), COUNT(*) FILTER (WHERE data_pgto_real IS NOT NULL) FROM public.deal_recebimentos GROUP BY 1;
-- aguardando 339 (0 pagas) | pago 3 (3)
SELECT COUNT(DISTINCT d.id), COUNT(DISTINCT r.deal_id) FILTER (WHERE r.data_pgto_real IS NOT NULL OR COALESCE(r.valor_recebido,0)>0)
FROM public.deals d LEFT JOIN public.deal_recebimentos r ON r.deal_id=d.id
WHERE d.status='contrato_assinado' AND d.data_fechamento BETWEEN '2026-04-01' AND '2026-07-31';  -- 45 | 0
```

## 7 · Canal de origem — campo, valores e preenchimento

Regra canônica do sistema: deal = `COALESCE(NULLIF(deals.origem,''), leads.canal)`; lead = `leads.canal`; reunião = `COALESCE(NULLIF(reunioes.canal,''), leads.canal)`.
Preenchimento: `leads.canal` **100%** (5.959/5.959) · `deals.origem` 99,7% · expressão canônica nos deals de julho **100%**.
Valores reais (não existe "inbound"): `leadbroker, blackbox, recovery, outbound, reativacao, recomendacao, indicacao`.
Kommo espelha em "Origem do lead" (select, 93,2% nos 146 leads abr–jul do Closer).

## 8 · PERGUNTA DE NEGÓCIO × RESPONDÍVEL × ONDE

| # | Pergunta | Respondível | Onde |
|---|---|---|---|
| 1 | Vendido em julho, por canal | **SIM** | `deals` (data_fechamento/status) + `deal_status_log` + canal canônico |
| 2 | Quanto ativou (permaneceu em ganho) | **SIM** | `deal_status_log` (entrada/saída de ganho) + `deals.status` atual |
| 3 | Caixa que entrou em julho | **NÃO** | `deal_recebimentos` existe mas 0 pagamentos registrados em ganhos abr–jul |
| 4 | Taxa de ativação por canal/closer/ticket | **SIM** · por faixa de faturamento: **PARCIAL** | log + deals; `leads.faturamento` 39,6% geral e ~vazio nos leads jul |
| 5 | Tempo call→ganho | **SIM** | `deals.data_call` (99,7%) × `data_fechamento` |
| 6 | Tempo ganho→pagamento | **NÃO** | sem pagamento registrado |
| 7 | Destino do pipe carregado jun→jul | **SIM (com ressalva)** | `deal_status_log` reconstrói etapa em 30/06; etapas legadas foram extintas em jul (mapeadas em `funil_etapas.sh_legado`) |
| 8 | LeadBroker: comprados/custo/reunião/venda | **PARCIAL** | leads/reuniões/vendas SIM; **custo NÃO** (`custos_comercial` vazia) |
| 9 | Resultado por faixa de faturamento | **NÃO em julho** | 1/65 leads LeadBroker de jul com faixa; histórico 39,6% |
| 10 | Conversão etapa a etapa em julho | **SIM (com ressalva)** | `deal_status_log` jul denso; higienização em massa infla saídas |
| 11 | Taxa de no-show | **SIM** | `reunioes` (realizada/show) |
| 12 | Pipe carregado de entrada de agosto | **SIM** | `deals.data_call` em jul + status atual + `updated_at`/tasks p/ última interação |

**Gargalos reais confirmados: caixa (Q3/Q6) e custo LeadBroker (Q8) não são mensuráveis hoje.** Detalhe e instrumentação no `02-caixa.md`.
