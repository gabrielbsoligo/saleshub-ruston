# Jornada do lead — cadência de construção (SDNA Outbound)

Documento vivo. Registra **o que já foi construído e validado (Fase 1)**, a **sequência
(cadência) da jornada de enriquecimento** e **o que vem a seguir (Fase 2)**. Serve de
âncora para continuarmos de onde paramos.

Lead-protótipo usado na validação: **RDC Construtora** (São José dos Campos/SP).

---

## ENRIQUECIMENTO — fase EM ANDAMENTO (multi-módulo, não fechada)

> Importante: o enriquecimento **NÃO terminou**. Ele é um conjunto de **módulos** que
> vão sendo somados; cada módulo enriquece mais o lead e **todos alimentam o arquiteto**
> (Fase seguinte). O que está pronto abaixo é o **módulo de tráfego pago (Meta + Google)**
> e o diagnóstico de base. Ainda vêm outros módulos (cliente oculto, redes sociais…).
> O arquiteto só monta a estrutura final quando o lead estiver enriquecido por todos os
> módulos e "conhecido" pelo sistema.

### Módulos CONCLUÍDOS e validados (no RDC)

Tudo abaixo já roda e foi validado. A lógica vive em funções compartilhadas
(`src/lib/`, `server/index.mjs`), então **cascateia** para a lista inteira quando
ligarmos o processamento em massa.

### Cadência (a ordem exata da jornada)

**1. Importação da lista**
- Sobe a planilha → valida CNPJ (BrasilAPI), situação cadastral, dedup.
- Receita Federal é a **fonte de verdade** dos dados da empresa.

**2. Qualificação decisiva (quem merece seguir no funil)**
- **Organograma + porte/faturamento** (DataStone) — diretoria e gerência.
- **Decisor (pessoa física)** identificado.
- **Contatos do decisor** (WhatsApp / telefone / e-mail) **validados em 2 fontes
  cruzadas: Lemit + DataStone** ("validado 2 fontes").

**3. Diagnóstico digital & de negócio**
- Descoberta e auditoria do **site institucional** (online, HTTPS, WhatsApp, pixels/tags, PageSpeed).
- **Presença digital**: redes sociais + **Google Meu Negócio** (nota, avaliações, contato, horário).
- **Empreendimentos** (IA): lançamentos / em obra / entregues, com **LPs**.
- **Briefing por IA** + análise de **dores/oportunidades do setor** e da empresa.

**4. Auditoria de anúncios — Meta (aba Meta)**
- Headless na Meta Ad Library (BR, ativos), busca multi-termo (empresa + empreendimentos), IP direto + proxy reserva.
- Validação cruzada → crivo de 3 níveis: **alta / média / baixa confiança** (curadoria manual: promover/rebaixar; nada é descartado).
- **Resumo de mídia paga**: destino dos anúncios (WhatsApp / LP / perfil), Google Ads.
- **Formato dos criativos** (vídeo / estático / carrossel), **duplicados** (fadiga/verba pulverizada).
- **LPs descobertas** nos anúncios realimentam a lista de empreendimentos.
- **Análise do Gestor de Tráfego (Meta)**: sobre os criativos de **alta confiança (auto + curadoria)** — destino/captação, qualificação (cruzada com WhatsApp da LP), duplicados/fadiga, cobertura de empreendimentos, formato, achados e plano de ação. **Reage à curadoria** (mudou a alta confiança → re-analisa).

**5. Auditoria das LPs & Google (aba Google)**
- Cada LP: **velocidade mobile + desktop**, **SEO**, **WhatsApp** (testado), **formulário** (campos, envio), **pixels Meta/Google/TikTok confirmados via headless**.
- **Nota de conversão por LP** (pesa rastreio, CTA, mobile).
- **Google Meu Negócio** ampliado.
- **Análise do Gestor de Tráfego (Google)**: KPIs de conversão por gravidade (rastreio ausente e CTA quebrado = críticos; mobile pesa mais; verba amplifica), reputação/contato do GMN, achados priorizados (verba × erro) e plano de ação.

### Último ponto validado (deste módulo)
- **Análise do GT (Meta) atrelada à curadoria**: ao promover/rebaixar criativos, a análise recalcula e traz nova devolutiva.
- Layout das abas Meta/Google finalizado (containers alinhados, Auditoria de ads, seletor de confiança em container separado).
- Tudo versionado no **GitHub** (`Nruston/sdna-outbound`, privado).

### Módulos de enriquecimento AINDA a construir (continuam NESTA fase)

Estes ainda enriquecem o lead antes de o arquiteto montar a narrativa final:

- **Cliente oculto** — com **API do WhatsApp** (segundo momento). Experiência real de atendimento/resposta do lead como consumidor anônimo.
- **Redes sociais & posicionamento** — YouTube, Instagram (e afins): nº de **seguidores**, engajamento, frequência de posts, **tempo/qualidade de resposta a leads/comentários**, posicionamento da marca.
- Outros módulos que surgirem (o enriquecimento é incremental).

Cada módulo novo entra na mesma lógica compartilhada e passa a alimentar o arquiteto.

---

## FASE SEGUINTE — Arquiteto de narrativa e abordagem (A CONSTRUIR)

O arquiteto só monta a estratégia final quando o lead estiver enriquecido por **todos os
módulos** (os concluídos + cliente oculto + redes sociais + o que vier) e "conhecido" pelo
sistema. Com esse insumo completo, ele monta a **estratégia de ataque multicanal**, com
fala direta ao decisor:

- **E-mail marketing**: cadência de e-mails, temas condizentes com o que foi diagnosticado, para o e-mail validado do decisor.
- **WhatsApp / CRM (Kommo)**: cadência e integração (Kommo é o destino dos dados).
- **Copy e narrativa** por canal, baseada nas dores/oportunidades e nos achados dos anúncios.
- **Scripts para o SDR ligar** durante a cadência.
- **Cliente oculto**.

> Premissa: validar cada peça no lead-protótipo antes de cascatear para a lista, e mitigar
> risco de bloqueio de qualquer plataforma ANTES de executar (cadência/tempo/custo + aprovação).
