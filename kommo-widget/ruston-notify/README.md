# Ruston Notify — widget privado do Kommo

Pop-up persistente de tarefa dentro do Kommo: fica na tela até o SDR fechar,
reaparece ao navegar, empilha, toca som e dispara notificação do navegador.
Substitui o Pusher pago do Komanda F5, sem custo.

## Conteúdo do bundle (zip)
```
manifest.json      widget + locations (settings, digital_pipeline, cards, listas) + settings + dp
script.js          AMD module: init/render/bind_actions/destroy; overlay no DOM; Notification + Audio
style.css          classes com prefixo rnw- (não colide com o Kommo)
notify.mp3         som do aviso (di-ding, ~0,5s)
i18n/              pt, en, es, ru
images/            logo.png (84x84) + icon.png (128x128, usado na Notification)
```
Todos os arquivos são UTF-8 sem BOM.

## Gatilho escolhido: polling da API de Tarefas (front puro, SEM backend)

**Por quê:** a ação de `digital_pipeline` do Kommo é *server-side* — ela faz
POST num `webhook_url`, não entrega um evento pro JS do widget no navegador.
Ou seja, não dá pra "receber o evento" client-side só declarando o
`digital_pipeline`. O caminho mais simples que **funciona sem backend** é o
`script.js` consultar a própria API do Kommo (`GET /api/v4/tasks`) de tempos
em tempos, filtrando as tarefas do usuário logado que **vencem em breve ou
estão atrasadas**, e popar as novas.

- Roda como o usuário logado (mesma origem, cookie de sessão) — sem token,
  sem servidor.
- `poll` a cada 45s (configurável), janela de "vence em breve" = 15 min
  (configurável). Atrasadas sempre avisam.
- Dedup por `localStorage` (`rnw_seen_*`): cada tarefa só pop uma vez.
- As notificações ativas ficam em `localStorage` (`rnw_active_*`) → sobrevivem
  a troca de página/reload até o SDR fechar no ×.

**Caminho opcional (futuro) via Digital Pipeline + backend:** o manifest já
declara `digital_pipeline` + `dp.webhook_url` apontando pra
`.../functions/v1/kommo-notify` (Supabase Edge — ainda não criada). Se um dia
quiser disparos ricos por estágio do funil, cria essa function pra gravar a
notificação e troca o polling por leitura dela. Não é necessário pro
funcionamento atual.

## Como subir e instalar (você é usuário da matriz)

> **Precisa de admin?** Sim. Criar uma integração privada exige um usuário
> **admin** da conta (com direito de "Integrações"). Se seu login da matriz
> for admin, você mesmo faz. Se não, peça pra um admin fazer o upload — depois
> qualquer usuário passa a ver o pop-up.

1. Kommo → **Configurações → Integrações** (Settings → Integrations).
2. Botão **"+ Criar integração"** (canto superior direito) → aba/opção
   **"Integração externa"** (widget).
3. Preencha nome/descrição, marque os escopos/permissões pedidos e **salve** —
   o Kommo gera o **ID da integração (chave)** e o **Secret**. *(São esses o
   "code/key" gerados pelo Kommo; o widget não precisa deles no código.)*
4. Na integração criada, aba **"Widget"/"Código"** → **enviar arquivo .zip** →
   selecione `ruston-notify.zip`.
5. **Instalar** a integração. Se a tela de instalação pedir os campos de
   configuração (posição, som, etc.), pode deixar em branco — tem padrão pra
   todos.

## O que testar depois de instalar

O pop-up é dirigido por **tarefas suas no Kommo**. Pra ver funcionando:

1. Abra o Kommo e navegue até **qualquer lead ou lista** (é o que "liga" o
   widget na sessão; depois ele segue rodando enquanto você navega).
2. Na 1ª interação (um clique), o navegador vai **pedir permissão de
   notificação** — clique **Permitir** (é pedido uma vez).
3. Crie uma **tarefa pra você mesmo** com prazo pra **agora / daqui a poucos
   minutos** (ou já vencida) num lead qualquer.
4. Em até ~45s (o intervalo do polling) deve aparecer:
   - o **pop-up** no canto inferior direito, com botão **"Abrir lead"**;
   - o **som** (di-ding);
   - a **notificação do navegador** (mesmo com a aba em segundo plano).
5. **Troque de página** dentro do Kommo → o pop-up **continua lá**.
6. Feche no **×** → some (e não volta pra essa tarefa).

### Ajustes (opcionais, na config da integração)
- `position`: `bottom-right` (padrão), `bottom-left`, `top-right`, `top-left`
- `sound`: `Y` (padrão) / `N`
- `poll_seconds`: intervalo de checagem (mín. 15, padrão 45)
- `lookahead_min`: minutos de antecedência (padrão 15)

### Se algo não aparecer
- Confirme que **permitiu notificação** no navegador (ícone do cadeado na URL).
- O widget só "acorda" quando você abre um lead/lista uma vez na sessão.
- Bloqueador de som: o navegador só toca áudio **após o 1º clique** na página
  (o widget já trata isso — basta ter clicado em algo no Kommo).
- Se o uploader reclamar do campo `code` no `manifest.json`, remova a linha
  `"code": "..."` e suba de novo (é opcional).
