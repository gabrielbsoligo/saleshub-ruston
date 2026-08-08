# Guia — chaves da Anthropic (Claude) e Serper

Estas duas chaves ativam: **empreendimentos** (Claude lê o site + busca e extrai a lista) e
**Google Meu Negócio** (nota/avaliações/categoria via Serper). Sem elas, essas etapas são
puladas (não quebram o enriquecimento). Coloque no `.env.local` (fora do git) e reinicie
`npm run dev`.

## 1. Anthropic (Claude) — ~5 min

1. Acesse **https://console.anthropic.com** e crie conta (dá para entrar com Google).
2. Adicione crédito: menu **Billing** (ou "Plans & Billing") → **Add credits / Set up billing**.
   - ⚠️ Aqui **você** adiciona o cartão e compra um crédito inicial (ex.: US$5). Eu não insiro pagamento.
   - O uso do Haiku (modelo que usamos p/ extrair empreendimentos) é barato — centavos por lead.
3. Menu **API Keys** → **Create Key** → nome (ex.: `sdna`) → **Copy** (começa com `sk-ant-`).
4. No `.env.local`:
   ```
   ANTHROPIC_API_KEY="sk-ant-..."
   ```

## 2. Serper — ~3 min

1. Acesse **https://serper.dev** → **Sign up** (pode logar com Google).
2. O plano inicial vem com **2.500 créditos grátis** (não pede cartão para começar).
3. No painel (**API Key** / Dashboard) → copie a chave.
4. No `.env.local`:
   ```
   SERPER_API_KEY="..."
   ```

## 3. Ativar

Reinicie o `npm run dev` e abra **http://localhost:3001/api/health**. Deve mostrar:
```
{"ok":true,"search":"brave","lemit":true,"serper":true,"anthropic":true}
```
Se `serper` ou `anthropic` vier `false`, a chave não foi carregada — confira o `.env.local` e reinicie.

## Observações
- A Serper usada aqui só para **Google Meu Negócio (Places)**; a busca web continua na Brave.
- O consumo real (Anthropic tokens, Serper créditos) a gente mede depois de rodar e calibra p/ volume.
