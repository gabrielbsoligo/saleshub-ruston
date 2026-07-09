import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { MultiSelectFilter } from "./ui/MultiSelect";
import { colorForMember } from "./HourlyCallsChart";
import { Activity, X, ExternalLink, Phone, Link2, CalendarCheck, Video, FileText, FileSignature, Trophy } from "lucide-react";

const KOMMO = "https://financeirorustonengenhariacombr.kommo.com";
const CANAIS = ["leadbroker", "blackbox", "outbound", "recovery", "recomendacao", "indicacao", "sem origem"];
type Preset = "hoje" | "7d" | "30d" | "custom";
const iso = (d: Date) => d.toISOString().slice(0, 10);

// etapa: chave RPC + label + fonte (sdr|closer) + cor + ícone
const STAGES = [
  { k: "recebidos", label: "Recebidos", src: "sdr", color: "#3b82f6", Icon: Phone },
  { k: "conexao", label: "Conexão", src: "sdr", color: "#06b6d4", Icon: Link2, noCanal: true },
  { k: "agendados", label: "Agendados", src: "sdr", color: "#8b5cf6", Icon: CalendarCheck },
  { k: "realizados", label: "Realizados", src: "sdr", color: "#a855f7", Icon: Video },
  { k: "proposta", label: "Proposta", src: "closer", color: "#f59e0b", Icon: FileText },
  { k: "contrato", label: "Contrato", src: "closer", color: "#f97316", Icon: FileSignature },
  { k: "fechados", label: "Fechados", src: "closer", color: "#10b981", Icon: Trophy },
] as const;

export const GeralView: React.FC = () => {
  const { members } = useAppStore();
  const active = useMemo(() => members.filter(m => m.active), [members]);
  const sdrsSet = useMemo(() => new Set(active.filter(m => m.role === "sdr").map(m => m.id)), [active]);
  const closersSet = useMemo(() => new Set(active.filter(m => m.role === "closer").map(m => m.id)), [active]);

  const [preset, setPreset] = useState<Preset>("30d");
  const [cFrom, setCFrom] = useState(iso(new Date(Date.now() - 29 * 864e5)));
  const [cTo, setCTo] = useState(iso(new Date()));
  const [selCanais, setSelCanais] = useState<string[]>([]);
  const [selUsers, setSelUsers] = useState<string[]>([]);
  const [tot, setTot] = useState<any>(null);
  const [canal, setCanal] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [popup, setPopup] = useState<{ stage: string; label: string } | null>(null);
  const [popupRows, setPopupRows] = useState<any[]>([]);
  const [popupLoading, setPopupLoading] = useState(false);

  const [from, to] = useMemo(() => {
    const t = new Date();
    if (preset === "hoje") return [iso(t), iso(t)];
    if (preset === "7d") return [iso(new Date(Date.now() - 6 * 864e5)), iso(t)];
    if (preset === "30d") return [iso(new Date(Date.now() - 29 * 864e5)), iso(t)];
    return [cFrom, cTo];
  }, [preset, cFrom, cTo]);

  // separa a seleção de usuários em SDR (filtra etapas SDR) e closer (filtra etapas closer)
  const { pSdrs, pClosers } = useMemo(() => {
    const s = selUsers.filter(u => sdrsSet.has(u));
    const c = selUsers.filter(u => closersSet.has(u));
    return { pSdrs: s.length ? s : null, pClosers: c.length ? c : null };
  }, [selUsers, sdrsSet, closersSet]);
  const pCanais = selCanais.length ? selCanais : null;

  const load = useCallback(async () => {
    setLoading(true);
    const [t, c] = await Promise.all([
      supabase.rpc("get_funil_geral_totais", { p_from: from, p_to: to, p_canais: pCanais, p_sdrs: pSdrs, p_closers: pClosers }),
      supabase.rpc("get_funil_geral_canal", { p_from: from, p_to: to, p_canais: pCanais, p_sdrs: pSdrs, p_closers: pClosers }),
    ]);
    setTot(t.data?.[0] || null); setCanal(c.data || []); setLoading(false);
  }, [from, to, pCanais, pSdrs, pClosers]);
  useEffect(() => { load(); }, [load]);

  const openPopup = async (stage: string, label: string) => {
    setPopup({ stage, label }); setPopupLoading(true); setPopupRows([]);
    const { data } = await supabase.rpc("get_funil_geral_leads", { p_from: from, p_to: to, p_stage: stage, p_canais: pCanais, p_sdrs: pSdrs, p_closers: pClosers, p_limit: 500 });
    setPopupRows(data || []); setPopupLoading(false);
  };

  const card = "rounded-xl border border-[var(--color-v4-border)] bg-[var(--color-v4-card)] p-4";
  const maxStage = tot ? Math.max(1, ...STAGES.map(s => tot[s.k] || 0)) : 1;
  const conv = (a: number, b: number) => b ? Math.round(100 * a / b) : 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity size={20} className="text-[var(--color-v4-red)]" />
        <h2 className="text-2xl font-display font-bold text-white">Geral</h2>
        <span className="text-sm text-[var(--color-v4-text-muted)]">— funil completo da operação</span>
      </div>

      {/* FILTROS */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex bg-[var(--color-v4-surface)] rounded-lg p-0.5">
          {(["hoje", "7d", "30d", "custom"] as Preset[]).map(p => (
            <button key={p} onClick={() => setPreset(p)} className={`px-3 py-1.5 rounded-md text-xs font-medium ${preset === p ? "bg-[var(--color-v4-red)] text-white" : "text-[var(--color-v4-text-muted)]"}`}>
              {p === "hoje" ? "Hoje" : p === "7d" ? "7 dias" : p === "30d" ? "30 dias" : "Custom"}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <span className="flex items-center gap-1 text-xs text-[var(--color-v4-text-muted)]">
            <input type="date" value={cFrom} onChange={e => setCFrom(e.target.value)} className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-white" />até
            <input type="date" value={cTo} onChange={e => setCTo(e.target.value)} className="bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] rounded px-2 py-1 text-white" />
          </span>
        )}
        <MultiSelectFilter options={CANAIS.map(c => ({ value: c, label: c }))} selected={selCanais} onChange={setSelCanais} placeholder="Todos os canais" />
        <MultiSelectFilter options={active.map(m => ({ value: m.id, label: `${m.name} (${m.role})` }))} selected={selUsers} onChange={setSelUsers} placeholder="Todos (SDR filtra pré-vendas · closer filtra fechamento)" />
        <div className="flex gap-1">
          <button onClick={() => setSelUsers([...sdrsSet])} className="px-2 py-1 rounded text-[11px] bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white">Só SDRs</button>
          <button onClick={() => setSelUsers([...closersSet])} className="px-2 py-1 rounded text-[11px] bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white">Só Closers</button>
          <button onClick={() => setSelUsers([])} className="px-2 py-1 rounded text-[11px] bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] hover:text-white">Todos</button>
        </div>
        {loading && <span className="text-xs text-[var(--color-v4-text-muted)]">carregando…</span>}
      </div>

      {/* CARDS GRANDES */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-6">
        {STAGES.map(s => (
          <button key={s.k} onClick={() => openPopup(s.k, s.label)} className={`${card} text-left hover:border-[var(--color-v4-red)] transition-colors`}>
            <div className="text-[11px] text-[var(--color-v4-text-muted)] flex items-center gap-1"><s.Icon size={12} style={{ color: s.color }} /> {s.label}</div>
            <div className="text-3xl font-bold text-white">{tot ? (tot[s.k] ?? 0) : "—"}</div>
            <div className="text-[9px] text-[var(--color-v4-text-muted)]">{s.src === "sdr" ? "pré-vendas" : "closer"}</div>
          </button>
        ))}
      </div>

      {/* FUNIL VISUAL */}
      <div className={`${card} mb-6`}>
        <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-3">Funil da operação — clique numa etapa pra ver os leads {tot && <span className="ml-2 text-red-400">· {tot.perdidos} perdidos</span>}</div>
        <div className="space-y-1.5">
          {STAGES.map((s, i) => {
            const val = tot ? (tot[s.k] || 0) : 0;
            const prev = i > 0 && tot ? (tot[STAGES[i - 1].k] || 0) : null;
            return (
              <div key={s.k} className="flex items-center gap-2">
                <span className="w-20 text-[11px] text-[var(--color-v4-text-muted)] text-right">{s.label}</span>
                <button onClick={() => openPopup(s.k, s.label)} className="flex-1 h-7 rounded bg-[var(--color-v4-surface)] overflow-hidden relative group" title="ver leads">
                  <div className="h-full rounded flex items-center px-2 text-[11px] text-white font-medium transition-all group-hover:brightness-110"
                    style={{ width: `${Math.max(6, 100 * val / maxStage)}%`, background: s.color }}>{val}</div>
                </button>
                <span className="w-14 text-[10px] text-[var(--color-v4-text-muted)]">{prev != null ? `${conv(val, prev)}%` : ""}</span>
              </div>
            );
          })}
        </div>
        {tot && <div className="text-[10px] text-[var(--color-v4-text-muted)] mt-2 opacity-70">No-show: {tot.noshow} · Conexão = ligações atendidas (proxy; ligação não tem canal). Etapas pré-vendas por SDR-dono; proposta/contrato/fechado por closer.</div>}
      </div>

      {/* POR CANAL */}
      <div className={`${card} mb-4 overflow-x-auto`}>
        <div className="text-[11px] text-[var(--color-v4-text-muted)] mb-2">Funil por canal</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[620px]">
            <thead><tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
              <th className="px-2 py-1">Canal</th><th className="px-2 py-1 text-right">Recebidos</th><th className="px-2 py-1 text-right">Agendados</th>
              <th className="px-2 py-1 text-right">Realizados</th><th className="px-2 py-1 text-right">No-show</th><th className="px-2 py-1 text-right">Proposta</th>
              <th className="px-2 py-1 text-right">Contrato</th><th className="px-2 py-1 text-right">Fechados</th>
            </tr></thead>
            <tbody>
              {canal.map((c, i) => (
                <tr key={i} className="border-t border-[var(--color-v4-border)] text-white">
                  <td className="px-2 py-1.5">{c.canal}</td>
                  <td className="px-2 py-1.5 text-right">{c.recebidos}</td><td className="px-2 py-1.5 text-right">{c.agendados}</td>
                  <td className="px-2 py-1.5 text-right">{c.realizados}</td><td className="px-2 py-1.5 text-right text-red-400/80">{c.noshow}</td>
                  <td className="px-2 py-1.5 text-right">{c.proposta}</td><td className="px-2 py-1.5 text-right">{c.contrato}</td>
                  <td className="px-2 py-1.5 text-right text-emerald-400">{c.fechados}</td>
                </tr>
              ))}
              {canal.length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-[var(--color-v4-text-muted)]">Sem dados.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* POPUP */}
      {popup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPopup(null)} />
          <div className="relative w-full max-w-4xl max-h-[85vh] overflow-y-auto bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">{popup.label} <span className="text-[var(--color-v4-text-muted)] font-normal">· {popupRows.length} leads</span></h3>
              <button onClick={() => setPopup(null)} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
            </div>
            {popupLoading ? <div className="text-sm text-[var(--color-v4-text-muted)]">carregando…</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] min-w-[760px]">
                  <thead><tr className="text-[11px] text-[var(--color-v4-text-muted)] text-left">
                    <th className="px-2 py-1">Empresa</th><th className="px-2 py-1 text-right">Valor</th><th className="px-2 py-1">Entrada</th>
                    <th className="px-2 py-1">Reunião</th><th className="px-2 py-1">SDR</th><th className="px-2 py-1">Closer</th>
                    <th className="px-2 py-1">Canal</th><th className="px-2 py-1 text-right">Dias parado</th><th className="px-2 py-1"></th>
                  </tr></thead>
                  <tbody>
                    {popupRows.map((r, i) => (
                      <tr key={i} className="border-t border-[var(--color-v4-border)] text-white">
                        <td className="px-2 py-1.5 max-w-[200px] truncate">{r.nome || "—"}</td>
                        <td className="px-2 py-1.5 text-right">{r.valor ? `R$ ${Number(r.valor).toLocaleString("pt-BR")}` : "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{r.data_entrada ? new Date(r.data_entrada).toLocaleDateString("pt-BR") : "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{r.data_reuniao ? new Date(r.data_reuniao).toLocaleDateString("pt-BR") : "—"}</td>
                        <td className="px-2 py-1.5">{r.sdr_name || "—"}</td>
                        <td className="px-2 py-1.5">{r.closer_name || "—"}</td>
                        <td className="px-2 py-1.5 text-[var(--color-v4-text-muted)]">{r.canal}</td>
                        <td className="px-2 py-1.5 text-right">{r.dias_parado ?? "—"}</td>
                        <td className="px-2 py-1.5">{r.kommo_id && /^\d+$/.test(String(r.kommo_id)) && <a href={`${KOMMO}/leads/detail/${r.kommo_id}`} target="_blank" rel="noreferrer" className="text-[var(--color-v4-red)] hover:underline inline-flex items-center gap-0.5">Kommo<ExternalLink size={11} /></a>}</td>
                      </tr>
                    ))}
                    {popupRows.length === 0 && <tr><td colSpan={9} className="px-2 py-4 text-center text-[var(--color-v4-text-muted)]">Nenhum lead nesta etapa.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
