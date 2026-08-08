# PRD — Sistema de Enriquecimento de Leads para Outbound (SDNA Outbound)

**Versão:** 1.1
**Data:** 2026-07-17
**Autor:** Claude + Ruston (V4 Ruston & Co)
**Status:** 🟢 Aprovado para construção (Fase 1) — **sem deploy até ordem explícita**

---

## 1. Visão geral

Ferramenta interna que recebe uma lista de leads (CNPJ, empresa, faixa de faturamento, telefone e e-mail) e **executa automaticamente uma investigação completa** de cada empresa e do seu **decisor (pessoa física)**, entregando ao SDR um briefing de abordagem específico — e alimentando o **CRM Kommo** com todos os dados garimpados, já que é pelo Kommo que os SDRs trabalham e ligam.

Além da ligação, a régua de prospecção cobre **WhatsApp, e-mail e redes sociais (Instagram, Facebook, LinkedIn)**, com estratégias e scripts personalizados por canal e por benchmark.

O objetivo é transformar uma lista fria numa lista quente e "contextualizada": quando o SDR aborda o decisor, ele já sabe a dor específica (site quebrado, sem anúncios, atendimento lento, perdendo para concorrente X) e abre com munição concreta.

**Volume alvo:** ~1.000 leads/mês.

---

## 2. Objetivos e métricas de sucesso

| Objetivo | Como medimos |
|---|---|
| Reduzir tempo de pesquisa manual do SDR | Horas/lead antes vs. depois (meta: ~20min → ~2min por lead) |
| Achar o decisor e seus contatos pessoais | % de leads com decisor identificado + ≥1 contato pessoal (tel/e-mail/social) |
| Aumentar taxa de resposta na abordagem | % que responde por canal (WhatsApp/e-mail/social) e % que atende ligação |
| Gerar munição concreta por lead | 100% dos leads "prontos" com briefing de ≥3 ganchos |
| Alimentar o Kommo sem retrabalho | 100% dos leads prontos sobem ao Kommo com campos preenchidos |
| Não queimar canais | Quality rating WhatsApp ≥ médio; bounce e-mail < 3%; contas sociais sem restrição |

---

## 3. Personas / usuários

- **SDR / pré-vendas** — trabalha **dentro do Kommo**; consome o briefing (que a ferramenta injeta no Kommo), liga e dispara. Na ferramenta, uso pontual (revisar/enviar social).
- **Gestor comercial** — importa listas, acompanha o enriquecimento e o funil, aprova o envio ao Kommo.
- **Admin (Ruston)** — usuários, permissões, config de canais e integrações (Kommo, WhatsApp, e-mail, sociais, chaves de API).

Login e permissões por role, **independente do sistema financeiro** (usuários próprios).

---

## 4. Módulos

### 4.1 Importação e validação de lista
- Upload de CSV/planilha (ou colar). **Colunas fixas**, mas **dados não confiáveis** → validação obrigatória.
- Campos de entrada: CNPJ, nome da empresa, faixa de faturamento, telefone, e-mail.
- **Validação/correção (fonte de verdade = Receita):**
  - **CNPJ:** valida dígito + consulta Receita; se divergir, dado oficial prevalece; marca divergência.
  - **Telefone/e-mail:** valida formato; checa WhatsApp; valida MX do e-mail. ⚠️ Ver 4.2 — o alvo final é o contato **do decisor**, não o da empresa.
  - **Status de qualidade do dado** por lead (válido / corrigido / suspeito / inválido).
- Deduplicação por CNPJ.
- Enriquecimento cadastral via CNPJ (Receita/BrasilAPI): razão social, nome fantasia, CNAE/segmento, cidade/UF, **sócios**, situação. Base do benchmark e da descoberta do decisor.

### 4.2 Descoberta do decisor e contatos pessoais ⭐ (novo)
> O que interessa não é o telefone/e-mail da empresa, e sim **o do decisor (pessoa física)**.

1. **Identificar o decisor** — a partir dos sócios do CNPJ + pesquisa (quem é o dono/sócio-administrador; em imobiliárias/construtoras, geralmente o sócio principal).
2. **Contatos pessoais** — buscar telefone pessoal, e-mail pessoal e **perfis sociais** (Instagram, Facebook, LinkedIn) do decisor.
   - Fontes: sócios da Receita → busca por nome + empresa; provedores de enriquecimento de pessoas (a definir: Apollo/Lusha/Snov/Hunter); busca em redes.
   - ⚠️ **Feasibilidade/limite:** contatos pessoais nem sempre existem em fonte estruturada; a ferramenta entrega o que encontrar + nível de confiança, e sinaliza quando o contato é só o comercial.
3. **Score de contactabilidade** — quão fácil é chegar no decisor (quantos canais válidos encontrados).

**LGPD:** dado pessoal é sensível — registrar base legal (legítimo interesse) por contato, permitir opt-out, e log de origem do dado.

### 4.3 Enriquecimento digital (por empresa)
1. **Auditoria de site** — descobre site; verifica no ar (HTTP/HTTPS/tempo); **testa botões WhatsApp/contato quebrados**; checa pixel/tag (Meta/Google).
2. **Mídia paga** — Google (Centro de Transparência de Anúncios) e Meta (Biblioteca de Anúncios): anuncia? o quê? há quanto tempo?
3. **Benchmark competitivo** — concorrentes do **mesmo ramo (CNAE) e região**: quem anuncia, quem tem presença melhor.

### 4.4 Cliente oculto (por empresa)
1. **Sondagem** — mensagem de cliente interessado (WhatsApp e/ou e-mail), persona adequada ao nicho (imobiliária: "esse imóvel ainda está disponível? qual valor?"). **Canal anônimo dedicado ≠ do canal de prospecção.**
2. **Cronômetro** — tempo até a primeira resposta (via webhook).
3. **Follow-up** — monitora se a empresa faz follow-up nos dias seguintes.
4. **Avaliação IA** — qualidade do atendimento (respondeu preço? qualificou? tentou agendar? tom?).
5. **Janela** — lead só fica "pronto" após o ciclo fechar (3–5 dias).

### 4.5 Briefing consolidado (IA)
- Claude junta tudo (decisor, site, anúncios, benchmark, cliente oculto) e gera:
  - Dores priorizadas; 3+ ganchos específicos; comparação com concorrentes; primeira frase da abordagem.
  - **Scripts personalizados por canal** (ligação, WhatsApp, e-mail, Instagram, Facebook, LinkedIn) ajustados ao benchmark.
- Exibido na ferramenta **e injetado no Kommo**.

### 4.6 Prospecção multicanal (régua de comunicação)
Régua personalizada por lead/decisor, com estratégia e script por canal:

| Canal | Como | Observação |
|---|---|---|
| **Ligação** | SDR liga pelo **Kommo** | Briefing já no card do Kommo |
| **WhatsApp** | API oficial (Cloud API) | Template aprovado + personalizado |
| **E-mail** | Domínio de prospecção dedicado | Ver 5.2 |
| **Instagram** | Conta própria (já têm) | ⚠️ Envio semi-manual (ver 5.4) |
| **Facebook** | Conta própria | ⚠️ Envio semi-manual |
| **LinkedIn** | Conta própria (já têm) | ⚠️ Envio semi-manual |

A ferramenta **encontra o perfil, gera o script e organiza a cadência**; registra status (enviado/respondido) por canal.

---

## 5. Decisões técnicas de canais

### 5.1 WhatsApp — dois canais separados
| Canal | Ferramenta | Motivo |
|---|---|---|
| **Prospecção** (marca V4) | **API oficial (Cloud API)** — já possuem | Sem risco de ban; quality rating; ~R$0,31–0,35/msg (jan/2026: por mensagem). 1.000/mês ≈ R$350. |
| **Cliente oculto** (anônimo) | Número comum + Evolution/Z-API | Precisa iniciar como consumidor anônimo (impossível na API oficial); baixo volume; número descartável. |

### 5.2 E-mail
- Têm **Google Workspace no `@v4company.com`**. ⚠️ **Não usar o domínio principal** para disparo frio — contamina a reputação da comunicação da empresa.
- **Registrar domínio de prospecção dedicado** (ex.: `v4prospec.com`, ~R$40/ano) + caixa no Workspace + SPF/DKIM/DMARC + warm-up.
- Caixa neutra separada para o cliente oculto.

### 5.3 IA
- API Anthropic (Claude). Haiku 4.5 para o grosso; Opus/Sonnet para análises complexas. < R$100/mês nesse volume. Chave criada na fase correspondente.

### 5.4 Redes sociais — limite importante
- **Não há API oficial para DM frio** em Instagram/Facebook/LinkedIn. Automação de DM em massa **arrisca banir a conta**.
- **Modelo adotado:** a ferramenta encontra o perfil do decisor, gera o script personalizado e organiza a régua; o **envio é semi-manual** (operador abre o perfil e envia da conta oficial). Uma camada de automação assistida pode ser avaliada depois, com risco assumido.
- Instagram e LinkedIn já têm conta; Facebook a confirmar.

### 5.5 Fontes de dados
| Dado | Fonte |
|---|---|
| CNPJ / sócios | BrasilAPI / ReceitaWS |
| Decisor / contatos pessoais | Sócios + provedor de enriquecimento de pessoas (a definir) + busca em redes |
| Site + botões | Crawler próprio (Edge Function) |
| Anúncios Meta | Biblioteca de Anúncios (API pública) |
| Anúncios Google | Centro de Transparência de Anúncios |
| Concorrentes | CNAE+região + busca |

---

## 6. Kommo CRM — centro de gravidade ⭐ (novo)

Os SDRs trabalham e ligam **pelo Kommo**. A ferramenta é o **motor de enriquecimento que alimenta o Kommo**.

**Estratégia de construção (em duas etapas, como pedido):**
1. **Agora:** construir a ferramenta com o **modelo de dados já desenhado para mapear no Kommo** — cada dado garimpado tem um campo-alvo correspondente (lead/contato/campos customizados/notas/tags no Kommo). Uma **camada de integração (adapter)** já fica pronta, mas em modo "stub" (grava o payload que *seria* enviado, sem chamar a API ainda).
2. **Depois (ferramenta validada):** ligar a integração real — API do Kommo (OAuth), criar/atualizar leads e contatos, preencher campos customizados, anexar o briefing como nota, aplicar tags de status, e sincronizar mudanças.

**Mapeamento previsto (ferramenta → Kommo):**
- Empresa + CNPJ + segmento → **Lead** (campos customizados).
- Decisor + contatos pessoais/sociais → **Contato** vinculado ao Lead.
- Briefing + ganchos + scripts por canal → **Nota** no card + campos.
- Status do pipeline (enriquecendo → pronto → em abordagem) → **etapa/tags** no funil do Kommo.
- Evidências (site quebrado, anúncios, cliente oculto) → campos/nota.

**Design first:** os campos da ferramenta são nomeados e tipados espelhando os campos do Kommo desde já, para a integração ser um "encaixe" e não uma refatoração.

---

## 7. Arquitetura

**Stack:** React + Vite + TypeScript (frontend) · Supabase (Postgres + Auth + Storage + Edge Functions) · deploy Vercel **(depois)**. Mesma base do financeiro.

**Construção:** local, via terminal. **Sem deploy.** Infra Supabase montada conforme necessário (schema/migrations versionados no repo).

**Enriquecimento é assíncrono → fila de jobs.**

```
Frontend (React) ── Supabase Auth (login/roles)
                 ├─ Supabase DB (leads, decisores, jobs, resultados, briefings, cadência, kommo_sync)
                 ├─ Supabase Storage (evidências)
                 ├─ Edge Functions (workers):
                 │    worker-cnpj · worker-decisor · worker-site · worker-ads
                 │    worker-benchmark · worker-mystery · worker-briefing · worker-cadence
                 ├─ Adapter Kommo (stub agora → API depois)
                 └─ Webhooks: recebimento WhatsApp (cliente oculto + respostas)
```

**Pipeline / status do lead:**
```
Importado → Validando → Enriquecendo empresa → Descobrindo decisor
→ Cliente oculto em andamento → Briefing gerado → Pronto (sobe ao Kommo)
→ Em abordagem → Respondido/Descartado
```

---

## 8. Modelo de dados (esboço, alinhado ao Kommo)

- **leads** — empresa: entrada + validado (Receita) + status + score + `kommo_lead_id`.
- **decision_makers** — decisor: nome, cargo, tel pessoal, e-mail pessoal, perfis sociais (IG/FB/LinkedIn), confiança, origem, `kommo_contact_id`.
- **enrichment_jobs** — fila (tipo, status, tentativas, payload, resultado).
- **site_audits** · **ad_presence** · **competitors** · **mystery_shopper** — resultados de cada etapa.
- **briefings** — texto + ganchos (JSON) + scripts por canal (JSON).
- **cadence_steps** — régua: canal, script, status, agendado_para, enviado_em, respondido_em.
- **kommo_sync** — o que foi/seria enviado ao Kommo (payload, status, timestamps) — a camada adapter.
- **users / user_profiles** — auth + roles + permissões (JSONB).
- **channel_config** — números, domínio, chaves, credenciais Kommo (só admin).

---

## 9. Roles e permissões

| Role | Acesso |
|---|---|
| `admin` | Tudo + usuários + config de canais/integrações |
| `gestor` | Importar, ver funil/métricas, aprovar envio ao Kommo |
| `sdr` | Ver leads/briefings, registrar envio social, marcar resultado |
| `viewer` | Só leitura |

Permissões customizáveis por usuário (`custom_permissions` JSONB).

---

## 10. Telas

1. **Dashboard** — funil, métricas, alertas (quality rating, bounces, contas sociais).
2. **Importar lista** — upload/colar, mapeamento, preview, validação.
3. **Lista de leads** — filtros por status/segmento/região/score/contactabilidade.
4. **Detalhe do lead** — decisor + contatos + briefing + evidências + scripts por canal + status Kommo.
5. **Cadência/prospecção** — régua por canal, fila de envios sociais (semi-manual), histórico.
6. **Cliente oculto** — sondagens em andamento.
7. **Usuários** (admin) · **Configurações/Integrações** (admin: Kommo, canais, chaves).

---

## 11. Fases de entrega

| Fase | Entrega | Valor |
|---|---|---|
| **1 — Núcleo** | Setup Supabase (local) + login/roles + importação + **validação de dados** + enriquecimento CNPJ + auditoria de site + tela do lead + **modelo de dados espelhando o Kommo** | Base usável; site quebrado por lead |
| **2 — Decisor + inteligência** | Descoberta do decisor e contatos pessoais/sociais + anúncios Google/Meta + benchmark + briefing IA com scripts por canal | Briefing completo + decisor |
| **3 — Cliente oculto** | Sondagem + cronômetro + follow-up + avaliação IA (canal anônimo) | Munição de atendimento |
| **4 — Cadência + Kommo** | Régua multicanal (WhatsApp/e-mail/social) + **integração real com o Kommo** | Ferramenta completa alimentando o CRM |
| **5 — Deploy** | Trâmites de deploy (Vercel + Supabase prod) | Em produção |

Cada fase é testada localmente e aprovada antes da próxima. **Deploy só na Fase 5.**

---

## 12. Conformidade e riscos

- **LGPD (crítico):** dado pessoal do decisor exige base legal (legítimo interesse), opt-out e log de origem. Registrar consentimento quando houver.
- **Redes sociais:** DM frio automatizado bane conta → envio semi-manual. Não usar as contas oficiais para automação em massa.
- **WhatsApp:** monitorar quality rating; personalização como defesa.
- **E-mail:** domínio dedicado + warm-up + SPF/DKIM/DMARC (não o `@v4company.com`).
- **Cliente oculto:** número descartável.
- **Custos/mês estimados:** WhatsApp ~R$350 + IA <R$100 + enriquecimento de pessoas (a definir) + APIs de dados (baixo) + infra.

---

## 13. Definições (2026-07-17)

1. Lista: colunas fixas, dados não confiáveis → validação com Receita. ✅
2. Alvo dos contatos: **decisor (pessoa física)**, não a empresa. ✅
3. Prospecção também em **Instagram/Facebook/LinkedIn** (têm IG e LinkedIn); envio semi-manual. ✅
4. **Kommo** é onde os SDRs trabalham; ferramenta alimenta o Kommo (design first, integração depois). ✅
5. E-mail: Workspace `@v4company.com` existe, mas usar **domínio de prospecção dedicado**. ✅
6. Meta Business/Cloud API: já possuem. ✅
7. Nichos: incorporadoras, construtoras, imobiliárias, varejo de construção. ✅
8. **Sem deploy** até ordem explícita; construir local. ✅

**Pendências para fases futuras (não bloqueiam a Fase 1):**
- Provedor de enriquecimento de pessoas (Apollo/Lusha/Snov/Hunter).
- Registrar domínio de prospecção + caixa no Workspace.
- Credenciais/OAuth do Kommo + mapeamento fino dos campos customizados.
- Confirmar conta de Facebook.

---

## 14. Fora de escopo (v1)

- Integração com o sistema financeiro.
- Substituir o Kommo (a ferramenta alimenta, não substitui o CRM).
- Discagem automática / VoIP (SDR liga pelo Kommo).
- Automação de DM em redes (envio semi-manual).

---

*Fim do PRD v1.1.*
