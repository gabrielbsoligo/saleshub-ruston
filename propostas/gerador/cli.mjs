#!/usr/bin/env node
// =============================================================
// Gerador de Propostas — CLI local (fase de teste)
// =============================================================
// Uso:
//   node propostas/gerador/cli.mjs preparar --template <ID_DA_COPIA_DE_TESTE>
//   node propostas/gerador/cli.mjs gerar --template <ID> --escopo <arquivo.json>
//        [--pasta <ID>] [--editor <email>]... [--link reader|writer|nenhum]
//        [--exportar pdf,pptx] [--saida <dir>] [--dry-run]
//
// Token: GOOGLE_ACCESS_TOKEN no ambiente (escopos presentations + drive.file
// ou drive). Nunca é impresso. --dry-run não usa rede nem token.
// =============================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { criarCliente } from './google.mjs';
import { gerarProposta, nomeProposta, planejar, prepararTemplate } from './gerar.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    template: { type: 'string' },
    escopo: { type: 'string' },
    pasta: { type: 'string' },
    editor: { type: 'string', multiple: true, default: [] },
    link: { type: 'string', default: 'reader' },
    exportar: { type: 'string', default: '' },
    saida: { type: 'string', default: '.' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const comando = positionals[0];
const sair = (msg) => { console.error(msg); process.exit(1); };
if (!values.template) sair('--template é obrigatório');

if (comando === 'preparar') {
  const cliente = criarCliente(process.env.GOOGLE_ACCESS_TOKEN);
  const res = await prepararTemplate(cliente, values.template);
  for (const r of res) console.log(`${r.trocas ? 'ok ' : 'ZERO'} ${r.trocas}x  ${r.literal}`);
  if (res.some((r) => !r.trocas)) console.log('Atenção: literal sem troca — confira o deck e o mapa LITERAIS_DECK.');
} else if (comando === 'gerar') {
  if (!values.escopo) sair('--escopo é obrigatório');
  if (!['reader', 'writer', 'nenhum'].includes(values.link)) sair('--link deve ser reader, writer ou nenhum');
  const escopo = JSON.parse(readFileSync(values.escopo, 'utf8'));
  const exportar = values.exportar.split(',').map((s) => s.trim()).filter(Boolean);

  if (values['dry-run']) {
    // Simula um deck de 3 slides com o slide de investimento na posição 2.
    const fake = { slides: [{}, {}, { pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Qual é o investimento?' } }] } } }] }] };
    const p = planejar(escopo, fake);
    console.log(JSON.stringify({ nome: nomeProposta(escopo), indice: p.indice, secoes: p.secoes, valores: p.valores, pendencias: p.pendencias, requests: p.requests.length }, null, 2));
  } else {
    const cliente = criarCliente(process.env.GOOGLE_ACCESS_TOKEN);
    const r = await gerarProposta(cliente, {
      templateId: values.template, escopo, pastaId: values.pasta,
      editores: values.editor, link: values.link, exportar,
    });
    mkdirSync(values.saida, { recursive: true });
    for (const [fmt, buf] of Object.entries(r.arquivos)) {
      const caminho = join(values.saida, `${nomeProposta(escopo)}.${fmt}`.replace(/[\\/:*?"<>|]/g, '-'));
      writeFileSync(caminho, buf);
      console.log(`exportado: ${caminho}`);
    }
    console.log(`proposta: ${r.url}`);
    console.log(`slides de escopo inseridos: ${r.slidesInseridos}`);
    if (r.pendencias.length) console.log(`PENDÊNCIAS (closer completa antes de enviar):\n- ${r.pendencias.join('\n- ')}`);
  }
} else {
  sair('comando: preparar | gerar');
}
