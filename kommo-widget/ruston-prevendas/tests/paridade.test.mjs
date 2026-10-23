// node --experimental-strip-types --test kommo-widget/ruston-prevendas/tests/paridade.test.mjs
// A ordem do servidor (TS, _shared/prevendas_ordem.ts) tem que ser IDÊNTICA à do widget (bloco Fila do script.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ordenar } from '../../../supabase/functions/_shared/prevendas_ordem.ts'

const dir = path.dirname(fileURLToPath(import.meta.url))
const ctx = { module: { exports: {} } }
vm.runInNewContext(fs.readFileSync(path.join(dir, '..', 'script.js'), 'utf8'), ctx)
const Fila = ctx.module.exports

const MOM = ['anti_noshow', 'speed_to_lead', 'conexao', 'follow_up', 'recuperar', 'pre_reuniao', 'prospeccao', 'sem_classificacao', 'outro']
const GR = ['G1', 'G2', 'G3', 'G4', 'G5', 'G9', 'G7']
let seed = 42
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }

test('paridade servidor × widget em 1000 casos aleatórios', () => {
  const AGORA = 1_800_000_000
  for (let caso = 0; caso < 1000; caso++) {
    const n = 1 + rnd(30)
    const itens = Array.from({ length: n }, (_, i) => ({
      id: i + 1 + rnd(5) * 100, due: rnd(10) === 0 ? 0 : AGORA + (rnd(400) - 200) * 60,
      momento: MOM[rnd(MOM.length)], grupo: GR[rnd(GR.length)], urgente: rnd(8) === 0,
    }))
    const cfg = { antecedencia_min: rnd(30), outbound_apos: ['16:00', '09:30', 'x', ''][rnd(4)], grupos: rnd(3) ? ['G1', 'G2', 'G3', 'G4', 'G5', 'G9'] : ['G4', 'G1'] }
    const minuto = rnd(1440)
    const a = Fila.ordenar(itens, cfg, AGORA, minuto)
    const b = ordenar(itens, cfg, AGORA, minuto)
    assert.deepEqual([...a.fila].map((x) => x.id), b.fila.map((x) => x.id), `caso ${caso}`)
    assert.equal(a.futura ? a.futura.id : null, b.futura ? b.futura.id : null, `caso ${caso} futura`)
  }
})
