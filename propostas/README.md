# Gerador de Propostas para Closers (fase de teste)

Gera a proposta do closer no Google Slides a partir do deck oficial **EE 2026**. A parte da V4 continua padrão (e editável). O que muda por lead é o escopo, o plano de execução e o preço falado na reunião.

## O que tem aqui
| Arquivo | O que é |
|---|---|
| `catalogo-v0.json` | Catálogo v0: entregáveis do slide de investimento, Semanas 1 a 4 (com a Semana 3 por modelo de venda), ênfases (LinkedIn B2B, auditoria de Google Ads, CRM, marketplace), overdeliveries sugeridos, execução e preços de referência. Rascunho, a validar com o Gabriel. |
| `escopo.schema.json` | Formato do escopo da proposta: a saída da análise da transcrição, editada pelo closer. O preço vem da transcrição. Valor ausente vira `[PREENCHER: …]` e entra em `pendencias`. |
| `exemplos/` | Escopo fictício para teste. |
| `gerador/` | Script local. `slides.mjs` monta os pedidos (funções puras), `google.mjs` é o cliente REST de Drive/Slides, `gerar.mjs` orquestra e `cli.mjs` é a linha de comando. |

## Como o deck é usado
O deck EE 2026 é quase todo imagem. Só os slides de investimento têm texto editável. Por isso:
- **Preço:** `preparar` troca, uma vez, os valores literais do deck por `{{placeholders}}` numa **cópia de teste**, e essa cópia vira o template. Nunca rodar no deck original.
- **Escopo:** a geração insere slides de texto (dores, uma por semana, overdeliveries e plano de execução) **antes** do primeiro slide "Qual é o investimento?".
- A lista de 11 entregáveis do slide de investimento continua fixa. O closer edita na mão. Sincronizar essa lista com o escopo fica para a v1.

## Testar
```
node --test propostas/gerador/gerador.test.mjs
node propostas/gerador/cli.mjs gerar --template X --escopo propostas/exemplos/escopo-exemplo-inside-sales-linkedin.json --dry-run
```
Para gerar de verdade, use `GOOGLE_ACCESS_TOKEN` no ambiente, com os escopos `presentations` e `drive.file`. O valor nunca é impresso.
```
node propostas/gerador/cli.mjs preparar --template <ID_COPIA_TESTE>
node propostas/gerador/cli.mjs gerar --template <ID_COPIA_TESTE> --escopo <json> --editor <email_closer> --exportar pdf,pptx --saida <dir_fora_do_drive>
```
- `--link reader` é o padrão: qualquer pessoa com o link vê o arquivo (decisão do Gabriel, 2026-10-29). Para testes internos, use `--link nenhum`.
- O `files.export` tem teto de 10 MB. Acima disso, o cliente cai para o `exportLinks` do arquivo.

## Desenho no SalesHub (próxima fase, ainda não construída)
1. **Gatilho:** reunião marcada como `show` → linha `propostas(status='pendente')`. O tick do cron que já existe (`post-meeting-process-pending`) avança a fila; nada de cron novo.
2. **Transcrição:** reaproveitar `tryFetchTranscriptForReuniao` / `reuniao_transcricoes` da edge `google-drive`.
3. **Análise:** edge `proposta-escopo`, no padrão do `analyze-call`. Recebe a transcrição e o `catalogo-v0.json` e devolve um JSON validado por `escopo.schema.json`. Item da IA sem citação é barrado.
4. **Geração:** a mesma lógica deste script dentro de uma edge, com o token Google do closer (`team_members`). O resultado vai para `status='revisao'`, com o link no deal e um aviso no DealDrawer.
5. **Envio:** botão manual do closer no DealDrawer. **Nunca automático.**

## Conexão Google: escopos
- A edge `google-auth` hoje pede `calendar`, `drive.readonly` e `documents.readonly`.
- **Faltam:** `https://www.googleapis.com/auth/presentations`, para editar a cópia, e `https://www.googleapis.com/auth/drive.file`, para criar a cópia, compartilhar e exportar. A combinação com o `drive.readonly`, que já existe, deve bastar para copiar o template. Se o Google recusar, o plano B é o escopo `drive` completo (restrito).
- Cada closer precisa reconectar o Google depois da mudança. O template precisa estar compartilhado (leitura) com os closers.
