-- ============================================================================
-- Migration 137 — Log persistente de erros do ENRIQUECEDOR
--
-- Tudo que falhar (no app durante as fases do funil, ou no motor no Railway)
-- fica registrado aqui, com lead e contexto — para auditoria periódica e
-- correção dos erros recorrentes. Registrar erro NUNCA pode quebrar o fluxo:
-- os gravadores são fire-and-forget nos dois lados.
-- ============================================================================

create table if not exists public.enriquecedor_error_log (
  id uuid primary key default gen_random_uuid(),
  origem text not null check (origem in ('app', 'motor')),
  etapa text,        -- fase do funil (ex.: 'F3 Diagnóstico digital') ou rota do motor (ex.: '/api/briefing')
  empresa text,
  cnpj text,
  mensagem text not null,
  detalhe jsonb,
  created_at timestamptz not null default now()
);
create index if not exists enriquecedor_error_log_created_idx
  on public.enriquecedor_error_log (created_at desc);

alter table public.enriquecedor_error_log enable row level security;
drop policy if exists "auth_all_enriquecedor_error_log" on public.enriquecedor_error_log;
create policy "auth_all_enriquecedor_error_log" on public.enriquecedor_error_log
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
