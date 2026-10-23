# Widget único de pré-vendas: proposta (fatia 1)

**Escopo:** um widget Kommo (`ruston-prevendas`) que junta **notify + PRÓXIMO + click-to-call**, para a conta `financeirorustonengenhariacombr`.

**Status:** proposta para o Gabriel decidir. **Nada foi criado ou alterado no Kommo.** Só fiz leituras via GET.

---

## 1. Inventário do que existe

| Item | Onde | O que aproveitar |
|---|---|---|
| **ruston-notify** (`rn_19a1462411`) | `kommo-widget/ruston-notify` (igual no hub-comercial) | **Base do widget novo.** Ver detalhes abaixo. O `dp.webhook_url` aponta para uma função `kommo-notify` que **não existe**. |
| **Ruston Próximo Lead** 1.0.2 | **só em zip:** `Downloads/ruston-next-lead-1.0.1.zip` e `1.0.2.zip`; não está no git | **É o PRÓXIMO quase pronto.** Ver detalhes abaixo. **Vou versionar o código no repo** dentro do widget novo. |
| **ruston-enriquecedor** | `kommo-widget/ruston-enriquecedor` | Padrão de botão flutuante no card (vigia de URL a cada 700 ms, já que o `render` falha com `init_once`) e de chamada ao backend com segredo. Fica como widget separado (é outra função). |
| Cadência do SalesHub | `kommo.plan_reconcile` (migration 155), `plan_closer` (072), retorno (131), sweeps SEM TAREFA (129/133), `enriquecedor-cadencia`, `kommo-call-note` | Ver §3 (impacto). |
| n8n `storeNewCalls` | Downloads | Só **lê** o 3C (webhook `call-history-was-created` + gravação com `?api_token=`). **Não discagem.** |
| api4com no código | `webhook-4com` (entrada), `team_members.ramal_4com` | **Nenhuma chamada de saída existe hoje**; a T5/T6 manda o SDR "ligar 3x pela API4COM" à mão. |
| 3C no código | `webhook-3c-calls`, `sweep-3c-calls`, `team_members.agente_3c_id`, isaas-hub `tresc.ts` | **Nenhum click2call ou discagem manual existe.** É trabalho novo. |
| "Origem do lead" no Kommo | campo `975168` (select): Recomendação, Outbound, Leadbroker, Indicação de Cliente, Networking, Thunderbolt, USA, Foodbox, Evento, Blackbox, Recovery, Reativação | **O canal já está no lead.** O PRÓXIMO pode ordenar por ele sem tipo de tarefa novo (§2.2). |

Detalhes do **ruston-notify**:
- faz polling do `/api/v4/tasks` do próprio usuário, pela sessão do Kommo (mesma origem, sem token no front);
- toca som, mostra notificação do navegador e uma pilha de alertas, e guarda o que já mostrou em `localStorage`.

Detalhes do **Ruston Próximo Lead** 1.0.2:
- configura a prioridade por **nome de tipo de tarefa**, além de antecedência, atalho Alt+N, posição e offset;
- monta a fila em 3 grupos:
  1. prioritários vencidos ou vencendo;
  2. cadência (ligar, WhatsApp, e-mail) por vencimento;
  3. prioritários futuros;
- abre a entidade pelo `AMOCRM.Router.navigate`.

**Tipos de tarefa hoje** (`GET /api/v4/account?with=task_types`):

| id | nome | onde é usado |
|---|---|---|
| 1 | Follow-up (Acompanhar) | T1, T2; retorno; plano do closer; cadência do enriquecedor; padrão de tarefa avulsa |
| 2 | Meeting | não usado pela cadência |
| 3732751 | Ligação | T5, T6 (anti no-show), R1, R3 (recuperação de no-show); auto-concluído pelo `kommo-call-note` |
| 3732759 | WhatsApp | T3, T4, R2 |
| 3732747 | Email | não usado pela cadência |
| 4174464 | Diagnóstico de M | manual |
| 3920343 | SEM TAREFA | sweep diário |
| 3928475 | ALERTA | pré-entrada duplicada |
| 4299552 | Cliente oculto | T0 (closer) |

> `GET /api/v4/tasks/types` responde 403 nesta conta. A lista acima vem do `account?with=task_types`. A criação foi feita por `POST /api/v4/tasks/types` ("Cliente oculto"), então esse endpoint existe para escrita.

---

## 2. Tipos de tarefa e ordem do PRÓXIMO

### 2.1 Opção A, como pedido: tipos por MOMENTO + um tipo por CANAL

Tipos novos (o prefixo numérico deixa a lista do Kommo na ordem de prioridade):

| # | Tipo novo | Momento ou canal | Quem cria |
|---|---|---|---|
| 1 | `01 Anti no-show` | véspera e dia da reunião, ligar e confirmar | cadência (T5, T6) |
| 2 | `02 Speed to lead` | lead novo de inbound, primeiros 5 min | gatilho da etapa SPEED TO LEAD |
| 3 | `03 Conexão` | lead em CONEXÃO REALIZADA: marcar a reunião | gatilho da etapa |
| 4 | `04 Recuperar no-show` | NOSHOW: R1, R2, R3 | cadência |
| 5 | `05 Follow-up` | FOLLOW 1 a 6 e retornos combinados | gatilho, retorno e manual |
| 6 | `06 Pré-reunião` | gerar valor (T1 a T4) | cadência |
| 7 | `10 Recomendação` | primeiro contato, canal Recomendação/Indicação | manual ou entrada |
| 8 | `11 Inbound` | primeiro contato, canal inbound/site | entrada |
| 9 | `12 Lead broker` | primeiro contato, canal Leadbroker | entrada |
| 10 | `13 Outbound` | prospecção fria (listas, 3C) | entrada ou manual |

**Mantidos:** Ligação, WhatsApp, Email, Meeting, Diagnóstico, SEM TAREFA, ALERTA e Cliente oculto. Ligação e WhatsApp viram legado e deixam de ser criados pela cadência; ninguém apaga nada.

### 2.2 Opção B (recomendada): tipos por MOMENTO + canal pelo campo "Origem do lead"

- **Tipos:** só os 6 de momento (`01` a `06`) e **um** `13 Prospecção` para o primeiro contato.
- **Canal:** o PRÓXIMO lê o campo **Origem do lead (975168)** e usa o canal como **segundo critério** de ordenação.

Por que é melhor:
- o lead já carrega o canal, e os tipos "por canal" duplicariam essa informação e divergiriam dela;
- evita a explosão momento × canal ("follow-up de recomendação" seria de que tipo?);
- a cadência só precisa trocar tipo por momento, nunca por canal.

O custo é uma consulta a mais (os leads das tarefas, em lote de 50). O widget já faz isso para mostrar os nomes.

### 2.3 Ordem proposta do PRÓXIMO (padrão, editável)

Regra de tempo, igual ao Próximo Lead:
- só entra na fila a tarefa **vencida** ou **vencendo nos próximos X min** (padrão 10);
- dentro do mesmo nível, ganha a mais atrasada.

| Prioridade | Tipo (e canal, na opção B) | Por quê |
|---|---|---|
| 1 | **Anti no-show** | tem horário: reunião em minutos |
| 2 | **Speed to lead** | lead quente esfria em minutos |
| 3 | **Conexão** | decisor já respondeu: marcar a reunião |
| 4 | **Follow-up**, na ordem Recomendação/Indicação → Inbound → Leadbroker → demais | sugestão do Gabriel: follow-up/recover primeiro |
| 5 | **Recuperar no-show** | recover |
| 6 | **Pré-reunião** | gerar valor tem prazo, mas aceita ficar à tarde |
| 7 | **Primeiro contato inbound / leadbroker / recomendação** | fila nova quente |
| 8 | **Outbound / Prospecção** | **fim do dia:** só aparece depois das **16h**, ou antes disso se a fila 1–7 estiver vazia (janela configurável) |

**Configuração:**
- **v1, no widget (aba Configurações da integração, só admin):**
  - `ordem` = lista de nomes de tipos, separados por vírgula;
  - `ordem_canal` = lista de valores do campo Origem;
  - `outbound_apos` = `16:00`;
  - `antecedencia_min` = `10`.
  - Vale para a conta toda.
- **v2:** ordem **por SDR ou por time** numa tabela do SalesHub (`prevendas_ordem`), servida pelo mesmo proxy do click-to-call. Assim o gestor muda sem mexer no Kommo.

**Botão PRÓXIMO:**
- abre o card da próxima tarefa e mostra um banner com o tipo, o motivo e o vencimento;
- botões "Concluir e próximo" e "Pular 15 min".
- O "Concluir" usa `PATCH /api/v4/tasks/{id}` com `is_completed` pela sessão do próprio SDR, ou seja, a mesma ação que ele faria na tela.

---

## 3. Impacto na cadência do SalesHub (mapeado, nada aplicado)

| Hoje | Onde | Muda para | Ajuste necessário |
|---|---|---|---|
| T0 Cliente oculto (4299552, closer) | `plan_reconcile` | **sem mudança** | — |
| T1, T2 gerar valor (1) | `plan_reconcile` | `06 Pré-reunião` | trocar o `task_type_id` no SQL do planner + migration |
| T3, T4 (3732759) | `plan_reconcile` | `06 Pré-reunião` (T3) e `01 Anti no-show` (T4, dia da reunião, closer) | idem |
| T5, T6 ligar API4COM (3732751) | `plan_reconcile` | `01 Anti no-show` | idem; **e** `kommo-call-note` deixa de achar a tarefa pelo tipo 3732751 e passa a aceitar o novo id (o texto "ligar" continua valendo) |
| R1, R2, R3 (3732751/3732759) | `plan_reconcile` | `04 Recuperar no-show` | idem |
| Retorno (1) | migration 131 | `05 Follow-up` | trocar o id |
| Closer A/M/B/C/P (1) | `plan_closer` | **sem mudança** (é closer, fora do PRÓXIMO do SDR) | — |
| SEM TAREFA, ALERTA | sweeps | sem mudança | o PRÓXIMO mostra no fim |
| `enriquecedor-cadencia` "Ligar AGORA" (1) | edge function | `03 Conexão` (o lead respondeu) | trocar o id |

Dois cuidados:
- **Tarefas já abertas** com os tipos antigos continuam válidas. O PRÓXIMO aceita os dois, porque o mapa "tipo antigo → nível" fica na configuração. O planner, ao reconciliar, **não recria** tarefa só por troca de tipo (Path B: PATCH, nunca DELETE). É preciso confirmar no SQL que o PATCH de reconciliação também atualiza `task_type_id`.
- **Ordem de aplicação:**
  1. criar os tipos;
  2. publicar o widget com o mapa antigo + novo;
  3. migration do planner;
  4. deploy do `kommo-call-note` e do `enriquecedor-cadencia`.

  Aplicar exige o OK do Gabriel, e o Engenheiro do SalesHub está mexendo nesse repo (precisa coordenar).

---

## 4. Desenho do click-to-call (3C e 4com)

### 4.1 Regra
O token do discador **nunca vai para o navegador.** O widget só pede "ligar para este número deste lead". Quem liga é um **proxy no servidor**: a edge function nova `prevendas-dial`, no Supabase do SalesHub.

### 4.2 Fluxo
```
[botão 📞 no card/contato ou no banner do PRÓXIMO]
   │ widget lê os telefones do contato pela sessão do Kommo (mesma origem); o SDR escolhe o número
   ▼
POST /functions/v1/prevendas-dial  { lead_id, contact_id, phone }  + header X-Auth-Token (JWT descartável do Kommo)
   │ proxy valida o JWT com o client secret da integração → sabe account_id e user_id DE VERDADE
   │ kommo user_id → team_members (discador preferido, ramal_4com, agente_3c_id, tokens no Vault)
   ├─ 4com: POST https://api.api4com.com/api/v1/calls   Authorization: <token do usuário>
   │        { extension: ramal, caller: ramal, called: "+55…", metadata: { kommo_lead_id, kommo_user_id } }
   │        → a resposta vem depois do atendimento (timeout longo); devolve o id; o hangup sai pelo mesmo id
   └─ 3C:   (o SDR precisa estar logado no 3C web, numa campanha e livre; o áudio toca no webphone dele)
            POST /agent/manual_call/enter  → POST /agent/manual_call/dial { phone }   com o token DO AGENTE
            (alternativa: POST https://3c.fluxoti.com/api/v1/click2call com token de gestor + ramal; formato não documentado)
   ▼
widget mostra "chamando…", e erro legível se houver (ramal não encontrado, agente fora da campanha, limite 15/min)
```

### 4.3 O que roda onde

| No navegador (widget) | No proxy (servidor) |
|---|---|
| ler telefones do lead/contato (`/api/v4/contacts/{id}`, sessão) | validar a identidade (JWT descartável do Kommo, `$authorizedAjax`) |
| escolher o número e chamar o proxy | escolher o discador do usuário; ler o token no Vault |
| mostrar estado e erro | chamar 3C ou 4com; registrar a tentativa (`prevendas_discagem`: user, lead, phone, provedor, resultado) |
| — | rate limit (4com: 15/min por ramal) e bloqueio de número fora do Brasil ou de teste |

**Por que não direto do navegador:**
1. os tokens (gestor 3C, usuário 4com) não podem ficar no front, nem na configuração do widget, que qualquer admin da conta lê;
2. não há garantia de CORS nas duas APIs;
3. sem a validação do JWT, qualquer pessoa com a URL do proxy ligaria em nome de outro.

**Identidade:**
- O Kommo assina um **token descartável (JWT)** para widgets de integração privada, enviado com `self.$authorizedAjax`. O proxy valida com o *secret key* da integração, que fica só no servidor.
- Se isso falhar na conta, o plano B é um segredo por usuário gerado no SalesHub e colado uma vez nas configurações pessoais do widget. É pior; só em último caso.

### 4.4 Configuração por usuário (SalesHub, tela Equipe)
- `discador`: `3c` ou `4com`.
- 4com: `ramal_4com` (já existe) + **token 4com do usuário** (login dele, `ttl -1`), no **Vault**.
- 3C: `agente_3c_id` (já existe) + **api_token do agente**, no **Vault**.

### 4.5 Riscos e o que validar na fatia 3

| Ponto | Validação |
|---|---|
| Token descartável (JWT) do Kommo para o widget (`$authorizedAjax`) funciona nesta conta | testar na fatia 2 (sem ligar para ninguém) |
| Nome do campo na discagem manual do 3C (`phone`?) e se o `manual_call/enter` é obrigatório | testar com o agente do Gabriel |
| Formato do click2call do 3C (fluxoti) | idem |
| 4com: token por usuário | precisa do login de cada SDR (ou de um token gerado pelo gestor, se a conta permitir) |
| Ligação real | **só para o número do próprio Gabriel**, com o OK dele |

---

## 5. Plano das próximas fatias
- **Fatia 2 (notify + próximo):** widget `ruston-prevendas` = base do notify + PRÓXIMO do Próximo Lead 1.0.2 com a ordem do §2.3 (lendo tipos por nome e o mapa antigo → novo), banner com "Concluir e próximo" e "Pular". Integração privada em zip, testada só com o usuário do Gabriel (11420911). Funciona **antes** de criar os tipos novos, usando o mapa dos tipos atuais.
- **Fatia 3 (click-to-call):** edge function `prevendas-dial` + tabela de log + campos no SalesHub + botão no widget; teste só com o número do Gabriel.

## 6. Decisões que preciso do Gabriel
1. **Tipos:** opção **B** (momento + campo Origem, recomendada) ou opção **A** (momento + um tipo por canal)?
2. **Ordem:** a tabela do §2.3 está boa? Confirmar o horário de corte do outbound (16h?) e a antecedência (10 min?).
3. **Criação dos tipos:** OK para eu criar os tipos no Kommo (POST /api/v4/tasks/types) **depois** que a fatia 2 estiver validada?
4. **Ajuste da cadência:** quem aplica, eu ou o Engenheiro do SalesHub, e quando?
5. **4com:** quem fornece os tokens por usuário (login de cada SDR) e o ramal de cada um?
6. **3C:** OK para um teste de discagem com o agente do Gabriel ligando para o celular dele?
