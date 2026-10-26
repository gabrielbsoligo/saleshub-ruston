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
3. `UPDATE oculto_config SET ativo = true WHERE id = 1;` — as sondagens `pendente` saem no próximo `varrer`.
   Sem isso, nada é enviado (as sondagens ficam na fila).
4. Conferir no primeiro webhook real o nome do evento (`messages.upsert` vs `MESSAGES_UPSERT`: os dois são aceitos)
   e o formato do número no `remoteJid`.

## Concorrência e efeitos (revisão do Vedor, 26/10)
- **Posse por sessão**: `oculto_claim` (lease 3 min + token) em todo avanço; escritas `WHERE claim_token = token`;
  `oculto_renovar` falha se a sessão foi cancelada ou mudou de dono → **cancelar invalida qualquer envio em curso**.
- **Config revalidada antes de CADA envio** (já com o texto do LLM): `ativo && conectado` desligado = adia, não envia.
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

## Limites e cuidados
- Número NÃO oficial: risco de bloqueio pela Meta; volume baixo, 1 sondagem por número-alvo por vez,
  texto curto e humano. Nunca usar o número da prospecção oficial.
- A persona nunca se identifica como teste; se a empresa pedir dados pessoais/pagamento, ela desconversa.
- Testes: `deno test --allow-read` em `supabase/functions/cliente-oculto` (9+).
- Reverter: cabeçalho da migration (cron → tabelas → segredo); `supabase functions delete cliente-oculto`;
  no Enriquecedor, voltar o `case 'cliente_oculto'` para o `Placeholder`.
