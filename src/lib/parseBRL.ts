// =============================================================
// parseBRL — parser tolerante a valores monetarios em formato BR
// =============================================================
// Lida com:
//   "R$ 1.234,56" → 1234.56
//   "889,20"      → 889.20
//   "889.20"      → 889.20  (formato US/raw)
//   889           → 889     (numero direto)
//   "" / null     → null
//
// Necessario porque parseFloat puro nao funciona com formato BR:
//   parseFloat("889,20") = 889  (corta na virgula)
//   parseFloat("R$ 889") = NaN
//
// Retorna null quando vazio, nao parseavel ou <= 0 (sentinel).
// =============================================================

export function parseBRL(s: unknown): number | null {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) && s > 0 ? s : null;
  let str = String(s).trim().replace(/R\$\s*/gi, '').replace(/\s+/g, '');
  if (!str) return null;
  // Formato BR ("1.234,56") → "1234.56". Formato US/raw fica intacto.
  if (str.indexOf(',') >= 0) str = str.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(str);
  return isFinite(n) && n > 0 ? n : null;
}
