#!/usr/bin/env node
// Publica os PNGs de propostas/visual/icones no Storage do projeto (bucket público
// "propostas-visual", pasta icones/<VERSAO_ICONES>/). Os ícones não têm dado de cliente.
// O Slides baixa a imagem uma vez, na inserção; o deck não depende do bucket depois.
//   set -a; . ~/.oraculo/segredos/saleshub.env; set +a     (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//   node propostas/visual/publicar-icones.mjs [--dry-run]
// Pré-requisito: bucket criado pela migration_186. Reverter: rollback da migration_186
// (apaga objetos e bucket) ou só a pasta da versão.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUCKET_ICONES, VERSAO_ICONES, baseIconesDoProjeto } from '../../supabase/functions/_shared/propostas/visual.mjs';

const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: chave } = process.env;
if (!url || !chave) { console.error('Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY'); process.exit(2); }
const dryRun = process.argv.includes('--dry-run');
const pasta = fileURLToPath(new URL('./icones', import.meta.url));
const arquivos = readdirSync(pasta).filter((f) => f.endsWith('.png'));
const cab = { apikey: chave, Authorization: `Bearer ${chave}` };

async function req(metodo, caminho, corpo, extra = {}) {
  const r = await fetch(`${url}/storage/v1/${caminho}`, { method: metodo, headers: { ...cab, ...extra }, body: corpo });
  const texto = await r.text();
  return { ok: r.ok, status: r.status, texto: texto.replaceAll(chave, '[redigido]').slice(0, 300) };
}

console.log(`${arquivos.length} ícones → ${BUCKET_ICONES}/icones/${VERSAO_ICONES}${dryRun ? ' (dry-run)' : ''}`);
if (dryRun) process.exit(0);

// O bucket nasce da migration (migration_186_propostas_visual_bucket.sql), não daqui.
const b = await req('GET', `bucket/${BUCKET_ICONES}`);
if (!b.ok) { console.error(`bucket ${BUCKET_ICONES} não existe: aplique a migration_186 antes (HTTP ${b.status})`); process.exit(1); }
let falhas = 0;
for (const f of arquivos) {
  const r = await req('POST', `object/${BUCKET_ICONES}/icones/${VERSAO_ICONES}/${f}`, readFileSync(join(pasta, f)), { 'Content-Type': 'image/png', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' });
  if (!r.ok) { falhas++; console.error(`${f}: HTTP ${r.status} ${r.texto}`); }
}
console.log(`${arquivos.length - falhas}/${arquivos.length} publicados. Base: ${baseIconesDoProjeto(url)}`);
process.exit(falhas ? 1 : 0);
