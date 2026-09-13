-- Migration 146 — "chaves de busca" do lead (Enriquecedor).
-- Pedido do Gabriel (13/09): as auditorias rodam em cima de identificadores que a
-- ferramenta escolhe sozinha (marca/nome de busca, site, Instagram e Facebook da
-- empresa, ficha do Google Meu Negócio, termo de busca na Meta Ad Library) e o
-- operador não conseguia ver, corrigir nem travar esses valores ANTES de dar play.
-- Este jsonb guarda, por chave: validação humana ('validado' = a re-busca não
-- sobrescreve), origem (planilha/receita/site/busca/gmn/manual), identificadores
-- rejeitados (domínio/@/cid — nunca voltam) e, para marca/meta_termo/gmn, o valor
-- ou termo de consulta manual. Os valores em si continuam nas colunas existentes
-- (site_url, company_instagram, company_facebook, google_business).
-- Formato: { "site": {"validacao":"validado","origem":"manual","rejeitados":["x.com.br"]},
--            "marca": {"valor":"RDC","validacao":"validado","origem":"manual"}, ... }
-- Aditiva e com default. Convenção: mapear em toRow E fromRow (leadsRepo.ts).

alter table public.enriquecedor_leads
  add column if not exists chaves_busca jsonb not null default '{}';
