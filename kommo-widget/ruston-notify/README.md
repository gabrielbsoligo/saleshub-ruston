# Ruston Notify — widget privado do Kommo (v1.0.2)

Pop-up persistente de tarefa dentro do Kommo: fica na tela até o SDR fechar,
reaparece ao navegar, empilha, toca som e dispara notificação do navegador.
Substitui o Pusher pago do Komanda F5, sem custo.

## Conteúdo do bundle (zip)
```
manifest.json      interface_version 2; locations settings + lcard-0/ccard-0/llist-0/clist-0; settings type "text"
script.js          AMD module: init/render/bind_actions/destroy; overlay no DOM; Notification + Audio
style.css          classes com prefixo rnw- (não colide com o Kommo)
notify.mp3         som do aviso (di-ding)
i18n/              pt, en, es, ru
images/            logo.png 130x100, logo_main 400x272, logo_small 108x108,
                   logo_medium 240x84, logo_min 84x84, icon.png 128x128 (Notification)
```
Todos os arquivos são UTF-8 sem BOM. Os 6 logos são o sino azul-marinho
(#1a2942) com badge vermelho (#E24B4A), fundo transparente.

## Gatilho: polling da API de Tarefas (front puro, SEM backend)
O `script.js` consulta `GET /api/v4/tasks` (do usuário logado, mesma sessão)
a cada 45s e popa as tarefas que **vencem em breve (5 min) ou estão
atrasadas**. Dedup e cards ativos em `localStorage` → sobrevivem à navegação
até o SDR fechar no ×. (O `digital_pipeline` foi removido: a ação dele é
server-side e não entrega evento client-side sem backend.)

## Defaults (configuráveis nas settings da integração)
- `position`: **top-right** (também: top-left, bottom-right, bottom-left)
- `sound`: **Y** (Y/N)
- `poll_seconds`: **45** (mín. 15)
- `lookahead_min`: **5** (atrasadas sempre avisam)

Todas as settings são do tipo **text** (o Kommo rejeita `numeric`). Números
são digitados como texto e convertidos no código.

## UX
- **Scroll fino/discreto** na coluna quando empilha muitos cards.
- **Abrir na mesma aba:** o botão navega na mesma aba (SPA do Kommo se
  disponível, senão `window.location`); os cards persistem após navegar.
- **Recolher/expandir:** botão `–` recolhe a coluna num badge (sino +
  contador); clicar no badge expande. Não apaga os cards — só esconde
  (estado em memória).

## Como subir e instalar (precisa de admin)
1. Kommo → **Configurações → Integrações** → **+ Criar integração** →
   **Integração externa** (widget).
2. Preencha nome/permissões e salve → o Kommo gera **ID/Secret** da integração.
3. Aba **Widget/Código** → **enviar .zip** → `ruston-notify.zip`.
4. **Instalar** (pode deixar os campos de config em branco — há padrão).
   > Como a `version` subiu pra 1.0.2, se a integração já existia é só reenviar
   > o zip e o Kommo trata como **atualização**.

## O que testar ao instalar
1. Abra **qualquer lead/lista** (liga o widget na sessão).
2. No 1º clique, o navegador pede **permissão de notificação** → Permitir.
3. Crie uma **tarefa pra você** vencendo em ≤5 min (ou já atrasada).
4. Em ~45s aparece: **pop-up (top-right) + som + notificação**.
5. Botão **Abrir lead** → navega na **mesma aba**; os cards continuam lá.
6. Botão **–** recolhe pro badge com contador; clicar expande.
7. **×** fecha o card individual.
