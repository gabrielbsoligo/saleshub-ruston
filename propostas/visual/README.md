# Camada visual da proposta (ícones, grafismos, gráficos)

Passo que roda **depois** da geração, sobre a apresentação pronta (nunca no deck original nem no template). Lógica em `supabase/functions/_shared/propostas/visual.mjs`: funções puras, mais `aplicarVisual()` (1 GET + 1 batchUpdate).

**Padrão: v2** (`visual-v2.mjs`, `aplicarVisualV2`). A v1 abaixo continua disponível com `--estilo v1`, e a v2 reusa as peças dela.

## v2: redesenho no padrão EE 2026
Benchmark: deck EE 2026 (template) e a página ee-2026. A v2 não só enfeita: ela **redesenha** os slides gerados.

| Slide | v2 |
|---|---|
| todos os gerados | fundo PNG vinho com brilho vermelho (`fundos/`, alternando `a`/`b`) e cartões de "vidro" (branco translúcido + borda vermelha fina) |
| Diagnóstico / Contexto | grade de até 4×2. Ícone por item e 1ª oração (até `:`, `;`, `,` ou ` (`) em negrito. Mesmo texto. |
| O que entregamos | grade 2×1 a 3×2 de "features": ícone, título curto e detalhe. Título: o que o deck curto escreve antes dos dois-pontos em **"Título curto: detalhe"** (até 5 palavras; o detalhe vira o resto). Sem isso, ou se não couber na grade, o nome do ícone do catálogo (Landing page, CRM + WhatsApp…) e o texto inteiro como detalhe |
| Próximos passos | passos numerados na horizontal; o selo amarelo "CONDIÇÃO VÁLIDA ATÉ dd/mm" sai só se a validade estiver escrita |
| Investimento, Etapa 2 | linhas e cartões em vidro, mais as peças da v1 (ícones, tabela × condição, pílulas, gráfico de mídia) |
| **novo** capa do cliente | **substitui** a capa institucional (padrão). Nome do cliente (do rodapé), tipo (`tipo` do gerador, senão o rótulo), data e a **marca V4**: "V4 COMPANY" em texto e, à direita, a arte da capa institucional (mão com o cubo V4, `marca/`). Com `capa: 'depois'`, vai sem a arte (ela está no slide anterior) |
| **novo** Como fica na prática | wireframes em shapes (navegador, celular, quadro do CRM, busca) das entregas que têm forma visível; sem texto inventado e com nota "ilustração" |
| **novo** case V4 | **desligado por padrão** (`caso: 'nao'`); o closer liga (`'sim'`), com aviso no rodapé fora de Estruturação. `casos-v0.json`: 6 cases oficiais da página EE 2026. Escolhido por afinidade (3 sinais ou mais, 1 específico; `modeloVenda` soma 1 ao case do mesmo modelo: pdv, inside-sales, e-commerce) |
| **novo** A proposta em números | até 4 números que **já estão no deck**: valor e desconto do painel, prazo, nº de entregas, validade, acompanhamento |
| linha do tempo, mídia | como na v1, com o fundo da v2 |

Layout que não cabe (texto longo, itens demais) **cai na lista da v1 com vidro**: nunca corta texto. Rodar de novo dá 0 pedidos (testado com simulação).

Assets: `fundos/` (gerados por `gerar-fundos.mjs`), `casos/` (fotos da página oficial) e `marca/v4-capa.png` (recorte da arte da capa institucional do deck aprovado). Todos são publicados com os ícones por `publicar-icones.mjs` em `propostas-visual/<pasta>/v1/`.

## O que acrescenta (v1)
| Peça | Onde | Como |
|---|---|---|
| Ícone por item | cartões de lista (`_c<i>`) e linhas de investimento (`_i<n>a`) | PNG (Lucide, ISC) por palavra-chave (`ICONES`). Nos cartões, o ícone entra **no lugar do número** ("01   "), com recuo equivalente: nenhuma linha quebra a mais. |
| Grafismo | todo slide gerado | dois anéis translúcidos no canto inferior direito, atrás de tudo |
| Etapa 1 → Etapa 2 | slides `PROPOSTA…` e `ETAPA 2…`/`PRÓXIMA ETAPA…`, se o deck tiver a segunda etapa | duas pílulas no alto, à direita; a etapa do slide vem preenchida |
| Tabela × condição | painel de investimento com "de R$ X por R$ Y" (`_p4`) | o texto vira duas barras. O "-N%" é o **falado** (`_p1`, "20% DE DESCONTO"); sem `_p1`, ou divergindo do de/por em mais de 1 ponto, a barra diz "CONDIÇÃO" |
| Verba Google × Meta | cartão com "R$ X em Google … R$ Y em Meta", **só** em slide de proposta (rótulo com etapa 2, próxima etapa, proposta, investimento ou verba; nunca Diagnóstico) | coluna à direita se o texto ainda couber (já descontado o recuo do ícone); senão, **slide próprio** logo depois. "/ MÊS" e "mês completo" (com "assessoria … R$ Z por mês" ou "Investimento: R$ Z por mês") só quando o cartão ou o slide fala em mês |
| Linha do tempo | antes de "Próximos passos" | Aceite → prazo ("Prazo…: N dias") → "+N dias de acompanhamento" → segunda etapa ("a partir de <mês>" ou "<Mês>: …"). Só sai com 3 marcos ou mais. |

Gráfico só sai quando o dado está no texto do slide. Nada é inventado. Tudo é shape ou imagem nativa do Slides, que o closer edita, move ou apaga.

**Idempotente:** tudo o que é criado usa o sufixo `_v…`. Slide que já tem a camada é pulado; rodar de novo dá 0 pedidos.

**Reconhecimento:** pela convenção `<slideId>_<sufixo>` (`r`, `t`, `c<i>`, `i<n>`, `p`, `p0…p4`, `f`), comum ao `slides.mjs` e ao deck curto. Não depende de IDs fixos.

## Ícones
- `icones/` tem os PNGs (192 px, transparentes) em 3 cores: `amarelo` #FFD60A (padrão), `vinho` #280000 (sobre o amarelo) e `branco`.
- Para gerar de novo: `node propostas/visual/gerar-icones.mjs --modulos <dir>/node_modules` (com `npm i --prefix <dir> @resvg/resvg-js lucide-static`). As dependências não entram no app.
- Bucket: `migration_186_propostas_visual_bucket.sql` cria o `propostas-visual` (público, só PNG, até 1 MB, escrita só com service_role; rollback no arquivo). No port para o hub-comercial, a migration vai junto. O bucket não nasce de script.
- Publicação: `node propostas/visual/publicar-icones.mjs` sobe os PNGs para `propostas-visual/icones/v1/` (só upload). Ícone não tem dado de cliente.
- O Slides **copia** a imagem na inserção. Depois disso o deck não depende do bucket. Para trocar o conjunto, suba `v2` e mude `VERSAO_ICONES`; os decks antigos não mudam.
- Licença: Lucide ISC (`icones/LICENSE-lucide.txt`).

## Rodar
```
GOOGLE_ACCESS_TOKEN=... SUPABASE_URL=https://<ref>.supabase.co node propostas/visual/cli.mjs --apresentacao <id> [--dry-run]
node --test propostas/visual/visual.test.mjs
```
O token nunca é impresso. O erro do Google passa por `redigir()`.

## Integração com o gerador
Depois do batchUpdate da geração, chamar `aplicarVisualV2({ token, apresentacaoId, assets: assetsDoProjeto(SUPABASE_URL), data: 'dd/mm/aaaa', capa: 'substituir', caso: incluirCase ? 'sim' : 'nao', tipo: escopo.oferta.tipo, modeloVenda })` (v1: `aplicarVisual({ token, apresentacaoId, base: baseIconesDoProjeto(SUPABASE_URL) })`). `tipo` ('estruturacao' | 'implementacao' | 'execucao' | 'implementacao_e_execucao') vale no lugar do rótulo do deck, na capa e no critério do case; `modeloVenda` é texto livre ("pontual"/"recorrente" não dão bônus). O `SUPABASE_URL` é o do **mesmo projeto da proposta** (no hub, o de produção, com a migration_186 aplicada e os ícones publicados).
- O batchUpdate é atômico. Se o Google não conseguir baixar um ícone, `aplicarVisual` repete **uma vez sem as imagens** e devolve `semIcones: true` com `erroIcones`.
- Qualquer outra falha lança erro. A integração faz `try/catch`, loga o erro (já redigido) e grava na proposta a pendência "camada visual não aplicada: <motivo>" (ou "sem ícones: <motivo>"). **Nunca** derruba a proposta.
- Pendência fixa enquanto o Gabriel não decidir: "números dos cartões substituídos por ícones".

## Imagem gerada por modelo (avaliado, não usado)
Seria possível gerar ilustrações com um modelo de imagem (Gemini/Imagen, ~US$ 0,02 a 0,04 por imagem). Não entrou porque:
- **Marca:** a saída varia de uma geração para outra, sem garantia de paleta e estilo V4.
- **Texto:** texto dentro da imagem sai errado com frequência.
- **Revisão:** cada imagem precisaria de revisão humana antes de ir ao cliente.
- **Dependência:** mais um serviço pago e um ponto de falha no fluxo do closer.

Ícones e gráficos nativos cobrem o pedido com custo zero e são editáveis. Se quiserem, uma capa ilustrada por segmento (ex.: marcenaria) pode ser gerada **uma vez**, curada e guardada como asset fixo.
