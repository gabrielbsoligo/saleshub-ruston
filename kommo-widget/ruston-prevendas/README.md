# Ruston Pré-vendas: widget único do Kommo (notify + PRÓXIMO; click-to-call na fatia 3)

Substitui o **ruston-notify** e o **Ruston Próximo Lead**. Proposta e regras: `PROPOSTA.md` (rev. 3, aprovada pelo Vedor).

## O que tem nesta pasta

| Arquivo | O que é |
|---|---|
| `script.js` | widget (AMD). O bloco `Fila` é puro e testado em Node |
| `manifest.json`, `i18n/`, `images/`, `notify.mp3` | pacote do Kommo |
| `build-zip.mjs` | gera `dist/ruston-prevendas.zip` (só os arquivos do widget; UTF-8 sem BOM) |
| `tests/` | `fila.test.cjs`, `widget.test.cjs` (ciclo completo em VM), `servidor.test.ts`, `classificar.test.ts`, `jwt.test.ts` |
| `../../supabase/functions/prevendas-fila/` | edge: lê **ao vivo** no Kommo a lista de tarefas abertas do usuário (fonte autoritativa), classifica com dados de lead (réplica/API) e slots; cache 40 s, trava por usuário, orçamento de vazão da conta |
| `../../supabase/functions/_shared/prevendas_servidor.ts` | núcleo puro do servidor (montarItens, leadsFaltando) |
| `../../supabase/migration_163_prevendas_fila.sql` | `prevendas_leads`, `prevendas_slots`, `prevendas_fila_frescor`, cache/trava (`prevendas_cache`, `prevendas_travar/gravar/liberar`) e orçamento (`prevendas_vazao`, `prevendas_consumir`); tudo só service_role |
| `../../supabase/functions/_shared/prevendas_classificar.ts` | classificador puro, também para o `kommo-call-note` no futuro |
| `../../supabase/functions/_shared/kommo_jwt.ts` | verificação do JWT descartável do Kommo (HS256) |

## Testes
```bash
node --test kommo-widget/ruston-prevendas/tests/fila.test.cjs
node --test kommo-widget/ruston-prevendas/tests/widget.test.cjs
node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/servidor.test.ts
node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/classificar.test.ts
node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/jwt.test.ts
```

## Instalação (teste só com o usuário do Gabriel, 11420911)

Na **ordem**:

1. **Gerar o zip:** `node kommo-widget/ruston-prevendas/build-zip.mjs`, que cria `dist/ruston-prevendas.zip`.
2. **Criar a integração privada** (admin do Kommo, pelo portal):
   - Configurações → Integrações → "+ Criar integração" → integração externa;
   - nome "Ruston Pré-vendas", salvar;
   - aba Widget → enviar o zip.
3. **Guardar o ID da integração e o Secret key** (aba "Chaves e escopos") **só no cofre:** `%USERPROFILE%\.oraculo\segredos\kommo-widget-prevendas.env`, com:
   ```
   KOMMO_WIDGET_CLIENT_ID=<ID da integração>
   KOMMO_WIDGET_SECRET=<Secret key>
   ```
4. **Publicar a função SQL e a edge** (Forja):
   - aplicar `supabase/migration_163_prevendas_fila.sql` no projeto do SalesHub. É só leitura e só o service_role executa;
   - rodar:
   ```bash
   supabase secrets set --project-ref iaompeiokjxbffwehhrx KOMMO_WIDGET_CLIENT_ID=… KOMMO_WIDGET_SECRET=… KOMMO_ACCOUNT_ID=34424367
   supabase functions deploy prevendas-fila --project-ref iaompeiokjxbffwehhrx --no-verify-jwt --use-api
   ```
   `KOMMO_API_TOKEN` já existe no projeto (usado para conferir o lote no Kommo). `PREVENDAS_TIPOS_MOMENTO` é opcional (mapa de tipos novos → momento, quando existirem).
5. **Instalar a integração** e preencher **antes de salvar**:
   - `endpoint` = `https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/prevendas-fila`;
   - **`usuarios` = `11420911`**. Com essa lista, os outros usuários não carregam nada.
   - Os demais campos podem ficar em branco (têm padrão).

## Roteiro de teste (fatia 2)

Nenhuma ligação; nada é criado. O único efeito colateral possível é o "Concluir e próximo", que só é clicado numa tarefa de teste do Gabriel.

1. **Visibilidade:** logado como Gabriel, aparecem a pastilha **Próximo** e o painel ▴. Com outro usuário, nada aparece.
2. **JWT:** o rodapé do painel mostra `servidor: ok`. Se mostrar `indisponível (jwt_…)`, o código diz qual claim falhou (formato, assinatura, conta, emissor, integração, expiração). É o teste do §4.6 da proposta. Ajustar só o nome do claim, se a conta usar outro.
3. **Fila:**
   - comparar a ordem do painel com a regra (anti no-show → speed → conexão → follow-up → recuperar → pré-reunião → prospecção; outbound só depois das 16h);
   - tarefas de cadência aparecem com o momento certo (T5/T6 = Anti no-show; R1–R3 = Recuperar).
4. **Notify:** uma tarefa de teste vencendo em 5 min gera pop-up, som e notificação do navegador.
5. **Concluir e próximo / Pular 15 min:** numa tarefa de teste criada só para isso.
6. **Negativos pelo servidor** (`curl` com JWT inválido ou de teste): a resposta deve ser 401 com o código certo. O servidor só devolve tarefas do usuário do token.
7. **Frescor:** o rodapé mostra o modo (`servidor` ou `degradado`) e a hora. Com a réplica atrasada mais de 10 min, aparece um aviso.

## Reverter
- Desinstalar ou desativar a integração "Ruston Pré-vendas" no Kommo. Os widgets antigos continuam instalados e intocados.
- Edge: `supabase functions delete prevendas-fila --project-ref iaompeiokjxbffwehhrx`, depois `supabase secrets unset KOMMO_WIDGET_CLIENT_ID KOMMO_WIDGET_SECRET KOMMO_ACCOUNT_ID`.
- SQL: `drop function public.prevendas_leads(bigint[]), public.prevendas_slots(bigint[]), public.prevendas_fila_frescor(), public.prevendas_travar(bigint,int), public.prevendas_gravar(bigint,text,jsonb), public.prevendas_liberar(bigint), public.prevendas_consumir(int,numeric,numeric); drop table public.prevendas_cache, public.prevendas_vazao;`
- Nenhuma tabela, cadência ou tipo de tarefa foi alterado nesta fatia; só duas funções de leitura foram adicionadas.

## Telefone no Kommo (webphone 4com) e chat sem resposta — v0.4.0 (NÃO aplicado)

Pré-requisito de segurança: a decisão A/B do Gabriel. O ramal registrado consegue originar chamada direto (sonda de 26/10), então a credencial no navegador equivale a uma linha.

**Aplicar (só com o ok):**
1. `supabase/migration_164_prevendas_voz.sql`: log e limite por usuário; só service_role.
2. Secrets:
   ```
   API4COM_TOKEN=<API4COM_TOKEN_PERMANENTE do cofre>
   API4COM_DOMAIN=ruston.api4com.com
   API4COM_WSS=wss://ruston.api4com.com:6443
   PREVENDAS_VOZ_USUARIOS=11420911
   PREVENDAS_VOZ_TELEFONES_TESTE=47997293673
   ```
   - `PREVENDAS_VOZ_TELEFONES_TESTE` só existe para o teste T2 e deve ser removido depois.
   - Opcional: `PREVENDAS_CHATS_DIAS=7`.
3. Deploy:
   ```
   supabase functions deploy prevendas-voz --no-verify-jwt --use-api
   supabase functions deploy prevendas-fila --no-verify-jwt --use-api
   ```
   O redeploy da `prevendas-fila` é o que traz o chat sem resposta.
4. Zip 0.4.0 (`node build-zip.mjs`). Settings do widget: `voz=Y`; o `endpoint_voz` fica vazio e é derivado do endpoint da fila.

**Testar:**
- **T1 (sem ligação):** o card "📞 Telefone · pronto" aparece. O navegador pede o microfone para o Kommo.
- **T2 (uma ligação):** num lead com o telefone de teste, "Ligar".
  1. O ramal toca no widget ("Sua ligação: atenda…") e o usuário clica em **Atender** (não há atendimento automático).
  2. A 4com liga para o número.
  3. Uma nota "📞 Ligação 4com…" é gravada no lead.

**Reverter:**
- `voz=N` nas settings (o telefone some na hora).
- `supabase functions delete prevendas-voz`.
- `supabase secrets unset API4COM_TOKEN API4COM_DOMAIN API4COM_WSS PREVENDAS_VOZ_USUARIOS PREVENDAS_VOZ_TELEFONES_TESTE`.
- No banco:
  ```sql
  -- telefone (só objetos da 164)
  drop function if exists public.prevendas_voz_reservar(bigint,text,int,int,int,text,text),
                          public.prevendas_voz_registrar(bigint,text,text),
                          public.prevendas_voz_bloquear(bigint,text,int);
  drop table if exists public.prevendas_voz_eventos, public.prevendas_voz_bloqueio;
  -- pausa compartilhada: volta o prevendas_consumir da 163 (sem pausa) ANTES de tirar a coluna; a fila segue funcionando
  create or replace function public.prevendas_consumir(p_n int, p_taxa numeric default 2, p_max numeric default 6)
  returns boolean language plpgsql security definer set search_path = public as $$
  declare ok boolean;
  begin
    update prevendas_vazao
       set fichas = least(p_max, fichas + extract(epoch from now() - em) * p_taxa) - p_n, em = now()
     where id = 1 and least(p_max, fichas + extract(epoch from now() - em) * p_taxa) >= p_n
    returning true into ok;
    return coalesce(ok, false);
  end $$;
  revoke all on function public.prevendas_consumir(int,numeric,numeric) from public, anon, authenticated;
  grant execute on function public.prevendas_consumir(int,numeric,numeric) to service_role;
  drop function if exists public.prevendas_pausar(int);
  alter table public.prevendas_vazao drop column if exists pausa_ate;
  ```
  Ordem: primeiro voltar as edges (a `prevendas-fila` de 25d9381 não chama `prevendas_pausar`), depois o SQL. A tabela `prevendas_vazao` e o balde continuam, porque a fila da 163 depende deles.
- Chat sem resposta: redeploy da `prevendas-fila` do commit 25d9381.

**Revogar uma credencial SIP já entregue.** Remover a edge ou os secrets NÃO revoga o HA1 que já foi para um navegador: com ele, o ramal continua registrando e originando chamadas direto (fora do limite do servidor).
1. Trocar a senha do ramal na 4com (painel, em Ramais, ou `PATCH /extensions`). Isso invalida o HA1 antigo; o próximo pedido de credencial já recebe o novo.
2. Para encerrar sessões e registros em curso, use o painel da 4com (registros do ramal) ou desligue o ramal.
3. Faça isso sempre que um usuário sair da lista `PREVENDAS_VOZ_USUARIOS`, mudar de ramal ou houver suspeita de vazamento.

Decisão do Gabriel (26/10): opção B, seguir sem pedir à 4com o bloqueio de saída direta dos ramais, com as mitigações acima.

## Fila do CLOSER (PROPOSTA §7 rev. 2.1 + decisões §7.5) — NÃO aplicado

Quem tem `team_members.role = 'closer'` recebe a fila do closer. Quem decide é o servidor, e só o gestor pode forçar o modo pelo setting `modo` (sdr | closer) para testar. A fila tem um card por LEAD, nesta ordem:
1. chat sem resposta;
2. reunião em que ele é o closer efetivo, de 2 h antes até 30 min depois (`antecedencia_closer_min`);
3. etapas do funil Closer, na ordem de `etapas_closer`. Padrão: CONTRATO NA RUA, CALL PROPOSTA AGENDADA, feedback reunião, MARCAR CALL, ALTA, MÉDIA, BAIXA;
4. o resto: funis de disparo, etapa a confirmar e contatos.

Ficam fora da fila Incoming leads, CONTRATO ASSINADO, ganho e perdido, mas só se a etapa for confirmada ao vivo. "Concluir" age só na tarefa exibida, e o próximo é outro lead. Nada muda na cadência.

**Aplicar (só com o ok):**
1. `supabase/migration_166_prevendas_closer.sql`: só funções de leitura.
2. `supabase functions deploy prevendas-fila --no-verify-jwt --use-api`.
3. Zip novo (`node build-zip.mjs`).

**Testar:**
- O Gabriel (gestor) põe `modo=closer` nas settings: a fila vira a do closer, com os leads dele.
- Depois volta para `modo` vazio.
- Closer de verdade só entra na lista `usuarios` com o ok do Gabriel.

**Reverter:**
- Voltar a edge do commit 3ba7688.
- `drop function public.prevendas_compromissos(bigint,bigint[],timestamptz,timestamptz);`
- Recriar o `prevendas_leads` da migration 163. O campo `status_id` a mais é inofensivo, então esse passo é opcional.

## 0.4.6 — a fila nunca prende o usuário

- **Servidor (`prevendas-fila`):**
  - A leitura dos chats da conta (cerca de 20 s pelo orçamento de 2 GET/s) roda em segundo plano, depois da resposta (`EdgeRuntime.waitUntil`). A fila usa o último cache de chats, com até 120 s.
  - Trava curta: 35 s, com prazo de execução de 25 s.
  - Se outra execução do mesmo usuário estiver em curso (outra aba ou outro navegador), o servidor devolve o último snapshot com a idade real (`em_andamento`). O 503 só aparece se ainda não existir nenhum snapshot.
- **Widget:**
  - Lista velha ou com falha não suspende mais as ações. Aparece só um aviso discreto ("Lista das HH:MM…").
  - O "Concluir" confere a tarefa ao vivo antes do PATCH (`GET /api/v4/tasks/{id}`). Se ela já estiver concluída ou com outra pessoa, sai da lista sem ser concluída.
  - Com `em_andamento`, tenta de novo em cerca de 7 s.
  - Um watchdog de 45 s impede que um pedido que nunca volta congele a fila.
  - As notificações continuam só com dado recente.
- **Reverter:** redeploy da `prevendas-fila` do commit anterior e o zip 0.4.5. Nada muda no banco.

## Servidor 0.4.7 — chats da janela inteira (7 dias), leitura incremental

- A janela de 7 dias tem cerca de 3.600 eventos de chat (37 páginas). Antes, a leitura parava em 10 páginas e por isso o aviso "leitura parcial" aparecia sempre.
- O servidor lê a janela inteira uma vez, em segundo plano. O prazo é de 110 s, a trava da conta de 150 s e há uma pausa de 300 ms entre GETs, para sobrar orçamento à fila.
- Depois disso, cada renovação lê só os eventos novos, desde a última leitura completa menos 10 min de sobreposição, sem repetir id. Os eventos ficam compactados em `prevendas_cache` (linha 0, campo `eventos`); o pedido do usuário lê só `chats`, `leads`, `talks`, `parcial` e `gerado_em`.
- A cada 30 min a leitura é integral (reconciliação): um evento que o Kommo só mostre depois dos 10 min de sobreposição entra nessa leitura. O atraso máximo é de cerca de 30 min, e o checkpoint da última leitura integral fica em `integral_em`.
- O aviso "Chats: leitura parcial" só aparece quando a leitura realmente trunca (limite de 80 páginas, prazo ou orçamento). Nesse caso o cache perde o `completo` e a próxima renovação relê a janela inteira.
- O widget não muda: continua o zip 0.4.6.
- **Reverter:** redeploy da `prevendas-fila` de `9f65f59`. O campo `eventos` a mais no cache é ignorado.

## 0.4.8 — telefone: número completo na nota e resultado final da ligação (CDR da 4com)

- **Uma nota por ligação.** A nota é criada ao discar, já com o número completo (`+55 47 99729-3673`) e "Resultado: aguardando o fim da ligação…". Quando a chamada termina, essa mesma nota é ATUALIZADA (PATCH) com o resultado: atendida (com a duração), não atendida, ocupado, cancelada antes de atender, número inexistente…
- **Vínculo com o CDR.** O id que o `POST /calls` da 4com devolve não é o id do CDR. Por isso o widget manda `metadata.widget_ev` (o id do evento de auditoria), e o servidor acha o CDR por `widget_ev` + `kommo_user`.
- **Ação `resultado` em `prevendas-voz` + cron.** O widget chama a ação ~8 s depois do fim da chamada (7 tentativas com espera crescente, ~17 min) e uma de segurança 90 s depois de discar. Independente da aba, o cron `prevendas-voz-resultados` (pg_cron a cada 2 min, só quando há pendentes; segredo no cofre `prevendas_voz_cron_secret` = env `PREVENDAS_VOZ_CRON_SECRET`) completa as pendentes de todos os usuários das últimas 24 h. Regras em `_shared/prevendas_voz_resultado.ts` (testadas com I/O falso):
  - pendentes filtradas no BANCO (`final_em is null`, as 25 mais antigas e as 25 mais novas, intercaladas);
  - posse com TOKEN exclusivo (`final = {proc, tok}`): toda escrita condicionada ao token; lease de 90 s revalidado (no banco) antes de cada efeito no Kommo; abandono só após 150 s;
  - nota idempotente: marcador `Ref. widget #<ev>`; a entidade da nota é gravada ANTES do POST; sem `nota_id`, a nota é procurada pelo marcador antes de criar (resposta perdida / id não gravado não duplicam);
  - CDRs por FAIXA DE TEMPO (`where started_at between`, janela [discagem − 5 min, + 10 min] de cada pendente, fundidas até 1 h, paginadas até o fim; envelope `{data, meta}`); ordem mais novas/mais antigas alternada e orçamento de requisições por rodada — uma pendência antiga não segura as novas; janela não lida inteira, envelope inesperado ou erro = ADIA; "não completou (sem registro na 4com)" só com a janela coberta e 15 min;
  - CDR sem fim/causa (em andamento/incompleto) ADIA; depois de 6 h fecha como "resultado indeterminado";
  - nota que falha volta para nova tentativa por até 3 h; `cdr_id` guardado (futuro `calls.provider_call_id`).
- **Para não duplicar a nota "LIGAÇÃO … Resumo" da 4com/N8N.** Nossa nota não repete o resumo. A gravação só entra se nenhuma outra nota da entidade já tiver aquele arquivo; atendida com gravação espera 2 min do fim para a N8N escrever primeiro (se a N8N atrasar mais, o link pode aparecer nas duas — inofensivo).
- **Onde fica o resultado:**
  - Lead aberto e autorizado: no lead, mesmo que o número digitado não seja dele.
  - Sem lead: num CONTATO com esse número, se a busca COMPLETA (paginada) achar exatamente um, do usuário (ou usuário gestor); ambíguo ou busca longa demais = sem nota.
  - Fora desses casos: só na auditoria (`prevendas_voz_eventos.final`) e no rodapé do widget ("Última ligação: …").
- **3C:** ainda sem CDR. A nota fica só com o cabeçalho.
- **Convergência:** quando a tabela `calls` + `kommo-writer` (AUDITORIA-LIGACOES F5, Engenheiro) existirem, a prevendas-voz só registra a tentativa (`client_ref = widget_ev`) e o writer atualiza ESTA nota (por `nota_id`/marcador); então o cron e a ação `resultado` são desligados.
- **Migration `supabase/migration_169_prevendas_voz_resultado.sql`:** aditiva. Colunas `provedor`, `nota_entidade`, `nota_id`, `final`, `final_em`, `cdr_id`; ação `resultado` no check; índice parcial das pendentes; job do cron.
- **Reverter:** zip 0.4.6, redeploy da `prevendas-voz` de `9f65f59` e o SQL de reversão do cabeçalho da 169.
