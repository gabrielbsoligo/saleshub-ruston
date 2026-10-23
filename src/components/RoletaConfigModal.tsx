import React, { useEffect, useMemo, useState } from "react";
import { X, RotateCcw, Repeat } from "lucide-react";
import toast from "react-hot-toast";
import { useAppStore } from "../store";
import { supabase } from "../lib/supabase";
import { CANAL_LABELS, ROLETA_CANAIS_SEM_PONTO_PADRAO, type LeadCanal, type RoletaCloser } from "../types";

const CANAIS: LeadCanal[] = Object.keys(CANAL_LABELS) as LeadCanal[];

interface Props {
  open: boolean;
  onClose: () => void;
}

export const RoletaConfigModal: React.FC<Props> = ({ open, onClose }) => {
  const { members, roleta, roletaReset, roletaSetAtivo, updateRoletaOrdem, roletaSetCanais } = useAppStore();
  const [rows, setRows] = useState<RoletaCloser[]>([]);
  const [loading, setLoading] = useState(false);

  // Todos os closers elegíveis (role closer/gestor, ativos no time)
  const closers = useMemo(
    () => members.filter((m) => (m.role === "closer" || m.role === "gestor") && m.active),
    [members],
  );
  const cfgByMember = useMemo(() => new Map(rows.map((r) => [r.member_id, r])), [rows]);
  const statusByMember = useMemo(() => new Map(roleta.map((r) => [r.member_id, r])), [roleta]);

  const fetchRows = async () => {
    setLoading(true);
    const { data, error } = await supabase.from("roleta_closers").select("*");
    if (error) toast.error(error.message);
    setRows((data || []) as RoletaCloser[]);
    setLoading(false);
  };

  useEffect(() => { if (open) fetchRows(); }, [open]);

  if (!open) return null;

  // Ordena pela ordem configurada (depois nome) para edição
  const sorted = [...closers].sort((a, b) => {
    const oa = cfgByMember.get(a.id)?.ordem ?? 9999;
    const ob = cfgByMember.get(b.id)?.ordem ?? 9999;
    return oa - ob || a.name.localeCompare(b.name);
  });

  const handleToggle = async (memberId: string, ativo: boolean) => {
    await roletaSetAtivo(memberId, ativo);
    fetchRows();
  };

  const handleOrdem = async (memberId: string, ordem: number) => {
    await updateRoletaOrdem(memberId, ordem);
    fetchRows();
  };

  // Canais que o closer atende: lista vazia/null = todos. Clicar num chip alterna.
  const handleCanal = async (memberId: string, canal: LeadCanal) => {
    const atuais = cfgByMember.get(memberId)?.canais ?? [];
    const base = atuais.length ? atuais : CANAIS; // "todos" vira lista explícita ao tirar um
    const next = base.includes(canal) ? base.filter((c) => c !== canal) : [...base, canal];
    if (!next.length) { toast.error("O closer precisa atender pelo menos um canal (ou tire-o do rodízio)."); return; }
    await roletaSetCanais(memberId, next.length === CANAIS.length ? [] : next);
    fetchRows();
  };

  const handleReset = async () => {
    if (!confirm("Zerar o rodízio? Todas as contagens voltam a zero e a fila reinicia.")) return;
    await roletaReset();
    fetchRows();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-v4-border)]">
          <div className="flex items-center gap-2">
            <Repeat size={18} className="text-[var(--color-v4-red)]" />
            <div>
              <h3 className="text-sm font-bold text-white">Rodízio de Closers</h3>
              <p className="text-[11px] text-[var(--color-v4-text-muted)]">Quem participa, canais que atende, ordem de desempate e contagem por canal</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--color-v4-text-muted)] hover:text-white"><X size={18} /></button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {loading && rows.length === 0 ? (
            <p className="text-xs text-[var(--color-v4-text-muted)] text-center py-6">Carregando…</p>
          ) : (
            <div className="space-y-1.5">
              {sorted.map((m) => {
                const cfg = cfgByMember.get(m.id);
                const ativo = cfg?.ativo ?? false;
                const st = statusByMember.get(m.id);
                const canaisCfg = cfg?.canais ?? [];
                const atende = (c: LeadCanal) => canaisCfg.length === 0 || canaisCfg.includes(c);
                const porCanal = st?.por_canal ?? {};
                return (
                  <div key={m.id} className="px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)]">
                  <div className="flex items-center gap-3">
                    {/* Toggle participação */}
                    <button
                      onClick={() => handleToggle(m.id, !ativo)}
                      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${ativo ? "bg-[var(--color-v4-red)]" : "bg-[var(--color-v4-border)]"}`}
                      title={ativo ? "No rodízio (clique para tirar)" : "Fora do rodízio (clique para incluir)"}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${ativo ? "translate-x-4" : "translate-x-0.5"}`} />
                    </button>

                    <span className="text-sm text-white flex-1 truncate">{m.name}</span>

                    {ativo ? (
                      <span className="text-[11px] text-[var(--color-v4-text-muted)] whitespace-nowrap">
                        {st ? `${st.total} reuniõe${st.total === 1 ? "" : "s"}` : "—"}
                      </span>
                    ) : (
                      <span className="text-[11px] text-[var(--color-v4-text-muted)]/60 whitespace-nowrap">fora</span>
                    )}

                    {/* Ordem de desempate */}
                    <input
                      type="number"
                      value={cfg?.ordem ?? 0}
                      disabled={!ativo}
                      onChange={(e) => handleOrdem(m.id, parseInt(e.target.value, 10) || 0)}
                      className="w-14 px-2 py-1 rounded bg-[var(--color-v4-bg)] border border-[var(--color-v4-border)] text-white text-xs text-center disabled:opacity-40"
                      title="Ordem de desempate (menor primeiro)"
                    />
                  </div>
                  {/* Canais que atende (chip aceso = atende) + recebidas no ciclo por canal */}
                  {ativo && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {CANAIS.map((c) => {
                        const on = atende(c);
                        const n = porCanal[c] ?? 0;
                        const semPonto = ROLETA_CANAIS_SEM_PONTO_PADRAO.includes(c);
                        return (
                          <button key={c} onClick={() => handleCanal(m.id, c)}
                            title={`${on ? "Atende" : "Não atende"} ${CANAL_LABELS[c]}${semPonto ? " (não pontua)" : ""} · ${n} no ciclo`}
                            className={`px-1.5 py-0.5 rounded text-[10px] border transition ${
                              on ? "border-[var(--color-v4-red)]/60 bg-[var(--color-v4-red)]/10 text-white" : "border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)] opacity-50 line-through"
                            }`}>
                            {CANAL_LABELS[c]}{n ? <span className="ml-1 opacity-70">{n}</span> : null}{semPonto && on ? <span className="ml-0.5 opacity-60">∅</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  </div>
                );
              })}
              {sorted.length === 0 && <p className="text-xs text-[var(--color-v4-text-muted)] text-center py-6">Nenhum closer ativo no time.</p>}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-v4-border)] flex items-center justify-between">
          <p className="text-[10px] text-[var(--color-v4-text-muted)] max-w-[60%]">
            O próximo é sempre quem tem menos reuniões entre os que atendem o canal do lead. Recomendação (∅) aparece na conta por canal, mas não pontua.
          </p>
          <button onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-v4-surface)] border border-[var(--color-v4-border)] hover:border-[var(--color-v4-red)] text-white text-xs">
            <RotateCcw size={13} /> Zerar rodízio
          </button>
        </div>
      </div>
    </div>
  );
};
