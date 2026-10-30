#!/usr/bin/env node
// Gera os PNGs dos ícones da camada visual a partir do Lucide (ISC) e do catálogo ICONES.
// Ferramenta de dev, roda uma vez por versão do conjunto. As dependências NÃO entram no
// package.json do app; instale numa pasta à parte e passe o caminho:
//   npm i --prefix <dir> @resvg/resvg-js lucide-static
//   node propostas/visual/gerar-icones.mjs --modulos <dir>/node_modules [--saida propostas/visual/icones]
// Saída: <chave>-<variante>.png (192 px, fundo transparente), uma por variante de cor.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ICONES, VARIANTES_ICONE } from '../../supabase/functions/_shared/propostas/visual.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, v) => (a.startsWith('--') ? [...acc, [a.slice(2), v[i + 1]]] : acc), []));
if (!args.modulos) { console.error('uso: --modulos <dir>/node_modules'); process.exit(2); }
const require = createRequire(join(args.modulos, 'x.js'));
const { Resvg } = require('@resvg/resvg-js');
const pastaLucide = join(args.modulos, 'lucide-static', 'icons');
const saida = args.saida || new URL('./icones', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(saida, { recursive: true });

const arquivos = new Set(ICONES.map((i) => i.lucide));
let n = 0;
for (const lucide of arquivos) {
  const svg = readFileSync(join(pastaLucide, `${lucide}.svg`), 'utf8').replace(/<!--.*?-->/s, '');
  for (const [variante, corHex] of Object.entries(VARIANTES_ICONE)) {
    const pintado = svg.replace(/stroke="currentColor"/, `stroke="${corHex}"`).replace(/stroke-width="2"/, 'stroke-width="1.75"');
    const png = new Resvg(pintado, { fitTo: { mode: 'width', value: 192 }, background: 'rgba(0,0,0,0)' }).render().asPng();
    for (const ic of ICONES.filter((i) => i.lucide === lucide)) {
      writeFileSync(join(saida, `${ic.chave}-${variante}.png`), png);
      n++;
    }
  }
}
console.log(`${n} PNGs em ${saida}`);
