import { Fragment, useState, useEffect, useRef } from 'react';
import PQueue from 'p-queue';
import toast from 'react-hot-toast';
import { Filter, Check, ArrowRight, ChevronDown, X, Play, Loader2, CheckCircle2, AlertCircle, Circle, Sparkles, FolderOpen, UploadCloud, ArrowLeft, Trash2 } from 'lucide-react';
import {
  useProjetos,
  finalizarImportacao,
  atualizarProjeto,
  excluirProjeto,
  ARQ,
  SEGMENTO,
  PERFIS,
  type WfLead,
  type AuditStatus,
  type Projeto,
} from '../lib/projectsStore';
import { parseSpreadsheet } from '../lib/parseSpreadsheet';
import { buildLeadsFromRows } from '../lib/importPipeline';
import { runAnuncios, enrichQualificacao, enrichDiagnostico, type FaseResult } from '../lib/enrichService';
import { leadsRepo } from '../lib/leadsRepo';
import { registrarErro } from '../lib/errorLog';
import { formatCnpj } from '../lib/validation';
import type { Lead } from '../types';
import { LeadDetail } from './LeadDetail';

// WORKFLOW = FUNIL de aprovação por PROJETO (dados FICTÍCIOS pra validar o conceito).
// Largo em cima → afunila até o arquiteto. Clicar num F abre a lista de leads
// daquela fase; clicar num lead abre o painel com os menus auditados/ a auditar.
// A cada aprovação, o lead avança pro próximo F.

const SEG = SEGMENTO;
const DESDE_ARQUITETO = 2; // atalho pro arquiteto liberado a partir do F3 (Diagnóstico digital)

interface Etapa {
  f: string;
  nome: string;
  auditado: string; // o que é auditado nesta fase
}

const ETAPAS: Etapa[] = [
  { f: 'F1', nome: 'Triagem', auditado: 'CNPJ, situação cadastral e ramo de atuação' },
  { f: 'F2', nome: 'Qualificação', auditado: 'organograma, porte/faturamento, decisor e contatos (2 fontes)' },
  { f: 'F3', nome: 'Diagnóstico digital', auditado: 'site, presença digital, empreendimentos e LPs' },
  { f: 'F4', nome: 'Anúncios & mídia paga', auditado: 'Meta + Google: criativos, destino, análise do GT' },
  { f: 'F5', nome: 'Redes sociais', auditado: 'Instagram/YouTube: seguidores, engajamento, resposta' },
  { f: 'F6', nome: 'Cliente oculto', auditado: 'atendimento real via WhatsApp' },
  { f: 'F7', nome: 'Pronto p/ arquiteto', auditado: 'narrativa, cadências e envio pro Kommo' },
];

// Status de auditoria de cada lead: verde (auditado) · amarelo (em andamento) ·
// vermelho (erro ao auditar) · cinza/undefined (na fila). O "play" atualiza em
// tempo real conforme audita cada lead.
const STATUS_META: Record<AuditStatus, { label: string; cor: string }> = {
  ok: { label: 'Auditado', cor: 'text-v4-success' },
  run: { label: 'Auditando', cor: 'text-v4-warning' },
  erro: { label: 'Erro ao auditar', cor: 'text-v4-error' },
};

function StatusIcone({ status, size = 16 }: { status?: AuditStatus; size?: number }) {
  if (status === 'ok') return <CheckCircle2 size={size} className="text-v4-success" />;
  if (status === 'run') return <Loader2 size={size} className="animate-spin text-v4-warning" />;
  if (status === 'erro') return <AlertCircle size={size} className="text-v4-error" />;
  return <Circle size={size} className="text-v4-text-disabled" />;
}
// Execução POR FASE do funil (1 fase por vez). Cada fase executável tem uma
// função que roda o enriquecimento REAL daquele lead (idempotente lá no service).
// F4 vive no service (runAnuncios): mede o Meta e re-gera o briefing com os
// dados de mídia — só marca ok com a medição realmente gravada.
const EXEC: Record<number, { label: string; verbo: string; run: (lead: Lead) => Promise<FaseResult> }> = {
  1: { label: 'Qualificação', verbo: 'qualificando (DataStone + Lemit)', run: enrichQualificacao },
  2: { label: 'Diagnóstico digital', verbo: 'diagnosticando (site, empreend., GMN, briefing)', run: enrichDiagnostico },
  3: { label: 'Anúncios (Meta)', verbo: 'medindo anúncios no Meta', run: runAnuncios },
};

// Console ao vivo no RODAPÉ — executa UMA fase, um lead por vez, e narra em tempo real.
interface LogLinha {
  empresa: string;
  msg: string;
  ok: boolean;
}
function PlayAudit({
  fase,
  leads,
  onDone,
  onClose,
  onLeadStatus,
}: {
  fase: number;
  leads: WfLead[];
  onDone: () => void;
  onClose: () => void;
  onLeadStatus: (id: string, status: AuditStatus) => void;
}) {
  const exec = EXEC[fase];
  const [logs, setLogs] = useState<LogLinha[]>([]);
  const [atual, setAtual] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      for (const wf of leads) {
        if (cancelado) return;
        setAtual(wf.empresa);
        onLeadStatus(wf.id, 'run');
        try {
          const lead = await leadsRepo.get(wf.id);
          if (!lead) {
            onLeadStatus(wf.id, 'erro');
            setLogs((p) => [...p, { empresa: wf.empresa, msg: 'lead não encontrado', ok: false }]);
            void registrarErro({
              etapa: exec.label, empresa: wf.empresa, cnpj: wf.cnpj,
              mensagem: 'lead não encontrado no repositório',
            });
            continue;
          }
          const r = await exec.run(lead);
          if (r.ok) {
            onLeadStatus(wf.id, 'ok');
            setLogs((p) => [...p, { empresa: wf.empresa, msg: r.resumo ?? 'ok', ok: true }]);
          } else {
            onLeadStatus(wf.id, 'erro');
            setLogs((p) => [...p, { empresa: wf.empresa, msg: `falhou${r.note ? ` (${r.note})` : ''}`, ok: false }]);
            void registrarErro({
              etapa: exec.label, empresa: wf.empresa, cnpj: wf.cnpj,
              mensagem: `auditoria falhou${r.note ? ` (${r.note})` : ''}`,
              detalhe: { resumo: r.resumo ?? null, note: r.note ?? null },
            });
          }
        } catch (e) {
          onLeadStatus(wf.id, 'erro');
          setLogs((p) => [...p, { empresa: wf.empresa, msg: e instanceof Error ? e.message : 'erro', ok: false }]);
          void registrarErro({
            etapa: exec.label, empresa: wf.empresa, cnpj: wf.cnpj,
            mensagem: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!cancelado) {
        setAtual(null);
        setDone(true);
        onDone();
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed bottom-0 left-60 right-0 z-40 border-t border-v4-red bg-[#0d0d0d] px-4 py-3 font-mono text-[11px] shadow-[0_-6px_24px_rgba(230,57,70,0.18)]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <span className="rounded bg-v4-red px-1.5 py-0.5 text-[10px] font-bold text-white">{ETAPAS[fase].f}</span>
          <span className="text-v4-text">{exec.label}</span>
          <span className={`flex items-center gap-1 ${done ? 'text-v4-success' : 'text-[#3b82f6]'}`}>
            {done ? <Check size={13} /> : <Loader2 size={13} className="animate-spin" />}
            {done ? 'Concluído' : 'Executando (1 por vez)…'}
          </span>
        </span>
        <button onClick={onClose} className="text-v4-text-muted hover:text-v4-red" title="Fechar console">
          <X size={14} />
        </button>
      </div>
      <div className="max-h-40 space-y-1 overflow-y-auto">
        {logs.map((l, i) => (
          <p key={i} className="text-v4-text-muted">
            <span className={l.ok ? 'text-v4-success' : 'text-v4-error'}>{l.ok ? '✓' : '✕'}</span>{' '}
            <span className="text-v4-text-disabled">[{l.empresa.split(' ')[0]}]</span>{' '}
            <span className={l.ok ? 'text-v4-text' : 'text-v4-error'}>{l.msg}</span>
          </p>
        ))}
        {atual && (
          <p className="animate-pulse text-[#60a5fa]">
            <Loader2 size={11} className="mr-1 inline animate-spin" />
            <span className="text-v4-text-disabled">[{atual.split(' ')[0]}]</span> {exec.verbo}…
          </p>
        )}
        {done && (
          <p className="border-t border-v4-border pt-2 text-[10px] text-v4-text-disabled">
            {leads.length} lead{leads.length !== 1 ? 's' : ''} processado{leads.length !== 1 ? 's' : ''} no {ETAPAS[fase].f}.
          </p>
        )}
      </div>
    </div>
  );
}

export function WorkflowView({
  projetoInicial,
  onConsumirInicial,
}: {
  projetoInicial?: string | null;
  onConsumirInicial?: () => void;
}) {
  const projetos = useProjetos();
  const [selId, setSelId] = useState<string | null>(() => sessionStorage.getItem('wf_sel'));
  const [leads, setLeads] = useState<WfLead[]>([]);
  const [openF, setOpenF] = useState<number | null>(null);
  const [runToken, setRunToken] = useState(0); // força reinício do console
  const [execFase, setExecFase] = useState<number | null>(null); // fase executando (1=F2,2=F3,3=F4)
  const [execId, setExecId] = useState<string | null>(null); // lead executando (1 por vez)
  const [autoFase, setAutoFase] = useState<number | null>(null); // fase em modo automático (1 por vez)
  const [openLead, setOpenLead] = useState<string | null>(null); // menu suspenso do lead (dados auditados)
  const [voltarMenu, setVoltarMenu] = useState<string | null>(null); // lead com o seletor "voltar p/ fase" aberto
  // status da execução por fase — chave `${fase}:${id}`; persiste no projeto.
  const [execStatus, setExecStatus] = useState<Record<string, AuditStatus>>({});

  const projeto = selId ? projetos.find((p) => p.id === selId) ?? null : null;
  const importada = !!projeto?.importada;

  // preserva o projeto aberto ao navegar (ex.: abrir o LeadDetail e voltar)
  useEffect(() => {
    if (selId) sessionStorage.setItem('wf_sel', selId);
    else sessionStorage.removeItem('wf_sel');
  }, [selId]);

  // abre direto o projeto recém-criado
  useEffect(() => {
    if (projetoInicial) {
      setSelId(projetoInicial);
      onConsumirInicial?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projetoInicial]);

  // carrega os dados do projeto ao abrir/importar
  useEffect(() => {
    const p = selId ? projetos.find((x) => x.id === selId) : null;
    if (p?.importada) {
      setLeads(p.leads);
      setExecStatus(p.leadStatus ?? {});
    } else {
      setLeads([]);
      setExecStatus({});
    }
    setOpenF(null);
    setExecFase(null);
    setExecId(null);
    setAutoFase(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, importada]);

  // persiste no store a cada mudança do funil (execStatus vai no campo leadStatus)
  useEffect(() => {
    if (selId && importada) atualizarProjeto(selId, { leads, leadStatus: execStatus });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, execStatus]);

  const stOf = (fase: number, id: string) => execStatus[`${fase}:${id}`];
  const setSt = (fase: number, id: string, status: AuditStatus) =>
    setExecStatus((prev) => (prev[`${fase}:${id}`] === status ? prev : { ...prev, [`${fase}:${id}`]: status }));
  // status mostrado na linha: F1 (Triagem) = validado no import; fases executáveis = execStatus.
  const statusLinha = (l: WfLead): AuditStatus | undefined => (l.etapa === 0 ? 'ok' : stOf(l.etapa, l.id));

  // ── F4 automático ──────────────────────────────────────────────────────────
  // Lead que chega em Anúncios (F4) entra SOZINHO na fila de medição do Meta —
  // 1 por vez, com a cadência anti-ban (~40s) — sem precisar clicar em nada.
  // Com o runAnuncios exigindo o meta gravado, "Auditado" só aparece após medir.
  // Erro NÃO re-entra sozinho (evita loop de ban): re-tenta pelo botão da fase.
  const adsAutoQueue = useRef(new PQueue({ concurrency: 1, interval: 40_000, intervalCap: 1 }));
  const enfileirados = useRef(new Set<string>());
  const selIdAtual = useRef(selId);
  useEffect(() => {
    // troca de projeto: esvazia a fila pendente (não mistura execStatus)
    selIdAtual.current = selId;
    adsAutoQueue.current.clear();
    enfileirados.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);
  useEffect(() => {
    if (!selId || !importada) return;
    const projetoDaFila = selId;
    for (const l of leads) {
      if (l.etapa !== 3 || l.descartado) continue;
      if (stOf(3, l.id) || enfileirados.current.has(l.id)) continue; // já rodou/rodando/na fila
      enfileirados.current.add(l.id);
      void adsAutoQueue.current.add(async () => {
        if (projetoDaFila !== selIdAtual.current) return; // projeto trocou no meio — descarta
        setSt(3, l.id, 'run');
        try {
          const lead = await leadsRepo.get(l.id);
          const r: FaseResult = lead ? await runAnuncios(lead) : { ok: false, note: 'lead não encontrado' };
          setSt(3, l.id, r.ok ? 'ok' : 'erro');
          if (!r.ok) {
            void registrarErro({
              etapa: 'Anúncios (Meta) — automático', empresa: l.empresa, cnpj: l.cnpj,
              mensagem: `medição automática falhou${r.note ? ` (${r.note})` : ''}`,
            });
          }
        } catch (e) {
          setSt(3, l.id, 'erro');
          void registrarErro({
            etapa: 'Anúncios (Meta) — automático', empresa: l.empresa, cnpj: l.cnpj,
            mensagem: e instanceof Error ? e.message : String(e),
          });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, selId, importada]);

  // Executa UMA fase de UM lead (manual). Bloqueia se já houver execução ou auto ligado.
  const executarLead = (l: WfLead, fase: number) => {
    if (execId || autoFase != null) return;
    setExecFase(fase);
    setExecId(l.id);
    setRunToken((t) => t + 1);
  };

  // Auto-runner: com autoFase ligado e nada executando, pega o próximo lead da fase
  // ainda não processado (ordem da lista) e executa — 1 por vez, nunca em lote.
  useEffect(() => {
    if (autoFase == null || execId) return;
    const prox = leads.find((l) => l.etapa === autoFase && !l.descartado && !execStatus[`${autoFase}:${l.id}`]);
    if (prox) {
      setExecFase(autoFase);
      setExecId(prox.id);
      setRunToken((t) => t + 1);
    } else {
      setAutoFase(null); // acabou a fila da fase
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFase, execId, leads, execStatus]);

  // Volta o lead para uma fase anterior escolhida e limpa os status daquela
  // fase em diante — as auditorias re-rodam (o F4 automático re-entra sozinho).
  const voltarPara = (id: string, alvo: number) => {
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, etapa: alvo, parcial: false, auditadoAte: undefined } : l)),
    );
    setExecStatus((prev) => {
      const next = { ...prev };
      for (let f = alvo; f < ETAPAS.length; f++) delete next[`${f}:${id}`];
      return next;
    });
    enfileirados.current.delete(id);
  };

  const avancar = (id: string) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, etapa: Math.min(l.etapa + 1, ETAPAS.length - 1) } : l)));
  };
  // Seleção por checkbox — permite avançar VÁRIOS leads de uma fase de uma vez.
  const [marcados, setMarcados] = useState<Record<string, boolean>>({});
  const toggleMarcado = (id: string) => setMarcados((prev) => ({ ...prev, [id]: !prev[id] }));
  const marcarFase = (fase: number, on: boolean) =>
    setMarcados((prev) => {
      const next = { ...prev };
      leads.forEach((l) => {
        if (l.etapa === fase && !l.descartado) next[l.id] = on;
      });
      return next;
    });
  const avancarSelecionados = (fase: number) => {
    if (fase >= ETAPAS.length - 1) return;
    setLeads((prev) => prev.map((l) => (l.etapa === fase && marcados[l.id] && !l.descartado ? { ...l, etapa: l.etapa + 1 } : l)));
    setMarcados((prev) => {
      const next = { ...prev };
      leads.forEach((l) => {
        if (l.etapa === fase) delete next[l.id];
      });
      return next;
    });
  };
  const aprovarFase = (fase: number) => {
    if (fase >= ETAPAS.length - 1) return;
    setLeads((prev) => prev.map((l) => (l.etapa === fase && !l.descartado ? { ...l, etapa: l.etapa + 1 } : l)));
  };
  const descartar = (id: string) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, descartado: true } : l)));
  };
  const restaurar = (id: string) => setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, descartado: false } : l)));
  const enviarArquiteto = (id: string) => {
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, auditadoAte: l.etapa, etapa: ARQ, parcial: true } : l)));
  };
  const enviarFaseArquiteto = (fase: number) => {
    setLeads((prev) => prev.map((l) => (l.etapa === fase && !l.descartado ? { ...l, auditadoAte: fase, etapa: ARQ, parcial: true } : l)));
  };
  const descartados = leads.filter((l) => l.descartado);
  const execLeadObj = execId ? leads.find((l) => l.id === execId) ?? null : null;
  const execRodando = execFase != null || autoFase != null;

  // Sem projeto selecionado → grade de projetos
  if (!selId || !projeto) {
    return <ProjetosGrid projetos={projetos} onOpen={setSelId} />;
  }
  // Projeto sem lista → tela de importação (drag & drop)
  if (!projeto.importada) {
    return <ImportarListaTela projeto={projeto} onVoltar={() => setSelId(null)} />;
  }

  return (
    <div className={`p-6 md:p-8 ${execId ? 'pb-56' : ''}`}>
      <button onClick={() => setSelId(null)} className="mb-3 flex items-center gap-1.5 text-xs text-v4-text-muted transition hover:text-v4-red">
        <ArrowLeft size={14} /> Projetos
      </button>
      <h1 className="mb-1 flex items-center gap-2 font-display text-2xl font-bold text-v4-text">
        <Filter size={24} className="text-v4-red" /> {projeto.nome}
        <span className="rounded-full border border-v4-border px-2.5 py-0.5 text-[11px] font-medium text-v4-text-muted">
          {PERFIS[projeto.perfil]?.label ?? projeto.perfil}
        </span>
      </h1>
      <p className="mb-6 max-w-3xl text-sm text-v4-text-muted">
        Funil de aprovação — <b className="text-v4-text">{leads.length}</b> leads importados. Clique num{' '}
        <b>F</b> para abrir a lista da fase e no <b>play</b> lateral para auditar em tempo real. A cada{' '}
        <b>aprovação</b>, os leads avançam pro próximo F — chegando menos leads, porém mais certos, nas fases caras.
      </p>

      <div className="space-y-2">
        {ETAPAS.map((e, i) => {
          const aqui = leads.filter((l) => l.etapa === i && !l.descartado);
          const nOk = aqui.filter((l) => statusLinha(l) === 'ok').length;
          const nRun = aqui.filter((l) => statusLinha(l) === 'run').length;
          const nErro = aqui.filter((l) => statusLinha(l) === 'erro').length;
          const aberto = openF === i;
          const width = `${100 - i * 9}%`; // afunila: 100% → ~46%
          const ultima = i === ETAPAS.length - 1;
          const nSel = aqui.filter((l) => marcados[l.id]).length;
          return (
            <Fragment key={i}>
              {/* Faixa do funil + botão de play na lateral direita */}
              <div style={{ width }} className="mx-auto flex items-center gap-2">
                <button
                  onClick={() => {
                    setOpenF(aberto ? null : i);
                  }}
                  className={`flex flex-1 items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition ${
                    aberto ? 'border-v4-red bg-v4-card shadow-[0_0_16px_rgba(230,57,70,0.2)]' : 'border-v4-border bg-v4-card hover:border-v4-red'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-v4-text">
                      <span className="rounded bg-v4-red px-1.5 py-0.5 text-[11px] font-bold text-white">{e.f}</span>
                      {e.nome}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-v4-text-muted">Audita: {e.auditado}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {(nOk > 0 || nRun > 0 || nErro > 0) && (
                      <span className="flex items-center gap-2 rounded-full bg-v4-surface px-2.5 py-1 text-[11px] font-medium">
                        {nOk > 0 && (
                          <span className="flex items-center gap-0.5 text-v4-success">
                            <CheckCircle2 size={13} /> {nOk}
                          </span>
                        )}
                        {nRun > 0 && (
                          <span className="flex items-center gap-0.5 text-v4-warning">
                            <Loader2 size={13} className="animate-spin" /> {nRun}
                          </span>
                        )}
                        {nErro > 0 && (
                          <span className="flex items-center gap-0.5 text-v4-error">
                            <AlertCircle size={13} /> {nErro}
                          </span>
                        )}
                      </span>
                    )}
                    <span className="rounded-full bg-v4-surface px-2.5 py-1 text-sm font-bold text-v4-text">{aqui.length}</span>
                    <ChevronDown size={16} className={`text-v4-text-muted transition ${aberto ? 'rotate-180' : ''}`} />
                  </div>
                </button>
              </div>

              {/* Lista de leads da fase (o funil "se abre") */}
              {aberto && (
                <div className="rounded-2xl border border-v4-red bg-v4-card p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-v4-text">
                      {e.f} · {e.nome} — {aqui.length} lead{aqui.length !== 1 ? 's' : ''}
                    </span>
                    {aqui.length > 0 && (
                      <div className="flex items-center gap-2">
                        {EXEC[i] && (
                          <button
                            onClick={() => setAutoFase((v) => (v === i ? null : i))}
                            disabled={(execRodando && autoFase !== i)}
                            title={`Executar ${EXEC[i].label} de TODOS os leads desta fase automaticamente — 1 por vez, em ordem, sem clicar em cada um`}
                            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                              autoFase === i
                                ? 'border-[#3b82f6] bg-[rgba(59,130,246,0.12)] text-[#3b82f6]'
                                : execRodando
                                  ? 'cursor-not-allowed border-v4-border text-v4-text-disabled'
                                  : 'border-v4-red text-v4-red hover:bg-[rgba(230,57,70,0.12)]'
                            }`}
                          >
                            {autoFase === i ? <><Loader2 size={13} className="animate-spin" /> Rodando todos… (parar)</> : <><Play size={13} /> Auditar todos (auto, 1 por vez)</>}
                          </button>
                        )}
                        {i >= DESDE_ARQUITETO && i < ARQ && (
                          <button
                            onClick={() => enviarFaseArquiteto(i)}
                            title="Enviar todos os leads desta fase direto ao arquiteto (enriquecimento parcial)"
                            className="flex items-center gap-1.5 rounded-lg border border-v4-red px-3 py-1.5 text-xs font-medium text-v4-red transition hover:bg-[rgba(230,57,70,0.12)]"
                          >
                            <Sparkles size={13} /> Enviar fase pro arquiteto
                          </button>
                        )}
                        {!ultima && (
                          <button
                            onClick={() => avancarSelecionados(i)}
                            disabled={nSel === 0}
                            title={nSel === 0 ? 'Marque leads no checkbox da lista para avançar em grupo' : `Avançar ${nSel} lead(s) selecionado(s) para ${ETAPAS[i + 1].f} · ${ETAPAS[i + 1].nome}`}
                            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                              nSel === 0
                                ? 'cursor-not-allowed border-v4-border text-v4-text-disabled'
                                : 'border-v4-success text-v4-success hover:bg-[rgba(34,197,94,0.12)]'
                            }`}
                          >
                            <ArrowRight size={13} /> Avançar selecionados{nSel > 0 ? ` (${nSel})` : ''}
                          </button>
                        )}
                        {!ultima && (
                          <button
                            onClick={() => aprovarFase(i)}
                            className="flex items-center gap-1.5 rounded-lg border border-v4-success px-3 py-1.5 text-xs font-medium text-v4-success transition hover:bg-[rgba(34,197,94,0.12)]"
                          >
                            <Check size={13} /> Aprovar todos e avançar
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {aqui.length === 0 ? (
                    <p className="py-4 text-center text-sm text-v4-text-disabled">Nenhum lead nesta fase.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-v4-border text-left text-[11px] uppercase tracking-wide text-v4-text-disabled">
                            <th className="px-2 py-2">
                              <input
                                type="checkbox"
                                checked={aqui.length > 0 && aqui.every((l) => marcados[l.id])}
                                onChange={(ev) => marcarFase(i, ev.target.checked)}
                                title="Marcar/desmarcar todos os leads desta fase"
                                className="h-3.5 w-3.5 cursor-pointer accent-v4-red"
                              />
                            </th>
                            <th className="px-2 py-2">Score</th>
                            <th className="px-2 py-2">Empresa</th>
                            <th className="px-2 py-2">Segmento</th>
                            <th className="px-2 py-2">UF</th>
                            <th className="px-2 py-2">Situação</th>
                            <th className="px-2 py-2">Auditoria</th>
                            <th className="px-2 py-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {aqui.map((l) => (
                            <Fragment key={l.id}>
                              <tr
                                onClick={() => setOpenLead((cur) => (cur === l.id ? null : l.id))}
                                title="Ver dados auditados (abre/recolhe aqui mesmo)"
                                className={`cursor-pointer border-b border-v4-border/60 transition hover:bg-v4-surface ${openLead === l.id ? 'bg-v4-surface' : ''}`}
                              >
                                <td className="px-2 py-2.5" onClick={(ev) => ev.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={!!marcados[l.id]}
                                    onChange={() => toggleMarcado(l.id)}
                                    title="Selecionar este lead para avançar em grupo"
                                    className="h-3.5 w-3.5 cursor-pointer accent-v4-red"
                                  />
                                </td>
                                <td className="px-2 py-2.5 font-display font-bold text-v4-text">{l.score}</td>
                                <td className="px-2 py-2.5">
                                  <p className="flex items-center gap-1.5 font-medium text-v4-text">
                                    {l.empresa}
                                    {l.parcial && (
                                      <span className="rounded bg-[rgba(250,204,21,0.15)] px-1.5 py-0.5 text-[10px] font-semibold text-v4-warning" title="Enviado ao arquiteto com enriquecimento parcial">
                                        parcial
                                      </span>
                                    )}
                                  </p>
                                  <p className="text-[11px] text-v4-text-disabled">{l.cnpj}</p>
                                </td>
                                <td className="px-2 py-2.5 text-xs text-v4-text-muted">{l.segmento ?? SEG}</td>
                                <td className="px-2 py-2.5 text-v4-text-muted">{l.uf}</td>
                                <td className="px-2 py-2.5">
                                  <span className="rounded bg-[rgba(34,197,94,0.15)] px-2 py-0.5 text-xs text-v4-success">ATIVA</span>
                                </td>
                                <td className="px-2 py-2.5">
                                  {(() => {
                                    const s = statusLinha(l);
                                    return (
                                      <span className={`flex items-center gap-1.5 text-xs ${s ? STATUS_META[s].cor : 'text-v4-text-disabled'}`}>
                                        <StatusIcone status={s} />
                                        {s ? STATUS_META[s].label : 'Na fila'}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td className="whitespace-nowrap px-2 py-2.5 text-right">
                                  {EXEC[i] && (() => {
                                    const rodandoEste = execId === l.id && execFase === i;
                                    const st = stOf(i, l.id);
                                    const ocupado = execRodando && !rodandoEste;
                                    const btnLabel = i === 1 ? 'Qualificar' : i === 2 ? 'Diagnosticar' : 'Anúncios';
                                    const Icon = rodandoEste || st === 'run' ? Loader2 : st === 'ok' ? CheckCircle2 : st === 'erro' ? AlertCircle : Play;
                                    const cor = rodandoEste || st === 'run' ? 'border-[#3b82f6] text-[#3b82f6]' : st === 'ok' ? 'border-v4-success text-v4-success' : st === 'erro' ? 'border-v4-error text-v4-error hover:bg-[rgba(239,68,68,0.12)]' : ocupado ? 'cursor-not-allowed border-v4-border text-v4-text-disabled' : 'border-v4-red text-v4-red hover:bg-[rgba(230,57,70,0.12)]';
                                    return (
                                      <button
                                        onClick={(ev) => {
                                          ev.stopPropagation();
                                          executarLead(l, i);
                                        }}
                                        disabled={ocupado || rodandoEste}
                                        title={rodandoEste ? 'Executando…' : ocupado ? 'Aguarde (1 por vez / automático ligado)' : st === 'ok' ? `${EXEC[i].label} feito — clique pra refazer` : st === 'erro' ? 'Falhou — clique pra tentar de novo' : `Executar ${EXEC[i].label} só deste lead`}
                                        className={`mr-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition ${cor}`}
                                      >
                                        <Icon size={11} className={rodandoEste || st === 'run' ? 'animate-spin' : ''} /> {btnLabel}
                                      </button>
                                    );
                                  })()}
                                  {!ultima && (
                                    <button
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        avancar(l.id);
                                      }}
                                      title={`Passar para ${ETAPAS[i + 1].f} · ${ETAPAS[i + 1].nome}`}
                                      className="mr-2 inline-flex items-center gap-1 rounded-md border border-v4-success px-2 py-1 text-[11px] font-medium text-v4-success transition hover:bg-[rgba(34,197,94,0.12)]"
                                    >
                                      Avançar <ArrowRight size={11} />
                                    </button>
                                  )}
                                  {i >= DESDE_ARQUITETO && i < ARQ && (
                                    <button
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        enviarArquiteto(l.id);
                                      }}
                                      title="Enviar direto ao arquiteto agora (com o que já foi auditado)"
                                      className="mr-2 inline-flex items-center gap-1 rounded-md border border-v4-red px-2 py-1 text-[11px] font-medium text-v4-red transition hover:bg-[rgba(230,57,70,0.12)]"
                                    >
                                      <Sparkles size={11} /> Arquiteto
                                    </button>
                                  )}
                                  {i > 0 &&
                                    (voltarMenu === l.id ? (
                                      <span className="mr-2 inline-flex items-center gap-0.5 rounded-md border border-v4-warning/60 px-1.5 py-1 align-middle">
                                        <span className="text-[10px] text-v4-text-muted">Voltar p/</span>
                                        {ETAPAS.slice(0, i).map((et, alvo) => (
                                          <button
                                            key={et.f}
                                            onClick={(ev) => {
                                              ev.stopPropagation();
                                              voltarPara(l.id, alvo);
                                              setVoltarMenu(null);
                                            }}
                                            title={`Voltar para ${et.f} · ${et.nome} — limpa as auditorias de ${et.f} em diante para re-rodar`}
                                            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-v4-text-muted transition hover:bg-[rgba(230,57,70,0.15)] hover:text-v4-red"
                                          >
                                            {et.f}
                                          </button>
                                        ))}
                                        <button
                                          onClick={(ev) => {
                                            ev.stopPropagation();
                                            setVoltarMenu(null);
                                          }}
                                          title="Cancelar"
                                          className="ml-0.5 text-v4-text-disabled transition hover:text-v4-text"
                                        >
                                          <X size={10} />
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        onClick={(ev) => {
                                          ev.stopPropagation();
                                          setVoltarMenu(l.id);
                                        }}
                                        title="Voltar este lead para uma fase anterior (escolhe a fase; re-roda as auditorias dali em diante)"
                                        className="mr-2 inline-flex items-center gap-1 rounded-md border border-v4-border px-2 py-1 text-[11px] font-medium text-v4-text-muted transition hover:border-v4-warning hover:text-v4-warning"
                                      >
                                        <ArrowLeft size={11} /> Voltar
                                      </button>
                                    ))}
                                  <button
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      descartar(l.id);
                                    }}
                                    title="Descartar (tira do funil)"
                                    className="mr-2 inline-flex items-center gap-1 rounded-md border border-v4-border px-2 py-1 text-[11px] font-medium text-v4-text-muted transition hover:border-v4-error hover:text-v4-error"
                                  >
                                    Descartar <X size={11} />
                                  </button>
                                  <ChevronDown size={16} className={`inline text-v4-text-muted transition ${openLead === l.id ? 'rotate-180' : ''}`} />
                                </td>
                              </tr>
                              {openLead === l.id && (
                                <tr>
                                  <td colSpan={8} className="px-2 pb-3">
                                    <div className="rounded-xl border border-v4-red/40 bg-v4-surface p-3">
                                      <LeadDetail leadId={l.id} embedded />
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      {/* Descartados — reprovados, fora do funil (dá pra restaurar) */}
      {descartados.length > 0 && (
        <div className="mt-4 rounded-2xl border border-dashed border-v4-border bg-v4-card p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-v4-text-muted">
            <X size={16} /> Descartados ({descartados.length}) — fora do funil
          </p>
          <div className="flex flex-wrap gap-2">
            {descartados.map((l) => (
              <div key={l.id} className="flex items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-2.5 py-1.5 text-xs">
                <span className="text-v4-text line-through">{l.empresa}</span>
                <span className="text-v4-text-disabled">({ETAPAS[l.etapa].f})</span>
                <button onClick={() => restaurar(l.id)} className="text-v4-red-hover hover:underline">
                  restaurar
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Console de execução em tempo real — UMA fase, UM lead por vez */}
      {execLeadObj && execFase != null && (
        <PlayAudit
          key={`${execFase}:${execLeadObj.id}-${runToken}`}
          fase={execFase}
          leads={[execLeadObj]}
          onDone={() => {
            setExecId(null);
            setExecFase(null);
          }}
          onClose={() => {
            setAutoFase(null);
            setExecId(null);
            setExecFase(null);
          }}
          onLeadStatus={(id, status) => setSt(execFase, id, status)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grade de projetos (quando nenhum projeto está aberto no Workflow)
// ---------------------------------------------------------------------------
function ProjetosGrid({ projetos, onOpen }: { projetos: Projeto[]; onOpen: (id: string) => void }) {
  return (
    <div className="p-6 md:p-8">
      <h1 className="mb-1 flex items-center gap-2 font-display text-2xl font-bold text-v4-text">
        <Filter size={24} className="text-v4-red" /> Workflow — projetos
      </h1>
      <p className="mb-6 max-w-2xl text-sm text-v4-text-muted">
        Cada projeto tem sua lista e roda o funil de aprovação. Crie um no botão{' '}
        <b className="text-v4-red">NOVO PROJETO</b> e clique nele aqui para importar a lista.
      </p>

      {projetos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-v4-border py-16 text-center text-v4-text-muted">
          <FolderOpen size={40} />
          <p className="text-sm">Nenhum projeto ainda. Clique em <b className="text-v4-red">NOVO PROJETO</b> no menu lateral.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projetos.map((p) => {
            const noArquiteto = p.leads.filter((l) => l.etapa === ARQ).length;
            return (
              <div
                key={p.id}
                onClick={() => onOpen(p.id)}
                className="group cursor-pointer rounded-2xl border border-v4-border bg-v4-card p-5 transition hover:border-v4-red hover:shadow-[0_0_16px_rgba(230,57,70,0.15)]"
              >
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-v4-red/15 text-v4-red">
                    <FolderOpen size={20} />
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Excluir o projeto "${p.nome}"?`)) excluirProjeto(p.id);
                    }}
                    title="Excluir projeto"
                    className="text-v4-text-disabled opacity-0 transition group-hover:opacity-100 hover:text-v4-error"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <p className="font-display text-base font-semibold text-v4-text">{p.nome}</p>
                <p className="mt-0.5 text-[11px] text-v4-text-disabled">{PERFIS[p.perfil]?.label ?? p.perfil}</p>
                <p className="mt-1 text-xs text-v4-text-muted">
                  {p.importada ? `${p.leads.length} leads` : 'Sem lista — clique para importar'}
                </p>
                {p.importada && noArquiteto > 0 && (
                  <p className="mt-2 inline-flex items-center gap-1 rounded bg-[rgba(230,57,70,0.12)] px-2 py-0.5 text-[11px] font-medium text-v4-red">
                    <Sparkles size={11} /> {noArquiteto} no arquiteto
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Projeção de um Lead real para o card do funil.
function toWf(lead: Lead): WfLead {
  return {
    id: lead.id,
    score: lead.score ?? 0,
    empresa: lead.razaoSocial ?? lead.nomeFantasia ?? lead.companyNameRaw,
    cnpj: formatCnpj(lead.cnpj ?? lead.cnpjRaw),
    uf: lead.uf ?? '',
    segmento: lead.segmento ?? null,
    etapa: 0,
  };
}

// ---------------------------------------------------------------------------
// Tela de importação da lista (drag & drop) — pipeline REAL, igual ao "Importar lista":
// parse → valida na Receita → salva → enriquece (site, sócios, contatos, empreendimentos, GMN).
// ---------------------------------------------------------------------------
function ImportarListaTela({ projeto, onVoltar }: { projeto: Projeto; onVoltar: () => void }) {
  const [drag, setDrag] = useState(false);
  const [stage, setStage] = useState<'idle' | 'validando' | 'enriquecendo'>('idle');
  const [prog, setProg] = useState({ done: 0, total: 0 });

  const importar = async (file: File) => {
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
      toast.error('Formato não suportado. Use CSV ou XLSX.');
      return;
    }
    try {
      const res = parseSpreadsheet(await file.arrayBuffer());
      if (res.missingColumns.length) {
        toast.error(`Colunas obrigatórias ausentes: ${res.missingColumns.join(', ')}`);
        return;
      }
      if (!res.rows.length) {
        toast.error('Nenhuma linha encontrada na planilha.');
        return;
      }
      setStage('validando');
      setProg({ done: 0, total: res.rows.length });
      const built = await buildLeadsFromRows(res.rows, setProg);
      const selected = built.filter((l) => l.dataQuality !== 'invalido');
      if (!selected.length) {
        toast.error('Nenhum lead válido (todos com CNPJ inválido).');
        setStage('idle');
        return;
      }
      // No IMPORT roda só a TRIAGEM (F1): valida CNPJ/Receita e salva. As demais
      // fases (F2 Qualificação, F3 Diagnóstico, F4 Anúncios) rodam DENTRO do funil,
      // 1 por vez — pra auditar cada etapa. Sobrescreve por CNPJ.
      for (const l of selected) l.perfil = projeto.perfil; // perfil de auditoria do projeto
      await leadsRepo.upsertMany(selected);
      const wf = selected.map(toWf);
      finalizarImportacao(projeto.id, wf, {}); // sem status: as fases rodam no funil
      const desc = built.length - selected.length;
      toast.success(`${wf.length} leads na Triagem (F1)${desc > 0 ? ` · ${desc} inválidos descartados` : ''}. Agora rode as fases no funil.`);
    } catch (e) {
      toast.error(`Falha ao importar: ${e instanceof Error ? e.message : String(e)}`);
      setStage('idle');
    }
  };

  return (
    <div className="p-6 md:p-8">
      <button onClick={onVoltar} className="mb-3 flex items-center gap-1.5 text-xs text-v4-text-muted transition hover:text-v4-red">
        <ArrowLeft size={14} /> Projetos
      </button>
      <h1 className="mb-1 flex items-center gap-2 font-display text-2xl font-bold text-v4-text">
        <FolderOpen size={24} className="text-v4-red" /> {projeto.nome}
      </h1>
      <p className="mb-6 text-sm text-v4-text-muted">
        Importe a lista (CSV/XLSX). Os dados são validados na Receita e enriquecidos automaticamente — mesma qualidade do “Importar lista”.
      </p>

      {stage === 'idle' ? (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const file = e.dataTransfer.files?.[0];
            if (file) importar(file);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed py-20 text-center transition ${
            drag ? 'border-v4-red bg-[rgba(230,57,70,0.08)]' : 'border-v4-border hover:border-v4-red'
          }`}
        >
          <UploadCloud size={44} className={drag ? 'text-v4-red' : 'text-v4-text-muted'} />
          <p className="text-sm font-medium text-v4-text">Arraste a lista aqui ou clique para selecionar</p>
          <p className="text-xs text-v4-text-disabled">.csv ou .xlsx — validação na Receita + enriquecimento real</p>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importar(file);
            }}
          />
        </label>
      ) : (
        <div className="rounded-2xl border border-v4-border bg-v4-card p-8 text-center">
          <p className="mb-1 flex items-center justify-center gap-2 text-sm font-medium text-v4-text">
            <Loader2 size={16} className="animate-spin text-v4-red" />
            {stage === 'validando' ? 'Validando na Receita…' : 'Enriquecendo (site, sócios, contatos, empreendimentos, Google)…'}
          </p>
          <p className="mb-3 text-xs text-v4-text-muted">
            {prog.done} de {prog.total}
          </p>
          <div className="mx-auto h-2 w-full max-w-md overflow-hidden rounded-full bg-v4-surface">
            <div className="h-full bg-v4-red transition-all" style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} />
          </div>
          <p className="mt-3 text-[11px] text-v4-text-disabled">Anúncios (Meta) são medidos por lead no F4 — sob demanda, com proxy (anti-ban).</p>
        </div>
      )}
    </div>
  );
}
