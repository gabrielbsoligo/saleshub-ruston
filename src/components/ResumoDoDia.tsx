// =============================================================
// ResumoDoDia — visão consolidada de UMA data específica
// =============================================================
// Quick chips: Ontem · Hoje · custom date picker.
// 3 colunas de reuniões + transições de status + ligações por membro.
// Default = hoje. Trocar data NÃO muda nada do resto do Dashboard.
// =============================================================
import React, { useState } from 'react';
import { Calendar, Clock, CheckCircle2, XCircle, FileText, Trophy, Phone } from 'lucide-react';
import { useResumoDia } from '../hooks/useResumoDia';
import { useAppStore } from '../store';
import type { Reuniao } from '../types';

const todayStr = () => new Date().toISOString().slice(0, 10);
const yesterdayStr = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

function fmtDate(s: string): string {
  return new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
function fmtHour(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtBRL(v?: number | null) {
  if (v == null) return '';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 }).format(v);
}

const STATUS_LABELS: Record<string, string> = {
  dar_feedback: 'Feedback',
  follow_longo: 'Follow Longo',
  negociacao: 'Negociação',
  contrato_na_rua: 'Pra rua',
  contrato_assinado: 'Fechado',
  perdido: 'Perdido',
};

const STATUS_BG: Record<string, string> = {
  dar_feedback: 'bg-amber-500/15 text-amber-400',
  follow_longo: 'bg-orange-500/15 text-orange-400',
  negociacao: 'bg-blue-500/15 text-blue-400',
  contrato_na_rua: 'bg-yellow-500/15 text-yellow-400',
  contrato_assinado: 'bg-green-500/15 text-green-400',
  perdido: 'bg-red-500/15 text-red-400',
};

export const ResumoDoDia: React.FC = () => {
  const { members } = useAppStore();
  const [data, setData] = useState<string>(todayStr());

  const resumo = useResumoDia(data);

  const isToday = data === todayStr();
  const isYesterday = data === yesterdayStr();

  // helpers de display
  const memberName = (id?: string | null) => {
    if (!id) return '—';
    const m = members.find(mm => mm.id === id);
    return m ? m.name.split(' ')[0] : '—';
  };

  // Aggregations
  const fechadosHoje = resumo.statusChanges.filter(s => s.status_novo === 'contrato_assinado');
  const praRuaHoje = resumo.statusChanges.filter(s => s.status_novo === 'contrato_na_rua');
  const perdidosHoje = resumo.statusChanges.filter(s => s.status_novo === 'perdido');
  const totalFechado = fechadosHoje.reduce((a, s) => a + (Number(s.valor_recorrente) || 0) + (Number(s.valor_escopo) || 0), 0);

  return (
    <div className="bg-[var(--color-v4-card)] border border-[var(--color-v4-border)] rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Calendar size={18} className="text-[var(--color-v4-red)]" />
          <h3 className="text-base font-bold text-white">Resumo do dia</h3>
          <span className="text-xs text-[var(--color-v4-text-muted)]">{fmtDate(data)}</span>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <Chip active={isYesterday} onClick={() => setData(yesterdayStr())}>Ontem</Chip>
          <Chip active={isToday} onClick={() => setData(todayStr())}>Hoje</Chip>
          <input
            type="date"
            value={data}
            onChange={(e) => setData(e.target.value)}
            min="2024-01-01" max="2050-12-31"
            className={`px-2 py-1 rounded text-xs border ${
              !isToday && !isYesterday
                ? 'bg-[var(--color-v4-red)]/15 border-[var(--color-v4-red)]/40 text-white'
                : 'bg-[var(--color-v4-bg)] border-[var(--color-v4-border)] text-[var(--color-v4-text-muted)]'
            }`}
          />
        </div>
      </div>

      {/* 3 colunas de reunioes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <ColunaReunioes
          icon={<Calendar size={14} />}
          titulo="Agendadas"
          subtitulo="Criadas neste dia"
          color="text-amber-400"
          reunioes={resumo.reunioesAgendadas}
          renderHora={(r) => `pra ${fmtDate((r.data_reuniao || '').slice(0, 10))} ${fmtHour(r.data_reuniao)}`}
        />
        <ColunaReunioes
          icon={<Clock size={14} />}
          titulo="Pra realizar"
          subtitulo="Acontecem hoje"
          color="text-blue-400"
          reunioes={resumo.reunioesParaRealizar}
          renderHora={(r) => fmtHour(r.data_reuniao)}
        />
        <ColunaReunioes
          icon={<CheckCircle2 size={14} />}
          titulo="Realizadas"
          subtitulo="Show / no-show"
          color="text-green-400"
          reunioes={resumo.reunioesRealizadas}
          renderHora={(r) => fmtHour(r.data_reuniao)}
          renderExtra={(r) => (
            <span className={`text-[9px] px-1.5 py-0.5 rounded ${r.show ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
              {r.show ? 'Show' : 'No-show'}
            </span>
          )}
        />
      </div>

      {/* Linha de transições + ligações */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Pra rua */}
        <CardTransicoes
          icon={<FileText size={14} className="text-yellow-400" />}
          titulo="Foram pra rua"
          changes={praRuaHoje}
          memberName={memberName}
          color="text-yellow-400"
        />
        {/* Fechados */}
        <CardTransicoes
          icon={<Trophy size={14} className="text-green-400" />}
          titulo={`Fechados${totalFechado > 0 ? ` · ${fmtBRL(totalFechado)}` : ''}`}
          changes={fechadosHoje}
          memberName={memberName}
          color="text-green-400"
        />
        {/* Ligações */}
        <div className="bg-[var(--color-v4-bg)] rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Phone size={14} className="text-cyan-400" />
            <h4 className="text-xs font-bold text-white">Ligações ({resumo.totalLigacoes})</h4>
          </div>
          {resumo.ligacoesPorMembro.length === 0 ? (
            <p className="text-[10px] text-[var(--color-v4-text-muted)] py-2">Sem ligações.</p>
          ) : (
            <div className="space-y-1">
              {resumo.ligacoesPorMembro.slice(0, 6).map(l => (
                <div key={l.member_id} className="flex items-center justify-between text-[11px]">
                  <span className="text-white truncate">{memberName(l.member_id)}</span>
                  <span className="text-[var(--color-v4-text-muted)]">
                    <span className="text-white font-bold">{l.total}</span>
                    {' · '}
                    <span className="text-green-400">{l.atendidas}</span>
                    {' atend.'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {perdidosHoje.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--color-v4-border)]/50">
          <div className="flex items-center gap-2 mb-1">
            <XCircle size={12} className="text-red-400" />
            <span className="text-[10px] uppercase text-red-400">{perdidosHoje.length} perdido{perdidosHoje.length > 1 ? 's' : ''}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {perdidosHoje.map(p => (
              <span key={p.deal_id} className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30">
                {p.empresa} ({memberName(p.mudou_por)})
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Chip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-3 py-1 rounded text-xs ${
      active
        ? 'bg-[var(--color-v4-red)] text-white font-bold'
        : 'bg-[var(--color-v4-surface)] text-[var(--color-v4-text-muted)] hover:text-white'
    }`}
  >
    {children}
  </button>
);

interface ColunaReunioesProps {
  icon: React.ReactNode;
  titulo: string;
  subtitulo: string;
  color: string;
  reunioes: Reuniao[];
  renderHora: (r: Reuniao) => string;
  renderExtra?: (r: Reuniao) => React.ReactNode;
}

const ColunaReunioes: React.FC<ColunaReunioesProps> = ({
  icon, titulo, subtitulo, color, reunioes, renderHora, renderExtra,
}) => (
  <div className="bg-[var(--color-v4-bg)] rounded-lg p-3 min-h-[160px]">
    <div className="flex items-center gap-2 mb-2">
      <span className={color}>{icon}</span>
      <h4 className="text-xs font-bold text-white">{titulo}</h4>
      <span className={`text-xs ${color}`}>({reunioes.length})</span>
    </div>
    <p className="text-[10px] text-[var(--color-v4-text-muted)] mb-2">{subtitulo}</p>
    {reunioes.length === 0 ? (
      <p className="text-[10px] text-[var(--color-v4-text-muted)] py-2">Vazio.</p>
    ) : (
      <div className="space-y-1.5 max-h-[260px] overflow-y-auto">
        {reunioes.slice(0, 12).map(r => (
          <div key={r.id} className="bg-[var(--color-v4-card)] rounded p-2 border border-[var(--color-v4-border)]/40">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-white font-medium truncate flex-1">{r.empresa}</span>
              {renderExtra && renderExtra(r)}
            </div>
            <div className="flex items-center justify-between gap-2 mt-1 text-[10px] text-[var(--color-v4-text-muted)]">
              <span className="truncate">
                {r.sdr?.name?.split(' ')[0] || '—'}
                {r.closer && <> · <span className="text-blue-400">{r.closer.name.split(' ')[0]}</span></>}
              </span>
              <span className="text-white whitespace-nowrap">{renderHora(r)}</span>
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
);

const CardTransicoes: React.FC<{
  icon: React.ReactNode;
  titulo: string;
  changes: any[];
  memberName: (id?: string | null) => string;
  color: string;
}> = ({ icon, titulo, changes, memberName, color }) => (
  <div className="bg-[var(--color-v4-bg)] rounded-lg p-3">
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <h4 className={`text-xs font-bold ${color}`}>{titulo}</h4>
      <span className="text-[var(--color-v4-text-muted)] text-xs">({changes.length})</span>
    </div>
    {changes.length === 0 ? (
      <p className="text-[10px] text-[var(--color-v4-text-muted)] py-2">Vazio.</p>
    ) : (
      <div className="space-y-1 max-h-[160px] overflow-y-auto">
        {changes.map(c => (
          <div key={c.deal_id + c.mudou_em} className="text-[11px] text-white flex items-center justify-between">
            <span className="truncate flex-1">{c.empresa}</span>
            <span className="text-[var(--color-v4-text-muted)] whitespace-nowrap ml-2">
              {memberName(c.mudou_por)}
              {(c.valor_recorrente || c.valor_escopo) && (
                <span className="text-green-400 ml-1">
                  · {fmtBRL((Number(c.valor_recorrente) || 0) + (Number(c.valor_escopo) || 0))}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
);
