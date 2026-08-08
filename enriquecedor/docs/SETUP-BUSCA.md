# Guia — ligar a busca de site por API (grátis)

Sem chave, a ferramenta descobre o site pelo domínio do e-mail corporativo e por palpite pelo nome.
Ligando a busca por API, ela também acha o site de leads sem e-mail corporativo (mais cobertura).

Recomendado: **Brave Search API** — plano gratuito de **2.000 buscas/mês, sem cartão**.

## Passo a passo (Brave, ~3 min)

1. Acesse **https://api-dashboard.search.brave.com** e crie uma conta.
2. Escolha o plano **Free** (Data for Search / Web Search). Não pede cartão no gratuito.
3. Vá em **API Keys → Generate** e copie a chave.
4. Na pasta do projeto, crie o arquivo `.env.local` (se ainda não existir) e adicione:
   ```
   BRAVE_API_KEY="sua_chave_aqui"
   ```
5. Reinicie o `npm run dev`. No log do **motor** deve aparecer:
   `[enrich] busca por API: BRAVE ativa`

Pronto — a descoberta de site passa a usar a busca web quando o domínio do e-mail e o palpite
não resolverem.

## Alternativa: Serper (resultados do Google)

1. Crie conta em **https://serper.dev** (dá crédito grátis inicial).
2. Copie a API key e coloque no `.env.local`:
   ```
   SERPER_API_KEY="sua_chave_aqui"
   ```
3. Reinicie. O log mostra `busca por API: SERPER ativa`. (Se ambas estiverem preenchidas, a Serper tem prioridade.)

## Verificar se está ligada

Com o `npm run dev` rodando, abra:
```
http://localhost:3001/api/health
```
Deve retornar algo como `{"ok":true,"search":"brave"}`. Se vier `"search":"none"`, a chave não foi
carregada — confira o `.env.local` e reinicie.

## Custo / escala

- Brave grátis: 2.000/mês cobre bem ~1.000 leads/mês (a busca só é acionada quando o e-mail/palpite
  não acham o site, então o consumo real costuma ser menor).
- Se um dia precisar de mais volume ou resultados do Google, dá para trocar por um plano pago da
  Brave ou pela Serper sem mudar o código.
