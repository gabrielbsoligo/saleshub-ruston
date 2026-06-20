import React, { useState, useMemo, useCallback } from "react";
import { useAppStore } from "../store";
import { RefreshCw, Loader2, AlertTriangle, CalendarClock, Lock } from "lucide-react";
import toast from "react-hot-toast";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { DateInput } from "./ui/DateInput";
import { colorForMember } from "./HourlyCallsChart";
import { queryTeamAvailability, type TeamAvailability, type PersonAvailability } from "../lib/teamAvailability";

const TZ = "America/Sao_Paulo";
const START_HOUR = 7;
const END_HOUR = 21;
const PX_PER_HOUR = 56;

function todayISODate(): string {
  // YYYY-MM-DD no fuso de São Paulo
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts; // en-CA já entrega YYYY-MM-DD
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export const AgendasTimeView: React.FC = () => {
  const { members } = useAppStore();

  // Membros elegíveis: ativos e com e-mail
  const eligible = useMemo(
    () => members.filter((m) => m.active && m.email),
    [members],
  );

  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    members.filter((m) => m.active && m.email && m.google_calendar_connected).map((m) => m.id),
  );
  const [date, setDate] = useState<string>(todayISODate());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TeamAvailability | null>(null);

  const memberById = useMemo(() => {
    const map = new Map<string, (typeof members)[number]>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const windowStart = useMemo(() => new Date(`${date}T${String(START_HOUR).padStart(2, "0")}:00:00-03:00`), [date]);
  const windowEnd = useMemo(() => new Date(`${date}T${String(END_HOUR).padStart(2, "0")}:00:00-03:00`), [date]);
  const totalHeight = (END_HOUR - START_HOUR) * PX_PER_HOUR;

  const consultar = useCallback(async () => {
    const selected = selectedIds.map((id) => memberById.get(id)).filter(Boolean) as (typeof members);
    const emails = selected.map((m) => m.email).filter(Boolean) as string[];
    if (!emails.length) {
      toast.error("Selecione ao menos um membro com e-mail.");
      return;
    }
    setLoading(true);
    try {
      const data = await queryTeamAvailability({
        emails,
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: TZ,
      });
      setResult(data);
      const withErr = data.people.filter((p) => p.error);
      if (withErr.length) {
        toast(`${withErr.length} agenda(s) sem acesso ao free/busy.`, { icon: "⚠️" });
      }
    } catch (e: any) {
      toast.error(e.message || "Falha ao consultar agendas");
    } finally {
      setLoading(false);
    }
  }, [selectedIds, memberById, windowStart, windowEnd]);

  const hours = useMemo(() => {
    const arr: number[] = [];
    for (let h = START_HOUR; h <= END_HOUR; h++) arr.push(h);
    return arr;
  }, []);

  const blockGeom = useCallback(
    (startISO: string, endISO: string) => {
      const ws = windowStart.getTime();
      const we = windowEnd.getTime();
      const s = Math.max(new Date(startISO).getTime(), ws);
      const e = Math.min(new Date(endISO).getTime(), we);
      if (e <= s) return null;
      const top = ((s - ws) / 3_600_000) * PX_PER_HOUR;
      const height = Math.max(((e - s) / 3_600_000) * PX_PER_HOUR, 16);
      return { top, height };
    },
    [windowStart, windowEnd],
  );

  const colorForPerson = useCallback(
    (p: PersonAvailability): string => {
      const m = p.member_id ? memberById.get(p.member_id) : undefined;
      if (m) return colorForMember(m);
      return "#6b7280"; // gray-500 para externos (freebusy)
    },
    [memberById],
  );

  const memberOptions = useMemo(
    () => eligible.map((m) => ({ value: m.id, label: m.name + (m.google_calendar_connected ? "" : " (sem Calendar)") })),
    [eligible],
  );

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center gap-3">
        <CalendarClock className="text-[var(--color-v4-red)]" size={24} />
        <div>
          <h1 className="text-xl font-display font-bold text-white">Agendas do Time</h1>
          <p className="text-xs text-[var(--color-v4-text-muted)]">Disponibilidade e janelas livres em comum</p>
        </div>
      </div>

      {/* Controles */}
      <div className="flex flex-wrap items-end gap-3 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
        <div>
          <label className="block text-xs font-medium text-[var(--color-v4-text-muted)] mb-1">Membros</label>
          <MultiSelectFilter options={memberOptions} selected={selectedIds} onChange={setSelectedIds} placeholder="Selecionar membros" />
        </div>
        <DateInput label="Dia" value={date} onChange={setDate} />
        <button
          onClick={consultar}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Consultar
        </button>
      </div>

      {/* Janelas livres em comum */}
      {result && (
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4">
          <h2 className="text-sm font-semibold text-white mb-2">Janelas livres em comum</h2>
          {result.common_free.length === 0 ? (
            <p className="text-xs text-[var(--color-v4-text-muted)]">Nenhum horário livre comum no intervalo.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {result.common_free.map((w, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium">
                  {fmtTime(w.start)} – {fmtTime(w.end)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timeline */}
      {result && result.people.length > 0 && (
        <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 overflow-x-auto">
          <div className="flex min-w-max">
            {/* Coluna de horas */}
            <div className="flex-shrink-0 w-14" style={{ paddingTop: 28 }}>
              {hours.map((h) => (
                <div key={h} className="text-[10px] text-[var(--color-v4-text-muted)] text-right pr-2 -translate-y-1.5" style={{ height: h === END_HOUR ? 0 : PX_PER_HOUR }}>
                  {String(h).padStart(2, "0")}h
                </div>
              ))}
            </div>

            {/* Colunas por pessoa */}
            {result.people.map((p) => (
              <div key={p.email} className="flex-1 min-w-[140px] px-1">
                {/* Cabeçalho da pessoa */}
                <div className="h-7 flex items-center gap-1.5 mb-0">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: colorForPerson(p) }} />
                  <span className="text-xs text-white truncate" title={p.name || p.email}>{p.name || p.email}</span>
                  {p.error ? (
                    <Lock size={11} className="text-amber-400 flex-shrink-0" />
                  ) : p.source === "freebusy" ? (
                    <span className="text-[9px] text-[var(--color-v4-text-muted)]">livre/ocupado</span>
                  ) : null}
                </div>

                {/* Trilha */}
                <div className="relative border-l border-[var(--color-v4-border)]" style={{ height: totalHeight }}>
                  {/* Gridlines */}
                  {hours.slice(0, -1).map((h, idx) => (
                    <div key={h} className="absolute left-0 right-0 border-t border-[var(--color-v4-border)]/40" style={{ top: idx * PX_PER_HOUR }} />
                  ))}

                  {/* Erro de acesso */}
                  {p.error && (
                    <div className="absolute inset-0 flex items-center justify-center text-center px-1">
                      <span className="text-[10px] text-amber-400/80 flex items-center gap-1">
                        <AlertTriangle size={11} /> sem acesso ao free/busy
                      </span>
                    </div>
                  )}

                  {/* Blocos ocupados */}
                  {!p.error &&
                    p.busy.map((b, i) => {
                      const geom = blockGeom(b.start, b.end);
                      if (!geom) return null;
                      return (
                        <div
                          key={i}
                          className="absolute left-0.5 right-0.5 rounded px-1 py-0.5 overflow-hidden text-white shadow-sm"
                          style={{ top: geom.top, height: geom.height, backgroundColor: colorForPerson(p) }}
                          title={`${b.title ? b.title + " · " : ""}${fmtTime(b.start)}–${fmtTime(b.end)}`}
                        >
                          <div className="text-[9px] leading-tight font-medium truncate">{fmtTime(b.start)}</div>
                          {b.title && geom.height > 28 && <div className="text-[9px] leading-tight truncate opacity-90">{b.title}</div>}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && (
        <p className="text-sm text-[var(--color-v4-text-muted)]">Selecione os membros e o dia, depois clique em <strong>Consultar</strong>.</p>
      )}
    </div>
  );
};
