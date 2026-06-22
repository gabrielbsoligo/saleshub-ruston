import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { RefreshCw, Loader2, AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Check, X, HelpCircle, Clock, Video, MapPin, Users, User, Search } from "lucide-react";
import toast from "react-hot-toast";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { colorForMember } from "./HourlyCallsChart";
import { AgendarReuniaoModal } from "./AgendarReuniaoModal";
import { RoletaPanel } from "./RoletaPanel";
import { CANAL_LABELS, LEAD_STATUS_LABELS, type Lead, type Reuniao } from "../types";
import { queryTeamAvailability, type TeamAvailability, type PersonAvailability, type BusyBlock, type RsvpStatus } from "../lib/teamAvailability";

const TZ = "America/Sao_Paulo";
const PX_PER_HOUR = 48;
const SLOT_MIN = 30;
const SLOT_PX = PX_PER_HOUR * (SLOT_MIN / 60); // altura de um bloco de 30min
const SLOTS_PER_DAY = (24 * 60) / SLOT_MIN; // 48
const DAY_HEIGHT = 24 * PX_PER_HOUR;
const COL_MIN_WIDTH = 150;
const GUTTER_W = 52;

const STATUS_LABEL: Record<RsvpStatus, string> = {
  accepted: "Sim",
  declined: "Não",
  tentative: "Talvez",
  needsAction: "Pendente",
};

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

interface SelectedEvent {
  block: BusyBlock;
  personName: string;
  color: string;
}

// ---- modal de detalhes do evento (estilo card do Google Agenda) ----
const EventModal: React.FC<{ ev: SelectedEvent; onClose: () => void }> = ({ ev, onClose }) => {
  const b = ev.block;
  const yes = (b.attendees || []).filter((a) => a.responseStatus === "accepted").length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl p-5 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>

        <div className="flex items-start gap-3 pr-6">
          <span className="w-3.5 h-3.5 rounded-sm flex-shrink-0 mt-1.5" style={{ backgroundColor: ev.color }} />
          <div>
            <h3 className="text-lg font-semibold text-white leading-snug">{b.title || "(sem título)"}</h3>
            <p className="text-sm text-[var(--color-v4-text-muted)] mt-0.5">
              {b.all_day ? "Dia inteiro" : `${fmtTime(b.start)} – ${fmtTime(b.end)}`}
              {b.status && <span className="ml-2 inline-flex items-center gap-1">· {STATUS_ICON[b.status]} {STATUS_LABEL[b.status]}</span>}
            </p>
            <p className="text-xs text-[var(--color-v4-text-muted)]">Agenda de {ev.personName}</p>
          </div>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          {b.meet_link && (
            <a href={b.meet_link} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-[var(--color-v4-red)] hover:underline">
              <Video size={16} /> Entrar com o Google Meet
            </a>
          )}
          {b.location && (
            <div className="flex items-center gap-2 text-white"><MapPin size={16} className="text-[var(--color-v4-text-muted)]" /> {b.location}</div>
          )}
          {b.organizer && (
            <div className="flex items-center gap-2 text-white"><User size={16} className="text-[var(--color-v4-text-muted)]" /> {b.organizer.name || b.organizer.email} <span className="text-xs text-[var(--color-v4-text-muted)]">organizador</span></div>
          )}
          {b.attendees && b.attendees.length > 0 && (
            <div>
              <div className="flex items-center gap-2 text-white mb-1.5"><Users size={16} className="text-[var(--color-v4-text-muted)]" /> {b.attendees.length} convidado(s) · {yes} sim</div>
              <ul className="space-y-1 pl-6">
                {b.attendees.map((a) => (
                  <li key={a.email} className="flex items-center gap-1.5 text-xs">
                    <span className="text-[var(--color-v4-text-muted)]">{STATUS_ICON[a.responseStatus]}</span>
                    <span className="text-white truncate">{a.name || a.email}</span>
                    {a.organizer && <span className="text-[10px] text-[var(--color-v4-text-muted)]">(org)</span>}
                    <span className="text-[10px] text-[var(--color-v4-text-muted)] ml-auto">{STATUS_LABEL[a.responseStatus]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.description && (
            <p className="text-xs text-[var(--color-v4-text-muted)] whitespace-pre-wrap border-t border-[var(--color-v4-border)] pt-3">{b.description}</p>
          )}
          {b.html_link && (
            <a href={b.html_link} target="_blank" rel="noreferrer" className="inline-block text-xs text-[var(--color-v4-text-muted)] hover:text-white underline">Abrir no Google Agenda</a>
          )}
        </div>
      </div>
    </div>
  );
};

export const AgendasTimeView: React.FC = () => {
  const { members, leads, reunioes, addReuniao, rescheduleReuniao, currentUser } = useAppStore();

  const eligible = useMemo(() => members.filter((m) => m.active && m.email), [members]);
  const memberById = useMemo(() => {
    const map = new Map<string, (typeof members)[number]>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  // Padrão: somente closers (acelera o carregamento)
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    members.filter((m) => m.active && m.email && m.role === "closer").map((m) => m.id),
  );
  const [date, setDate] = useState<string>(todayISODate());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TeamAvailability | null>(null);
  const [selected, setSelected] = useState<SelectedEvent | null>(null);
  // bloco de 30min sob o cursor (destaque do que será selecionado ao clicar)
  const [hoverSlot, setHoverSlot] = useState<{ email: string; slot: number } | null>(null);

  // agendamento ao clicar num espaço livre
  const [scheduling, setScheduling] = useState<{ date: string; time: string; closerId: string } | null>(null);
  const [showLeadPicker, setShowLeadPicker] = useState(false);
  const [schedLead, setSchedLead] = useState<Lead | null>(null);
  const [leadSearch, setLeadSearch] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  // substituição: reagendar reunião ativa existente do lead
  const [pendingReschedule, setPendingReschedule] = useState<
    { existing: Reuniao; data_reuniao: string; closer_id: string; lead_email?: string; participantes_extras?: string[] } | null
  >(null);

  const cache = useRef<Map<string, TeamAvailability>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);

  const cacheKey = useMemo(() => `${date}|${[...selectedIds].sort().join(",")}`, [date, selectedIds]);

  // Ancorar o layout no dia do RESULTADO (evita blocos "fora de esquadro" ao trocar de dia
  // enquanto a nova consulta ainda não chegou)
  const dayStartMs = useMemo(
    () => (result ? new Date(result.timeMin).getTime() : new Date(`${date}T00:00:00-03:00`).getTime()),
    [result, date],
  );

  const load = useCallback(
    async (force = false) => {
      const selectedMembers = selectedIds.map((id) => memberById.get(id)).filter(Boolean) as typeof members;
      const emails = selectedMembers.map((m) => m.email).filter(Boolean) as string[];
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

  useEffect(() => {
    const t = setTimeout(() => { load(); }, 200);
    return () => clearTimeout(t);
  }, [load]);

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

  const openEvent = (p: PersonAvailability, b: BusyBlock, e: React.MouseEvent) => {
    e.stopPropagation();
    if (p.source === "freebusy" && !b.title) return; // freebusy sem detalhe
    setSelected({ block: b, personName: p.name || p.email, color: colorForPerson(p) });
  };

  const leadsDisponiveis = useMemo(
    () => leads.filter((l) =>
      !["perdido", "estorno", "convertido"].includes(l.status) &&
      (leadSearch ? l.empresa.toLowerCase().includes(leadSearch.toLowerCase()) : true),
    ),
    [leads, leadSearch],
  );

  // índice do bloco de 30min sob o cursor (0..47)
  const slotFromEvent = (e: React.MouseEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = Math.floor((e.clientY - rect.top) / SLOT_PX);
    return Math.max(0, Math.min(slot, SLOTS_PER_DAY - 1));
  };

  // clique num espaço livre -> abre fluxo de agendamento com horário/closer pré-preenchidos
  const onSlotClick = (p: PersonAvailability, e: React.MouseEvent<HTMLDivElement>) => {
    const totalMin = slotFromEvent(e) * SLOT_MIN;
    const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    const m = p.member_id ? memberById.get(p.member_id) : undefined;
    const closerId = m && (m.role === "closer" || m.role === "gestor") ? m.id : "";
    setScheduling({ date, time: `${hh}:${mm}`, closerId });
    setSchedLead(null);
    setLeadSearch("");
    setShowLeadPicker(true);
  };

  const handleAgendarConfirm = async (dataReuniaoISO: string, closerId: string, participantesExtras?: string[], leadEmail?: string) => {
    if (!schedLead || isProcessing) return;
    setIsProcessing(true);
    try {
      await addReuniao({
        lead_id: schedLead.id, empresa: schedLead.empresa,
        nome_contato: schedLead.nome_contato || undefined, canal: schedLead.canal,
        sdr_id: schedLead.sdr_id || currentUser?.id || undefined, closer_id: closerId || undefined,
        kommo_id: schedLead.kommo_id || undefined,
        data_agendamento: new Date().toISOString().split("T")[0], data_reuniao: dataReuniaoISO,
        participantes_extras: participantesExtras || undefined, lead_email: leadEmail || undefined,
      } as any);
      setSchedLead(null); setScheduling(null);
      cache.current.delete(cacheKey); // invalida o dia para mostrar o novo evento
      load(true);
    } catch (err: any) {
      if (err.message === "REUNIAO_ATIVA_EXISTENTE") {
        // lead já tem reunião ativa → abre substituição (reagendamento da existente)
        const existing = reunioes.find((re) => re.lead_id === schedLead.id && !re.realizada && re.tipo !== "retorno");
        if (existing) {
          setPendingReschedule({ existing, data_reuniao: dataReuniaoISO, closer_id: closerId, lead_email: leadEmail, participantes_extras: participantesExtras });
          setSchedLead(null); // fecha o modal de agendar; abre o de substituição
        } else {
          toast.error("Reunião ativa existente não encontrada.");
        }
      } else {
        toast.error(err.message || "Falha ao agendar reunião");
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReplaceConfirm = async () => {
    if (!pendingReschedule || isProcessing) return;
    setIsProcessing(true);
    try {
      await rescheduleReuniao(pendingReschedule.existing, {
        data_reuniao: pendingReschedule.data_reuniao,
        closer_id: pendingReschedule.closer_id || undefined,
        lead_email: pendingReschedule.lead_email,
        participantes_extras: pendingReschedule.participantes_extras,
      });
      setPendingReschedule(null);
      setScheduling(null);
      cache.current.delete(cacheKey);
      load(true);
    } catch (err: any) {
      toast.error(err.message || "Falha ao reagendar reunião");
    } finally {
      setIsProcessing(false);
    }
  };

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

      {/* Indicador do rodízio de closers */}
      <RoletaPanel />

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
                        <div key={i} onClick={(e) => openEvent(p, b, e)} className="text-[10px] px-1.5 py-0.5 rounded truncate cursor-pointer" style={blockStyle(colorForPerson(p), b.status)} title={b.title}>
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
                  const timed = layoutTimed(p.busy.filter((b) => !b.all_day), dayStartMs);
                  return (
                    <div
                      key={p.email}
                      onClick={(e) => onSlotClick(p, e)}
                      onMouseMove={(e) => setHoverSlot({ email: p.email, slot: slotFromEvent(e) })}
                      onMouseLeave={() => setHoverSlot((h) => (h?.email === p.email ? null : h))}
                      title="Clique num espaço livre para agendar"
                      className="flex-1 min-w-[150px] relative border-l border-[var(--color-v4-border)] cursor-pointer"
                    >
                      {hours.map((h) => (
                        <div key={h} className="absolute left-0 right-0 border-t border-[var(--color-v4-border)]/30 pointer-events-none" style={{ top: h * PX_PER_HOUR }} />
                      ))}

                      {/* destaque do bloco de 1h (duração da reunião); início snap de 30min */}
                      {hoverSlot?.email === p.email && (() => {
                        const startMin = hoverSlot.slot * SLOT_MIN;
                        const endMin = startMin + 60;
                        const fmt = (min: number) => `${String(Math.floor((min % 1440) / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
                        const top = Math.min(hoverSlot.slot * SLOT_PX, DAY_HEIGHT - PX_PER_HOUR);
                        return (
                          <div
                            className="absolute left-0.5 right-0.5 rounded-sm bg-[var(--color-v4-red)]/20 border border-[var(--color-v4-red)]/50 pointer-events-none z-[5] flex items-start justify-end px-1"
                            style={{ top, height: PX_PER_HOUR }}
                          >
                            <span className="text-[8px] text-white/80 leading-tight mt-0.5">{fmt(startMin)}–{fmt(endMin)}</span>
                          </div>
                        );
                      })()}

                      {p.error ? (
                        <div className="absolute inset-x-0 top-1/3 flex items-center justify-center text-center px-1 pointer-events-none">
                          <span className="text-[10px] text-amber-400/80 flex items-center gap-1"><AlertTriangle size={11} /> sem acesso ao free/busy</span>
                        </div>
                      ) : (
                        timed.map((b, i) => (
                          <div
                            key={i}
                            onClick={(e) => openEvent(p, b, e)}
                            className="absolute rounded px-1 py-0.5 overflow-hidden shadow-sm cursor-pointer hover:brightness-110 hover:z-10 transition-[filter]"
                            style={{ top: b.top, height: b.height, left: `calc(${b.leftPct}% + 1px)`, width: `calc(${b.widthPct}% - 2px)`, ...blockStyle(colorForPerson(p), b.status) }}
                            title={`${b.title ? b.title + " · " : ""}${fmtTime(b.start)}–${fmtTime(b.end)}`}
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

      {selected && <EventModal ev={selected} onClose={() => setSelected(null)} />}

      {/* Seletor de lead (mesmo fluxo da tela de Reuniões) */}
      {showLeadPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setShowLeadPicker(false); setScheduling(null); }} />
          <div className="relative w-full max-w-md bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl overflow-hidden max-h-[80vh] flex flex-col">
            <div className="px-5 py-4 border-b border-[var(--color-v4-border)] flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">Selecionar Lead</h3>
                {scheduling && <p className="text-xs text-[var(--color-v4-text-muted)]">{formatDayLabel(scheduling.date)} · {scheduling.time}</p>}
              </div>
              <button onClick={() => { setShowLeadPicker(false); setScheduling(null); }} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
            </div>
            <div className="p-3 border-b border-[var(--color-v4-border)]">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-v4-text-muted)]" />
                <input className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm" placeholder="Buscar lead..." value={leadSearch} onChange={(e) => setLeadSearch(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              {leadsDisponiveis.slice(0, 30).map((l) => (
                <button key={l.id} onClick={() => { setSchedLead(l); setShowLeadPicker(false); setLeadSearch(""); }}
                  className="w-full text-left px-4 py-3 hover:bg-[var(--color-v4-card-hover)] border-b border-[var(--color-v4-border)] last:border-0 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm text-white font-medium">{l.empresa}</span>
                      <p className="text-xs text-[var(--color-v4-text-muted)]">{l.nome_contato || "—"} · {CANAL_LABELS[l.canal]}</p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]">{LEAD_STATUS_LABELS[l.status]}</span>
                  </div>
                </button>
              ))}
              {leadsDisponiveis.length === 0 && <p className="text-sm text-[var(--color-v4-text-muted)] text-center py-8">Nenhum lead encontrado</p>}
            </div>
          </div>
        </div>
      )}

      {schedLead && scheduling && (
        <AgendarReuniaoModal
          lead={schedLead}
          initialDate={scheduling.date}
          initialTime={scheduling.time}
          initialCloserId={scheduling.closerId}
          onConfirm={handleAgendarConfirm}
          onClose={() => { setSchedLead(null); setScheduling(null); }}
        />
      )}

      {/* Substituição: reagendar a reunião ativa existente do lead */}
      {pendingReschedule && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setPendingReschedule(null); setScheduling(null); }} />
          <div className="relative w-full max-w-sm bg-[var(--color-v4-card)] border border-yellow-500/30 rounded-2xl shadow-2xl p-6">
            <h3 className="text-sm font-bold text-yellow-400 mb-1">Reunião já existente</h3>
            <p className="text-xs text-[var(--color-v4-text-muted)] mb-4">
              Este lead já tem uma reunião ativa. Deseja <strong className="text-white">reagendá-la</strong> para o novo horário? A reunião atual será movida (sem deixar evento duplicado).
            </p>
            <div className="space-y-2 mb-5 text-sm">
              <div className="flex items-center justify-between bg-[var(--color-v4-surface)] rounded-lg px-3 py-2">
                <span className="text-[var(--color-v4-text-muted)] text-xs">De</span>
                <span className="text-white line-through opacity-70">
                  {pendingReschedule.existing.data_reuniao ? new Date(pendingReschedule.existing.data_reuniao).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                <span className="text-emerald-300/80 text-xs">Para</span>
                <span className="text-emerald-300 font-medium">
                  {new Date(pendingReschedule.data_reuniao).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TZ })}
                </span>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setPendingReschedule(null); setScheduling(null); }}
                className="flex-1 py-2.5 rounded-xl border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] text-sm">Cancelar</button>
              <button onClick={handleReplaceConfirm} disabled={isProcessing}
                className="flex-1 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400 disabled:opacity-30 text-black font-bold text-sm">{isProcessing ? "Reagendando..." : "Reagendar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
