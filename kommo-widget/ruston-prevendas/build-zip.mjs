// Gera dist/ruston-prevendas.zip só com os arquivos do widget (sem testes, docs nem scripts).
// Uso: node kommo-widget/ruston-prevendas/build-zip.mjs
// Compacta com o tar do sistema (no Windows, System32/tar.exe gera zip com barras "/" e arquivos na raiz).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(dir, 'dist')
const stage = path.join(out, 'stage')
const arquivos = ['manifest.json', 'script.js', 'notify.mp3', 'i18n', 'images']

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
for (const a of arquivos) fs.cpSync(path.join(dir, a), path.join(stage, a), { recursive: true })

// UTF-8 sem BOM em texto (o Kommo rejeita BOM)
const BOM = String.fromCharCode(0xfeff)
for (const f of ['manifest.json', 'script.js', 'i18n/pt.json', 'i18n/en.json']) {
  const p = path.join(stage, f)
  const s = fs.readFileSync(p, 'utf8')
  fs.writeFileSync(p, s.startsWith(BOM) ? s.slice(1) : s, 'utf8')
}

const zip = path.join(out, 'ruston-prevendas.zip')
const win = process.platform === 'win32'
const tar = win ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'zip'
const args = win ? ['-a', '-c', '-f', zip, ...arquivos] : ['-r', zip, ...arquivos]
execFileSync(tar, args, { stdio: 'inherit', cwd: stage })
fs.rmSync(stage, { recursive: true, force: true })
console.log('ok', zip, fs.statSync(zip).size, 'bytes')
