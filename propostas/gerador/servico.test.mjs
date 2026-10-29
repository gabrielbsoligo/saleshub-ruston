// node propostas/gerador/servico.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehChaveDeServico } from '../../supabase/functions/_shared/propostas/servico.mjs';

const auth = (status) => {
  const chamadas = [];
  const impl = async (url, init) => { chamadas.push({ url, auth: init.headers.Authorization }); if (status === 'rede') throw new Error('rede'); return { ok: status < 400, status }; };
  return { impl, chamadas, set: (s) => { status = s; } };
};
const opts = (f) => ({ url: 'https://x.supabase.co', chaveEnv: 'env-key', fetchImpl: f.impl });

test('Vedor 625d19f #1: chave antes válida e depois recusada → recusada (sem cache)', async () => {
  const f = auth(200);
  assert.equal(await ehChaveDeServico('jwt-legado', opts(f)), true);
  f.set(401);
  assert.equal(await ehChaveDeServico('jwt-legado', opts(f)), false);
  assert.equal(f.chamadas.length, 2, 'consultou o Auth nas duas vezes');
});

test('igual à env não consulta o Auth; vazio, 403, 500 e rede recusam', async () => {
  const f = auth(200);
  assert.equal(await ehChaveDeServico('env-key', opts(f)), true);
  assert.equal(f.chamadas.length, 0);
  assert.equal(await ehChaveDeServico('', opts(f)), false);
  for (const s of [403, 500, 'rede']) assert.equal(await ehChaveDeServico('outra', opts(auth(s))), false, String(s));
});

test('consulta endpoint só de admin com o próprio bearer', async () => {
  const f = auth(200);
  await ehChaveDeServico('jwt-legado', opts(f));
  assert.match(f.chamadas[0].url, /\/auth\/v1\/admin\/users/);
  assert.equal(f.chamadas[0].auth, 'Bearer jwt-legado');
});
