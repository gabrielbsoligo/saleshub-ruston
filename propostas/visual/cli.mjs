#!/usr/bin/env node
// Aplica a camada visual numa apresentação JÁ GERADA (nunca no deck original/template).
//   GOOGLE_ACCESS_TOKEN=... SUPABASE_URL=... node propostas/visual/cli.mjs --apresentacao <id> [--estilo v2|v1] [--data dd/mm/aaaa] [--capa substituir|depois|antes|nao] [--caso nao|sim|auto] [--tipo estruturacao|implementacao|...] [--modelo <modelo de venda>] [--dry-run]
// O token nunca é impresso. Rodar de novo é seguro: slides que já têm a camada (_v…) são pulados.
import { aplicarVisual, baseIconesDoProjeto } from '../../supabase/functions/_shared/propostas/visual.mjs';
import { aplicarVisualV2, assetsDoProjeto } from '../../supabase/functions/_shared/propostas/visual-v2.mjs';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const id = arg('apresentacao');
const token = process.env.GOOGLE_ACCESS_TOKEN;
const url = process.env.SUPABASE_URL;
const estilo = arg('estilo') || 'v2';
if (!id || !token || !url) { console.error('uso: --apresentacao <id> [--estilo v2|v1] [--data dd/mm/aaaa] [--capa ...] [--caso ...] [--tipo ...] [--modelo ...] [--dry-run]; precisa de GOOGLE_ACCESS_TOKEN e SUPABASE_URL'); process.exit(2); }

const dryRun = argv.includes('--dry-run');
const r = estilo === 'v1'
  ? await aplicarVisual({ token, apresentacaoId: id, base: baseIconesDoProjeto(url), dryRun })
  : await aplicarVisualV2({ token, apresentacaoId: id, assets: assetsDoProjeto(url), data: arg('data') || null, capa: arg('capa'), caso: arg('caso'), tipo: arg('tipo') || null, modeloVenda: arg('modelo') || null, dryRun });
for (const s of r.resumo) console.log(`${String(s.titulo).padEnd(36)} ${s.feito.join(', ')}`);
console.log(`${r.total} pedidos${r.aplicado ? ' aplicados' : ' (não aplicados)'}${r.semIcones ? ` — SEM IMAGENS (plano B): ${r.erroIcones}` : ''}`);
