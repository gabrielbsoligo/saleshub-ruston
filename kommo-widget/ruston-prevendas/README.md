# Ruston Pré-vendas: widget único do Kommo (notify + PRÓXIMO; click-to-call na fatia 3)

Substitui o **ruston-notify** e o **Ruston Próximo Lead**. Proposta e regras: `PROPOSTA.md` (rev. 3, aprovada pelo Vedor).

## O que tem nesta pasta

| Arquivo | O que é |
|---|---|
| `script.js` | widget (AMD). O bloco `Fila` é puro e testado em Node |
| `manifest.json`, `i18n/`, `images/`, `notify.mp3` | pacote do Kommo |
| `build-zip.mjs` | gera `dist/ruston-prevendas.zip` (só os arquivos do widget; UTF-8 sem BOM) |
| `tests/` | `fila.test.cjs` (ordem, janela, notificação, liderança), `widget.test.cjs` (ciclo completo, degradado, destroy, multi-aba), `classificar.test.ts`, `jwt.test.ts` |
| `../../supabase/functions/prevendas-fila/` | edge que devolve a fila **do próprio usuário** já classificada, lida da réplica do Kommo (zero chamadas à API do Kommo) |
| `../../supabase/migration_160_prevendas_fila.sql` | funções SQL `prevendas_fila` e `prevendas_fila_frescor` (só leitura; só o service_role executa) |
| `../../supabase/functions/_shared/prevendas_classificar.ts` | classificador puro, também para o `kommo-call-note` no futuro |
| `../../supabase/functions/_shared/kommo_jwt.ts` | verificação do JWT descartável do Kommo (HS256) |

## Testes
```bash
node --test kommo-widget/ruston-prevendas/tests/fila.test.cjs
node --test kommo-widget/ruston-prevendas/tests/widget.test.cjs
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
   - aplicar `supabase/migration_160_prevendas_fila.sql` no projeto do SalesHub. É só leitura e só o service_role executa;
   - rodar:
   ```bash
   supabase secrets set --project-ref iaompeiokjxbffwehhrx KOMMO_WIDGET_CLIENT_ID=… KOMMO_WIDGET_SECRET=… KOMMO_ACCOUNT_ID=34424367
   supabase functions deploy prevendas-fila --project-ref iaompeiokjxbffwehhrx --no-verify-jwt --use-api
   ```
   `PREVENDAS_TIPOS_MOMENTO` é opcional (mapa de tipos novos → momento, quando existirem).
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
- SQL: `drop function public.prevendas_fila(bigint,int); drop function public.prevendas_fila_frescor();`
- Nenhuma tabela, cadência ou tipo de tarefa foi alterado nesta fatia; só duas funções de leitura foram adicionadas.
