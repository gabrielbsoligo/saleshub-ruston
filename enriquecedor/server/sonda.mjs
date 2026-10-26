// sonda.mjs — sondagem HTTP(S) segura contra SSRF (Central de Cases: "site no ar").
// Por que aqui e não na edge: só em Node dá para CONECTAR no IP aprovado (option `lookup`) preservando
// Host e SNI (`servername`) — fecha a janela de DNS rebinding entre validar e conectar. Regras:
//   * só http(s); host público (sem localhost/.local/.internal/sem ponto; IP literal não pode ser privado);
//   * resolve A/AAAA, recusa se QUALQUER IP é privado/loopback/link-local/multicast; conecta no 1º IP aprovado;
//   * redirects seguidos MANUALMENTE (≤5), cada salto revalidado do zero (host, DNS, IP fixado);
//   * timeout por salto; devolve {ok:true, noAr:boolean, status, saltos} ou {ok:false, motivo} (não mede).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

// Faixas NÃO públicas via net.BlockList (normaliza formas IPv6 expandidas/comprimidas). IPv4-mapped (::ffff:a.b.c.d
// e a forma hexadecimal ::ffff:7f00:1) é NEGADO por inteiro: endereço IPv4 só é aceito como A record puro.
// Duas listas: as regras IPv6 incluem ::ffff:0:0/96 (IPv4-mapped), que o Node também aplicaria a QUALQUER IPv4
// numa lista única — por isso IPv4 é conferido só contra as faixas IPv4.
const BLOQUEIO4 = new net.BlockList();
for (const [cidr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) BLOQUEIO4.addSubnet(cidr, bits, 'ipv4');
const BLOQUEIO6 = new net.BlockList();
for (const [cidr, bits] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32]]) BLOQUEIO6.addSubnet(cidr, bits, 'ipv6');
export function ipPrivado(ip) {
  const limpo = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');   // sem colchetes/zone id
  const tipo = net.isIP(limpo);
  if (tipo === 4) return BLOQUEIO4.check(limpo, 'ipv4');
  if (tipo === 6) return BLOQUEIO6.check(limpo, 'ipv6');
  return true;   // não é IP válido: trata como não-público
}
export function hostPublico(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa') || !h.includes('.')) return false;
  if (net.isIP(h.replace(/^\[|\]$/g, ''))) return !ipPrivado(h);
  return true;
}

const resolverPadrao = async (host) => {
  const out = [];
  for (const fn of [() => dns.resolve4(host), () => dns.resolve6(host)]) { try { out.push(...(await fn())); } catch { /* sem registro */ } }
  return out;
};
// requisição com IP FIXADO: `lookup` devolve o IP aprovado (contrato do Node: com `all:true` devolve
// [{address, family}], senão (address, family)); `family` fixada e `autoSelectFamily:false` para o net não
// pedir outra coisa; `servername`/Host ficam com o hostname original (SNI e virtual host corretos).
export function opcoesRequisicao(u, ip, timeoutMs) {
  const family = net.isIP(ip) === 6 ? 6 : 4;
  return {
    protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'GET',
    headers: { host: u.host, 'user-agent': 'Mozilla/5.0 (compatible; SalesHub-Cases/1.0)', accept: 'text/html,*/*' },
    servername: u.hostname,
    family,
    autoSelectFamily: false,
    lookup: (_host, opts, cb) => {
      const quer = typeof opts === 'function' ? {} : (opts || {});
      const done = typeof opts === 'function' ? opts : cb;
      if (quer.all) return done(null, [{ address: ip, family }]);
      return done(null, ip, family);
    },
    timeout: timeoutMs,
  };
}
const requisitarPadrao = (u, ip, timeoutMs, request) => new Promise((resolve) => {
  const mod = u.protocol === 'https:' ? https : http;
  const fazer = request ?? mod.request.bind(mod);
  const req = fazer(opcoesRequisicao(u, ip, timeoutMs), (res) => { res.resume(); resolve({ status: res.statusCode || 0, location: res.headers.location || null }); });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (e) => resolve({ erro: String(e?.message || e).slice(0, 120) }));
  req.end();
});
export { requisitarPadrao };

/**
 * @param {string} url
 * @param {{resolver?: (host:string)=>Promise<string[]>, requisitar?: Function, saltos?: number, timeoutMs?: number}} deps
 */
export async function sondarSite(url, deps = {}) {
  const resolver = deps.resolver ?? resolverPadrao, requisitar = deps.requisitar ?? requisitarPadrao;
  const maxSaltos = deps.saltos ?? 5, timeoutMs = deps.timeoutMs ?? 8000;
  let atual = url;
  for (let i = 0; i <= maxSaltos; i++) {
    let u;
    try { u = new URL(atual); } catch { return { ok: false, motivo: 'url invalida' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, motivo: 'esquema nao permitido' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!hostPublico(host)) return { ok: false, motivo: 'host nao publico' };
    let ip;
    if (net.isIP(host)) ip = host;
    else {
      const ips = await resolver(host).catch(() => []);
      if (!ips.length) return { ok: false, motivo: 'dns sem resposta' };
      if (ips.some((x) => ipPrivado(x))) return { ok: false, motivo: 'dns aponta para rede privada' };
      ip = ips[0];                                   // conexão FIXADA neste IP (sem nova resolução)
    }
    const r = await requisitar(u, ip, timeoutMs);
    if (r.erro) return { ok: false, motivo: r.erro };
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) return { ok: false, motivo: 'redirect sem location' };
      try { atual = new URL(r.location, u).toString(); } catch { return { ok: false, motivo: 'redirect invalido' }; }
      continue;                                      // próximo salto: revalida host + DNS + IP do zero
    }
    return { ok: true, noAr: r.status < 400, status: r.status, saltos: i };
  }
  return { ok: false, motivo: 'redirects demais' };
}
