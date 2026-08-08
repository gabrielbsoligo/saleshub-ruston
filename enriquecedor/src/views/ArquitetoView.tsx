import { useState } from 'react';
import {
  Sparkles,
  Mail,
  MessageCircle,
  Phone,
  ArrowLeft,
  ChevronDown,
  Copy,
  Clock,
  Users,
  AlertTriangle,
} from 'lucide-react';
import { useProjetos, ARQ, type Projeto, type WfLead } from '../lib/projectsStore';

// ===========================================================================
// ARQUITETO — entrega fictícia (modelo pra auditar a UX). Quando ligarmos os
// leads reais + as skills, este render recebe o plano gerado de verdade.
// Princípio: ESTRATÉGIA é da construtora; COMUNICAÇÃO é por decisor.
// ===========================================================================

type Gate = 'quentes' | 'todos';
type Canal = 'email' | 'whatsapp' | 'ligacao';

interface Decisor {
  nome: string;
  cargo: string;
  quente: boolean;
  angulo: string;
  gancho: string;
  email: { assunto: string; corpo: string }[];
  whatsapp: string[];
  ligacao: string;
}
interface Plano {
  tese: string;
  parcial: boolean;
  faltando: string[];
  decisores: Decisor[];
  cadencia: { dia: string; canal: Canal | 'social'; oque: string }[];
  sdr: string;
}

const PRIMEIRO_NOME = ['Ricardo', 'Ana', 'Marcelo', 'Patrícia', 'Eduardo', 'Camila'];

function montarPlano(lead: WfLead, gate: Gate): Plano {
  const marca = lead.empresa.split(' ')[0];
  const semAds = (lead.auditadoAte ?? lead.etapa) < 3; // não passou pelo F4
  const faltando: string[] = [];
  if (lead.parcial) {
    if (semAds) faltando.push('Anúncios & mídia paga (GT Meta/Google)', 'Análise estratégica completa');
    faltando.push('Redes sociais', 'Cliente oculto');
  }

  const tese = semAds
    ? `${marca}: incorporadora ativa em ${lead.uf} com presença digital funcional, porém captação dependente de canais orgânicos. Tese: destravar geração de lead qualificado antes do próximo lançamento. (base parcial — sem auditoria de mídia paga)`
    : `${marca}: investe em mídia paga (Meta + Google) mas perde conversão por rastreio incompleto e LP lenta no mobile. Tese: mesma verba, mais reunião — corrigir a base de conversão e reorganizar a mensagem por decisor.`;

  const nome = PRIMEIRO_NOME[Number(lead.id) % PRIMEIRO_NOME.length];
  const nome2 = PRIMEIRO_NOME[(Number(lead.id) + 3) % PRIMEIRO_NOME.length];

  const socio: Decisor = {
    nome,
    cargo: 'Sócio-administrador',
    quente: true,
    angulo: 'Dono do negócio — fala em dinheiro e risco.',
    gancho: semAds
      ? 'Dependência de indicação/orgânico trava a previsibilidade de vendas dos lançamentos.'
      : 'Verba de mídia rodando sem rastreio confiável = decisão no escuro e CAC inflado.',
    email: [
      {
        assunto: `${marca}: uma perda silenciosa`,
        corpo: `Olá {{decisor.primeiro_nome}}, olhei a operação digital da ${marca} e ${semAds ? 'vi que a captação hoje depende muito de orgânico/indicação' : 'notei que a mídia roda sem rastreio confiável de conversão'}. Isso significa lançamento entrando às cegas. Faz sentido eu te mostrar em 15 min onde está o furo e o quanto ele custa?`,
      },
      {
        assunto: 'reenvio — 2 números',
        corpo: `{{decisor.primeiro_nome}}, resumindo em 2 números o que encontrei na ${marca}: [gancho auditado]. Se fizer sentido, terça 10h ou quinta 15h?`,
      },
    ],
    whatsapp: [
      `Oi {{decisor.primeiro_nome}}, aqui é da V4. Fiz um diagnóstico rápido da presença digital da ${marca} e achei 1 ponto que impacta direto a venda dos lançamentos. Te mando em 1 print ou prefere uma call de 15 min?`,
      `{{decisor.primeiro_nome}}, consigo te mostrar o achado hoje ainda — 15 min. Terça 10h funciona?`,
    ],
    ligacao: `Abertura: "${marca}? É o {{decisor.primeiro_nome}}? Aqui é da V4 — te roubo 30s?" → Motivo: "fizemos um raio-x da captação de vocês e achei um ponto caro." → Descoberta: "como vocês estão gerando lead pros lançamentos hoje?" → Pitch: liga o gancho ao risco de vendas. → CTA: agendar diagnóstico (terça 10h / quinta 15h).`,
  };

  const comercial: Decisor = {
    nome: nome2,
    cargo: 'Diretor(a) comercial',
    quente: false,
    angulo: 'Responsável pela meta — fala em conversão e velocidade de venda.',
    gancho: semAds
      ? 'Sem funil de captação previsível, o time comercial fica refém do fluxo de loja/indicação.'
      : 'LP lenta no mobile e CTA de WhatsApp com falha derrubam a conversão do tráfego pago.',
    email: [
      {
        assunto: `conversão dos lançamentos da ${marca}`,
        corpo: `Oi {{decisor.primeiro_nome}}, tenho um recorte de onde a ${marca} está perdendo lead qualificado antes de chegar no seu time. É rápido de corrigir e mexe direto na sua meta. Vale 15 min?`,
      },
      { assunto: 'follow — conversão', corpo: `{{decisor.primeiro_nome}}, seguimos? Consigo te mostrar o gargalo e o ganho estimado. Quinta 15h?` },
    ],
    whatsapp: [
      `Oi {{decisor.primeiro_nome}}! Achei um gargalo na conversão de lead da ${marca} que impacta a meta comercial. Te mostro em 15 min?`,
    ],
    ligacao: `Abertura curta → Descoberta: "quantos leads/mês chegam pro time e de onde?" → Pitch: gargalo de conversão auditado → CTA: diagnóstico.`,
  };

  const decisores = gate === 'quentes' ? [socio] : [socio, comercial];

  const cadencia: Plano['cadencia'] = [
    { dia: 'D+0', canal: 'email', oque: 'E-mail 1 (gancho auditado)' },
    { dia: 'D+1', canal: 'whatsapp', oque: 'WhatsApp 1 (template)' },
    { dia: 'D+3', canal: 'ligacao', oque: 'Ligação (script SDR)' },
    { dia: 'D+5', canal: 'email', oque: 'E-mail 2 (reenvio/2 números)' },
    { dia: 'D+8', canal: 'whatsapp', oque: 'WhatsApp 2 (follow)' },
    { dia: 'D+10', canal: 'social', oque: 'Social (semi-manual)' },
  ];

  return { tese, parcial: !!lead.parcial, faltando, decisores, cadencia, sdr: 'SDR ' + ((Number(lead.id) % 3) + 1) };
}

function payloadKommo(lead: WfLead, plano: Plano) {
  return {
    lead: { empresa: lead.empresa, cnpj: lead.cnpj, uf: lead.uf, score: lead.score, origem: 'SDNA Outbound', parcial: plano.parcial },
    pipeline: 'Outbound Incorporadoras',
    estagio: 'Novo — cadência iniciada',
    campos: { dor_principal: plano.tese.slice(0, 60) + '…', tese: 'ver Análise estratégica', canais: ['email', 'whatsapp', 'ligacao', 'social'] },
    contatos: plano.decisores.map((d) => ({ nome: d.nome, cargo: d.cargo, quente: d.quente, base_legal: 'legítimo interesse', origem: 'DataStone+Lemit' })),
    tarefas: plano.cadencia.map((t, i) => ({ ordem: i + 1, prazo: t.dia, canal: t.canal, descricao: t.oque, responsavel: plano.sdr })),
  };
}

const CANAL_ICON: Record<string, typeof Mail> = { email: Mail, whatsapp: MessageCircle, ligacao: Phone, social: Users };

export function ArquitetoView() {
  const projetos = useProjetos();
  const [selId, setSelId] = useState<string | null>(null);
  const comArquiteto = projetos.filter((p) => p.leads.some((l) => l.etapa === ARQ));
  const projeto = selId ? projetos.find((p) => p.id === selId) ?? null : null;

  if (!projeto) {
    return (
      <div className="p-6 md:p-8">
        <h1 className="mb-1 flex items-center gap-2 font-display text-2xl font-bold text-v4-text">
          <Sparkles size={24} className="text-v4-red" /> Arquiteto
        </h1>
        <p className="mb-6 max-w-2xl text-sm text-v4-text-muted">
          Cada projeto com leads aprovados pro arquiteto aparece aqui, com a esteira multicanal pronta pra plugar no Kommo.
        </p>
        {comArquiteto.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-v4-border py-16 text-center text-v4-text-muted">
            <Sparkles size={40} />
            <p className="text-sm">
              Nenhum projeto com leads no arquiteto ainda. Aprove leads no <b className="text-v4-red">Workflow</b> (F7 ou botão “Arquiteto”).
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {comArquiteto.map((p) => {
              const n = p.leads.filter((l) => l.etapa === ARQ).length;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelId(p.id)}
                  className="group rounded-2xl border border-v4-border bg-v4-card p-5 text-left transition hover:border-v4-red hover:shadow-[0_0_16px_rgba(230,57,70,0.15)]"
                >
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-v4-red/15 text-v4-red">
                    <Sparkles size={20} />
                  </div>
                  <p className="font-display text-base font-semibold text-v4-text">{p.nome}</p>
                  <p className="mt-1 text-xs text-v4-text-muted">{n} empresa{n !== 1 ? 's' : ''} no arquiteto</p>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return <ArquitetoProjeto projeto={projeto} onVoltar={() => setSelId(null)} />;
}

function ArquitetoProjeto({ projeto, onVoltar }: { projeto: Projeto; onVoltar: () => void }) {
  const [gate, setGate] = useState<Gate>('quentes');
  const empresas = projeto.leads.filter((l) => l.etapa === ARQ);

  return (
    <div className="p-6 md:p-8">
      <button onClick={onVoltar} className="mb-3 flex items-center gap-1.5 text-xs text-v4-text-muted transition hover:text-v4-red">
        <ArrowLeft size={14} /> Projetos do arquiteto
      </button>
      <h1 className="mb-1 flex items-center gap-2 font-display text-2xl font-bold text-v4-text">
        <Sparkles size={24} className="text-v4-red" /> {projeto.nome}
      </h1>
      <p className="mb-4 text-sm text-v4-text-muted">
        {empresas.length} empresa{empresas.length !== 1 ? 's' : ''} · esteira multicanal por decisor, pronta pra Kommo (dry-run).
      </p>

      {/* Gate de contatos quentes */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-v4-border bg-v4-card p-4">
        <span className="text-sm font-medium text-v4-text">Com quais contatos trabalhamos?</span>
        <div className="flex gap-2">
          {(
            [
              ['quentes', 'Só o mais quente por decisor'],
              ['todos', 'Incluir outros achados (teste)'],
            ] as [Gate, string][]
          ).map(([g, label]) => (
            <button
              key={g}
              onClick={() => setGate(g)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                gate === g ? 'border-v4-red bg-[rgba(230,57,70,0.12)] text-v4-red' : 'border-v4-border text-v4-text-muted hover:text-v4-text'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-v4-text-disabled">O arquiteto pergunta isso antes de montar — muda quantos contatos entram na esteira.</span>
      </div>

      <div className="space-y-4">
        {empresas.map((lead) => (
          <EmpresaEsteira key={lead.id} lead={lead} gate={gate} />
        ))}
      </div>
    </div>
  );
}

function EmpresaEsteira({ lead, gate }: { lead: WfLead; gate: Gate }) {
  const plano = montarPlano(lead, gate);
  const [openKommo, setOpenKommo] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const json = JSON.stringify(payloadKommo(lead, plano), null, 2);

  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
      {/* Cabeçalho da empresa + tese (estratégia da construtora) */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-display text-lg font-semibold text-v4-text">
            {lead.empresa}
            {plano.parcial && (
              <span className="rounded bg-[rgba(250,204,21,0.15)] px-1.5 py-0.5 text-[10px] font-semibold text-v4-warning">parcial</span>
            )}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-v4-text-disabled">Estratégia da construtora</p>
        </div>
        <span className="shrink-0 rounded-full bg-v4-surface px-2.5 py-1 text-[11px] font-medium text-v4-text-muted">{plano.sdr}</span>
      </div>
      <p className="mb-3 text-sm text-v4-text-muted">{plano.tese}</p>

      {plano.parcial && plano.faltando.length > 0 && (
        <p className="mb-4 flex items-start gap-1.5 rounded-lg border border-[rgba(250,204,21,0.35)] bg-[rgba(250,204,21,0.08)] p-2 text-[11px] text-v4-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> Enviado parcial — sem: {plano.faltando.join(' · ')}. A esteira sai mais enxuta.
        </p>
      )}

      {/* Cadência / esteira */}
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-v4-text">
        <Clock size={13} className="text-v4-red" /> Esteira (cadência)
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        {plano.cadencia.map((t, i) => {
          const Icon = CANAL_ICON[t.canal] ?? Mail;
          return (
            <div key={i} className="flex items-center gap-1.5 rounded-lg border border-v4-border bg-v4-surface px-2.5 py-1.5 text-[11px] text-v4-text-muted">
              <span className="font-mono font-semibold text-v4-text">{t.dia}</span>
              <Icon size={12} className="text-v4-red" />
              {t.oque}
            </div>
          );
        })}
      </div>

      {/* Comunicação por decisor */}
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-v4-text">
        <Users size={13} className="text-v4-red" /> Comunicação por decisor
      </p>
      <div className="space-y-2">
        {plano.decisores.map((d, i) => (
          <DecisorBloco key={i} d={d} />
        ))}
      </div>

      {/* Payload Kommo (dry-run) */}
      <div className="mt-4">
        <button
          onClick={() => setOpenKommo((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-v4-text-muted transition hover:text-v4-red"
        >
          <ChevronDown size={14} className={`transition ${openKommo ? 'rotate-180' : ''}`} /> Payload Kommo (dry-run)
        </button>
        {openKommo && (
          <div className="mt-2 rounded-xl border border-v4-border bg-[#0d0d0d]">
            <div className="flex items-center justify-between border-b border-v4-border px-3 py-1.5">
              <span className="text-[10px] uppercase tracking-wide text-v4-text-disabled">o que seria enviado ao Kommo (Fase 4)</span>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(json);
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 1500);
                }}
                className="flex items-center gap-1 text-[11px] text-v4-text-muted hover:text-v4-red"
              >
                <Copy size={12} /> {copiado ? 'copiado!' : 'copiar'}
              </button>
            </div>
            <pre className="max-h-64 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-v4-text-muted">{json}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

function DecisorBloco({ d }: { d: Decisor }) {
  const [canal, setCanal] = useState<Canal>('email');
  return (
    <div className="rounded-xl border border-v4-border bg-v4-surface p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-v4-text">
            {d.cargo}
            {d.quente && <span className="rounded bg-[rgba(34,197,94,0.15)] px-1.5 py-0.5 text-[10px] font-semibold text-v4-success">contato quente</span>}
          </p>
          <p className="text-[11px] text-v4-text-muted">{d.angulo}</p>
        </div>
        <div className="flex gap-1">
          {(
            [
              ['email', Mail],
              ['whatsapp', MessageCircle],
              ['ligacao', Phone],
            ] as [Canal, typeof Mail][]
          ).map(([c, Icon]) => (
            <button
              key={c}
              onClick={() => setCanal(c)}
              className={`flex h-7 w-7 items-center justify-center rounded-md border transition ${
                canal === c ? 'border-v4-red bg-[rgba(230,57,70,0.12)] text-v4-red' : 'border-v4-border text-v4-text-muted hover:text-v4-text'
              }`}
              title={c}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>

      <p className="mb-2 rounded bg-v4-card px-2 py-1 text-[11px] text-v4-text-muted">
        <b className="text-v4-text">Gancho:</b> {d.gancho}
      </p>

      {canal === 'email' && (
        <div className="space-y-2">
          {d.email.map((e, i) => (
            <div key={i} className="rounded-lg border border-v4-border bg-v4-card p-2.5 text-xs">
              <p className="mb-1 text-v4-text">
                <span className="text-v4-text-disabled">Assunto:</span> {e.assunto}
              </p>
              <p className="text-v4-text-muted">{e.corpo}</p>
            </div>
          ))}
        </div>
      )}
      {canal === 'whatsapp' && (
        <div className="space-y-2">
          {d.whatsapp.map((m, i) => (
            <p key={i} className="rounded-lg border border-v4-border bg-v4-card p-2.5 text-xs text-v4-text-muted">{m}</p>
          ))}
        </div>
      )}
      {canal === 'ligacao' && <p className="rounded-lg border border-v4-border bg-v4-card p-2.5 text-xs text-v4-text-muted">{d.ligacao}</p>}
    </div>
  );
}
