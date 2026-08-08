// Validação/normalização dos dados da planilha. A Receita é a fonte de verdade
// (a consulta ao CNPJ acontece em cnpjService.ts); aqui ficam as checagens
// locais de formato que não dependem de rede.

export function onlyDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * Normaliza os dígitos do CNPJ, recuperando zeros à esquerda que o Excel come
 * ao salvar o CNPJ como número (ex.: "14161000134" -> "00014161000134").
 * Só completa quando o valor tem entre 8 e 13 dígitos; caso contrário devolve
 * como está (14 dígitos passam direto; lixo curto continua inválido).
 */
export function normalizeCnpjDigits(value: string | null | undefined): string {
  const d = onlyDigits(value);
  if (d.length >= 8 && d.length < 14) return d.padStart(14, '0');
  return d;
}

/** Valida CNPJ pelos dígitos verificadores. */
export function isValidCnpj(raw: string | null | undefined): boolean {
  const cnpj = onlyDigits(raw);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false; // todos iguais

  const calcDigit = (base: string) => {
    const weights =
      base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = base
      .split('')
      .reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  const base12 = cnpj.slice(0, 12);
  const d1 = calcDigit(base12);
  const d2 = calcDigit(base12 + d1);
  return cnpj.endsWith(`${d1}${d2}`);
}

export function formatCnpj(raw: string | null | undefined): string {
  const c = onlyDigits(raw);
  if (c.length !== 14) return raw ?? '';
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

export interface PhoneCheck {
  normalized: string | null; // E.164 parcial: 55DDDNUMERO
  valid: boolean;
  isMobile: boolean; // celular (potencial WhatsApp)
}

/** Valida telefone brasileiro e indica se é celular (candidato a WhatsApp). */
export function checkPhone(raw: string | null | undefined): PhoneCheck {
  let digits = onlyDigits(raw);
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);

  if (digits.length !== 10 && digits.length !== 11) {
    return { normalized: null, valid: false, isMobile: false };
  }
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) {
    return { normalized: null, valid: false, isMobile: false };
  }
  // Celular: 11 dígitos e o primeiro após o DDD é 9.
  const isMobile = digits.length === 11 && digits[2] === '9';
  return { normalized: `55${digits}`, valid: true, isMobile };
}

// Normaliza a faixa de faturamento para rótulos padrão.
export function normalizeRevenueBand(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const digits = v.replace(/[^\dkKmMbB]/gi, '');
  const lower = v.toLowerCase();
  if (/\bb\b|bi|bilh/.test(lower) || /b\+?$/i.test(digits)) return '1B+';
  const m = lower.match(/(\d+)\s*m/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100) return '100M+';
    if (n >= 50) return '50M+';
    if (n >= 10) return '10M+';
    if (n >= 1) return `${n}M+`;
  }
  if (/mil|\bk\b/.test(lower)) return '<1M';
  return v; // mantém o original se não reconhecer
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'tempmail.com',
  'guerrillamail.com',
  '10minutemail.com',
]);

export interface EmailCheck {
  normalized: string | null;
  valid: boolean;
  disposable: boolean;
  domain: string | null;
}

/** Valida sintaxe do e-mail (a checagem de MX fica no worker/serviço). */
export function checkEmail(raw: string | null | undefined): EmailCheck {
  const value = (raw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(value)) {
    return { normalized: null, valid: false, disposable: false, domain: null };
  }
  const domain = value.split('@')[1];
  return {
    normalized: value,
    valid: true,
    disposable: DISPOSABLE_DOMAINS.has(domain),
    domain,
  };
}
