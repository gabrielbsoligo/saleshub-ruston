# Ruston Enriquecedor — widget da Kommo

Botão **🔎 Enriquecer lead** no card do lead: abre um modal (CNPJ pré-preenchido se
existir campo de CNPJ no card + escolha do perfil de auditoria) e dispara o lead pro
**Enriquecedor** (`/enriquecedor` do SalesHub). O fluxo todo:

1. Cria o lead no Enriquecedor (ou reaproveita, se o CNPJ já existir lá).
2. Devolve **nota no card na hora** com o link de acompanhamento.
3. Roda a **esteira completa** no motor (Railway): Receita → DataStone/Lemit/redes dos
   sócios → site/PageSpeed/Google Meu Negócio/empreendimentos → briefing por IA →
   anúncios Meta → briefing **re-gerado** com os dados de mídia.
4. Ao concluir, devolve **outra nota** com os **ganchos de abordagem** (e dores) + link.

## Como subir e instalar (igual ao ruston-notify)

1. Kommo → **Configurações → Integrações** → **+ Criar integração** → **Integração
   externa** (widget). Precisa de usuário **admin**.
2. Na integração criada, aba **Widget/Código** → enviar o arquivo
   **`ruston-enriquecedor.zip`** (gerado nesta pasta).
3. **Instalar**. Na tela de configuração:
   - **Segredo da integração**: cole o valor de `ENRIQ_KOMMO_SECRET` (o time que
     administra o Enriquecedor te passa — fica nos secrets do Supabase, função
     `enriquecedor-kommo`).
   - **URL do endpoint**: deixe em branco (usa o padrão).

## Backend (já no ar)

- Edge function `enriquecedor-kommo` (Supabase) — valida o segredo, cria o lead,
  posta a 1ª nota e aciona o motor com o usuário de integração
  (`integracao-enriquecedor@rustonassessoria.com`).
- Motor `/api/esteira` (Railway) — roda as fases em background e posta a nota final
  (usa `KOMMO_API_TOKEN` + `KOMMO_SUBDOMAIN` do ambiente do Railway).

## Rotacionar o segredo

Gerar novo valor e atualizar o secret `ENRIQ_KOMMO_SECRET` da função no Supabase +
o campo de configuração do widget na Kommo.
