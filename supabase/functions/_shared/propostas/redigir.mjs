// Mascara segredos em texto que vai para log, banco ou resposta HTTP.
// Recebe os valores conhecidos (tokens/chaves em uso) e também mascara
// formatos comuns de credencial que um provedor possa ecoar no erro.
const PADROES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ya29\.[A-Za-z0-9._-]+/g,
  /1\/\/[A-Za-z0-9._-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g,
  /sb_secret_[A-Za-z0-9_-]{8,}/g,
];

export function redigir(texto, segredos = []) {
  let t = String(texto ?? '');
  for (const s of segredos) if (typeof s === 'string' && s.length >= 8) t = t.split(s).join('<omitido>');
  for (const p of PADROES) t = t.replace(p, '<omitido>');
  return t
    .replace(/(Bearer\s+)(?!<omitido>)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1<omitido>')
    .replace(/((?:api[_-]?key|access_token|refresh_token|key)["']?\s*[=:]\s*["']?)(?!<omitido>)[A-Za-z0-9._~+/-]{8,}/gi, '$1<omitido>');
}
