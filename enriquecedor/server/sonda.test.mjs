// node --test enriquecedor/server/sonda.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostPublico, ipPrivado, sondarSite } from './sonda.mjs';

test('ipPrivado/hostPublico', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(ipPrivado(ip), true, ip);
  for (const ip of ['8.8.8.8', '200.1.2.3', '2800:3f0::1']) assert.equal(ipPrivado(ip), false, ip);
  assert.equal(hostPublico('localhost'), false); assert.equal(hostPublico('app.internal'), false); assert.equal(hostPublico('127.0.0.1'), false); assert.equal(hostPublico('semponto'), false); assert.equal(hostPublico('clinicasorriso.com.br'), true);
});

test('DNS rebinding: validação pública, mas a conexão é FIXADA no IP aprovado (requisitar recebe o IP validado, nunca resolve de novo)', async () => {
  let resolucoes = 0; const conexoes = [];
  const resolver = async () => { resolucoes++; return resolucoes === 1 ? ['200.10.20.30'] : ['10.0.0.5']; };   // 2ª resolução "mudaria" para privado
  const requisitar = async (u, ip) => { conexoes.push({ host: u.hostname, ip }); return { status: 200 }; };
  const r = await sondarSite('https://alvo.com/', { resolver, requisitar });
  assert.deepEqual(r, { ok: true, noAr: true, status: 200, saltos: 0 });
  assert.equal(resolucoes, 1); assert.deepEqual(conexoes, [{ host: 'alvo.com', ip: '200.10.20.30' }]);
});

test('redirect para loopback/metadata/DNS privado é recusado ANTES de qualquer conexão privada; redirect público segue e revalida', async () => {
  const conexoes = [];
  const resolver = async (h) => (h === 'dns-privado.com' ? ['10.0.0.5'] : h === 'semdns.com' ? [] : ['200.10.20.30']);
  const requisitar = async (u, ip) => {
    conexoes.push(`${u.hostname}@${ip}`);
    if (u.hostname === 'redir-privado.com') return { status: 302, location: 'http://127.0.0.1:8080/admin' };
    if (u.hostname === 'redir-meta.com') return { status: 301, location: 'http://169.254.169.254/latest/meta-data' };
    if (u.hostname === 'redir-dns.com') return { status: 301, location: 'https://dns-privado.com/' };
    if (u.hostname === 'redir-ok.com') return { status: 301, location: 'https://www.redir-ok.com/home' };
    if (u.hostname === 'fora.com') return { status: 503 };
    if (u.hostname === 'loop.com') return { status: 302, location: 'https://loop.com/' };
    return { status: 200 };
  };
  assert.equal((await sondarSite('https://redir-privado.com/', { resolver, requisitar })).ok, false);
  assert.equal((await sondarSite('https://redir-meta.com/', { resolver, requisitar })).ok, false);
  assert.equal((await sondarSite('https://redir-dns.com/', { resolver, requisitar })).motivo, 'dns aponta para rede privada');
  assert.equal((await sondarSite('https://semdns.com/', { resolver, requisitar })).motivo, 'dns sem resposta');
  assert.equal((await sondarSite('ftp://x.com/', { resolver, requisitar })).ok, false);
  assert.equal((await sondarSite('https://loop.com/', { resolver, requisitar })).motivo, 'redirects demais');
  assert.deepEqual(await sondarSite('https://redir-ok.com/', { resolver, requisitar }), { ok: true, noAr: true, status: 200, saltos: 1 });
  assert.deepEqual(await sondarSite('https://fora.com/', { resolver, requisitar }), { ok: true, noAr: false, status: 503, saltos: 0 });
  assert.ok(!conexoes.some((c) => c.includes('127.0.0.1') || c.includes('169.254') || c.includes('10.0.0.5')));
  assert.ok(conexoes.includes('redir-ok.com@200.10.20.30') && conexoes.includes('www.redir-ok.com@200.10.20.30'));
});
