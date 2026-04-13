# PRD: Automatização Pós-Reunião de Venda com IA

## Problem Statement

Após cada reunião de vendas, o closer precisa executar manualmente entre 5 e 8 tarefas no sistema: atualizar a temperatura do deal, registrar o valor da proposta, preencher produtos discutidos, coletar e cadastrar indicações como novos leads, agendar a próxima reunião duplicando o evento do Google Calendar, e adicionar notas/resumo. Esse processo leva em média 15-20 minutos por reunião e é propenso a erros e esquecimentos — especialmente o cadastro de indicações, que frequentemente fica pendente. Com ~10 reuniões por semana, o time perde 2-3 horas semanais em trabalho administrativo que poderia ser automatizado, já que todas as informações necessárias estão disponíveis na gravação/transcrição do Google Meet.

## Solution

Um sistema de automação pós-reunião que, após a confirmação de uma reunião como "show":

1. **Busca automaticamente** a transcrição da call no Google Drive (Google Meet gera transcrição no Google Docs ~30 min após a call)
2. **Analisa com IA (Gemini)** o conteúdo da transcrição para extrair dados estruturados
3. **Aplica automaticamente** todas as atualizações no sistema: deal, leads de indicação, próxima reunião
4. **Complementa dados** de indicações via API do Kommo (WhatsApp do lead)
5. **Mostra feedback** ao closer sobre o que foi feito, de forma 100% automática (sem necessidade de revisão)

O closer verá um botão "Pós-Reunião IA" no card da reunião realizada. Ao clicar, o sistema faz tudo sozinho e mostra o resultado.

## User Stories

1. As a closer, I want the system to automatically find the call transcript after I confirm a meeting as "show", so that I don't need to manually search for it in Google Drive.
2. As a closer, I want the AI to automatically determine the lead temperature (quente/morno/frio) from the call content, so that I don't need to classify it manually.
3. As a closer, I want the AI to extract the proposed deal value (OT and MRR) from the conversation, so that the deal record is updated without manual input.
4. As a closer, I want the AI to identify which products (from the existing OT/MRR taxonomy) were discussed, so that the deal's product fields are automatically filled.
5. As a closer, I want the AI to estimate a BANT score (1-4) based on the conversation, so that deal qualification is done automatically.
6. As a closer, I want the AI to estimate the client tier (tiny/small/medium/large/enterprise) based on mentioned revenue, so that the deal is categorized correctly.
7. As a closer, I want the AI to generate an executive summary of the call (key points, objections, next steps), so that I have a reference without rewatching the recording.
8. As a closer, I want the AI to extract referral names and contact info mentioned during the call, so that new leads are created automatically.
9. As a SDR (Lary), I want referral leads to be automatically created in the system with canal='recomendacao' and assigned to me, so that I can start working them immediately.
10. As a closer, I want the next meeting to be automatically scheduled in Google Calendar with the date/time mentioned in the call, duplicating participants from the original event, so that I don't need to manually create calendar events.
11. As a gestor, I want to see how many referrals each closer collects per meeting, so that I can track this KPI automatically.
12. As a closer, I want the system to complement referral contact info from Kommo's WhatsApp chat when the transcript doesn't have complete data, so that leads are created with accurate information.
13. As a closer, I want to see a "Pós-Reunião IA" button on completed meeting cards, so that I can trigger the automation with one click.
14. As a closer, I want to see the status of the automation (searching transcript → found → processing → done), so that I know what's happening.
15. As a closer, I want the system to show me what actions were taken (deal updated, X leads created, next meeting scheduled), so that I can verify the results.
16. As a gestor, I want the deal's link_call_vendas and link_transcricao fields to be automatically filled with the Drive recording and Docs transcript URLs, so that the team can review calls later.
17. As a closer, I want the automation to work even if the transcript takes longer than 30 minutes to become available, with retry/polling, so that it's reliable.
18. As a closer, I want the system to handle cases where no next meeting was discussed (negative outcome / frio), only updating deal fields without scheduling.
19. As a closer, I want the system to handle cases where no referrals were mentioned, only updating deal fields without creating leads.
20. As a closer, I want the deal's observacoes field to contain the AI-generated executive summary, so that context is always available.

## Implementation Decisions

### New Modules

**1. MeetingTranscriptFetcher**
- Supabase Edge Function that accesses Google Drive API using the organizer's OAuth tokens
- Searches for transcript file matching the meeting (by event title, date, or Meet recording metadata)
- Polls periodically (every 2 minutes for up to 60 minutes) after meeting confirmation
- Returns the full text content of the Google Docs transcript
- Also retrieves the Google Drive recording URL (video link)
- Requires expanding OAuth scopes to include: `drive.readonly`, `documents.readonly`

**2. CallAnalyzer**
- Uses Google Gemini API (`@google/genai` already in project) to analyze transcript text
- Structured output prompt that returns JSON with:
  - `temperatura`: "quente" | "morno" | "frio"
  - `valor_escopo`: number (OT value)
  - `valor_recorrente`: number (MRR value)
  - `produtos_ot`: string[] (mapped to PRODUTOS_OT constants)
  - `produtos_mrr`: string[] (mapped to PRODUTOS_MRR constants)
  - `bant`: number (1-4)
  - `tier`: "tiny" | "small" | "medium" | "large" | "enterprise"
  - `resumo_executivo`: string (executive summary)
  - `indicacoes`: Array<{ nome: string, empresa: string, telefone?: string }>
  - `proxima_reuniao`: { data: string, hora: string } | null
- Product names are matched against the existing taxonomy (PRODUTOS_MRR, PRODUTOS_OT from types.ts)
- The prompt includes the product list and tier definitions for accurate extraction

**3. PostMeetingOrchestrator**
- Coordinates all post-meeting actions in sequence:
  1. Fetch transcript (MeetingTranscriptFetcher)
  2. Analyze content (CallAnalyzer)
  3. Update deal: temperatura, valor_escopo, valor_recorrente, produtos_ot, produtos_mrr, bant, tier, observacoes (resumo), link_call_vendas, link_transcricao
  4. Create referral leads: canal='recomendacao', sdr_id=Lary's member ID, with nome_contato and telefone from transcript
  5. Complement referral data from Kommo WhatsApp API (if phone/name missing)
  6. Schedule next meeting: use existing `addReuniao` flow which creates Google Calendar event
- 100% automatic execution — no human review step
- Stores automation status and results for UI display

**4. PostMeetingPanel (UI Component)**
- Button "Pós-Reunião IA" visible on reunião cards where `realizada=true AND show=true`
- Displays real-time status: 🔍 Buscando transcrição → 📝 Analisando call → ⚡ Aplicando ações → ✅ Concluído
- Shows summary of actions taken after completion
- Disabled/hidden if automation already ran for this meeting

### Modifications to Existing Code

**OAuth Google (google-auth Edge Function)**
- Add scopes: `https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/documents.readonly`
- Existing users will need to re-authorize to grant new permissions

**store.tsx**
- New actions: `startPostMeetingAutomation(reuniaoId)`, `getAutomationStatus(reuniaoId)`
- Extend existing `updateDeal` to handle batch field updates from AI

**Supabase Schema**
- New table `post_meeting_automations`:
  - `id` (UUID)
  - `reuniao_id` (FK to reunioes)
  - `deal_id` (FK to deals)
  - `status` ('pending' | 'fetching_transcript' | 'analyzing' | 'applying' | 'completed' | 'error')
  - `transcript_text` (TEXT - cached transcript)
  - `ai_result` (JSONB - structured extraction result)
  - `actions_taken` (JSONB - log of what was done)
  - `leads_created` (UUID[] - referral lead IDs)
  - `next_reuniao_id` (UUID - if new meeting was scheduled)
  - `error_message` (TEXT)
  - `created_at`, `completed_at` (TIMESTAMPTZ)

**Kommo Integration (kommo.ts)**
- New function to fetch WhatsApp chat messages for a lead's contact
- Extract referral contact details from recent messages

### Architecture Decisions

- **Edge Functions for API calls**: All Google Drive/Docs API calls go through Supabase Edge Functions (same pattern as existing Google Calendar integration) to avoid CORS and keep tokens server-side
- **Polling strategy**: After meeting confirmation, the edge function polls Drive every 2 min for up to 60 min. Uses the meeting title and date to find the transcript file
- **Gemini for analysis**: Using Google's Gemini model (already a dependency) with structured JSON output mode for reliable data extraction
- **Idempotency**: Each reunião can only have one automation run. The `post_meeting_automations` table prevents duplicate runs
- **Product mapping**: The Gemini prompt includes the exact product names from the taxonomy, so extraction maps directly to existing constants

## Testing Decisions

Testing is out of scope for the hackathon MVP. Priority is on delivering working functionality.

When tests are added later, good tests should:
- Test external behavior (API contracts, data transformations) not implementation details
- **CallAnalyzer**: Test with sample transcripts that the JSON output matches expected schema and reasonable values
- **PostMeetingOrchestrator**: Test that given a known AI result, the correct database operations are called (deal updated, leads created, meeting scheduled)

## Out of Scope

- **Video analysis**: Processing the Google Meet video recording directly (would use Gemini multimodal) — transcript text is sufficient and more reliable
- **Real-time transcription**: Live transcription during the call
- **Automatic trigger**: Auto-starting the automation without the closer clicking the button (could be added later)
- **Undo/rollback**: Ability to undo automation actions (100% automatic as requested)
- **Performance metrics update**: Auto-updating SDR/Closer performance tables from automation data
- **Multi-language support**: Assuming all calls are in Portuguese
- **Batch processing**: Running automation for multiple meetings at once
- **Notification system**: Notifying SDR Lary when new referral leads are created (could be a toast or push notification in future)

## Further Notes

- The Google OAuth re-authorization is a one-time step per user but may cause friction. Consider showing a clear prompt explaining why new permissions are needed.
- Gemini's structured output (JSON mode) should be used to ensure reliable data extraction. The prompt needs careful engineering with examples.
- The 30-minute delay for Google Meet transcripts is a Google limitation. The polling approach handles this gracefully.
- The "Lary" SDR assignment is hardcoded for now. Could be made configurable per team in the future.
- Kommo WhatsApp integration depends on available API endpoints. If not feasible, fall back to transcript-only data for referrals.
- The `link_call_vendas` field in deals already exists and expects a URL — perfect for storing the Google Drive recording link.
- The `link_transcricao` field in deals already exists — perfect for storing the Google Docs transcript link.
