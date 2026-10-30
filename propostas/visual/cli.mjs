#!/usr/bin/env node
// Aplica a camada visual numa apresentação JÁ GERADA (nunca no deck original/template).
//   GOOGLE_ACCESS_TOKEN=... SUPABASE_URL=... node propostas/visual/cli.mjs --apresentacao <id> [--dry-run]
// O token nunca é impresso. Rodar de novo é seguro: slides que já têm a camada (_v…) são pulados.
import { aplicarVisual, baseIconesDoProjeto } from '../../supabase/functions/_shared/propostas/visual.mjs';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const id = arg('apresentacao');
const token = process.env.GOOGLE_ACCESS_TOKEN;
const base = arg('base') || (process.env.SUPABASE_URL && baseIconesDoProjeto(process.env.SUPABASE_URL));
if (!id || !token || !base) { console.error('uso: --apresentacao <id> [--dry-run] [--base <url dos ícones>]; precisa de GOOGLE_ACCESS_TOKEN e SUPABASE_URL'); process.exit(2); }

const r = await aplicarVisual({ token, apresentacaoId: id, base, dryRun: argv.includes('--dry-run') });
for (const s of r.resumo) console.log(`${s.titulo.padEnd(36)} ${s.feito.join(', ')}`);
console.log(`${r.total} pedidos${r.aplicado ? ' aplicados' : ' (não aplicados)'}`);
