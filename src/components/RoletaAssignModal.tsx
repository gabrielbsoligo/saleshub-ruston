import React, { useEffect, useMemo, useState } from "react";
import { X, Repeat, UserPlus, Check } from "lucide-react";
import toast from "react-hot-toast";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import type { Lead, RoletaStatusRow } from "../types";

interface Props {
  lead: Lead;                 // lead recém-criado (inbound), ainda sem dono
  onClose: () => void;        // fecha e segue o fluxo (ex.: vai p/ 'leads')
}

type Modo = "roleta" | "manual";

// Modal de atribuição do lead inbound (roleta INBOUND de SDR).
// 2 caminhos: "Distribuir pela roleta" (conta no balanço) e
// "Atribuir fora da roleta" (só registra no log, não conta).
// Ambos gravam o dono no SH + write-back do responsible_user_id no Kommo,
// via a RPC roleta_assign(lead, member, tipo, 'inbound').
export const RoletaAssignModal: React.FC<Props> = ({ lead, onClose }) => {
  const { members } = useAppStore();
  const [modo, setModo] = useState<Modo>("roleta");
  const [fila, setFila] = useState<RoletaStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecionado, setSelecionado] = useState<string>("");
  const [salvando, setSalvando] = useState(false);

  // Fila da roleta inbound (1ª linha = próximo sugerido)
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("get_roleta_status_sdr", { p_escopo: "inbound" });
      if (error) { toast.error(error.message); setLoading(false); return; }
      const rows = (data || []) as RoletaStatusRow[];
      setFila(rows);
      setSelecionado(rows[0]?.member_id ?? "");   // pré-seleciona [0] (menor total)
      setLoading(false);
    })();
  }, []);

  // Elegíveis p/ "fora da roleta": qualquer SDR ou closer ativo
  const foraDaRoleta = useMemo(
    () => members.filter((m) => (m.role === "sdr" || m.role === "closer") && m.active)
                 .sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  // Ao trocar de modo, ajusta a seleção default
  useEffect(() => {
    if (modo === "roleta") setSelecionado(fila[0]?.member_id ?? "");
    else setSelecionado("");
  }, [modo, fila]);

  const confirmar = async () => {
    if (!selecionado) { toast.error("Selecione quem recebe o lead"); return; }
    setSalvando(true);
    const { error } = await supabase.rpc("roleta_assign", {
      p_lead_id: lead.id,
      p_member_id: selecionado,
      p_tipo: modo,               // 'roleta' conta no balanço; 'manual' não
      p_escopo: "inbound",
    });
    setSalvando(false);
    if (error) { toast.error(error.message); return; }
    const nome = (modo === "roleta"
      ? fila.find((r) => r.member_id === selecionado)?.name
      : foraDaRoleta.find((m) => m.id === selecionado)?.name) || "SDR";
    toast.success(
      modo === "roleta"
        ? `Lead distribuído pela roleta → ${nome}`
        : `Lead atribuído (fora da roleta) → ${nome}`,
      { icon: modo === "roleta" ? "🎯" : "✋" },
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex items-center gap-2">
            <Repeat size={18} className="text-[var(--color-v4-red)]" />
            <div>
              <h3 className="text-sm font-bold text-white">Distribuir lead inbound</h3>
              <p className="text-[11px] text-[var(--color-v4-text-muted)] truncate max-w-[320px]">
                {lead.empresa} · {lead.canal}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white" title="Decidir depois"><X size={18} /></button>
        </div>

        {/* tabs */}
        <div className="flex gap-1 px-4 pt-3">
          <button
            onClick={() => setModo("roleta")}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-xs font-medium border-b-2 ${
              modo === "roleta"
                ? "text-white border-[var(--color-v4-red)]"
                : "text-[var(--color-v4-text-muted)] border-transparent hover:text-white"
            }`}>
            <Repeat size={13} /> Distribuir pela roleta
          </button>
          <button
            onClick={() => setModo("manual")}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-xs font-medium border-b-2 ${
              modo === "manual"
                ? "text-white border-[var(--color-v4-red)]"
                : "text-[var(--color-v4-text-muted)] border-transparent hover:text-white"
            }`}>
            <UserPlus size={13} /> Atribuir fora da roleta
          </button>
        </div>

        {/* body */}
        <div className="p-4 overflow-y-auto flex-1">
          {loading ? (
            <p className="text-xs text-[var(--color-v4-text-muted)] text-center py-6">Carregando fila…</p>
          ) : modo === "roleta" ? (
            <div className="space-y-1.5">
              {fila.map((r, i) => {
                const sel = r.member_id === selecionado;
                return (
                  <button key={r.member_id} onClick={() => setSelecionado(r.member_id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
                      sel
                        ? "bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/50"
                        : "bg-[var(--color-v4-surface)] border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)]/40"
                    }`}>
                    <span className={`w-4 h-4 rounded-full border flex items-center justify-center flex-shrink-0 ${sel ? "border-[var(--color-v4-red)] bg-[var(--color-v4-red)]" : "border-[var(--color-v4-border)]"}`}>
                      {sel && <Check size={11} className="text-white" />}
                    </span>
                    {i === 0 && <span className="text-[9px] font-bold uppercase text-[var(--color-v4-red)]">próximo</span>}
                    <span className="text-sm text-white flex-1 truncate">{r.name}</span>
                    <span className="text-[11px] text-[var(--color-v4-text-muted)] whitespace-nowrap">
                      {r.total} no ciclo
                    </span>
                  </button>
                );
              })}
              {fila.length === 0 && <p className="text-xs text-[var(--color-v4-text-muted)] text-center py-6">Nenhum SDR ativo na roleta.</p>}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-[var(--color-v4-text-muted)]">
                Atribuição direta a qualquer pessoa. <span className="text-white">Não conta</span> no balanço da roleta — só registra no histórico.
              </p>
              <select
                value={selecionado}
                onChange={(e) => setSelecionado(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-sm">
                <option value="">Selecione…</option>
                {foraDaRoleta.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="px-5 py-4 border-t border-[var(--color-v4-border)] flex items-center justify-between gap-3">
          <p className="text-[10px] text-[var(--color-v4-text-muted)] max-w-[55%]">
            {modo === "roleta"
              ? "O próximo é sempre quem tem menos no ciclo. Trocar rebalanceia sozinho."
              : "Grava o dono no Kommo, mas fica fora da contagem da roleta."}
          </p>
          <button onClick={confirmar} disabled={salvando || !selecionado}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-v4-red)] hover:opacity-90 text-white text-xs font-medium disabled:opacity-40">
            <Check size={14} /> {salvando ? "Atribuindo…" : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
};
