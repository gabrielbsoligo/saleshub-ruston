# Plano — rodar a lista de 89 leads (até o módulo de anúncios) → arquiteto

Objetivo do dia: subir 89 leads, enriquecer até o **módulo de anúncios (Meta)**, e mandar
os "quentes" pro **arquiteto** (que ainda vamos construir) cuspir: scripts de e-mail
marketing, cadência de WhatsApp, disparo por API e sugestões de script anti-bloqueio.

Status das ferramentas (checado): Brave ✅ · Lemit ✅ · Serper ✅ · Anthropic ✅ · DataStone ✅
· **Decodo (proxy) ❌ ZERADO** (limite de tráfego atingido).

---

## 1. Premissas de "lead quente" (gating pra chegar no anúncio)

O headless de anúncios é o passo mais caro/lento — só vale gastar em quem passou:
1. **CNPJ ativo** + ramo imobiliário/construção.
2. **Decisor identificado + porte** (DataStone).
3. **Presença digital** mínima (site OU rede OU Google Meu Negócio).
4. **Empreendimento ativo** (lançamento/obra) **com LP** — senão não há criativo/LP pra auditar.

Quem não passa → **stand-by** (não consome o módulo caro; revisamos depois).

---

## 2. Consumo estimado (89 leads) e onde pode travar

| Ferramenta | Uso ~por lead | Total ~89 | Limite / risco | Ação |
|---|---|---|---|---|
| BrasilAPI (CNPJ) | 1 | ~89 | grátis, generoso | ok |
| Brave (descobrir site) | 1–3 | ~90–270 | free 2.000/mês | conferir plano (provável ok) |
| **DataStone** (empresa + pessoas) | ~2–3 créditos | **~180–270** | **créditos pagos** | **conferir saldo e RECARREGAR** |
| Lemit (contatos) | ~1–2 | ~90–180 | cota do plano | conferir saldo |
| Serper (Google Meu Negócio) | 1 | ~89 | créditos do plano | provável ok (conferir) |
| PageSpeed (Google) | site + LPs×2 (~5) | ~450 | 25.000/dia c/ chave | ok |
| Anthropic (Haiku + Sonnet) | 2 | ~178 | por token | ~US$ 2–6 (barato) |
| **Headless Meta** (anúncios) | multi-termo, ~30–40s | **~50–60 min** | tempo + risco de bloqueio | cadência (ver §3) |
| **Proxy Decodo** (se usar) | ~10–20 MB | **~1–2 GB** | **ZERADO agora** | **recarregar OU usar IP direto** |

**Gargalos reais:** (a) **créditos DataStone**, (b) **tráfego do Decodo** (zerado).
O resto (Brave, Serper, PageSpeed, Anthropic, Lemit) tende a caber — confirmar saldos nos painéis.

---

## 3. Anti-ban, cadência e tempo (módulo de anúncios)

Decisão-chave pro headless dos 89 (Decodo está zerado):

- **Opção A — recarregar o Decodo (recomendada p/ volume):** roda via proxy residencial,
  cada consulta por um IP diferente → **sem risco de ban**, pode ir em paralelo (~rápido).
  Custo: comprar GB (estimo **~2–3 GB** pra sobrar). É o caminho seguro pra 89 de uma vez.
- **Opção B — IP direto com cadência (6s):** grátis, mas 89 leads × vários loads = muitos
  requests seguidos → o IP direto aguenta uso interativo de poucos leads, mas em lote
  **convida bloqueio transitório** (cooldown de 90s) → fica lento e instável.

Tempo estimado do módulo de anúncios: **~50–60 min** (só os leads quentes; sequencial).
Enriquecimento base (5 em paralelo): mais ~1–1,5 h. **Rodada total: ~2–2,5 h.**

---

## 4. Checklist ANTES de rodar (amanhã)

- [ ] **DataStone:** conferir saldo; recarregar se < ~300 créditos.
- [ ] **Decodo:** recarregar tráfego (~2–3 GB) **ou** decidir por IP direto (Opção B).
- [ ] **Lemit / Serper / Brave:** conferir cota/saldo dos planos.
- [ ] **Ligar o módulo de anúncios em lote** (hoje é sob demanda por lead): ativar a fila
      cadenciada `runAdsQueue`, que só mede os leads **quentes** (§1). É ~1 linha + cadência.
- [ ] Definir a cadência do headless conforme a opção A ou B.

---

## 5. Custos a colocar (estimativa — confirmar preços nos painéis)

- **DataStone:** recarga de créditos (principal). ~180–270 créditos p/ os 89.
- **Decodo:** recarga de ~2–3 GB (se Opção A).
- **Anthropic:** ~US$ 2–6 (baixo).
- **Serper / Brave / PageSpeed:** provavelmente dentro do plano atual.

---

## 6. Arquiteto (Fase seguinte) — o que falta CONSTRUIR

O arquiteto ainda **não existe** — é o que vamos montar depois de enriquecer os 89 até
anúncios. Ele vai gerar, por lead quente:
- **Scripts de e-mail marketing** (fala direta ao decisor, tema do diagnóstico/anúncios).
- **Cadência de contato no WhatsApp**.
- **Disparo de WhatsApp por API** + **sugestões de script anti-bloqueio**.

⚠️ **Disparo por WhatsApp cai na premissa anti-ban** (API oficial Cloud API, número aquecido,
cadência, opt-in/LGPD). Isso vira um planejamento próprio com aprovação antes de disparar.
