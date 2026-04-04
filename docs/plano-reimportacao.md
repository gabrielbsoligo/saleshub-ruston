# Plano de Reimportacao - SalesHub

## Quando executar
Executar DEPOIS de terminar todo o desenvolvimento. Apaga tudo e reimporta do zero.

## Fonte de dados
Planilha: `C:\Users\gabri\Downloads\Dash de Aquisição _ Ruston & Co. (2).xlsx`

## Ordem de execucao

### 1. Limpar banco
```sql
TRUNCATE deals, reunioes, leads, metas, performance_sdr, performance_closer, custos_comercial CASCADE;
-- NAO apagar: team_members, comissoes_config, blackbox_contratos, integracao_config
```

### 2. Importar Leads (5 abas → tabela leads)

#### BlackBox (184 rows)
| Planilha | DB | Notas |
|---|---|---|
| EMPRESAS | empresa | |
| SDR | sdr_id | Match por nome → team_members.id |
| ID KOMMO | kommo_id | |
| NOME | nome_contato | |
| TELEFONE | telefone | |
| DATA CADASTRO | data_cadastro | **ATENCAO: formato misto** - strings 'dd/mm' (assumir 2026) e datetimes. Normalizar pra DATE |
| STATUS | status | Mapear: Reunião Marcada→reuniao_marcada, Sem contato→sem_contato, etc |
| FATURAMENTO | faturamento | |
| CANAL (fonte) | fonte | GOOGLE, FACEBOOK, etc |
| PRODUTO | produto | |
| Valor OT | *(nao vai pro lead, vai pro deal se existir)* | |
| Valor MRR | *(nao vai pro lead, vai pro deal se existir)* | |
| Mês | mes_referencia | |
| Status Negociação | *(indica se virou deal)* | Se preenchido, criar deal vinculado |
| Temperatura | *(vai pro deal)* | |
| MOTIVO DE PERDA | *(vai pro deal)* | |
| MÊS BOX | *(fallback pra data)* | Abril→2026-04, Março→2026-03, Fevereiro→2026-02 |
| Link Kommo | kommo_link | |
| canal (fixo) | canal = 'blackbox' | |

#### LeadBroker (784 rows)
| Planilha | DB | Notas |
|---|---|---|
| EMPRESAS | empresa | |
| SDR | sdr_id | Match por nome |
| ID KOMMO | kommo_id | |
| NOME | nome_contato | |
| TELEFONE | telefone | |
| DATA DA COMPRA | data_cadastro | Datetime, ok |
| STATUS | status | Mapear status |
| FATURAMENTO | faturamento | |
| CNPJ | cnpj | |
| VALOR | valor_lead | Custo do lead |
| CANAL | fonte | GOOGLE, FACEBOOK |
| PRODUTO | produto | |
| Valor OT, Valor MRR | *(deal)* | |
| Mês | mes_referencia | |
| Status Negociação, Temperatura, MOTIVO DE PERDA | *(deal)* | |
| Link Kommo | kommo_link | |
| canal (fixo) | canal = 'leadbroker' | |

#### Outbound (51 rows)
| Planilha | DB | Notas |
|---|---|---|
| EMPRESA | empresa | |
| BDR | sdr_id | Match por nome |
| ID KOMMO | kommo_id | |
| NOME | nome_contato | |
| TELEFONE | telefone | |
| DATA DO AGENDAMENTO | data_cadastro | |
| STATUS | status | |
| Valor OT, Valor MRR | *(deal)* | |
| Mês | mes_referencia | |
| Status Negociação, Temperatura, MOTIVO DE PERDA | *(deal)* | |
| Link Kommo | kommo_link | |
| canal (fixo) | canal = 'outbound' | |

#### Recomendacao (verificar aba)
canal = 'recomendacao'

#### Indicacao (verificar aba)
canal = 'indicacao'

### 3. Importar Deals (aba Negociacoes BR → tabela deals)
875 rows. Mapeamento ja feito (funciona bem). Adicionar:
- Vincular `lead_id` por match de `kommo_id` entre deal e lead
- Mapear `closer` por nome → team_members.id (incluir inativos)
- `produto` pode ser single (campo antigo) - manter no campo `produto`
- Para deals com `Status = Contrato Assinado`, verificar se tem valores pra `produtos_ot`/`produtos_mrr`

### 4. Importar Reunioes (aba REUNIOES AGENDADAS → tabela reunioes)
61 rows.
| Planilha | DB |
|---|---|
| SDR | sdr_id |
| CANAL | canal |
| ID KOMMO | kommo_id |
| DIA DO AGENDAMENTO | data_agendamento |
| DATA REUNIÃO | data_reuniao |
| REALIZADA | realizada |
| EMPRESA | empresa |
| NOME | nome_contato |
- Vincular `lead_id` por match de kommo_id ou empresa

### 5. Vincular leads ↔ deals
Depois de importar ambos, vincular `deals.lead_id` usando:
1. Match por `kommo_id` (deal.kommo_id == lead.kommo_id)
2. Fallback: match por `empresa` (case insensitive)

### 6. Verificacao pos-import
```sql
SELECT 'leads' as tabela, count(*) FROM leads
UNION ALL SELECT 'deals', count(*) FROM deals
UNION ALL SELECT 'reunioes', count(*) FROM reunioes;

-- Verificar leads sem data
SELECT canal, count(*) FROM leads WHERE data_cadastro IS NULL GROUP BY canal;

-- Verificar deals sem lead
SELECT count(*) FROM deals WHERE lead_id IS NULL;

-- Verificar deals sem closer
SELECT count(*) FROM deals WHERE closer_id IS NULL;
```

## Cuidados
- NAO desativar o trigger `lead_kommo_sync` antes de importar (ou vai criar 1000+ leads no Kommo)
- Desativar trigger ANTES: `ALTER TABLE leads DISABLE TRIGGER lead_kommo_sync;`
- Reativar DEPOIS: `ALTER TABLE leads ENABLE TRIGGER lead_kommo_sync;`
- Manter team_members (inclusive inativos, pois deals historicos apontam pra eles)
- BlackBox DATA CADASTRO: strings '02/04' devem virar '2026-04-02', '07/03' vira '2026-03-07'
