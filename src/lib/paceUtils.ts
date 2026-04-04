// Pace/Ritmo calculation utilities

export function getBusinessDaysInMonth(year: number, month: number): number {
  let count = 0;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

export function getBusinessDaysSoFar(year: number, month: number, today: number): number {
  let count = 0;
  for (let d = 1; d <= today; d++) {
    const day = new Date(year, month, d).getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

export function getPacePercentage(year: number, month: number, currentDay: number): number {
  const total = getBusinessDaysInMonth(year, month);
  const soFar = getBusinessDaysSoFar(year, month, currentDay);
  return total > 0 ? soFar / total : 0;
}

export interface PaceData {
  metaMrr: number;
  metaOt: number;
  metaReunioes: number;
  realizadoMrr: number;
  realizadoOt: number;
  realizadoReunioes: number;
  pacePercent: number;
  expectedMrr: number;
  expectedOt: number;
  expectedReunioes: number;
  gapMrr: number;
  gapOt: number;
  gapReunioes: number;
  mrrOnTrack: boolean;
  otOnTrack: boolean;
  reunioesOnTrack: boolean;
}

export function calculatePace(
  metaMrr: number, metaOt: number, metaReunioes: number,
  realizadoMrr: number, realizadoOt: number, realizadoReunioes: number,
  pacePercent: number
): PaceData {
  const expectedMrr = metaMrr * pacePercent;
  const expectedOt = metaOt * pacePercent;
  const expectedReunioes = Math.round(metaReunioes * pacePercent);

  return {
    metaMrr, metaOt, metaReunioes,
    realizadoMrr, realizadoOt, realizadoReunioes,
    pacePercent,
    expectedMrr, expectedOt, expectedReunioes,
    gapMrr: expectedMrr - realizadoMrr,
    gapOt: expectedOt - realizadoOt,
    gapReunioes: expectedReunioes - realizadoReunioes,
    mrrOnTrack: realizadoMrr >= expectedMrr,
    otOnTrack: realizadoOt >= expectedOt,
    reunioesOnTrack: realizadoReunioes >= expectedReunioes,
  };
}

// Generate daily pace line data for charts
export interface DailyPacePoint {
  day: number;
  label: string;
  expected: number;
  realizado: number | null; // null for future days
}

export function generateDailyPaceLine(
  year: number, month: number, meta: number, currentDay: number,
  dailyRealized: Record<number, number> // day -> cumulative value
): DailyPacePoint[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalBizDays = getBusinessDaysInMonth(year, month);
  const dailyRate = totalBizDays > 0 ? meta / totalBizDays : 0;

  const points: DailyPacePoint[] = [];
  let cumExpected = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay();
    const isBizDay = dow !== 0 && dow !== 6;
    if (isBizDay) cumExpected += dailyRate;

    points.push({
      day: d,
      label: String(d),
      expected: Math.round(cumExpected * 100) / 100,
      realizado: d <= currentDay ? (dailyRealized[d] || (d > 1 ? points[points.length - 2]?.realizado ?? 0 : 0)) : null,
    });
  }

  // Fill forward realized values
  let lastVal = 0;
  for (const p of points) {
    if (p.realizado !== null) {
      lastVal = p.realizado;
    } else if (p.day <= currentDay) {
      p.realizado = lastVal;
    }
  }

  return points;
}
