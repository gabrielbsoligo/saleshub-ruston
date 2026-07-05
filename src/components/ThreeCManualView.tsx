import React, { useEffect, useMemo, useState } from "react";
import {
  Phone, Search, Loader2, ArrowRight, ArrowLeft, ExternalLink,
  CheckCircle2, AlertTriangle, RefreshCw, ShieldAlert,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  crossReference, buildWritebackPayload, writebackEndpoint, kommoLeadUrl,
  isRotten, rottenReasons, WRITEBACK_ENABLED,
  TARGET_PIPELINE_ID, TARGET_STATUS_ID,
  type KommoLeadState, type KommoUser, type SearchResult,
} from "../lib/threeC";
import {
  lookupCall as realLookupCall,
  lookupQuery as realLookupQuery,
  fetchKommoUsers as realFetchUsers,
  moveToConexaoRealizada as realMove,
} from "../lib/kommoLookup";

// Injeção opcional pra testes/preview — em produção usa os clientes reais.
interface Props {
  lookupCallFn?: typeof realLookupCall;
  lookupQueryFn?: typeof realLookupQuery;
  fetchUsersFn?: typeof realFetchUsers;
  moveFn?: typeof realMove;
  writebackEnabled?: boolean;
}

type Phase = "input" | "searching" | "result" | "confirm" | "done";

interface CallInputs {
  protocolo: string;
  identificador: string;
  inicio: string;
  nome: string;
  empresa: string;
  telefone: string;
}

const EMPTY: CallInputs = { protocolo: "", identificador: "", inicio: "", nome: "", empresa: "", telefone: "" };

const inputCls =
  "w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm focus:outline-none focus:ring-1 focus:ring-[var(--color-v4-red)]";
const labelCls = "block text-xs font-semibold text-[var(--color-v4-text-muted)] mb-1.5";
const cardCls = "bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl";

const chip = (kind: "ok" | "warn" | "err" | "mut" | "blue", text: string) => {
  const map: Record<string, string> = {
    ok: "bg-emerald-500/15 text-emerald-300",
    warn: "bg-amber-500/15 text-amber-300",
    err: "bg-red-500/15 text-red-300",
    mut: "bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)]",
    blue: "bg-blue-500/15 text-blue-300",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${map[kind]}`}>
      {text}
    </span>
  );
};

function formatPhone(p?: string | null): string {
  const c = (p || "").replace(/\D/g, "");
  if (c.startsWith("55") && c.length >= 12) return `(${c.slice(2, 4)}) ${c.slice(4, -4)}-${c.slice(-4)}`;
  if (c.length >= 10) return `(${c.slice(0, 2)}) ${c.slice(2, -4)}-${c.slice(-4)}`;
  return p || "";
}

// ---------- Card de lead (estado vivo, selecionável) ----------
const LeadCard: React.FC<{
  lead: KommoLeadState;
  sourceLabel?: string;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  idMatch?: boolean;
  compact?: boolean;
}> = ({ lead, sourceLabel, selectable, selected, onSelect, idMatch, compact }) => {
  const rotten = isRotten(lead);
  const reasons = rottenReasons(lead);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!selectable}
      className={[
        "text-left w-full rounded-xl p-4 border transition-all",
        selectable ? "cursor-pointer hover:-translate-y-0.5" : "cursor-default",
        selected
          ? "border-[var(--color-v4-red)] ring-2 ring-[var(--color-v4-red-muted)] bg-[var(--color-v4-card)]"
          : rotten
          ? "border-red-900/60 bg-[var(--color-v4-card)]"
          : "border-[var(--color-v4-border-strong)] bg-[var(--color-v4-card)]",
      ].join(" ")}
    >
      {sourceLabel && (
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider font-bold text-[var(--color-v4-text-muted)]">{sourceLabel}</span>
          {idMatch && chip("blue", "= id")}
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-semibold text-[15px] truncate">{lead.name || "(sem nome)"}</p>
          {lead.contact_name && lead.contact_name !== lead.name && (
            <p className="text-[var(--color-v4-text-muted)] text-xs truncate">contato: {lead.contact_name}</p>
          )}
        </div>
        {selectable && (
          <span
            className={[
              "flex-none w-4 h-4 rounded-full border-2 mt-1",
              selected ? "border-[var(--color-v4-red)] bg-[var(--color-v4-red)]" : "border-[var(--color-v4-border-strong)]",
            ].join(" ")}
          />
        )}
      </div>

      {!compact && (
        <div className="mt-3 space-y-1.5 text-[13px]">
          <Row l="Funil atual" v={lead.is_deleted ? "—" : lead.pipeline_name || `#${lead.pipeline_id ?? "?"}`} />
          <Row
            l="Etapa"
            v={
              lead.is_deleted
                ? chip("err", "deletado")
                : lead.is_lost
                ? chip("err", "Perdido")
                : chip("mut", lead.status_name || `#${lead.status_id ?? "?"}`)
            }
          />
          <Row
            l="Tags"
            v={
              lead.tags.length
                ? <span className="flex flex-wrap gap-1 justify-end">{lead.tags.map((t) => <React.Fragment key={t}>{chip(rottenTag(t) ? "warn" : "mut", t)}</React.Fragment>)}</span>
                : "—"
            }
          />
          <Row
            l="Telefone"
            v={lead.phones.length ? lead.phones.map(formatPhone).join(" · ") : "—"}
          />
          <Row
            l="Estado"
            v={rotten ? chip("err", "registro podre") : chip("ok", "ativo")}
          />
        </div>
      )}

      {compact && (
        <p className="text-[var(--color-v4-text-muted)] text-xs mt-1">
          {lead.is_deleted ? "deletado" : `${lead.pipeline_name || "?"} · ${lead.status_name || "?"}`}
          {" · "}
          {rotten ? <span className="text-red-300">{reasons.join(", ")}</span> : <span className="text-emerald-300">ativo</span>}
        </p>
      )}

      {rotten && !compact && (
        <div className="mt-3 flex items-start gap-1.5 text-[11px] text-red-300 bg-red-500/10 rounded-lg px-2 py-1.5">
          <ShieldAlert size={13} className="flex-none mt-0.5" />
          <span>Suspeito: {reasons.join(", ")}. Confira antes de usar.</span>
        </div>
      )}
    </button>
  );
};

const Row: React.FC<{ l: string; v: React.ReactNode }> = ({ l, v }) => (
  <div className="flex items-center justify-between gap-3 border-t border-[var(--color-v4-border)] pt-1.5">
    <span className="text-[var(--color-v4-text-muted)]">{l}</span>
    <span className="text-white text-right">{v}</span>
  </div>
);

const rottenTag = (t: string) => /(^|[^a-z])_?(dupe?|duplicad[ao]|legado|legacy|antigo|old|lixo|migrad[ao])\b/i.test(t);

// =============================================================
export const ThreeCManualView: React.FC<Props> = ({
  lookupCallFn = realLookupCall,
  lookupQueryFn = realLookupQuery,
  fetchUsersFn = realFetchUsers,
  moveFn = realMove,
  writebackEnabled = WRITEBACK_ENABLED,
}) => {
  const [phase, setPhase] = useState<Phase>("input");
  const [inputs, setInputs] = useState<CallInputs>(EMPTY);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [byIdStatus, setByIdStatus] = useState<string>("");
  const [selected, setSelected] = useState<KommoLeadState | null>(null);
  const [error, setError] = useState<string>("");

  // busca manual
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<KommoLeadState[] | null>(null);
  const [manualLoading, setManualLoading] = useState(false);

  // usuários do Kommo
  const [users, setUsers] = useState<KommoUser[]>([]);
  const [usersError, setUsersError] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<number | "">("");

  // resultado da gravação (dry-run ou escrita real)
  const [doneInfo, setDoneInfo] = useState<{ mode: "dryrun" | "real"; endpoint: string; payload: any; lead: KommoLeadState; user: KommoUser; kommoStatus?: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [moveError, setMoveError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchUsersFn()
      .then((u) => { if (alive) setUsers(u); })
      .catch((e) => { if (alive) setUsersError(e.message || "Falha ao carregar usuários do Kommo"); });
    return () => { alive = false; };
  }, [fetchUsersFn]);

  const set = (k: keyof CallInputs) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setInputs((prev) => ({ ...prev, [k]: e.target.value }));

  const canSearch = inputs.identificador.trim() !== "" || inputs.telefone.trim() !== "";

  const runSearch = async () => {
    if (!canSearch) { toast.error("Informe ao menos o Identificador ou o Telefone."); return; }
    setPhase("searching");
    setError("");
    setManualResults(null);
    try {
      const resp = await lookupCallFn({ kommo_id: inputs.identificador.trim(), telefone: inputs.telefone.trim() });
      setByIdStatus(resp.byIdStatus);
      const byId = resp.byId && resp.byIdStatus === "found" ? resp.byId : (resp.byId && resp.byId.is_deleted ? resp.byId : null);
      const xref = crossReference({ byId, byPhone: resp.byPhone || [] });
      setResult(xref);
      // pré-seleciona quando há confiança / fonte única
      if (xref.mode === "match") setSelected(xref.lead);
      else if (xref.mode === "single") setSelected(xref.lead);
      else setSelected(null);
      setPhase("result");
    } catch (e: any) {
      setError(e.message || "Erro na busca");
      setPhase("input");
      toast.error(e.message || "Erro na busca");
    }
  };

  const runManual = async () => {
    if (!manualQuery.trim()) return;
    setManualLoading(true);
    try {
      const r = await lookupQueryFn(manualQuery.trim());
      setManualResults(r);
      if (r.length === 1) setSelected(r[0]);
    } catch (e: any) {
      toast.error(e.message || "Erro na busca manual");
    } finally {
      setManualLoading(false);
    }
  };

  const confirmMove = async () => {
    if (!selected || selectedUserId === "") return;
    const user = users.find((u) => u.id === selectedUserId);
    if (!user) return;
    const payload = buildWritebackPayload(user.id);
    setMoveError("");

    if (!writebackEnabled) {
      // DRY-RUN: monta e mostra o payload, NÃO grava.
      setDoneInfo({ mode: "dryrun", endpoint: writebackEndpoint(selected.id), payload, lead: selected, user });
      setPhase("done");
      return;
    }

    // ESCRITA REAL via kommo-3c-move → kommo-writeback.
    setSubmitting(true);
    try {
      const res = await moveFn({ kommo_id: String(selected.id), responsible_user_id: user.id });
      setDoneInfo({ mode: "real", endpoint: writebackEndpoint(selected.id), payload, lead: selected, user, kommoStatus: res.kommo_status });
      setPhase("done");
      toast.success("Movido para Conexão Realizada!");
      window.open(kommoLeadUrl(selected.id), "_blank", "noopener,noreferrer");
    } catch (e: any) {
      const msg = e?.message || "Erro ao gravar no Kommo";
      setMoveError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setInputs(EMPTY); setResult(null); setSelected(null); setDoneInfo(null);
    setManualQuery(""); setManualResults(null); setSelectedUserId(""); setError("");
    setMoveError(""); setSubmitting(false);
    setPhase("input");
  };

  // ---------- Header ----------
  const header = (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[var(--color-v4-red-muted)] text-[var(--color-v4-red)] flex items-center justify-center">
          <Phone size={18} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-white">Trabalhar ligação — 3C</h1>
            {chip("warn", "tela temporária")}
          </div>
          <p className="text-xs text-[var(--color-v4-text-muted)]">Localize o lead no Kommo a partir dos dados da ligação.</p>
        </div>
      </div>
      {phase !== "input" && (
        <button onClick={reset} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--color-v4-text-muted)] hover:text-white hover:bg-[var(--color-v4-surface)]">
          <RefreshCw size={14} /> Nova ligação
        </button>
      )}
    </div>
  );

  return (
    <div className="flex-1 overflow-hidden flex flex-col p-6">
      {header}
      <div className="flex-1 overflow-y-auto -mx-1 px-1">
        <div className="max-w-3xl mx-auto pb-10">
          {phase === "input" && renderInput()}
          {phase === "searching" && (
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-[var(--color-v4-text-muted)]">
              <Loader2 className="animate-spin" size={28} />
              <p className="text-sm">Buscando no Kommo — por id e por telefone…</p>
            </div>
          )}
          {phase === "result" && renderResult()}
          {phase === "confirm" && renderConfirm()}
          {phase === "done" && renderDone()}
        </div>
      </div>
    </div>
  );

  // ---------- Fase 1: entrada ----------
  function renderInput() {
    return (
      <div className={`${cardCls} p-5`}>
        <p className="text-sm text-[var(--color-v4-text-muted)] mb-4">Cole os dados que o 3C mostra ao conectar na ligação.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Protocolo"><input className={`${inputCls} font-mono`} value={inputs.protocolo} onChange={set("protocolo")} /></Field>
          <Field label="Identificador (id Kommo)"><input className={`${inputCls} font-mono`} value={inputs.identificador} onChange={set("identificador")} placeholder="ex. 7234810" /></Field>
          <Field label="Início da ligação"><input className={`${inputCls} font-mono`} value={inputs.inicio} onChange={set("inicio")} /></Field>
          <Field label="Nome"><input className={inputCls} value={inputs.nome} onChange={set("nome")} /></Field>
          <Field label="Empresa"><input className={inputCls} value={inputs.empresa} onChange={set("empresa")} /></Field>
          <Field label="Telefone"><input className={`${inputCls} font-mono`} value={inputs.telefone} onChange={set("telefone")} placeholder="ex. 5512981297383" /></Field>
        </div>
        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
        <button
          onClick={runSearch}
          disabled={!canSearch}
          className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm"
        >
          <Search size={16} /> Localizar lead no Kommo
        </button>
      </div>
    );
  }

  // ---------- Fase 2: resultado ----------
  function renderResult() {
    if (!result) return null;
    const r = result;

    // Match — confiança alta
    if (r.mode === "match") {
      return (
        <div className="space-y-4">
          <Banner kind="ok" title="Lead encontrado — id e telefone batem" sub="Confiança alta." />
          <LeadCard lead={r.lead} sourceLabel="✔ id + telefone" selectable selected onSelect={() => setSelected(r.lead)} />
          <Continue onClick={() => setPhase("confirm")} enabled={!!selected} />
        </div>
      );
    }

    // Divergência — o coração da tela
    if (r.mode === "divergence") {
      return (
        <div className="space-y-4">
          <Banner kind="warn" title="Atenção — o id e o telefone apontam leads diferentes"
            sub="Pós-migração o Identificador pode apontar pra um registro podre. Confira e selecione. A tela não decide por você." />
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-stretch">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-[var(--color-v4-text-muted)] mb-2">pelo Identificador · {inputs.identificador}</p>
              <LeadCard lead={r.byId} selectable selected={selected?.id === r.byId.id} onSelect={() => setSelected(r.byId)} />
            </div>
            <div className="flex md:flex-col items-center justify-center gap-2">
              <span className="text-2xl font-mono font-bold text-amber-400">≠</span>
              <span className="text-[10px] uppercase tracking-widest text-[var(--color-v4-text-muted)]">divergem</span>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-[var(--color-v4-text-muted)] mb-2">pelo Telefone · {inputs.telefone}</p>
              <div className="space-y-3">
                {r.byPhone.map((l) => (
                  <LeadCard key={l.id} lead={l} selectable selected={selected?.id === l.id} onSelect={() => setSelected(l)} compact={r.byPhone.length > 1} />
                ))}
              </div>
            </div>
          </div>
          <Continue onClick={() => setPhase("confirm")} enabled={!!selected} hint="selecione um dos lados pra continuar" />
        </div>
      );
    }

    // Vários por telefone
    if (r.mode === "multiple") {
      return (
        <div className="space-y-4">
          <Banner kind="warn" title={`${r.leads.length} leads com esse telefone`} sub="Escolha o correto — o que casa com o id vem sinalizado." />
          <div className="space-y-3">
            {r.leads.map((l) => (
              <LeadCard key={l.id} lead={l} selectable selected={selected?.id === l.id} onSelect={() => setSelected(l)} idMatch={r.idMatchId === l.id} compact />
            ))}
          </div>
          <Continue onClick={() => setPhase("confirm")} enabled={!!selected} />
        </div>
      );
    }

    // Fonte única
    if (r.mode === "single") {
      const rotten = isRotten(r.lead);
      return (
        <div className="space-y-4">
          <Banner
            kind={rotten ? "warn" : "ok"}
            title={r.source === "id" ? "Encontrado só pelo Identificador" : "Encontrado só pelo Telefone"}
            sub={rotten ? "Estado suspeito — confira antes de confirmar." : "Sem divergência."}
          />
          <LeadCard lead={r.lead} sourceLabel={r.source === "id" ? "pelo id" : "pelo telefone"} selectable selected={selected?.id === r.lead.id} onSelect={() => setSelected(r.lead)} />
          <Continue onClick={() => setPhase("confirm")} enabled={!!selected} />
        </div>
      );
    }

    // Nada — busca manual
    return (
      <div className="space-y-4">
        <div className={`${cardCls} p-8 text-center`}>
          <div className="text-3xl mb-2">∅</div>
          <p className="text-white font-semibold">Nada encontrado por id nem por telefone</p>
          <p className="text-sm text-[var(--color-v4-text-muted)] mt-1 max-w-md mx-auto">
            Nem o Identificador <span className="font-mono">{inputs.identificador || "—"}</span> nem o telefone <span className="font-mono">{inputs.telefone || "—"}</span> bateram. Busque manualmente por nome/empresa.
          </p>
          <div className="flex gap-2 max-w-md mx-auto mt-4">
            <input className={inputCls} placeholder="nome ou empresa…" value={manualQuery}
              onChange={(e) => setManualQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runManual(); }} />
            <button onClick={runManual} disabled={manualLoading}
              className="px-4 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border-strong)] text-white text-sm flex items-center gap-2">
              {manualLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Buscar
            </button>
          </div>
        </div>
        {manualResults && (
          <div className="space-y-3">
            {manualResults.length === 0 && <p className="text-sm text-[var(--color-v4-text-muted)] text-center">Nada encontrado pra "{manualQuery}".</p>}
            {manualResults.map((l) => (
              <LeadCard key={l.id} lead={l} selectable selected={selected?.id === l.id} onSelect={() => setSelected(l)} compact />
            ))}
            {manualResults.length > 0 && <Continue onClick={() => setPhase("confirm")} enabled={!!selected} />}
          </div>
        )}
      </div>
    );
  }

  // ---------- Fase 3: confirmar ----------
  function renderConfirm() {
    if (!selected) { setPhase("result"); return null; }
    const rotten = isRotten(selected);
    return (
      <div className="space-y-4">
        <button onClick={() => setPhase("result")} className="flex items-center gap-1.5 text-sm text-[var(--color-v4-text-muted)] hover:text-white">
          <ArrowLeft size={14} /> voltar aos resultados
        </button>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className={`${cardCls} p-4`}>
            <p className="text-[11px] uppercase tracking-wider text-[var(--color-v4-text-muted)] font-bold mb-2">Lead selecionado</p>
            <p className="text-white font-semibold text-[15px]">{selected.name || "(sem nome)"}</p>
            {rotten && <div className="mt-1">{chip("err", "registro podre — você confirmou")}</div>}
            <div className="mt-3 space-y-1.5 text-[13px]">
              <Row l="De" v={selected.is_deleted ? "deletado" : `${selected.pipeline_name || "?"} · ${selected.status_name || "?"}`} />
              <Row l="Para" v={<span className="text-emerald-300 font-medium">Novo-Pré Vendas · Conexão Realizada</span>} />
            </div>
          </div>
          <div className={`${cardCls} p-4`}>
            <p className="text-[11px] uppercase tracking-wider text-[var(--color-v4-text-muted)] font-bold mb-2">Atribuir para</p>
            <label className={labelCls}>Usuário responsável (qualquer um do Kommo)</label>
            <select className={inputCls} value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Selecione o usuário…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` — ${u.email}` : ""}</option>)}
            </select>
            {usersError && <p className="text-xs text-red-400 mt-2">{usersError}</p>}
            <button
              onClick={confirmMove}
              disabled={selectedUserId === "" || submitting}
              className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm"
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              {submitting ? "Gravando no Kommo…" : "Mover p/ Conexão Realizada + atribuir"}
            </button>
            {moveError && (
              <p className="text-xs text-red-400 mt-2 flex items-start gap-1.5">
                <AlertTriangle size={13} className="flex-none mt-0.5" /> {moveError}
              </p>
            )}
            {!writebackEnabled && (
              <p className="text-[11px] text-amber-300/90 mt-2 flex items-start gap-1.5">
                <AlertTriangle size={12} className="flex-none mt-0.5" />
                Dry-run: mostra o payload exato que seria enviado, <b className="font-semibold">sem gravar</b>.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------- Fase 4: feito (escrita real ou dry-run) ----------
  function renderDone() {
    if (!doneInfo) return null;
    const url = kommoLeadUrl(doneInfo.lead.id);
    const isReal = doneInfo.mode === "real";
    return (
      <div className="space-y-4">
        <div className={`${cardCls} p-6 text-center`}>
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${isReal ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
            {isReal ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}
          </div>
          <p className="text-white font-semibold text-[15px]">
            {isReal ? "Movido para Conexão Realizada" : "Dry-run — nada foi gravado no Kommo"}
          </p>
          <p className="text-sm text-[var(--color-v4-text-muted)] mt-1">
            {doneInfo.lead.name} → Conexão Realizada · atribuído a {doneInfo.user.name}
          </p>
          <div className="inline-flex items-center gap-2 mt-4 bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg pl-3 pr-2 py-1.5">
            <span className="font-mono text-xs text-blue-300 truncate max-w-[280px]">{url}</span>
            <a href={url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] text-white text-xs font-medium">
              Abrir no Kommo <ExternalLink size={13} />
            </a>
          </div>
          {isReal && <p className="text-[11px] text-emerald-300/80 mt-3">Kommo respondeu {doneInfo.kommoStatus} · aba aberta automaticamente.</p>}
        </div>

        <div className={`${cardCls} p-4`}>
          <p className="text-[11px] uppercase tracking-wider text-[var(--color-v4-text-muted)] font-bold mb-2">
            {isReal ? "Payload enviado" : "Payload que seria enviado"}
          </p>
          <pre className="bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] rounded-lg p-3 overflow-x-auto text-xs font-mono text-slate-300 leading-relaxed">
{`${doneInfo.endpoint}
${JSON.stringify(doneInfo.payload, null, 2)}`}
          </pre>
          <p className="text-[11px] text-[var(--color-v4-text-muted)] mt-2">
            Destino fixo: pipeline <span className="font-mono">{TARGET_PIPELINE_ID}</span> · status <span className="font-mono">{TARGET_STATUS_ID}</span>.
          </p>
        </div>

        <button onClick={reset} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-v4-surface)] border border-[var(--color-v4-border-strong)] text-white font-medium text-sm">
          <Phone size={15} /> Trabalhar a próxima ligação
        </button>
      </div>
    );
  }
};

// ---------- helpers de layout ----------
const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div><label className={labelCls}>{label}</label>{children}</div>
);

const Banner: React.FC<{ kind: "ok" | "warn"; title: string; sub?: string }> = ({ kind, title, sub }) => {
  const isOk = kind === "ok";
  return (
    <div className={`flex items-start gap-3 rounded-xl px-4 py-3 border ${isOk ? "border-emerald-800/50 bg-emerald-500/10" : "border-amber-800/50 bg-amber-500/10"}`}>
      {isOk ? <CheckCircle2 size={18} className="text-emerald-400 flex-none mt-0.5" /> : <AlertTriangle size={18} className="text-amber-400 flex-none mt-0.5" />}
      <div>
        <p className={`text-sm font-semibold ${isOk ? "text-emerald-200" : "text-amber-200"}`}>{title}</p>
        {sub && <p className="text-xs text-[var(--color-v4-text-muted)] mt-0.5">{sub}</p>}
      </div>
    </div>
  );
};

const Continue: React.FC<{ onClick: () => void; enabled: boolean; hint?: string }> = ({ onClick, enabled, hint }) => (
  <div className="flex items-center gap-3">
    <button onClick={onClick} disabled={!enabled}
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-v4-red)] hover:bg-[var(--color-v4-red-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm">
      Continuar para confirmação <ArrowRight size={16} />
    </button>
    {!enabled && hint && <span className="text-xs text-[var(--color-v4-text-muted)]">{hint}</span>}
  </div>
);
