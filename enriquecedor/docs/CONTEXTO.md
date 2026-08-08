# CONTEXTO DO PROJETO — SDNA Outbound

> Documento de memória do projeto. Consolida **o que foi construído, o que foi
> VALIDADO como padrão, as decisões, os aprendizados e como rodar**. Lido para
> continuar o trabalho em qualquer máquina. Complementa o `CLAUDE.md` (regras) e
> `docs/JORNADA-CADENCIA.md` (cadência detalhada).

Lead-protótipo de validação: **RDC Construtora** (São José dos Campos/SP).
Repo: `github.com/Nruston/sdna-outbound` (privado). Deploy ainda NÃO feito.

---

## 1. O que a ferramenta é
Recebe uma lista de leads (incorporadoras/construtoras) → valida → descobre o
**decisor (pessoa física)** e contatos → audita presença digital (site, anúncios,
empreendimentos, Google) → **cliente oculto** (a construir) → **arquiteto** monta a
esteira multicanal → alimenta o **Kommo** (destino dos dados; integração = Fase 4).

Dois processos (local, sem deploy): `npm run dev` sobe **site** (Vite, :3001) +
**motor** (`server/index.mjs`, :3011). O Vite faz proxy de `/api` → :3011.

---

## 2. PREMISSAS VALIDADAS (o padrão RDC — vale para TODOS os leads)

Estas são as regras que validamos e que **precisam valer em massa**. Se o código
divergir de qualquer uma, é bug.

1. **Receita Federal é a fonte de verdade** dos dados da empresa. Dado da planilha
   que diverge é marcado e substituído pelo oficial. CNPJ sem zero à esquerda é
   normalizado com `padStart(14,'0')`.
2. **Site institucional: NUNCA confiar na planilha.** Investigar de verdade —
   cruzar **Google Meu Negócio + e-mail corporativo + planilha + busca web (nome
   fantasia)** e **validar qual candidato realmente responde** (https/www). Ordem de
   confiança: GMN > e-mail > planilha > busca. (Ver `discoverSite` em `server/index.mjs`.)
3. **Empreendimentos** ancorados no **site real** + busca pelo **nome fantasia**:
   lançamento / em obra / entregue, com **LPs de lançamento** (prioriza LP no domínio
   próprio da empresa).
4. **Contatos do decisor validados em 2 fontes cruzadas (Lemit + DataStone)** —
   telefone/e-mail que bate nas duas = "validado"; "quente" vem da flag da DataStone.
5. **Busca no Google:** Brave = busca web; Serper = Google Meu Negócio (Places).
6. **Busca no Meta (Ad Library, headless):** por **nome de marca** (não a razão
   social crua — `adSearchTerm` tira ltda/sa), **multi-termo** (empresa + empreendimentos
   ativos). IP direto + proxy Decodo de reserva. Crivo alta/média/baixa + curadoria.
7. **LPs descobertas nos anúncios do Meta** (destino dos criativos) **realimentam os
   empreendimentos E são auditadas** (PageSpeed mobile+desktop, pixels confirmados via
   headless, formulário, WhatsApp, nota de conversão) → aparecem na **aba Google**.
8. **Anti-ban / LGPD:** mitigar risco de bloqueio de QUALQUER plataforma ANTES de
   executar (cadência/tempo/custo → aprovação). WhatsApp de prospecção = API oficial;
   e-mail em domínio dedicado; dado pessoal do decisor exige base legal + opt-out + origem.
9. **Cascatear:** tudo validado no RDC roda em massa via **funções compartilhadas**
   (`src/lib/`, `server/index.mjs`) — nunca lógica duplicada em componente.

---

## 3. Cadência de enriquecimento (F1 → F7)
- **F1 Triagem** — CNPJ/situação (Receita), ramo.
- **F2 Qualificação** — organograma + porte (DataStone); decisor; contatos 2 fontes.
- **F3 Diagnóstico digital** — site (descoberto de verdade) + PageSpeed; presença/redes;
  empreendimentos + LPs; GMN; briefing IA.
- **F4 Anúncios & mídia paga** — Meta (headless, sob demanda) + LPs; **Análise do GT**;
  **Análise estratégica (SWOT)** nasce aqui.
- **F5 Redes sociais** — Instagram/YouTube (A CONSTRUIR).
- **F6 Cliente oculto** — WhatsApp número descartável (A CONSTRUIR).
- **F7 Pronto p/ arquiteto** — esteira multicanal + payload Kommo.

**Importante:** o enriquecimento de base (F1–F3 + briefing) roda no **import**
(`enrichLeads`). Os **anúncios do Meta NÃO rodam no import** — são **sob demanda por
lead** (`measureLeadAds`), acionados no **play do F4** (anti-ban). É o passo mais pesado.

---

## 4. Arquiteto (F7) — design escolhido
Squad de **skills** em `.claude/skills/` orquestrado:
- `arquiteto-esteira-outbound` (orquestrador) → consome `analise-estrategica-incorporacao`.
- `copy-email-outbound`, `copy-whatsapp-outbound`, `script-ligacao-sdr` (comunicação).
- `ops-kommo-esteira` (pipeline, campos, tarefas, distribuição por SDR, payload dry-run).

**Princípio-chave:** a **estratégia é da CONSTRUTORA** (uma tese, dos itens auditados +
SWOT); a **comunicação é particular por DECISOR** (mesma tese, ângulo/tom/canal por cargo).
**Gate obrigatório:** o arquiteto pergunta se usamos só o **contato mais quente** de cada
decisor (validado em 2 fontes) ou incluímos outros achados pra testar.
Kommo real = Fase 4; até lá entrega o **payload dry-run**. A ArquitetoView (UI) hoje é
**modelo fictício** — a geração real via skills ainda será ligada.

---

## 5. Workflow (aba de PROJETOS) — estado atual
- **(28/07) Import SÓ via projeto:** a aba global "Importar lista" foi REMOVIDA
  (`ImportView` deletada; decisão do Ruston). O único caminho é NOVO PROJETO →
  drag&drop da lista no projeto. A aba Leads segue como visão geral da base.
- Botão **NOVO PROJETO** (sidebar, vermelho) → nome → abre no Workflow.
- **Drag&drop do projeto usa o pipeline REAL** (igual ao "Importar lista"):
  `parseSpreadsheet → buildLeadsFromRows (valida Receita) → leadsRepo.upsertMany →
  enrichLeads`. Sempre enriquece do zero (sobrescreve por CNPJ).
- Funil sobre **leads reais**; clicar no lead abre o **LeadDetail real (RDC)**.
- **Auditoria de anúncios (F4) = SEMPRE 1 lead por vez** (rodar em lote derruba o motor):
  - Botão **"Anúncios"** por lead (manual, escolhe qual medir), e
  - Botão **"Auditar todos (auto, 1 por vez)"** no topo do F4 — audita todos os leads do F4
    em sequência, um de cada vez, em ordem, sem clicar em cada um. Dá pra parar a qualquer momento.
  - Status dos anúncios é separado do status de enriquecimento (fica no botão de cada lead).
- Ícones de status por lead (auditado/andamento/erro/na fila); envio ao arquiteto (parcial).
- Store: `src/lib/projectsStore.ts` (localStorage `sdna_projects`).

---

## 6. APRENDIZADOS / CUIDADOS operacionais (erros que já custaram caro)
- **Rodar anúncios (Meta headless) de MUITOS leads de uma vez DERRUBA o motor** (carga
  do navegador headless). Rodar o play do F4 **em lotes pequenos (~5–10 leads)**.
- **Motor caindo** = todas as chamadas `/api` falham ("Failed to fetch" / ECONNREFUSED).
  Sintoma: anúncios "falhou" em todos. Solução: reiniciar `npm run dev` e esperar
  `backend ... :3011`.
- **(28/07) Motor SEM `--watch`:** no Windows o watch (via `--env-file`) vigiava o
  projeto inteiro recursivamente e derrubava o motor no meio do run com qualquer
  evento de arquivo. Removido do script `server`. Consequência: após editar
  `server/index.mjs` ou o `.env.local`, reiniciar o `npm run dev` manualmente.
- **Não editar código durante um run** — o HMR do Vite pode interromper o loop de
  enriquecimento que roda na página.
- **Queda de internet** no meio do run: o `enrichLeads` tem retry (3 rodadas); leads
  pegos ficam `incompleto`. Re-enriquecer resolve.
- **Créditos são o gargalo da escala:** DataStone e Lemit consomem saldo por lead;
  Decodo (proxy) tem tráfego limitado; Brave/Serper têm cota. Rodar **em lotes** e
  vigiar saldo. Testar com ~10 leads antes de soltar a lista inteira.
- **localStorage não é fonte confiável entre runs:** re-importar sempre enriquece do zero.

---

## 7. Regras de comportamento (do Ruston)
- **Nunca commitar/push no GitHub sem pedir** — sempre pedir permissão explícita.
- **Nunca fazer deploy** sem "pode subir" (deploy = Fase 5).
- **Validar cada premissa no protótipo antes de cascatear**; provar rodando, não assumir.
- **Anti-ban:** trazer cadência/tempo/custo e pedir aprovação antes de disparo em massa.

---

## 8. Como rodar em OUTRA máquina
1. Instalar **Node.js** + **Git**.
2. `git clone https://github.com/Nruston/sdna-outbound.git`
3. `cd sdna-outbound` && `npm install`
4. Criar **`.env.local`** na raiz (NÃO vem do GitHub — segredos). Use os nomes de
   `.env.local.example` e copie os **valores** do seu `.env.local` atual.
   **(28/07)** Com o Brave em plano pago (billing ativo), incluir
   `SEARCH_INTERVAL_MS=150` — sem isso o motor roda no ritmo do plano grátis
   (1,1s/busca) e o enriquecimento fica ~7x mais lento.
5. `npm run dev` → `http://localhost:3001`.

**Chromium do Playwright** (necessário pro headless do Meta): o `npm install` já roda
`playwright install chromium` (via postinstall). Se por algum motivo o headless falhar
com "Executable doesn't exist", rode manualmente: `npx playwright install chromium`.

Obs.: os **dados dos leads** (localStorage) NÃO viajam pelo GitHub — começam zerados na
outra máquina (re-importar a lista lá). Portabilidade real dos dados só com **Supabase**
(Fase 5). O `.env.local` **nunca** deve ser commitado.
