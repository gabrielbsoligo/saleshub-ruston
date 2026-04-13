// Pure date utilities for ISO date strings (YYYY-MM-DD).
// Keeps timezone math centralized to avoid +30d duplication and TZ drift.

export function addDays(iso: string | null | undefined, days: number): string | null {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export function monthRange(yearMonth: string): { start: string; end: string } {
  const [year, month] = yearMonth.split('-').map(Number);
  const start = `${yearMonth}-01`;
  const end = new Date(year, month, 0).toISOString().split('T')[0];
  return { start, end };
}

export function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function formatBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}
