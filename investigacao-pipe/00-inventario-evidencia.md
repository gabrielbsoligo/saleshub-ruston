# 00 · Inventário de evidência — investigação de pipe (03/08/2026)
> Somente leitura. Universo de referência: **90 deals em etapa aberta** hoje (89 com par no Kommo).
> Regra central respeitada: nenhuma leitura usa etapa/última transição (contaminadas pela migração de 27–31/07).

| Fonte | Existe | Onde | Janela | Cobertura dos 90 abertos | Distingue humano × automação |
|---|---|---|---|---|---|
| (a) WhatsApp backfill (texto, in/out, autor) | SIM | `kommo.mensagens` (15.540; direction in/out; author; origens waba/amocrmwa) | 05/2025 → **12/07/2026 (parou)** | 21/90 (23%) com msg do cliente | **SIM** (direction + author) |
| (a2) Eventos de chat (sem texto) | SIM | `kommo.events` type in/outgoing_chat_message (17.509; lead e contact) | 31/03/2026 → **03/08/2026 (fresco)** | 59/90 (66%) com incoming | **PARCIAL** — incoming = cliente (confiável); outgoing NÃO distingue humano de bot |
| (a) combinado (cliente respondeu, qualquer fonte) | — | mensagens ∪ events incoming (lead+contato) | até hoje | **65/90 (72,2%) ✅ > portão de 50%** | — |
| (b) Notas Kommo | SIM | `kommo.notes` (26.438; note_type, created_by, params) | 05/2025 → 03/08 | 77/90 (86%) | **PARCIAL** — notas do SalesHub/robô identificáveis por padrão de texto; nota manual via API fica com o user do token. Usada só como contexto, não como toque |
| (c) Ligações 3C Plus + API4COM | SIM | `public.ligacoes_4com` (18.024; atendida, duration, record_url, provider) | 03/04/2026 → 03/08 | 76/90 (84%) | **SIM** (ligação é sempre ação humana) |
| (d) Transcrição Whisper (callquality) | SIM | `public.call_quality.transcricao` (182 com texto) | 11/07 → 03/08/2026 | ligações analisadas apenas | SIM |
| (e) Transcrições de reunião (Gemini/Meet) | SIM | `public.reuniao_transcricoes` (193 com texto; amarra por `reuniao_id` → deal/lead — não por nome) | 02/04 → 03/08/2026 | 60 dos 66 deals c/ reunião no período (91%) | SIM |
| (f) Tarefas | SIM | `kommo.tasks` (54.320; is_completed, complete_till, responsável) | 05/2025 → hoje | ~100% dos com Kommo | PARCIAL — `is_auto_task()` separa cadência de humana |
| (g) E-mail | **NÃO** | nenhuma tabela de e-mail; `mensagens.origin` não tem e-mail | — | — | — |
| `kommo.mensagens_eventos_crm` | existe mas é **administrativa** (stage_move/field_change) | — | — | — | **descartada como contato** |

```sql
-- cobertura (1 query): 90 abertos; msg cliente por backfill=21, por evento=59, qualquer=65 (72,2%)
SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM kommo.mensagens m WHERE m.lead_id=a.kid AND m.direction='in')
   OR EXISTS (SELECT 1 FROM kommo.events e WHERE e.entity_id=a.kid AND e.entity_type='lead' AND e.type='incoming_chat_message')) ...
```

**Decisões de método derivadas deste inventário (valem para as partes 1–4):**
1. "Última mensagem do cliente" = MAX(backfill `in`, evento `incoming` no lead OU no contato vinculado). Data confiável até hoje; **texto só até 12/07**.
2. "Mensagem nossa" via eventos **pode conter bot** — usada para datar o silêncio, NÃO como toque humano.
3. "Toque humano" = ligação (qualquer, são discadas) + reunião realizada + mensagem `out` do backfill (01–12/07). **Mensagens humanas de 13/07 a 31/07 ficam de fora da contagem** — subconta declarada.
4. Portão da investigação: **72,2% ≥ 50% → SEGUE.**
