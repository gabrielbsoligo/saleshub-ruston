# Convenções do Projeto SDNA Outbound

Lido pelo Claude Code a cada sessão. Regras obrigatórias. Ver `docs/PRD.md` para o escopo completo.

## 🚫 Regras de execução (NUNCA sem permissão explícita do Ruston)

1. **Nunca fazer deploy** (Vercel/Supabase prod). Deploy é a **Fase 5**, só sob ordem explícita ("pode subir").
2. **Nunca fazer git commit/push** sem pedir.
3. **Nunca configurar cron jobs** sem pedir.
4. Construir **local** (terminal). Infra Supabase montada só conforme necessário.

## 🎯 O que a ferramenta faz (essência)

Recebe lista de leads → valida → descobre o **decisor (pessoa física)** e seus contatos pessoais/sociais → audita presença digital (site, anúncios, benchmark) → **cliente oculto** → briefing por IA com scripts por canal → **alimenta o CRM Kommo** (onde os SDRs ligam). Prospecção multicanal: WhatsApp, e-mail, Instagram, Facebook, LinkedIn.

## 🧭 Princípios de arquitetura

- **Kommo é o destino dos dados.** Todo dado garimpado tem um campo-alvo no Kommo. Modele campos espelhando o Kommo (ver `kommo_sync` e §6 do PRD). Integração real = Fase 4; até lá, o adapter grava o payload que *seria* enviado.
- **Receita é a fonte de verdade** dos dados da empresa. Dado da planilha que diverge é marcado e substituído pelo oficial.
- **Alvo dos contatos = decisor**, não a empresa.
- **Enriquecimento é assíncrono** → fila (`enrichment_jobs`) + workers. Nunca bloquear a UI em trabalho pesado.
- **Cálculo/lógica compartilhada** vive em `src/lib/`, nunca duplicada em componente.

## 🖥️ Dois processos (sem deploy)

`npm run dev` sobe **site** (Vite, :3001) + **motor** (`server/index.mjs`, :3011). O motor faz o
que o navegador não pode (CORS/busca): **descobre o site** (domínio do e-mail → palpite por nome →
busca por API se houver chave), **audita** o site e **consulta CNPJ** com cache+retry. O Vite faz
proxy de `/api` → :3011. Descoberta por API precisa de `SERPER_API_KEY`/`BRAVE_API_KEY` (opcional).

## 🤖 Enriquecimento é automático

Após a importação, o sistema **descobre e audita o site de todos os leads sozinho** (sem clicar
lead a lead). O operador só intervém no que não foi encontrado. Nunca voltar a exigir ação manual
por lead para etapas que dá para automatizar.

## 📁 Estrutura

- `src/lib/` — serviços e lógica pura (validação, CNPJ, enrichService, leadScore, repositórios, permissões).
- `server/index.mjs` — motor de enriquecimento local (Node).
- `src/views/` — telas.
- `src/components/` — UI compartilhada (Layout, Login).
- `src/types.ts` — tipos do domínio (nomes espelhando o Kommo).
- `supabase/migrations/` — schema SQL versionado.

## ✅ Ao adicionar uma nova aba/view

Atualizar SEMPRE:
1. `src/types.ts` → adicionar ao union `View`.
2. `src/types.ts` (`Permissions`) + `src/lib/permissions.ts` → nova permissão nos 4 roles.
3. `src/components/Layout.tsx` → item no `NAV_ITEMS` com `permission`.
4. `src/App.tsx` → case no `renderView`.

## 🔐 Roles

`admin` (tudo + usuários + config), `gestor` (importar/funil/aprovar), `sdr` (ver/registrar/marcar), `viewer` (leitura). Permissões customizáveis por usuário em `user_profiles.custom_permissions` (JSONB); helper `mergePermissions`.

## 🗄️ Banco (Supabase)

- Schema em `supabase/migrations/*.sql`.
- Enquanto não há projeto Supabase próprio, a app roda em **modo local** (`localStorage`) — ver `supabaseConfigured` em `src/lib/supabase.ts`. Ao configurar o `.env.local`, os repositórios passam a usar o Postgres automaticamente.
- snake_case no banco ↔ camelCase na app (mapeado em `leadsRepo`).

## 📵 Limites conhecidos (registrados no PRD)

- **WhatsApp:** prospecção = API oficial (Cloud API); cliente oculto = número não-oficial descartável (precisa iniciar como consumidor anônimo).
- **Redes sociais:** sem API de DM frio → **envio semi-manual** (ferramenta acha perfil + gera script + organiza cadência; operador envia da conta oficial).
- **E-mail:** domínio de prospecção dedicado (NÃO o `@v4company.com`).
- **LGPD:** dado pessoal do decisor exige base legal + opt-out + log de origem.

## 🧪 Ao terminar uma feature

1. `npx tsc --noEmit` (zero erros).
2. Testar no localhost (porta 3001).
3. **Sem deploy** até o Ruston pedir.
