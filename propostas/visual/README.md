# Camada visual da proposta (ícones, grafismos, gráficos)

Passo que roda **depois** da geração, sobre a apresentação pronta (nunca no deck original nem no template). Lógica em `supabase/functions/_shared/propostas/visual.mjs`: funções puras, mais `aplicarVisual()` (1 GET + 1 batchUpdate).

## O que acrescenta
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

## Integração com o gerador (a combinar com a Etapa 2)
Depois do batchUpdate da geração, chamar `aplicarVisual({ token, apresentacaoId, base: baseIconesDoProjeto(SUPABASE_URL) })`. O `SUPABASE_URL` é o do **mesmo projeto da proposta** (no hub, o de produção, com a migration_186 aplicada e os ícones publicados).
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
