import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { RefreshCw, Loader2, AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Check, X, HelpCircle, Clock } from "lucide-react";
import toast from "react-hot-toast";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { colorForMember } from "./HourlyCallsChart";
import { queryTeamAvailability, type TeamAvailability, type PersonAvailability, type BusyBlock, type RsvpStatus } from "../lib/teamAvailability";

const TZ = "America/Sao_Paulo";
const PX_PER_HOUR = 48;
const DAY_HEIGHT = 24 * PX_PER_HOUR;
const COL_MIN_WIDTH = 150;
const GUTTER_W = 52;

// ---- helpers de data (YYYY-MM-DD, sem drift de fuso) ----
function todayISODate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function addDays(isoDate: string, delta: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function formatDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const s = dt.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

// ---- layout de eventos sobrepostos (colunas lado a lado) ----
interface LaidOutBlock extends BusyBlock {
  top: number;
  height: number;
  leftPct: number;
  widthPct: number;
}
function layoutTimed(blocks: BusyBlock[], dayStartMs: number): LaidOutBlock[] {
  const evs = blocks
    .map((b) => ({ ...b, _s: new Date(b.start).getTime(), _e: new Date(b.end).getTime() }))
    .filter((b) => b._e > b._s)
    .sort((a, b) => a._s - b._s || a._e - b._e);

  const out: any[] = [];
  let cluster: any[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const cols: number[] = [];
    for (const ev of cluster) {
      let placed = false;
      for (let i = 0; i < cols.length; i++) {
        if (ev._s >= cols[i]) { ev._col = i; cols[i] = ev._e; placed = true; break; }
      }
      if (!placed) { ev._col = cols.length; cols.push(ev._e); }
    }
    for (const ev of cluster) ev._ncol = cols.length;
    out.push(...cluster);
    cluster = [];
    clusterEnd = -Infinity;
  };
  for (const ev of evs) {
    if (cluster.length && ev._s >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev._e);
  }
  if (cluster.length) flush();

  return out.map((ev) => {
    const top = Math.max(((ev._s - dayStartMs) / 3_600_000) * PX_PER_HOUR, 0);
    const rawH = ((ev._e - ev._s) / 3_600_000) * PX_PER_HOUR;
    const height = Math.min(Math.max(rawH, 15), DAY_HEIGHT - top);
    const widthPct = 100 / ev._ncol;
    return { ...ev, top, height, widthPct, leftPct: widthPct * ev._col };
  });
}

// ---- estilo por status de RSVP (igual Google Agenda) ----
function blockStyle(color: string, status?: RsvpStatus): React.CSSProperties {
  switch (status) {
    case "declined":
      return { background: "transparent", border: `1px solid ${color}`, color, opacity: 0.55, textDecoration: "line-through" };
    case "tentative":
      return { backgroundImage: `repeating-linear-gradient(45deg, ${color}, ${color} 5px, ${color}66 5px, ${color}66 10px)`, color: "#fff" };
    case "needsAction":
      return { background: "transparent", border: `1.5px dashed ${color}`, color };
    default:
      return { background: color, color: "#fff" };
  }
}
const STATUS_ICON: Record<RsvpStatus, React.ReactNode> = {
  accepted: <Check size={10} />,
  declined: <X size={10} />,
  tentative: <HelpCircle size={10} />,
  needsAction: <Clock size={10} />,
};

export const AgendasTimeView: React.FC = () => {
  const { members } = useAppStore();

  const eligible = useMemo(() => members.filter((m) => m.active && m.email), [members]);
  const memberById = useMemo(() => {
    const map = new Map<string, (typeof members)[number]>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    members.filter((m) => m.active && m.email && m.google_calendar_connected).map((m) => m.id),
  );
  const [date, setDate] = useState<string>(todayISODate());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TeamAvailability | null>(null);

  // cache em memória: evita recarregar dias já vistos (navegação instantânea)
  const cache = useRef<Map<string, TeamAvailability>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);

  const windowStart = useMemo(() => new Date(`${date}T00:00:00-03:00`), [date]);
  const windowStartMs = windowStart.getTime();

  const cacheKey = useMemo(() => `${date}|${[...selectedIds].sort().join(",")}`, [date, selectedIds]);

  const load = useCallback(
    async (force = false) => {
      const selected = selectedIds.map((id) => memberById.get(id)).filter(Boolean) as typeof members;
      const emails = selected.map((m) => m.email).filter(Boolean) as string[];
      if (!emails.length) { setResult(null); return; }

      if (!force && cache.current.has(cacheKey)) {
        setResult(cache.current.get(cacheKey)!);
        return;
      }
      setLoading(true);
      try {
        const data = await queryTeamAvailability({
          emails,
          timeMin: new Date(`${date}T00:00:00-03:00`).toISOString(),
          timeMax: new Date(`${date}T23:59:59-03:00`).toISOString(),
          timeZone: TZ,
        });
        cache.current.set(cacheKey, data);
        setResult(data);
        const withErr = data.people.filter((p) => p.error);
        if (withErr.length) toast(`${withErr.length} agenda(s) sem acesso ao free/busy.`, { icon: "⚠️" });
      } catch (e: any) {
        toast.error(e.message || "Falha ao consultar agendas");
      } finally {
        setLoading(false);
      }
    },
    [selectedIds, memberById, cacheKey, date],
  );

  // auto-load (debounce) ao mudar dia/membros
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
  }, [load]);

  // scroll inicial para ~7h
  useEffect(() => {
    if (result && scrollRef.current && !didInitialScroll.current) {
      scrollRef.current.scrollTop = 7 * PX_PER_HOUR;
      didInitialScroll.current = true;
    }
  }, [result]);

  const colorForPerson = useCallback(
    (p: PersonAvailability): string => {
      const m = p.member_id ? memberById.get(p.member_id) : undefined;
      return m ? colorForMember(m) : "#6b7280";
    },
    [memberById],
  );

  const memberOptions = useMemo(
    () => eligible.map((m) => ({ value: m.id, label: m.name + (m.google_calendar_connected ? "" : " (sem Calendar)") })),
    [eligible],
  );

  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const people = result?.people ?? [];
  const isToday = date === todayISODate();

  return (
    <div className="p-6 flex flex-col h-full">
      {/* Cabeçalho + navegação */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <CalendarClock className="text-[var(--color-v4-red)]" size={24} />
        <div className="mr-2">
          <h1 className="text-xl font-display font-bold text-white leading-tight">Agendas do Time</h1>
          <p className="text-xs text-[var(--color-v4-text-muted)]">Disponibilidade e janelas livres em comum</p>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => setDate((d) => addDays(d, -1))} className="p-2 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white hover:bg-[var(--color-v4-card-hover)] transition-colors" title="Dia anterior">
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => setDate(todayISODate())} disabled={isToday}
            className="px-3 py-2 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white text-sm hover:bg-[var(--color-v4-card-hover)] disabled:opacity-40 transition-colors">
            Hoje
          </button>
          <button onClick={() => setDate((d) => addDays(d, 1))} className="p-2 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white hover:bg-[var(--color-v4-card-hover)] transition-colors" title="Próximo dia">
            <ChevronRight size={16} />
          </button>
        </div>

        <span className="text-sm font-medium text-white min-w-[180px]">{formatDayLabel(date)}</span>

        <div className="ml-auto flex items-center gap-2">
          <MultiSelectFilter options={memberOptions} selected={selectedIds} onChange={setSelectedIds} placeholder="Membros" />
          <button onClick={() => load(true)} disabled={loading} className="p-2 rounded-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] text-white hover:bg-[var(--color-v4-card-hover)] disabled:opacity-50 transition-colors" title="Recarregar">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
      </div>

      {/* Janelas livres + legenda */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-white">Livres em comum:</span>
          {!result ? (
            <span className="text-xs text-[var(--color-v4-text-muted)]">—</span>
          ) : result.common_free.length === 0 ? (
            <span className="text-xs text-[var(--color-v4-text-muted)]">nenhuma janela livre</span>
          ) : (
            result.common_free
              .filter((w) => new Date(w.end).getTime() - new Date(w.start).getTime() >= 15 * 60000)
              .map((w, i) => (
                <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-medium">
                  {fmtTime(w.start)}–{fmtTime(w.end)}
                </span>
              ))
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 text-[10px] text-[var(--color-v4-text-muted)]">
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-[var(--color-v4-text-muted)]" />aceito</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm" style={{ backgroundImage: "repeating-linear-gradient(45deg,#9ca3af,#9ca3af 3px,#9ca3af66 3px,#9ca3af66 6px)" }} />talvez</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm border border-dashed border-[var(--color-v4-text-muted)]" />pendente</span>
          <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-sm border border-[var(--color-v4-text-muted)] line-through" />recusado</span>
        </div>
      </div>

      {/* Timeline */}
      {people.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-v4-text-muted)]">
          {loading ? <Loader2 className="animate-spin" /> : "Selecione membros para ver as agendas."}
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl overflow-hidden">
          {loading && (
            <div className="absolute top-2 right-2 z-30 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 text-white text-[11px]">
              <Loader2 size={12} className="animate-spin" /> atualizando
            </div>
          )}
          <div ref={scrollRef} className="h-full overflow-auto">
            <div style={{ minWidth: GUTTER_W + people.length * COL_MIN_WIDTH }}>
              {/* Cabeçalho de pessoas (sticky) */}
              <div className="sticky top-0 z-20 flex bg-[var(--color-v4-card)] border-b border-[var(--color-v4-border)]">
                <div style={{ width: GUTTER_W }} className="flex-shrink-0" />
                {people.map((p) => (
                  <div key={p.email} className="flex-1 min-w-[150px] px-2 py-2 border-l border-[var(--color-v4-border)]">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: colorForPerson(p) }} />
                      <span className="text-xs font-medium text-white truncate" title={p.name || p.email}>{p.name || p.email}</span>
                    </div>
                    {p.source === "freebusy" && !p.error && <span className="text-[9px] text-[var(--color-v4-text-muted)]">livre/ocupado</span>}
                    {p.error && <span className="text-[9px] text-amber-400 inline-flex items-center gap-0.5"><AlertTriangle size={9} />sem acesso</span>}
                  </div>
                ))}
              </div>

              {/* Faixa de dia inteiro */}
              {people.some((p) => p.busy.some((b) => b.all_day)) && (
                <div className="flex border-b border-[var(--color-v4-border)] bg-[var(--color-v4-bg)]/40">
                  <div style={{ width: GUTTER_W }} className="flex-shrink-0 text-[9px] text-[var(--color-v4-text-muted)] text-right pr-1.5 pt-1.5">dia<br/>todo</div>
                  {people.map((p) => (
                    <div key={p.email} className="flex-1 min-w-[150px] px-1 py-1 border-l border-[var(--color-v4-border)] space-y-0.5">
                      {p.busy.filter((b) => b.all_day).map((b, i) => (
                        <div key={i} className="text-[10px] px-1.5 py-0.5 rounded truncate" style={blockStyle(colorForPerson(p), b.status)} title={b.title}>
                          {b.title}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* Grade horária */}
              <div className="flex" style={{ height: DAY_HEIGHT }}>
                {/* Gutter de horas */}
                <div style={{ width: GUTTER_W }} className="flex-shrink-0 relative">
                  {hours.map((h) => (
                    <div key={h} className="absolute right-1.5 text-[10px] text-[var(--color-v4-text-muted)] -translate-y-1.5" style={{ top: h * PX_PER_HOUR }}>
                      {h === 0 ? "" : `${String(h).padStart(2, "0")}h`}
                    </div>
                  ))}
                </div>

                {/* Colunas por pessoa */}
                {people.map((p) => {
                  const timed = layoutTimed(p.busy.filter((b) => !b.all_day), windowStartMs);
                  return (
                    <div key={p.email} className="flex-1 min-w-[150px] relative border-l border-[var(--color-v4-border)]">
                      {/* linhas de hora */}
                      {hours.map((h) => (
                        <div key={h} className="absolute left-0 right-0 border-t border-[var(--color-v4-border)]/30" style={{ top: h * PX_PER_HOUR }} />
                      ))}

                      {p.error ? (
                        <div className="absolute inset-x-0 top-1/3 flex items-center justify-center text-center px-1">
                          <span className="text-[10px] text-amber-400/80 flex items-center gap-1"><AlertTriangle size={11} /> sem acesso ao free/busy</span>
                        </div>
                      ) : (
                        timed.map((b, i) => (
                          <div
                            key={i}
                            className="absolute rounded px-1 py-0.5 overflow-hidden shadow-sm"
                            style={{ top: b.top, height: b.height, left: `calc(${b.leftPct}% + 1px)`, width: `calc(${b.widthPct}% - 2px)`, ...blockStyle(colorForPerson(p), b.status) }}
                            title={`${b.title ? b.title + " · " : ""}${fmtTime(b.start)}–${fmtTime(b.end)}${b.status ? ` · ${b.status}` : ""}`}
                          >
                            <div className="flex items-center gap-0.5 text-[9px] leading-tight font-medium">
                              {b.status && b.status !== "accepted" && STATUS_ICON[b.status]}
                              <span className="truncate">{fmtTime(b.start)}</span>
                            </div>
                            {b.title && b.height > 26 && <div className="text-[9px] leading-tight truncate opacity-90">{b.title}</div>}
                          </div>
                        ))
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
