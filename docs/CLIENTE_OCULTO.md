# Cliente oculto automatizado (Enriquecedor)

Persona de cliente (Claude Haiku) conversa pelo WhatsApp **anônimo** (Evolution API, número comum no
Railway do Gabriel) com a empresa do lead e avalia o atendimento. Primeiro pelos leads; depois concorrentes.

## Peças
- `supabase/migration_165_cliente_oculto.sql` — `oculto_config` (instância, ativo, conectado, limites, modelo),
  `oculto_sessoes` (1 por empresa-alvo: persona, estado, métricas, notas, parecer), `oculto_mensagens`
  (histórico in/out, dedupe por `wa_id`). RLS: leitura para membros ativos; escrita só service_role.
  Segredo do webhook em `integracao_config.oculto_webhook_secret`. Cron `oculto-varrer` (*/10, só com sessão aberta).
- Edge `cliente-oculto` (`--no-verify-jwt`): `conversa.ts` (puro: persona por nicho, prompts, métricas,
  notas, máquina de estados, parser do evento), `adaptadores.ts` (Evolution + Anthropic, fetch injetável),
  `index.ts` (webhook `/s/<segredo>`, `varrer`, `iniciar`, `cancelar`, `instancia`).
- Enriquecedor: aba **Cliente oculto** (`views/ClienteOcultoView.tsx`, `lib/ocultoRepo.ts`): painel do
  número (criar instância, QR, estado), lista de sondagens, conversa, notas e parecer; "Nova sondagem" por lead.

## Ciclo de uma sondagem
1. `iniciar` → sessão `pendente`; se `oculto_config.ativo` e `conectado`, a persona manda a abertura (`enviada`).
2. Webhook `messages.upsert` (empresa respondeu) → registra, cronômetro da 1ª resposta, persona responde
   (até `max_turnos`, padrão 4) → `conversando`.
3. Sem resposta à nossa última fala por 24 h, ou turnos esgotados → `aguardando_followup` (janela 72 h).
4. Fim da janela, ou 72 h sem nenhuma resposta → `concluida`: métricas determinísticas + avaliação do
   Haiku (qualificação, proposta/preço, tom, parecer, pontos fortes/fracos) → **notas 0–10**:
   tempo de resposta (≤5 min=10 … >24 h=1; sem resposta=0), qualificação, proposta/preço, follow-up
   (24 h=10, 48 h=7, 72 h=4, nenhum=0), tom; final = 30/20/20/20/10 %.

## Ligar (quando o Gabriel tiver o número)
1. Secrets da edge: `EVOLUTION_URL`, `EVOLUTION_APIKEY` (do Railway), `ANTHROPIC_API_KEY` (já existe).
2. Na aba: **Criar instância** (registra o webhook `<edge>/cliente-oculto/s/<segredo>` com
   `MESSAGES_UPSERT`/`CONNECTION_UPDATE`) → **QR code** → ler no WhatsApp do número anônimo → **Ver estado**.
3. **Interruptor na tela** (só gestor): botão **Ligar envios** / **Desligar envios** na faixa do número (edge `acao:'config'`, grava `oculto_config.ativo`; pede confirmação ao ligar, com o que vai sair). As sondagens `pendente` e as respostas represadas saem no próximo `varrer` (até 10 min). `ativo` nasce `false` (migration_165) de propósito.
   Sem isso, nada é enviado (as sondagens ficam na fila).
4. Conferir no primeiro webhook real o nome do evento (`messages.upsert` vs `MESSAGES_UPSERT`: os dois são aceitos)
   e o formato do número no `remoteJid`.

## Concorrência e efeitos (revisão do Vedor, 26/10)
- **Posse por sessão**: `oculto_claim` (lease 3 min + token) em todo avanço; escritas `WHERE claim_token = token`;
  `oculto_renovar` falha se a sessão foi cancelada ou mudou de dono → **cancelar invalida qualquer envio em curso**.
- **Config revalidada antes de CADA envio** (já com o texto do LLM): `ativo && conectado` desligado = adia, não envia.
- **Envios desligados**: a varredura adia abertura/resposta em 300 s ANTES de chamar o LLM (sem custo); avaliação e follow-up seguem. O cron `oculto-varrer` fica SEMPRE ligado — o único interruptor é `ativo`.
- **Ritmo humano** (migration_182, parâmetros em `oculto_config`, editáveis pelo gestor no botão **Ritmo** da tela):
  - `resposta_min_s`/`resposta_max_s` (padrão 40/240): atraso de "ler + pensar" antes de cada resposta, aleatório na faixa
    (determinístico por mensagem), **+ até 120 s** de leitura para mensagens longas (1 s a cada 12 caracteres; soma todas as
    mensagens da empresa ainda sem resposta; conta a partir da ÚLTIMA delas).
  - `janela_inicio`/`janela_fim` (padrão 08:00/18:00, seg–sex), `janela_sabado_fim` (NULL = sem sábado) e `fuso`
    (America/Sao_Paulo): fora da janela a resposta **e a abertura** esperam a próxima, com folga de 0–15 min.
  - "digitando...": a Evolution mostra por ~5 caracteres/s (2–20 s) antes de entregar (`delay` do sendText).
  - O portão de horário roda ANTES do LLM (sem custo); envios desligados continuam tendo precedência; limite de turnos intacto.
  - Cron `oculto-varrer` a cada minuto (só dispara com sessão devida) para os atrasos valerem de fato.
  - A tela mostra "responde às HH:MM" na sessão com resposta agendada.
- Rótulos da tela dizem o motivo de `pendente` (sem número / envios desligados / próximo ciclo) e marcam "resposta presa".
- **Envio**: intenção gravada antes do POST (`fase='enviando'`, `envio_pendente`); aceito → `oculto_envio_registrar`
  (mensagem + turnos + estado, atômico); 4xx → `erro` (não reenvia); timeout/rede/5xx → `fase='envio_incerto'` e a
  varredura **reconcilia** (eco do webhook ou `findMessages`) — encontrado = registra; não encontrado = `erro`
  visível, **sem reenvio automático**.
- **1 sessão aberta por número** (UNIQUE parcial inclui `pendente`) → 409 na corrida de dois "iniciar".
- **Follow-up** = nova iniciativa da empresa (mensagem dela logo após outra dela, ≥2 h depois); resposta tardia
  à nossa fala é resposta, não follow-up.
- **Avaliação IA indisponível** → status `avaliando`, 3 tentativas (30 min); se persistir, conclui com
  `notas.incompleta=true` e `final=null` (tempo e follow-up medidos; qualificação/proposta/tom sem nota) — nunca zero.
- **Varredura** só pega trabalhos devidos (`proximo_em <= now`, mais antigos primeiro, 15 por execução).
- Remetente do webhook e número cadastrado passam pela MESMA canonicalização (`numeroWa`: DDI 55 + 9º dígito).
- **Entrada da empresa** = RPC `oculto_entrada` (uma transação, idempotente): mensagem + watermark `entrada_rev` +
  `proximo_em=now`; vale também durante a abertura (`pendente`). `oculto_envio_registrar`/`oculto_liberar` comparam
  a watermark com o snapshot do avanço e, se a empresa escreveu no meio, reagendam para agora.
- **Identidade de mensagem**: `key.id`; sem ele, determinística (remetente|messageTimestamp|texto); sem id E sem
  timestamp = quarentena (ignorada com aviso) — nunca um id pela hora de recebimento.
- **Reconciliação**: só confirma com exatamente 1 evidência nova (eco local ∪ provedor, unidas por wa_id);
  2+ = erro ambíguo, sem reenvio.

## Limites e cuidados
- Número NÃO oficial: risco de bloqueio pela Meta; volume baixo, 1 sondagem por número-alvo por vez,
  texto curto e humano. Nunca usar o número da prospecção oficial.
- A persona nunca se identifica como teste; se a empresa pedir dados pessoais/pagamento, ela desconversa.
- Testes: `deno test --allow-read` em `supabase/functions/cliente-oculto` (9+).
- Reverter: cabeçalho da migration (cron → tabelas → segredo); `supabase functions delete cliente-oculto`;
  no Enriquecedor, voltar o `case 'cliente_oculto'` para o `Placeholder`.
