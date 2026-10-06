import { useState } from 'react';
import { ChevronDown, Clock, Loader2, Cpu } from 'lucide-react';
import type { Job } from '../lib/jobsRepo';
import { jobsRepo } from '../lib/jobsRepo';
import type { FilaMotorInfo } from '../lib/motorClient';

// Painel "Fila do motor": o que está rodando, o que está na fila (com posição),
// capacidade por fase e os gargalos compartilhados (busca web, headless, Meta).
// Lê os jobs do banco (Realtime) e o /api/health — nunca o status da aba.
const FASE_LABEL: Record<string, string> = { f2: 'F2 Qualificação', f3: 'F3 Diagnóstico', f4: 'F4 Anúncios', all: 'Esteira completa' };
const FASE_CURTA: Record<string, string> = { f2: 'F2', f3: 'F3', f4: 'F4', all: 'F2–F4' };

const seg = (iso: string | null, agora: number) => (iso ? Math.max(0, Math.round((agora - new Date(iso).getTime()) / 1000)) : 0);
const fmtDur = (s: number) => (s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

export function FilaMotor({
  jobs,
  nomeDe,
  info,
  worker,
  agora,
  mediaSeg,
}: {
  jobs: Job[];
  nomeDe: (leadId: string) => string | null;
  info: FilaMotorInfo | null;
  worker: boolean | null;
  agora: number;
  /** duração média (s) por fase na última hora — pra estimar a espera */
  mediaSeg: Record<string, number | null>;
}) {
  const [aberto, setAberto] = useState(true);
  const rodando = jobs.filter((j) => j.status === 'running');
  const pendentes = jobs.filter((j) => j.status === 'pending');
  if (worker === false) return null;
  if (!rodando.length && !pendentes.length) return null;
  const fases = ['f2', 'f3', 'f4', 'all'].filter((f) => (info?.capacidade?.[f] ?? 0) > 0 || jobs.some((j) => j.fase === f));
  const batida = info?.ultimoTick ? seg(info.ultimoTick, agora) : null;
  const motorVivo = batida != null && batida < 30;
  const cooldown = info?.meta?.cooldownAte ? new Date(info.meta.cooldownAte) : null;
  const previsao = (f: string) => {
    const cap = info?.capacidade?.[f] ?? 1;
    const n = pendentes.filter((j) => j.fase === f).length;
    const m = mediaSeg[f];
    if (!n || !m) return null;
    return fmtDur(Math.round((n / Math.max(1, cap)) * m));
  };

  return (
    <div className="mb-3 max-w-3xl rounded-xl border border-[#3b82f6]/50 bg-[rgba(59,130,246,0.08)] text-xs text-v4-text">
      <button onClick={() => setAberto((v) => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
        <Loader2 size={14} className="shrink-0 animate-spin text-[#3b82f6]" />
        <span className="flex-1">
          <b>Fila do motor</b> — {rodando.length} rodando · {pendentes.length} na fila
          {info ? ` · capacidade ${fases.map((f) => `${FASE_CURTA[f]} ${info.rodando?.[f] ?? 0}/${info.capacidade?.[f] ?? 0}`).join(' · ')}` : ''}
        </span>
        <span className={`inline-flex items-center gap-1 ${motorVivo ? 'text-v4-success' : info ? 'text-v4-warning' : 'text-v4-text-muted'}`} title={info?.workerId ?? ''}>
          <Cpu size={12} /> {motorVivo ? 'motor ativo' : info ? `sem batida há ${batida} s` : 'lendo o motor…'}
        </span>
        <ChevronDown size={14} className={`transition ${aberto ? 'rotate-180' : ''}`} />
      </button>
      {aberto && (
        <div className="grid gap-3 border-t border-[#3b82f6]/30 px-4 py-3 md:grid-cols-2">
          <div>
            <p className="mb-1 font-semibold">Rodando agora</p>
            {rodando.length === 0 && <p className="text-v4-text-muted">nada — a fila anda no próximo tick (2 s)</p>}
            <ul className="space-y-1">
              {rodando.map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <Loader2 size={11} className="shrink-0 animate-spin text-v4-warning" />
                  <span className="truncate">{nomeDe(j.leadId) ?? <i className="text-v4-text-muted">outro projeto</i>}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-v4-text-muted">
                    {FASE_CURTA[j.fase]} · há {fmtDur(seg(j.startedAt, agora))}{j.attempts > 1 ? ` · ${j.attempts}ª tentativa` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-1 font-semibold">Na fila</p>
            {pendentes.length === 0 && <p className="text-v4-text-muted">vazia</p>}
            <ul className="space-y-1">
              {pendentes.slice(0, 12).map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <Clock size={11} className="shrink-0 text-[#3b82f6]" />
                  <span className="truncate">{nomeDe(j.leadId) ?? <i className="text-v4-text-muted">outro projeto</i>}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-v4-text-muted">{FASE_CURTA[j.fase]} · {jobsRepo.posicao(j, jobs)}º</span>
                </li>
              ))}
              {pendentes.length > 12 && <li className="text-v4-text-muted">… e mais {pendentes.length - 12}</li>}
            </ul>
            {fases.map((f) => previsao(f)).some(Boolean) && (
              <p className="mt-1.5 text-v4-text-muted">
                Previsão: {fases.map((f) => (previsao(f) ? `${FASE_LABEL[f]} ≈ ${previsao(f)}` : null)).filter(Boolean).join(' · ')}
                {' '}(média da última hora ÷ capacidade)
              </p>
            )}
          </div>
          {info && (
            <p className="md:col-span-2 border-t border-[#3b82f6]/20 pt-2 font-mono text-[11px] text-v4-text-muted">
              busca web: {info.busca.naFila} na fila, {info.busca.rodando} rodando (1 a cada {(info.busca.intervaloMs / 1000).toFixed(1)} s — limite do Brave) · headless: {info.headless.ativos}/{info.headless.max} ativos, {info.headless.esperando} esperando · Meta: {cooldown ? `em cooldown até ${cooldown.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : info.meta.proxy ? 'via proxy' : `${info.meta.usadoHoje}/${info.meta.cap} hoje (IP direto)`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
