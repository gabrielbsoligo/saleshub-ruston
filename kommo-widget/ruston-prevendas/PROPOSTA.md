# Widget único de pré-vendas: proposta (fatia 1, rev. 3)

**Escopo:** um widget Kommo (`ruston-prevendas`) que junta **notify + PRÓXIMO + click-to-call**, para a conta `financeirorustonengenhariacombr`.

**Status:** proposta para o Gabriel decidir. **Nada foi criado ou alterado no Kommo**; só fiz leituras via GET.

A rev. 2 incorpora a 1ª revisão do Vedor (9 pontos) e a rev. 3 a 2ª (3 pontos). O que mudou está no fim do arquivo.

---

## 1. Inventário do que existe

| Item | Onde | O que aproveitar |
|---|---|---|
| **ruston-notify** (`rn_19a1462411`) | `kommo-widget/ruston-notify` (igual no hub-comercial) | **Base do widget novo.** Ver detalhes abaixo. O `dp.webhook_url` aponta para uma função `kommo-notify` que **não existe**. |
| **Ruston Próximo Lead** 1.0.2 | estava **só em zip** (`Downloads/ruston-next-lead-1.0.2.zip`); **agora versionado** em `kommo-widget/ruston-next-lead` | **Base do PRÓXIMO.** Ver detalhes abaixo. |
| **ruston-enriquecedor** | `kommo-widget/ruston-enriquecedor` | Padrão de botão flutuante no card (vigia de URL a cada 700 ms) e de chamada ao backend. Fica como widget separado. |
| Cadência do SalesHub | `kommo.plan_reconcile` (migration 155) + executor `kommo-cadencia`; `plan_closer` (072); Retorno (131); sweeps (129/133); `enriquecedor-cadencia`; `kommo-call-note` | Ver §3. |
| n8n `storeNewCalls` | Downloads | Só **lê** o 3C (webhook + gravação). **Não discagem.** |
| api4com no código | `webhook-4com` (só entrada), `team_members.ramal_4com` | **Nenhuma chamada de saída existe.** |
| 3C no código | `webhook-3c-calls`, `sweep-3c-calls`, `team_members.agente_3c_id` | **Nenhum click2call ou discagem manual existe.** |
| "Origem do lead" no Kommo | campo `975168` (select) | Ver §2.2. |

Detalhes do **ruston-notify**:
- faz polling de `/api/v4/tasks` pela sessão do Kommo (mesma origem, sem token no front), limitado a **100 tarefas**;
- toca som, mostra notificação e uma pilha de alertas, e guarda o que já mostrou em `localStorage`.

Detalhes do **Ruston Próximo Lead** 1.0.2:
- configura a prioridade por nome de tipo, além de antecedência, Alt+N e posição;
- monta a fila em 3 blocos:
  1. prioritários vencidos ou vencendo;
  2. cadência por vencimento, **inclusive futura**;
  3. prioritários futuros;
- lê **só as primeiras 250 tarefas** e busca nomes **só das 12 primeiras** já ordenadas (`script.js:445-455`).

**Tipos de tarefa hoje** (`GET /api/v4/account?with=task_types`; o `GET /tasks/types` dá 403):

| id | nome | quem produz |
|---|---|---|
| 1 | Follow-up (Acompanhar) | T1, T2 (SDR); Retorno (**closer**, com fallback para o dono do lead); `plan_closer` (closer); "Ligar AGORA" e "classificar resposta" do `enriquecedor-cadencia`; avulsas |
| 3732751 | Ligação | T5, T6, R1, R3 (SDR) |
| 3732759 | WhatsApp | T3 (SDR), **T4 (closer)**, R2 (SDR) |
| 4299552 | Cliente oculto | T0 (closer) |
| 3920343 / 3928475 | SEM TAREFA / ALERTA | sweeps |
| 2, 3732747, 4174464 | Meeting, Email, Diagnóstico de M | manuais |

**Conclusão:** o **tipo atual não identifica o momento.** O mesmo id cobre momentos diferentes (3732759 = T3, T4 ou R2; 1 = cinco produtores). Por isso o PRÓXIMO **não pode** classificar por "tipo → nível" (§2.3).

---

## 2. Tipos de tarefa e ordem do PRÓXIMO

### 2.1 Princípio
Separar **três coisas** que hoje estão misturadas no tipo:
1. **Momento** (por que a tarefa existe): anti no-show, speed to lead, conexão, follow-up, recuperação, pré-reunião, prospecção.
2. **Ação** (o que fazer): ligar, WhatsApp, e-mail. Automações dependem dela: o `kommo-call-note` conclui só tarefa de **ligação**.
3. **Origem do lead** (canal de aquisição): Recomendação, Leadbroker...

### 2.2 Opção A (como pedido) × Opção B (recomendada)

| | A: tipo por momento **e** um tipo por canal | **B: tipo por momento; canal pelo campo Origem (975168)** |
|---|---|---|
| Tipos novos | 6 de momento + 4 de canal | 6 de momento + `07 Prospecção` |
| Canal | no tipo da tarefa (duplica o campo do lead e pode divergir dele) | lido do lead, que já é a fonte da verdade |
| "Follow-up de um lead de Recomendação" | ambíguo: qual tipo usar? | tipo Follow-up + origem Recomendação |

**Nas duas opções:**
- a **ação** fica marcada de forma **estruturada**, não no tipo. Ver §2.4 sobre identificar a ação.
- **Tipos de momento propostos:** `01 Anti no-show`, `02 Speed to lead`, `03 Conexão`, `04 Recuperar no-show`, `05 Follow-up`, `06 Pré-reunião` (e `07 Prospecção` na opção B).
- **Mantidos:** Ligação, WhatsApp, Email, Meeting, Diagnóstico, SEM TAREFA, ALERTA e Cliente oculto. Nenhum tipo é apagado.

**Mapa da Origem para a opção B.** É um contrato explícito, e qualquer valor fora dele vai para o grupo **"Sem origem"**, **nunca** é tratado como outbound:

| Grupo | Valores do campo 975168 |
|---|---|
| G1 Indicação | Recomendação, Indicação de Cliente, Networking, Evento |
| G2 Inbound | **(não há valor "Inbound" no campo hoje)** Proposta: criar a opção `Inbound`, ou mapear Blackbox/Foodbox (confirmar com o Gabriel) |
| G3 Base própria | Recovery, Reativação |
| G4 Leadbroker | Leadbroker |
| G5 Outbound | Outbound, Thunderbolt, USA |
| G9 Sem origem | vazio ou valor desconhecido; vai depois de G5, sinalizado como "sem origem" |

### 2.3 Ordem do PRÓXIMO: chave de ordenação inequívoca

**Elegibilidade** (é decisão nova e difere do 1.0.2, que também mostra tarefas futuras):
- entra na fila a tarefa **vencida** ou **vencendo em até X min** (padrão 10) **do próprio SDR**;
- **exceção:** os momentos com prazo curto prometido (Speed to lead e Conexão vinda de resposta) entram **assim que criados**, seja qual for o `complete_till`. Isso resolve o "Ligar AGORA", que hoje vence em +2 h e ficaria escondido.
- **Se a fila elegível estiver vazia:** o PRÓXIMO mostra a próxima tarefa futura, com o aviso "nada vencido; próxima às HH:MM". Nunca abre "nada" em silêncio.

**Chave de ordenação**, aplicada nesta ordem:
1. **Nível do momento:**
   - 1 Anti no-show;
   - 2 Speed to lead;
   - 3 Conexão;
   - 4 Follow-up;
   - 5 Recuperar no-show;
   - 6 Pré-reunião;
   - 7 Prospecção quente (G1, G2, G3, G4);
   - 7b Prospecção **sem origem** (G9): **neutra**, logo depois da quente e **sem** a janela do outbound. O banner mostra "origem não informada: preencha o campo";
   - 8 Prospecção outbound (**só G5**);
   - 9 sem classificação (avulsas, SEM TAREFA, ALERTA).
2. **Grupo de origem**, só nos níveis 4, 5 e 7: G1 → G2 → G3 → G4 → G5 → G9.
3. **Vencimento**, mais atrasada primeiro.
4. **id da tarefa** (desempate estável).

**Janela do outbound:**
- **só o nível 8 (G5)** fica restrito: elegível depois das **16h**, ou antes disso se os níveis 1 a 7b estiverem vazios. O horário é configurável;
- a origem vazia ou desconhecida (G9) **nunca** herda essa janela.
- **Teste:** prospecção com origem vazia às 10h aparece na fila (nível 7b); prospecção Outbound às 10h, com outra tarefa elegível, não aparece.

**Configuração:** v1 na aba de configuração do widget (admin), com nível por momento, ordem dos grupos, mapa da Origem, `antecedencia_min`, `outbound_apos` e lista de tipos legados. v2 por SDR ou time no SalesHub.

### 2.4 Como o widget sabe o momento e a ação de cada tarefa (classificador)
A classificação por tipo não funciona (§1). O classificador é uma **função compartilhada no servidor** (`_shared/classificar.ts`), usada por:
- (a) o endpoint `prevendas-classificar`, que o widget chama;
- (b) o `kommo-call-note`, que é job de servidor autenticado por `KOMMO_SYNC_SECRET`, chama a função **direto** e **não** depende de JWT do navegador.

Ela devolve `{momento, acao, origem_grupo}` por tarefa, usando, nesta ordem:
1. **Slot da cadência:** o planner já guarda o mapa **slot → id da tarefa** de cada reunião, na coluna `reunioes.cadencia_task_ids` (jsonb, lido como `v_map` no `plan_reconcile`). Daí T5/T6 = anti no-show + ligar; T4 = anti no-show + WhatsApp (closer); T3 = pré-reunião + WhatsApp; R1/R3 = recuperar + ligar; R2 = recuperar + WhatsApp.
2. **Produtor conhecido sem slot:** Retorno (texto `Retorno`, tipo 1) = follow-up, **do closer**; textos `CADENCIA: lead respondeu…` = conexão + ligar; `CADENCIA: classificar…` = follow-up.
3. **Tipo novo de momento**, quando a tarefa já nasceu com ele.
4. **Fallback:** sem classificação (nível 9). Nunca é chute.

A **origem** sai do campo 975168 do lead, lido no servidor (réplica `kommo.leads` do SalesHub, `custom_fields`) para **todas** as candidatas antes de ordenar. Não depende de consultas no navegador limitadas às 12 primeiras.

**Três camadas de autorização, separadas:**
1. **Identidade (todos os endpoints):** JWT descartável válido (algoritmo, assinatura, `exp`/`iat`, conta permitida) + `kommo_user_id` mapeado para membro **ativo**.
2. **Leitura (`prevendas-classificar`):**
   - os ids vêm do navegador e **não são confiáveis**;
   - o servidor confere **cada** tarefa: da conta permitida, **aberta** e com `responsible_user_id` = usuário autenticado, ou usuário gestor autorizado;
   - só depois lê o lead (origem) e a cadência com credencial de servidor;
   - ids que não passam são **descartados** e contados como "negados" na resposta, sem dado.
   - **Não exige** discador, ramal nem token de provedor. Um SDR sem discador configurado tem notify e PRÓXIMO normalmente.
3. **Discagem (`prevendas-dial`, fatia 3):** as camadas 1 + a autorização de recurso do §4.2 + discador configurado.

Testes negativos da leitura: tarefa de outro usuário, tarefa concluída e tarefa de outra conta; nenhuma devolve dado.

**Leitura completa das tarefas** no widget:
- paginação de `/api/v4/tasks` (250 por página) até o fim das abertas do SDR, com deduplicação por id;
- só então chama o classificador e ordena;
- cache de 45 s, com atualização ao concluir ou pular;
- se a leitura estiver incompleta (erro ou limite), o banner diz **"fila parcial"**.

### 2.5 Botão PRÓXIMO
- Abre o card da próxima tarefa e mostra um banner com o momento, a origem, o vencimento e o motivo.
- Botões **"Concluir e próximo"** (PATCH `is_completed` pela sessão do SDR, a mesma ação da tela) e **"Pular 15 min"**. O pulo é local e não altera a tarefa.

---

## 3. Impacto na cadência do SalesHub (mapeado, nada aplicado)

**Fato confirmado no código:** o executor `kommo-cadencia` usa `task_type_id` **só no POST** de tarefa nova (`index.ts:43`). O `patch_move` manda **só `complete_till`** (`index.ts:35`). Portanto, mudar o tipo no planner afeta **só tarefas novas**; as abertas continuam com o tipo antigo.

| Produtor | Hoje | Proposta | Cuidado |
|---|---|---|---|
| T0 (closer) | 4299552 | sem mudança | — |
| T1, T2 (SDR) | 1 | `06 Pré-reunião` | — |
| T3 (SDR) | 3732759 | `06 Pré-reunião` | ação = WhatsApp |
| T4 (**closer**) | 3732759 | `01 Anti no-show` | ação = WhatsApp: **não pode** ser concluída por ligação |
| T5, T6 (SDR) | 3732751 | `01 Anti no-show` | ação = ligar |
| R1, R3 (SDR) | 3732751 | `04 Recuperar no-show` | ação = ligar |
| R2 (SDR) | 3732759 | `04 Recuperar no-show` | ação = WhatsApp: **não pode** ser concluída por ligação |
| Retorno (migration 131) | 1, texto `Retorno` | **fora do escopo do SDR**: é do **closer** | se mudar o tipo, a busca anti-duplicação (`task_type_id = 1`, `:32`) tem que aceitar o legado **e** o novo, senão uma remarcação cria tarefa duplicada. **Recomendo não mexer agora.** |
| `plan_closer` | 1 | sem mudança (closer) | — |
| `enriquecedor-cadencia` "Ligar AGORA" | 1, +2 h | `03 Conexão`; o vencimento passa a **+15 min**, ou fica elegível já na criação (§2.3) | ação = ligar |
| `kommo-call-note` (baixa automática) | conclui se tipo = 3732751 **ou** texto com "ligar" | **não** passar a aceitar os tipos de momento. A baixa usa a **ação = ligar**, vinda do classificador (slot/produtor) ou do tipo legado 3732751 | **teste negativo obrigatório:** uma ligação **não** conclui T4 nem R2 |

**Duas estratégias para as tarefas abertas** (o Gabriel escolhe):
- **(a) Manter o legado:** o classificador (§2.4) cuida delas pelo slot ou texto até vencerem. Sem migração. **Recomendada.**
- **(b) Migrar:** um script rastreável faz PATCH `task_type_id` das abertas por slot, com log antes e depois e dry-run.

**Ordem de publicação** (os consumidores antes dos produtores):
1. widget + classificador entendendo legado e novo;
2. `kommo-call-note` com a regra por ação;
3. criar os tipos (OK do Gabriel);
4. planner e `enriquecedor-cadencia` emitindo os tipos novos.

O repo é compartilhado com o Engenheiro do SalesHub, então cada passo precisa ser combinado com ele.

---

## 4. Desenho do click-to-call (3C e 4com)

### 4.1 Regra
O token do discador **nunca vai para o navegador.** O widget só pede "ligar para o telefone X do contato Y do lead Z". O proxy `prevendas-dial` (edge nova no Supabase do SalesHub) **decide se pode** e liga.

### 4.2 Autorização no proxy (falha fechada em qualquer passo)
1. **Identidade:** JWT descartável do Kommo (`$authorizedAjax`), validado com o *secret* da integração. É preciso conferir:
   - algoritmo esperado (rejeitar `none` e outros);
   - assinatura;
   - `exp` e `iat` (com tolerância curta);
   - `account_id` / `subdomain` = **conta permitida**;
   - `user_id` presente.
2. **Usuário:** `kommo_user_id` mapeado para um `team_members` **ativo**, com papel de pré-vendas ou closer e discador configurado.
3. **Lead:**
   - o proxy lê o lead **no servidor** (`GET /api/v4/leads/{id}?with=contacts`, token de servidor) e exige `responsible_user_id = usuário`, ou usuário com permissão explícita (lista de gestores);
   - o `contact_id` recebido precisa estar **vinculado** a esse lead.
4. **Telefone:** o proxy lê os telefones **do contato** no servidor, normaliza em E.164 e exige que o número pedido **seja um deles**. Também aplica:
   - bloqueio de números fora do Brasil, de emergência e curtos;
   - lista de bloqueio opcional.
5. **Fallback por segredo pessoal** (só se o JWT não funcionar na conta): segredo gerado no SalesHub, por usuário, com **expiração** e **revogação**, guardado como hash, e os mesmos passos 2 a 4.

### 4.3 Idempotência e estado da chamada (contra ligação duplicada)
- O widget gera uma `chave_tentativa` (UUID) por clique e reenvia **a mesma** chave em retry.
- O proxy grava a tentativa em `prevendas_discagem` **antes** de discar. A tabela tem:
  - chave única `(chave_tentativa)`;
  - **dono** (conta + `kommo_user_id`);
  - **payload imutável** (lead, contato, telefone E.164, provedor) com hash;
  - índice parcial que impede **duas tentativas ativas do mesmo usuário**.
- **Chave repetida:**
  - mesmo dono e mesmo payload: devolve o estado existente;
  - **outro dono:** `403`, sem revelar nada da tentativa;
  - mesmo dono e **payload diferente:** `409 conflito`, **sem discar**.
- **GET de estado e encerramento** (`GET/POST prevendas-dial/{chave}[/encerrar]`): exigem identidade válida **e** que o autenticado seja o dono da tentativa (ou gestor autorizado). Outro usuário recebe `404`.
- **Estados:** `pedida → discando → em_curso | falhou | incerta → encerrada`.
- **Reenvio** com a mesma chave devolve o estado existente e **não redisca**.
- **Timeout ou resposta perdida** viram `incerta`. **Nunca há rediscagem automática.** O estado é reconciliado depois:
  - 4com: pelo webhook (que leva o `metadata.chave_tentativa`) ou por `GET /calls`;
  - 3C: pelo evento ou relatório de chamadas.
- Correlação: guardar o id do provedor. O 4com devolve o `id` da chamada, que serve para `POST /calls/{id}/hangup`.
- **Resposta assíncrona:** o 4com só responde quando a chamada conecta, o que pode passar do tempo da edge. O proxy responde `202 discando` logo, e a conclusão chega por webhook, sweep ou consulta do widget (`GET prevendas-dial/{chave}`).
- **Rate limit:** 4com 15/min por ramal; o proxy limita **antes** de chamar.

### 4.4 Provedores

| | 4com (api4com) | 3C Plus |
|---|---|---|
| Chamada | `POST https://api.api4com.com/api/v1/calls` `{extension, caller, called, metadata}` | o agente precisa estar **logado no 3C web, numa campanha e livre**. `POST /agent/manual_call/enter` → `POST /agent/manual_call/dial` (corpo a validar: `phone`?) com o **token do agente**. Alternativa: `click2call` (fluxoti) com token de gestor + ramal (formato não documentado) |
| Token | **por usuário** (a 4com recomenda um por usuário; `ttl -1`), no **Vault** | api_token **do agente**, no **Vault** |
| Encerrar | `POST /calls/{id}/hangup` | `POST /agent/call/{id}/hangup` |
| Estado | webhook (`metadata`) e `GET /calls` | eventos e relatório de chamadas |

### 4.5 O que roda onde

| Navegador (widget) | Servidor (proxy) |
|---|---|
| mostrar os telefones do contato (leitura pela sessão do Kommo) | identidade, autorização (lead, contato, telefone), idempotência, estado |
| gerar `chave_tentativa`; mostrar estado e erro | ler o token no Vault; chamar 3C ou 4com; log; rate limit |
| consultar o estado da tentativa | reconciliar `incerta` sem rediscar |

### 4.6 Validações da fatia 3 (antes de qualquer ligação real)
- JWT descartável funciona nesta conta. Testar na fatia 2, sem discar.
- **Testes negativos** do proxy:
  - JWT de outra conta;
  - JWT expirado;
  - usuário inativo;
  - lead de outro responsável;
  - contato que não é do lead;
  - telefone que não é do contato;
  - duas tentativas simultâneas;
  - reenvio da mesma chave (devolve o estado);
  - mesma chave por **outro usuário** (403);
  - mesma chave com **outro telefone/lead** (409, não disca);
  - GET de estado e encerramento por outro usuário (404).
- Corpo do `manual_call/dial` do 3C e formato do click2call.
- **Ligação real só para o número do próprio Gabriel, com o OK dele.**

---

## 5. Próximas fatias
- **Fatia 2 (notify + próximo):** widget `ruston-prevendas` + edge `prevendas-classificar` com o JWT e o classificador por slot/produtor (§2.4) + leitura paginada.
  - Sem criar tipos: o widget funciona com o legado.
  - Teste só com o usuário do Gabriel (11420911).
- **Fatia 3 (click-to-call):** edge `prevendas-dial` + tabela `prevendas_discagem` + campos e tokens no Vault + botão; todos os testes do §4.6.

## 6. Decisões que preciso do Gabriel
1. Tipos: **opção B** (recomendada) ou A?
2. Ordem e janela: a chave do §2.3 está boa? Outbound depois das **16h**? Antecedência de **10 min**?
3. Origem: criar a opção **`Inbound`** no campo 975168, ou mapear Blackbox/Foodbox como inbound?
4. Tarefas abertas: **manter o legado** (a, recomendado) ou migrar (b)?
5. Retorno do closer: fica **fora** desta mudança?
6. Quem aplica as mudanças da cadência no repo do SalesHub, eu ou o Engenheiro dele, e quando?
7. 4com: tokens e ramais por usuário, quem fornece?
8. 3C: OK para testar a discagem com o agente do Gabriel ligando para o celular dele?

---

### O que mudou na rev. 2 (revisão do Vedor)
1. Autorização completa no proxy: lead, contato, telefone, conta e expiração do JWT, falha fechada (§4.2).
2. A baixa por ligação usa a **ação**, nunca o tipo de momento, com teste negativo para T4 e R2 (§3).
3. Classificador por slot e produtor, no lugar de tipo → nível (§2.4).
4. Idempotência, estados, `incerta` sem rediscagem e resposta assíncrona (§4.3).
5. Regra de tempo declarada como diferente do 1.0.2, exceção para Speed to lead e "Ligar AGORA", e fallback de fila vazia (§2.3).
6. Retorno é do closer, e a busca anti-duplicação depende do tipo 1: recomendo fora do escopo (§3).
7. PATCH da reconciliação confirmado: só `complete_till` (§3).
8. Mapa da Origem, grupo "Sem origem", falta de "Inbound" e chave de desempate (§2.2, §2.3).
9. Leitura paginada, origem de todas as candidatas antes de ordenar e "fila parcial" (§2.4).

### O que mudou na rev. 3 (2ª revisão do Vedor)
1. A leitura (`prevendas-classificar`) confere cada tarefa (conta, aberta, dona = usuário) antes de ler dados; o GET de estado e o encerramento exigem ser o dono; a idempotência fica vinculada ao dono e ao payload (403/409), com testes negativos (§2.4, §4.3, §4.6).
2. Três camadas separadas: identidade, leitura (não exige discador) e discagem. O classificador é função compartilhada no servidor; o `kommo-call-note` usa a função direto, sem JWT (§2.4).
3. Origem desconhecida (G9) ganha nível neutro 7b, fora da janela do outbound, com teste (§2.3).

### Implementação (fatia 2): mudança de desenho após a revisão de código do Vedor
- **A fila vem do servidor, lida da réplica do Kommo** (`kommo.tasks/leads/stages`, sincronizada a cada 1–2 min pelo kommo-sync), via `public.prevendas_fila(user)`. Antes, o navegador enviava ids ao classificador.
- **O servidor não recebe ids do navegador:** devolve só as tarefas abertas do usuário do JWT. Isso elimina a autorização por id (§2.4) e o risco de dado alheio.
- **Zero chamadas à API do Kommo por SDR:** resolve o limite de 7 req/s.
- **Todas as tarefas são reclassificadas a cada ciclo:** sem cache de 5 min e sem tarefa não classificada.
- **Slots por join SQL,** sem corte de data; erro de banco devolve 503.
- **Frescor:** `kommo.sync_status` (tarefas). Atraso acima de 10 min gera aviso.
- **Sem servidor:** modo degradado lê o Kommo pela sessão (paginado, respeita 429 e Retry-After) e ordena por vencimento, com aviso.
- **Várias abas:** uma líder consulta; as outras usam o snapshot. Há variação aleatória no intervalo.
- **A etapa do lead NÃO define o momento** (fica só como exibição). Um mapa explícito etapa → momento por pipeline fica como decisão do Gabriel.

### Implementação, rodada 2 da revisão de código: limite da réplica e verificação ao vivo
- **Limite declarado:** a réplica do Kommo reflete a **última sincronização**. Ela não confirma em tempo real o dono nem se a tarefa está aberta, e **não remove tarefas excluídas**. Além disso, o `kommo-sync` atual pode marcar `done` mesmo se a gravação em lote falhar. São dois bugs **pré-existentes** no sync, reportados ao Gabriel e ao Engenheiro do SalesHub, fora do escopo deste widget.
- **Mitigação no widget (verificação ao vivo):** a cada ciclo, a aba líder confere no Kommo, pela sessão do SDR e numa única chamada, **as 20 primeiras** da fila (e a próxima futura).
  - O que estiver excluído, concluído ou com outro dono sai e ganha uma marca local de 30 min, compartilhada entre as abas.
  - O que estiver válido ganha prazo e texto atuais.
  - A réplica decide **ordem e classificação**; o Kommo decide **se a tarefa existe, está aberta e é do usuário**.
- **Concluir:** grava uma marca local compartilhada, para que a réplica atrasada não ressuscite a tarefa.
- **Snapshot entre abas:**
  - tem revisão própria por mutação;
  - a idade dos dados (`dadosEm`) fica separada do estado da tentativa (`falha`);
  - as abas seguidoras mostram a falha.
- **429 e Retry-After:** viram uma pausa compartilhada entre as abas, inclusive com leitura parcial e no botão Atualizar. O modo degradado lê no máximo 4 páginas, a 1,5 s cada.
- **Função SQL:** devolve um envelope JSON `{itens, total, truncado}`, imune ao `max_rows` do PostgREST.

### Implementação, rodada 3 da revisão de código: o servidor é a autoridade
A verificação no navegador não autoriza o que o servidor já entregou. Por isso a edge `prevendas-fila` passou a:
1. montar as candidatas pela réplica **e** pela **descoberta ao vivo** (tarefas do usuário alteradas nas últimas 3 h, numa chamada). Isso pega, por exemplo, o "Ligar AGORA" que um sync falho não gravou;
2. ordenar com a configuração do widget (a ordem foi portada para TS, com teste de paridade em 1000 casos);
3. **conferir no Kommo o lote que vai emitir** (as 25 primeiras + a próxima futura, que entra separada e nunca é cortada). Precisa existir, estar aberta, ser do usuário e estar na mesma entidade. O que sobe depois de uma invalidação é conferido também (até 2 rodadas);
4. **emitir só o que foi confirmado**. O resto vira só uma contagem (`pendentes`). Kommo com 429 ou indisponível devolve 503 e nada é emitido;
5. guardar um cache de 40 s por usuário (tabela `prevendas_cache`), o que dá cerca de 2 a 4 chamadas ao Kommo por SDR a cada ciclo.

No widget:
- a verificação no cliente e a marca de 30 min saíram; ficou só "concluí agora", com 2 min;
- com falha ou dados velhos (mais de 3 ciclos), as ações (Próximo, Concluir, Ir) ficam suspensas;
- 429 do servidor gera pausa compartilhada entre as abas, sem cair no modo degradado.

**Risco remanescente:** tarefa criada há mais de 3 h, perdida pelo sync e nunca mais alterada não é descoberta. Isso depende da correção do kommo-sync, que foi reportada.

### Implementação, rodada 4 da revisão de código: lista viva do Kommo como fonte
Conferir um lote limitado em cima de uma réplica não confiável gerava casos sem fim: falta de progresso entre ciclos, pulos, reclassificação, cortes, leads sem origem e concorrência. A causa foi eliminada:
- **A lista de tarefas vem AO VIVO do Kommo:** abertas do usuário, paginadas até 3000. É a fonte autoritativa; nada da réplica decide o que é emitido.
- **A réplica só fornece dados do LEAD** (nome, etapa, origem) para TODOS os leads da lista, numa consulta ao banco. Os faltantes vêm da API em lotes de 50, e por falta de orçamento ficam como `origem_pendente`, com aviso.
- **Classificação com texto e tipo vivos.**
- **O widget recebe a lista completa e ordena;** o pular funciona sem depender do servidor.
- **Vazão:**
  - cache de 40 s por usuário;
  - **trava atômica por usuário** (`prevendas_travar`): uma execução por vez, e as concorrentes recebem o cache;
  - **orçamento compartilhado da conta** (`prevendas_consumir`, balde de 6 fichas com recarga de 2/s) antes de cada GET. Sem ficha, o widget pausa por instantes e não cai no degradado.
- **Incompletude nunca silenciosa:** `parcial` + `motivos_parcial` (limite de páginas, vazão, leads não consultados).
- **Saíram:** a ordem no servidor e a paridade, o lote e as rodadas, os pendentes e a descoberta de 3 h. O risco de "tarefa perdida pelo sync" deixa de existir para a fila, porque a lista é viva.
- **Custo:** cerca de 1 a 3 chamadas por SDR a cada 40 s; com 10 SDRs, cerca de 0,5 req/s. O balde limita a 2/s no agregado.

### Implementação, rodada 5 da revisão de código
- **Cache vencido nunca é autoritativo.** Com a trava ocupada, o servidor só devolve cache dentro da validade (40 s); fora disso, devolve 503 `em_andamento`. O widget usa o `gerado_em` do servidor (início da leitura viva) como idade real, ignora resposta mais velha que a atual e não rejuvenesce o snapshot. Com dados vencidos (mais de 3 ciclos), ações e notificações ficam suspensas.
- **Trava com token de posse.** `prevendas_travar` devolve um token, e `prevendas_gravar`/`prevendas_liberar` só valem para o dono com a trava dentro da validade. Uma execução lenta cuja trava venceu não sobrescreve nem libera a mais nova; isso foi validado num dry-run desfeito, no cenário A lento → B assume → A termina. Prazo total de 40 s, menor que a trava de 60 s, e timeout de 8 s por GET.
- **Progresso com orçamento curto.** Cada GET espera a recarga do balde por até 3 s (`esperarFicha`) em vez de desistir. O teste com 8 páginas e balde de 6 fichas, recarga 2/s, lê tudo em 3 rodadas seguidas. Se mesmo assim faltar ficha, o parcial vem com motivo.
- **Origem pendente** tem etiqueta própria ("prioridade provisória"), distinta de "origem não informada".
- **Dedup por id** depois da paginação: fica a versão com `updated_at` maior.
- A edge passou no type-check do Deno (`deno check`).

### Implementação, rodada 6 da revisão de código
- Uma leitura só substitui os dados se for **estritamente mais nova** (`Fila.leituraMaisNova`), com ou sem falha registrada. Vale para o servidor e para o degradado (início da leitura).
- A falha só é limpa por uma leitura **posterior** a ela (`Fila.falhaApos`): cache de antes da falha não comprova recuperação.
- Notificação só sai com dados recentes **e** sem falha, no líder e nas seguidoras.
- Testes cobrem, depois de uma falha: cache 30 s mais velho (dentro de 3 ciclos), cache com o mesmo `gerado_em` e leitura posterior. Em cada caso conferem falha, `dadosEm`, ids e ações.

### Decisões do Gabriel (26/10) aplicadas
1. **Anti no-show e pré-reunião são o mesmo momento** (slots T0–T6 = anti no-show). O canal vem do campo Origem (opção B).
2. **Sem corte das 16h:** o outbound entra só pela ordem.
3. **Leadbroker, Blackbox e Foodbox contam como Inbound (G2).** A opção "Inbound" não foi criada no campo.

Pendências, por decisão do Gabriel:
- migrar as tarefas abertas para os tipos novos só depois dos testes;
- mudar a cadência só com o widget pronto.

Para a fatia 3, junto com o click-to-call: a fila do CLOSER organizada pela etapa do funil Closer.

## 7. Fila do CLOSER pela etapa do funil Closer (desenho, nada aplicado)

Pedido do Gabriel (26/10, decisão 5): o PRÓXIMO também precisa servir ao closer, com a fila organizada pela **etapa do funil Closer** (11010459), sem criar tipos de tarefa novos.

### 7.1 O que existe hoje (levantamento só leitura na réplica, 26/10)
| etapa (status_id) | leads abertos | balde da cadência do closer (`kommo.closer_balde`) |
|---|---|---|
| Incoming leads (84456015) | 28, sem dono mapeado | sem cadência |
| feedback reunião (84456019) | 12 (closer 2, gestor 4, SDR 4, sem dono 2) | sem cadência; tarefa "Feedback da Reunião" (ALERTA) |
| MARCAR CALL PROPOSTA (103523344) | 9 | `MARCAR_CALL` |
| CALL PROPOSTA AGENDADA (110113248) | 4 | `PROP_AGENDADA` (+ recuperação de no-show R1–R3) |
| BAIXA PRIORIDADE +30d (102174776) | 48 (closer 23, SDR 24) | `BAIXA` (follow semanal infinito) |
| MÉDIA PRIORIDADE 11–30d (102174780) | 9 | `MEDIA` |
| ALTA PRIORIDADE 1–10d (102174784) | 10 | `ALTA` |
| CONTRATO NA RUA (84456095) | 2 | `CONTRATO` |
| CONTRATO ASSINADO / ganho / perdido | — | sem cadência |

A cadência do closer está ligada (`cadencia_closer_ativa=true`) e **cria as tarefas com antecedência**, com texto `CLOSER · <BALDE> · <passo>`. Por isso há muitas tarefas por lead:
- Sandro tem 209 tarefas abertas para 37 leads;
- um lead da BAIXA chega a ter 22 tarefas abertas, 21 delas vencidas.

Os closers também têm tarefas fora do funil Closer:
- Pré-vendas: T0 cliente oculto, T4 WhatsApp na manhã da reunião, Retorno.
- Funis de disparo (BASE, DISPARO 6): cerca de 37 tarefas, quase todas vencidas.

### 7.2 Desenho
1. **Mesmo widget, mesma edge.** O modo é decidido no SERVIDOR: `team_members.role = 'closer'` do usuário do JWT dá `modo: 'closer'`. Uma configuração `modo` (auto | sdr | closer) existe só para teste: o Gabriel (gestor) força `closer` e testa com os 4 leads dele no funil Closer.
2. **Fonte igual à do SDR.** A lista VIVA de tarefas do usuário vem do Kommo (autoritativa). Os dados do lead vêm da réplica: o RPC `prevendas_leads` passa a devolver também `status_id`, numa migration pequena que só faz `create or replace` de uma função de leitura. Lead que falta é buscado na API (o lote de 50 já devolve `status_id`/`pipeline_id`); se nada disso funcionar, o item fica `etapa_pendente` e vai para o fim, sem chute.
3. **A unidade da fila é o LEAD, não a tarefa.** É um card por lead, mostrando a tarefa mais antiga vencida e o aviso "+N vencidas". Sem isso, um lead com 21 follows acumulados ocuparia 21 posições.
4. **Elegível:** tarefa com prazo ≤ agora + `lookahead_min`. As tarefas futuras que a cadência já criou não aparecem.
5. **Ordem (configurável em `etapas_closer`, lista de status_id):**
   - **0. Reunião/call com hora marcada:** slots T0/T4 (via `reunioes.cadencia_task_ids`) e recuperação R1–R3, quando o prazo está dentro da antecedência. Hora marcada passa na frente de tudo, como no anti no-show do SDR.
   - 1. CONTRATO NA RUA
   - 2. CALL PROPOSTA AGENDADA
   - 3. feedback reunião
   - 4. MARCAR CALL PROPOSTA
   - 5. ALTA (1–10d)
   - 6. MÉDIA (11–30d)
   - 7. BAIXA (+30d)
   - 8. Lead fora do funil Closer (pré-vendas sem slot, funis de disparo) ou etapa pendente
   - Fora da fila: Incoming leads, CONTRATO ASSINADO, ganho, perdido.
   - Dentro do mesmo nível, vence o prazo mais antigo.
6. **"Concluir e próximo" conclui SÓ a tarefa mostrada**, como o closer faria no Kommo. Não fecha em lote as vencidas acumuladas: isso mexeria no mapa `deals.cadencia_closer_task_ids` da cadência, e o comportamento do `cadencia_closer_plan` diante de tarefa concluída à mão precisa ser conferido antes. Fica como pergunta, sem fazer.
7. **Ligar:** os closers têm `ramal_4com` e não têm agente 3C, então para eles o botão disca pela 4com, usando o mesmo proxy da §4.
8. **Nada muda** em tipos, cadência ou configuração do Kommo. Fila e ordem são só leitura e apresentação.

### 7.3 Perguntas para o Gabriel
1. A ordem da §7.2.5 está certa? Em especial, CONTRATO NA RUA antes de CALL PROPOSTA AGENDADA, e feedback reunião antes de MARCAR CALL.
2. A BAIXA (follow semanal infinito) entra na fila, por último? Hoje são 171 tarefas, 40 vencidas.
3. Há leads do funil Closer com dono SDR (Lary 19, Edric 15, a maioria na BAIXA e na ALTA). Esses SDRs seguem com a fila de SDR, onde essas tarefas caem em "sem classificação", ou a parte do funil Closer usa a ordem do closer?
4. Tarefas de closer nos funis de disparo, quase todas vencidas: entram no fim ou ficam de fora?
5. Querem um botão para concluir de uma vez os follows acumulados da cadência do closer? Seria uma entrega separada, só depois de conferir a cadência.
