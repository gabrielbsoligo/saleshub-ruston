#!/usr/bin/env node
// Gera os fundos (PNG 1920x1080) da camada visual: vinho V4 com brilho vermelho,
// no espírito do deck EE 2026. Ferramenta de dev, como gerar-icones.mjs:
//   node propostas/visual/gerar-fundos.mjs --modulos <dir>/node_modules
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const modulos = argv[argv.indexOf('--modulos') + 1];
if (!argv.includes('--modulos') || !modulos) { console.error('uso: --modulos <dir>/node_modules'); process.exit(2); }
const { Resvg } = createRequire(join(modulos, 'x.js'))('@resvg/resvg-js');
const saida = fileURLToPath(new URL('./fundos', import.meta.url));
mkdirSync(saida, { recursive: true });

const brilho = (id, cx, cy, r, cor, op) => `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}" gradientUnits="objectBoundingBox">
  <stop offset="0" stop-color="${cor}" stop-opacity="${op}"/><stop offset="0.55" stop-color="${cor}" stop-opacity="${op * 0.35}"/><stop offset="1" stop-color="${cor}" stop-opacity="0"/></radialGradient>`;
const linhas = (op) => Array.from({ length: 9 }, (_, i) => `<line x1="${1180 + i * 90}" y1="0" x2="${1920}" y2="${740 - i * 90}" stroke="#FB2E0A" stroke-opacity="${op}" stroke-width="1.2"/>`).join('');

const FUNDOS = {
  // slides de conteúdo: brilho baixo à direita (a) ou no alto (b), texto à esquerda continua legível
  a: { brilhos: [['g1', 0.95, 1.05, 0.75, '#E3150C', 0.55], ['g2', 0, 0, 0.6, '#4A0000', 0.6]], linhas: 0.05 },
  b: { brilhos: [['g1', 1.0, -0.05, 0.7, '#E3150C', 0.45], ['g2', 0.1, 1.1, 0.6, '#5A0000', 0.5]], linhas: 0.04 },
  // capa e fecho: brilho forte
  capa: { brilhos: [['g1', 0.82, 0.62, 0.8, '#FF2A12', 0.85], ['g2', 1.0, 1.0, 0.5, '#FFD60A', 0.12], ['g3', 0, 0, 0.6, '#140000', 0.8]], linhas: 0.08 },
  // números em destaque: brilho embaixo, no centro
  destaque: { brilhos: [['g1', 0.5, 1.15, 0.8, '#E3150C', 0.6], ['g2', 0.5, -0.2, 0.5, '#3A0000', 0.6]], linhas: 0 },
};

for (const [nome, f] of Object.entries(FUNDOS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<defs>${f.brilhos.map((b) => brilho(...b)).join('')}</defs>
<rect width="1920" height="1080" fill="#1E0000"/>
${f.brilhos.map(([id]) => `<rect width="1920" height="1080" fill="url(#${id})"/>`).join('')}
${f.linhas ? linhas(f.linhas) : ''}
</svg>`;
  writeFileSync(join(saida, `fundo-${nome}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: 1920 } }).render().asPng());
}
console.log(`${Object.keys(FUNDOS).length} fundos em ${saida}`);
