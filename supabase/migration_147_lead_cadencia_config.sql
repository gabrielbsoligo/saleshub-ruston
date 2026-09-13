-- 147 · Cadência validada pelo SDR no arquiteto (F7 → F8 "Pronto p/ importar").
-- O SDR escolhe o que será abordado (falha principal/secundária = ganchos das
-- mensagens), o decisor ({{1}}), o próprio nome ({{2}}), a marca ({{3}}), pode
-- ajustar as frases ({{4}}/{{5}}) dentro dos tetos e escolher a variante do
-- template. O motor (prepararCadencia) e o carteiro (enriquecedor-cadencia)
-- usam EXATAMENTE isto quando validado. Ver enriquecedor/src/lib/cadencia.ts.
alter table enriquecedor_leads
  add column if not exists cadencia_config jsonb not null default '{}';
comment on column enriquecedor_leads.cadencia_config is
  'Escolhas do SDR pra cadência WABA: falhaPrimaria, falhaSecundaria, decisorId, nome1, sdrNome, fantasia, fraseFalha, fraseImpacto, rotuloSecundaria, templates{p1,p2,p3}, validadoEm, validadoPor';
