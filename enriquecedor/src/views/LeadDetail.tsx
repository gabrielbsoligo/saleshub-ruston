import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  Building2,
  Building,
  Globe,
  MessageSquare,
  ShieldCheck,
  Users,
  Send,
  Loader2,
  Phone,
  Save,
  Linkedin,
  Instagram,
  Facebook,
  Star,
  Target,
  Mail,
  ChevronRight,
  RefreshCw,
  Gauge,
  Copy,
  Check,
  Network,
  Briefcase,
  PhoneCall,
  Lightbulb,
  Factory,
  Package,
  Workflow,
  Award,
  MapPin,
  Crosshair,
  Handshake,
  ShoppingCart,
  History,
  AlertTriangle,
  Megaphone,
  ExternalLink,
  FileText,
  Smartphone,
  Monitor,
} from 'lucide-react';
import type { AdItem, AnunciosMeta, Briefing, DecisionMaker, EmpreendimentoLpAudit, Lead, Organograma, SiteAudit } from '../types';
import { leadsRepo } from '../lib/leadsRepo';
import { decisionMakersRepo } from '../lib/decisionMakersRepo';
import { resumoSelecao, selecionarTudo, toggleDecisor, toggleEmail, togglePhone } from '../lib/contactSelection';
import { auditLeadSite, enrichLeads, fetchPagespeed, measureLeadAds, setAdDecision } from '../lib/enrichService';
import { computeScore, decisorLevel } from '../lib/leadScore';
import { siteGrade, loadTimeInfo } from '../lib/siteScore';
import { computeDores, whatsappAudit } from '../lib/dores';
import { QUALITY_COLORS, QUALITY_LABELS, STATUS_LABELS } from '../lib/labels';
import { checkEmail, checkPhone, formatCnpj } from '../lib/validation';

const DECISOR_LEVEL: Record<string, { label: string; cls: string }> = {
  alto: { label: 'decisor alto', cls: 'bg-[rgba(34,197,94,0.15)] text-v4-success' },
  medio: { label: 'decisor médio', cls: 'bg-[rgba(250,204,21,0.15)] text-v4-warning' },
  baixo: { label: 'decisor baixo', cls: 'bg-v4-surface text-v4-text-muted' },
};

const SITE_SOURCE_LABELS: Record<string, string> = {
  informado: 'informado',
  email: 'domínio do e-mail',
  busca: 'busca web',
  nao_encontrado: 'não encontrado',
};

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = iso.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : iso;
}
function fmtRenda(v: number | null): string | null {
  return v == null ? null : `R$ ${v.toLocaleString('pt-BR')}`;
}

export function LeadDetail({ leadId, onBack, embedded = false }: { leadId: string; onBack?: () => void; embedded?: boolean }) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [audit, setAudit] = useState<SiteAudit | null>(null);
  const [people, setPeople] = useState<DecisionMaker[]>([]);
  const [siteUrl, setSiteUrl] = useState('');
  const [auditing, setAuditing] = useState(false);
  const [contact, setContact] = useState({ phone: '', email: '' });
  const [savingContact, setSavingContact] = useState(false);
  const [reenriching, setReenriching] = useState(false);
  const [section, setSection] = useState<string | null>(null);
  const [measuringAds, setMeasuringAds] = useState(false);

  useEffect(() => {
    leadsRepo.get(leadId).then((l) => {
      setLead(l);
      if (l?.siteUrl) setSiteUrl(l.siteUrl);
      setContact({ phone: l?.phoneRaw ?? '', email: l?.emailRaw ?? '' });
    });
    leadsRepo.getAudit(leadId).then(setAudit);
    decisionMakersRepo.listByLead(leadId).then(setPeople);
  }, [leadId]);

  // Persiste a seleção de decisores/contatos (F2) — grava e reflete na hora.
  const persistPeople = (next: DecisionMaker[]) => {
    setPeople(next);
    decisionMakersRepo.replaceForLead(leadId, next).catch(() => {
      toast.error('Não foi possível salvar a seleção — tente de novo.');
    });
  };

  const reloadAll = async () => {
    const [l, a, ppl] = await Promise.all([
      leadsRepo.get(leadId),
      leadsRepo.getAudit(leadId),
      decisionMakersRepo.listByLead(leadId),
    ]);
    setLead(l);
    setAudit(a);
    setPeople(ppl);
  };

  const handleReenrich = async () => {
    if (!lead) return;
    setReenriching(true);
    try {
      await enrichLeads([lead]);
      await reloadAll();
      toast.success('Lead re-enriquecido.');
    } finally {
      setReenriching(false);
    }
  };

  const handleMeasureAds = async () => {
    if (!lead) return;
    setMeasuringAds(true);
    try {
      const r = await measureLeadAds(lead);
      await reloadAll();
      if (r.note === 'proxy_sem_trafego') toast.error('Proxy (Decodo) sem tráfego — a franquia de GB acabou. Recarregue o plano para medir anúncios.', { duration: 8000 });
      else if (r.note === 'proxy_auth') toast.error('Proxy (Decodo) recusou usuário/senha. Confira as credenciais.', { duration: 8000 });
      else if (r.note === 'proxy_conexao') toast.error('Proxy (Decodo) sem resposta agora. Tente de novo em instantes.');
      else if (r.note === 'timeout') toast.error('A busca demorou demais e foi interrompida. Tente re-medir (o proxy pode estar lento agora).');
      else if (r.note === 'meta_bloqueado') toast('Meta bloqueou todos os termos agora. Tente re-medir em instantes (o proxy troca de IP).');
      else if (r.note === 'meta_parcial') toast('Parte dos anúncios veio; alguns termos bloquearam. Re-medir para completar.');
      else if (r.note === 'meta_sem_resultado') toast('Nenhum anúncio ativo encontrado para a empresa/empreendimentos.');
      else if (r.note === 'meta_cap') toast('Teto diário de consultas atingido.');
      else if (r.ok === false) toast.error('Não consegui medir os anúncios agora. Tente re-medir.');
      else toast.success('Anúncios medidos.');
    } finally {
      setMeasuringAds(false);
    }
  };

  const handleAdDecision = async (adId: string, decision: 'validado' | 'a_validar' | 'descartado' | null) => {
    if (!lead) return;
    await setAdDecision(lead, adId, decision);
    await reloadAll();
  };

  const runAudit = async () => {
    if (!lead) return;
    setAuditing(true);
    try {
      const leadForAudit: Lead = { ...lead, siteUrl: siteUrl.trim() || lead.siteUrl };
      const { audit: result } = await auditLeadSite(leadForAudit);
      if (result.isOnline && result.siteUrl) {
        result.pagespeed = await fetchPagespeed(result.siteUrl);
      }
      await leadsRepo.saveAudit(result);
      setAudit(result);
      const rescored: Lead = { ...lead, score: computeScore(lead, result) };
      await leadsRepo.update(rescored);
      setLead(rescored);
      toast.success(result.siteUrl ? `Site: ${result.siteUrl}` : 'Auditoria concluída.');
    } finally {
      setAuditing(false);
    }
  };

  const saveContact = async () => {
    if (!lead) return;
    setSavingContact(true);
    try {
      const updated: Lead = {
        ...lead,
        phoneRaw: contact.phone.trim() || null,
        emailRaw: contact.email.trim() || null,
        siteUrl: siteUrl.trim() || lead.siteUrl,
        updatedAt: new Date().toISOString(),
      };
      updated.score = computeScore(updated, audit);
      await leadsRepo.update(updated);
      setLead(updated);
      toast.success('Contato da planilha atualizado.');
    } finally {
      setSavingContact(false);
    }
  };

  if (!lead) {
    return <div className="p-8 text-sm text-v4-text-muted">Carregando lead…</div>;
  }

  const companyName = lead.razaoSocial ?? lead.companyNameRaw;
  const dores = computeDores(lead, audit, people);
  const emp = lead.empreendimentos;
  const empLancamento = emp.filter((e) => e.status === 'lancamento');
  const empAndamento = emp.filter((e) => e.status === 'em_obra');
  const empConcluidas = emp.filter((e) => e.status === 'entregue');
  const empSemStatus = emp.filter(
    (e) => !e.status || !['lancamento', 'em_obra', 'entregue'].includes(e.status),
  );
  const gb = lead.googleBusiness;

  // Auditoria agregada: site institucional + TODAS as LPs auditadas.
  // A nota e o PageSpeed do site passam a ser a MÉDIA de todas as páginas.
  const auditedPages: Array<SiteAudit | EmpreendimentoLpAudit> = [
    ...(audit ? [audit] : []),
    ...emp.map((e) => e.lpAudit).filter((a): a is EmpreendimentoLpAudit => !!a),
  ].filter((a) => a.isOnline);
  const avgOf = (nums: Array<number | null | undefined>) => {
    const v = nums.filter((n): n is number => n != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const gradeLabel = (n: number | null) =>
    n == null ? '' : n >= 8 ? 'ótimo' : n >= 6 ? 'bom' : n >= 4 ? 'regular' : 'fraco';
  const avgNota = auditedPages.length ? avgOf(auditedPages.map((a) => siteGrade(a).nota)) : null;
  const g = avgNota != null ? { nota: avgNota, label: gradeLabel(avgNota) } : null;
  const ps = auditedPages.length
    ? {
        performance: avgOf(auditedPages.map((a) => a.pagespeed?.performance)),
        seo: avgOf(auditedPages.map((a) => a.pagespeed?.seo)),
        bestPractices: avgOf(auditedPages.map((a) => a.pagespeed?.bestPractices)),
        accessibility: avgOf(auditedPages.map((a) => a.pagespeed?.accessibility)),
        lcpMs: avgOf(auditedPages.map((a) => a.pagespeed?.lcpMs)),
      }
    : null;
  const avgLoadMs = avgOf(auditedPages.map((a) => a.loadTimeMs));
  // LPs com endereço (auditadas OU descobertas nos anúncios, ainda sem auditoria).
  const lpsAuditadas = emp.filter((e) => e.lp);
  const briefing = lead.briefing ?? null;
  const organograma = lead.organograma ?? null;
  const primaryPerson = people.find((p) => p.isPrimary) ?? people[0];
  const primaryFirstName = primaryPerson ? primaryPerson.nome.split(/\s+/)[0] : null;
  const orgCount = organograma ? organograma.diretoria.length + organograma.gerencia.length : 0;

  // WhatsApp CONSOLIDADO (site + LPs + Google) — sinal crítico do quadro e menu.
  const wa = whatsappAudit(lead, audit);
  const waValue =
    wa.status === 'broken' ? 'Quebrado' : wa.status === 'missing' ? 'Falta' : wa.status === 'widget' ? 'Widget' : wa.status === 'ok' ? 'OK' : '—';
  const waTone: Tone =
    wa.status === 'broken' || wa.status === 'missing' ? 'error' : wa.status === 'widget' ? 'warning' : wa.status === 'ok' ? 'success' : 'neutral';

  // Carregamento (KPI) — média do site + LPs.
  const loadMs = avgLoadMs;
  const loadSecs = loadMs != null ? `${(loadMs / 1000).toFixed(1)}s` : '—';
  const loadTone: Tone = loadMs == null ? 'neutral' : loadMs < 3000 ? 'success' : loadMs < 5000 ? 'warning' : 'error';

  const toggle = (s: string) => setSection((prev) => (prev === s ? null : s));

  return (
    <div className={embedded ? '' : 'mx-auto max-w-[1500px] p-6 lg:p-8'}>
      <div className={`mb-4 flex items-center ${embedded ? 'justify-end' : 'justify-between'}`}>
        {!embedded && (
          <button onClick={onBack} className="flex items-center gap-1 text-sm text-v4-text-muted hover:text-v4-text">
            <ArrowLeft size={16} /> Voltar
          </button>
        )}
        <button
          onClick={handleReenrich}
          disabled={reenriching}
          className="flex items-center gap-2 rounded-lg border border-v4-red px-3 py-2 text-sm font-medium text-v4-red-hover hover:bg-v4-red-muted disabled:opacity-60"
        >
          {reenriching ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {reenriching ? 'Re-enriquecendo…' : 'Re-enriquecer este lead'}
        </button>
      </div>

      {/* Cabeçalho-resumo — oculto no modo embedded (a linha do funil já mostra empresa/score) */}
      {!embedded && (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-v4-border pb-5">
          <div>
            <h1 className="font-display text-2xl font-bold text-v4-text">{companyName}</h1>
            <p className="mt-1 text-sm text-v4-text-muted">
              {formatCnpj(lead.cnpj ?? lead.cnpjRaw)}
              {lead.cidade ? ` · ${lead.cidade}/${lead.uf ?? ''}` : ''}
              {lead.segmento ? ` · ${lead.segmento}` : ''}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Pill className={QUALITY_COLORS[lead.dataQuality]}>{QUALITY_LABELS[lead.dataQuality]}</Pill>
              {lead.revenueBandRaw && <Pill className="bg-v4-surface text-v4-text-muted">Faturamento {lead.revenueBandRaw}</Pill>}
              {lead.situacaoCadastral && <Pill className="bg-v4-surface text-v4-text-muted">{lead.situacaoCadastral}</Pill>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-v4-text-muted">Score</div>
            <div className="font-display text-4xl font-bold leading-none text-v4-red">{lead.score ?? '—'}</div>
            <span className="mt-2 inline-block rounded-lg bg-v4-red-muted px-3 py-1 text-xs font-medium text-v4-red-hover">
              {STATUS_LABELS[lead.status]}
            </span>
          </div>
        </div>
      )}

      {/* AVISO — plataformas que falharam no último enriquecimento */}
      {lead.enrichIssues && lead.enrichIssues.length > 0 && (
        <div className="mb-5 rounded-2xl border border-v4-warning bg-[rgba(250,204,21,0.08)] p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-v4-warning">
            <AlertTriangle size={16} /> Plataformas com falha neste enriquecimento
          </p>
          <ul className="space-y-1 text-sm">
            {lead.enrichIssues.map((it, i) => (
              <li key={i}>
                <span className="font-medium text-v4-text">{it.source}:</span>{' '}
                <span className="text-v4-text-muted">{it.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* QUADRO FIXO — visão rápida (KPIs). Sempre visível. */}
      <div className="mb-5 rounded-2xl border border-v4-border-strong bg-v4-card p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          <KpiTile value={waValue} label="WhatsApp" sub={wa.problemas.length ? `${wa.problemas.length} alerta(s)` : null} tone={waTone} small />
          <KpiTile value={g ? `${g.nota}/10` : '—'} label="Nota do site" tone={notaSiteTone(g?.nota ?? null)} />
          <KpiTile value={ps?.performance ?? '—'} label="Performance" tone={scoreTone(ps?.performance ?? null)} />
          <KpiTile value={ps?.seo ?? '—'} label="SEO" tone={scoreTone(ps?.seo ?? null)} />
          <KpiTile value={loadSecs} label="Carregamento" tone={loadTone} small />
          <KpiTile value={gb?.rating ?? '—'} label="Google ★" sub={gb ? `${gb.reviews ?? 0} aval.` : null} tone={ratingTone(gb?.rating ?? null)} />
          <KpiTile value={emp.length} label="Empreend." sub={empLancamento.length ? `${empLancamento.length} em lançam.` : null} tone="neutral" />
          <KpiTile value={orgCount || people.length} label="Pessoas" sub={people.length ? `${people.length} decisores` : null} tone="neutral" />
        </div>
        {/* Sem briefing: mostra as dores/gaps aqui como fallback rápido. */}
        {!briefing && dores.length > 0 && (
          <div className="mt-4 border-t border-v4-border pt-3">
            <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">
              <Target size={13} className="text-v4-red" /> Principais dores / gaps
            </p>
            <div className="flex flex-wrap gap-1.5">
              {dores.map((d, i) => (
                <span
                  key={i}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                    /quebrad|fora do ar|sem site|ausente/i.test(d) ? 'bg-v4-red text-black' : 'bg-v4-surface text-v4-text'
                  }`}
                >
                  {d}
                </span>
              ))}
            </div>
          </div>
        )}
        {!briefing && (
          <p className="mt-3 text-xs text-v4-text-muted">
            {lead.status === 'enriquecido'
              ? 'Briefing por IA indisponível — re-enriquecer para gerar.'
              : 'Enriqueça o lead para gerar o briefing.'}
          </p>
        )}
      </div>

      {/* MENU CLICÁVEL — logo abaixo dos KPIs, abre cada bloco sob demanda */}
      <div className="mb-5 flex flex-wrap gap-2">
        {audit && (
          <MenuBtn active={section === 'diagnostico'} onClick={() => toggle('diagnostico')} icon={Globe} label="Diagnóstico digital" />
        )}
        {briefing && (
          <MenuBtn active={section === 'analise'} onClick={() => toggle('analise')} icon={Target} label="Análise estratégica" />
        )}
        {briefing?.scripts && (
          <MenuBtn active={section === 'scripts'} onClick={() => toggle('scripts')} icon={Send} label="Scripts de abordagem" />
        )}
        {emp.length > 0 && (
          <MenuBtn active={section === 'empreendimentos'} onClick={() => toggle('empreendimentos')} icon={Building2} label={`Empreendimentos · ${emp.length}`} />
        )}
        <MenuBtn active={section === 'anuncios'} onClick={() => toggle('anuncios')} icon={Megaphone} label="Anúncios" />
        {orgCount > 0 && (
          <MenuBtn active={section === 'organograma'} onClick={() => toggle('organograma')} icon={Network} label={`Organograma · ${orgCount}`} />
        )}
        <MenuBtn active={section === 'decisores'} onClick={() => toggle('decisores')} icon={Users} label={`Decisores · ${people.length}`} />
        <MenuBtn active={section === 'empresa'} onClick={() => toggle('empresa')} icon={Building2} label="Empresa" />
        {briefing && ((briefing.dores?.length ?? 0) > 0 || (briefing.ganchos?.length ?? 0) > 0) && (
          <MenuBtn active={section === 'oportunidades'} onClick={() => toggle('oportunidades')} icon={Lightbulb} label="Oportunidades" />
        )}
      </div>

      {/* CONTEÚDO DA SEÇÃO — aparece logo abaixo dos botões ao clicar */}

      {/* Seção: Diagnóstico digital */}
      {section === 'diagnostico' && (
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        {/* Presença digital + Google Meu Negócio */}
        <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
          <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
            <Globe size={18} /> Presença digital
          </h3>
          {audit ? (
            <>
              {audit.siteUrl && (
                <a href={audit.siteUrl} target="_blank" rel="noreferrer" className="block break-all text-sm text-v4-red-hover hover:underline">
                  {audit.siteUrl}
                </a>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Chip ok={audit.isOnline} label={audit.isOnline ? 'Site no ar' : 'Fora do ar'} />
                <Chip ok={audit.httpsValid} label="HTTPS" />
                <Chip ok={audit.hasMetaPixel} label="Meta Pixel" />
                <Chip ok={audit.hasGoogleTag} label="Google Tag" />
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-sm">
                <MessageSquare size={14} className="text-v4-text-muted" />
                <WhatsappStatus audit={audit} />
              </div>
              {audit.isOnline && audit.loadTimeMs != null && (
                <p className="mt-1.5 text-sm text-v4-text-muted">
                  Carregamento: {(audit.loadTimeMs / 1000).toFixed(1)}s
                  {(() => {
                    const t = loadTimeInfo(audit.loadTimeMs);
                    return t ? <span className={`ml-1 font-medium ${t.cls}`}>({t.label})</span> : null;
                  })()}
                </p>
              )}
              <div className="mt-4 border-t border-v4-border pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-v4-text-disabled">Redes da empresa</p>
                <div className="flex flex-wrap gap-2">
                  <BrandSocial href={lead.companyInstagram} icon={Instagram} label="Instagram" color="#E1306C" />
                  <BrandSocial href={lead.companyFacebook} icon={Facebook} label="Facebook" color="#1877F2" />
                </div>
              </div>
              {/* Google Meu Negócio — logo abaixo das redes sociais */}
              <div className="mt-4 border-t border-v4-border pt-3">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-v4-text-disabled">
                  <Star size={13} /> Google Meu Negócio
                </p>
                {gb ? (
                  <>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`font-display text-xl font-bold ${ratingTone(gb.rating) === 'success' ? 'text-v4-success' : ratingTone(gb.rating) === 'warning' ? 'text-v4-warning' : 'text-v4-error'}`}>
                        {gb.rating ?? '—'} ★
                      </span>
                      <span className="text-v4-text-muted">· {gb.reviews ?? 0} avaliações</span>
                    </div>
                    {gb.category && <p className="mt-1 text-sm text-v4-text">{gb.category}</p>}
                    {gb.address && <p className="mt-0.5 text-sm text-v4-text-muted">{gb.address}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <MatLink
                        href={`https://www.google.com/maps/search/${encodeURIComponent(`${gb.title ?? companyName} ${lead.cidade ?? ''}`)}`}
                        label="Ver no Google Maps"
                      />
                      {gb.website && <MatLink href={gb.website} label="Site" />}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-v4-text-muted">Sem perfil no Google encontrado.</p>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-v4-text-muted">Ainda não auditado.</p>
          )}
        </div>

        {/* Landing pages (LPs) dos empreendimentos + dados de cada uma */}
        <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
          <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
            <Building2 size={18} /> Landing pages
            <span className="text-sm font-normal text-v4-text-muted">{lpsAuditadas.length}</span>
          </h3>
          {lpsAuditadas.length > 0 ? (
            <div className="space-y-3">
              {lpsAuditadas.map((e, i) => (
                <LpNotes key={i} e={e} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-v4-text-muted">
              Nenhuma LP auditada ainda. As LPs dos empreendimentos ativos entram aqui após o enriquecimento.
            </p>
          )}
        </div>

        {/* Nota do site — MÉDIA do site institucional + todas as LPs */}
        <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
          <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
            <Gauge size={18} /> Nota do site
          </h3>
          {g ? (
            <>
              <KpiTile value={`${g.nota}/10`} label="Nota do site (média)" sub={g.label} tone={notaSiteTone(g.nota)} />
              <p className="mt-2 text-[11px] text-v4-text-disabled">
                Média de {auditedPages.length} página(s): site institucional + {lpsAuditadas.filter((e) => e.lpAudit?.isOnline).length} LP(s)
              </p>
              <div className="mt-3 border-t border-v4-border pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-v4-text-disabled">PageSpeed médio (Google, mobile)</p>
                {ps ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <PsTile label="Performance" value={ps.performance} />
                      <PsTile label="SEO" value={ps.seo} />
                      <PsTile label="Boas práticas" value={ps.bestPractices} />
                      <PsTile label="Acessib." value={ps.accessibility} />
                    </div>
                    {ps.lcpMs != null && (
                      <p className="mt-3 text-sm text-v4-text-muted">
                        LCP médio (maior conteúdo): <span className="font-medium text-v4-text">{(ps.lcpMs / 1000).toFixed(1)}s</span>
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-v4-text-muted">Sem dados do PageSpeed (re-auditar).</p>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-v4-text-muted">Ainda não auditado.</p>
          )}
        </div>
      </div>
      )}

      {/* Seção: Análise estratégica */}
      {section === 'analise' && briefing && <AnaliseSection briefing={briefing} />}

      {/* Seção: Scripts de abordagem */}
      {section === 'scripts' && briefing && (
        <ScriptsSection briefing={briefing} primaryFirstName={primaryFirstName} />
      )}

      {/* Seção: Oportunidades (Dores + Ganchos) */}
      {section === 'oportunidades' && briefing && <OportunidadesSection briefing={briefing} sinais={dores} />}

      {/* Seção: Empreendimentos — por status */}
      {section === 'empreendimentos' && emp.length > 0 && (
        <>
          <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-v4-text">
            <Building2 size={20} /> Empreendimentos{' '}
            <span className="text-sm font-normal text-v4-text-muted">{emp.length} encontrados</span>
          </h2>
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <EmpreendimentosCard title="Lançamentos" items={empLancamento} tone="error" withMaterials companyName={companyName} />
            <EmpreendimentosCard title="Em andamento" items={empAndamento} tone="warning" withMaterials companyName={companyName} />
            <EmpreendimentosCard title="Concluídas" items={empConcluidas} tone="success" companyName={companyName} />
          </div>
          {empSemStatus.length > 0 && (
            <div className="mb-6">
              <EmpreendimentosCard title="Sem status definido" items={empSemStatus} tone="neutral" withMaterials companyName={companyName} />
            </div>
          )}
        </>
      )}

      {/* Seção: Anúncios & mídia paga */}
      {section === 'anuncios' && (
        <AnunciosSection
          lead={lead}
          audit={audit}
          companyName={companyName}
          onMeasure={handleMeasureAds}
          measuring={measuringAds}
          onDecide={handleAdDecision}
        />
      )}

      {/* Seção: Decisores & contatos */}
      {section === 'decisores' && (
        <>
      <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-v4-text">
        <Users size={20} /> Decisores &amp; contatos
      </h2>
      {primaryPerson && <BestContacts person={primaryPerson} />}
      {people.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-v4-border bg-v4-card px-4 py-3">
          <div className="text-sm text-v4-text-muted">
            <b className="text-v4-text">Seleção para a próxima etapa:</b>{' '}
            {(() => {
              const r = resumoSelecao(people);
              return r.decisores === 0
                ? 'nenhuma — sem seleção, seguem as sugestões mais validadas'
                : `${r.decisores} decisor(es) · ${r.phones} telefone(s) · ${r.emails} e-mail(s)`;
            })()}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => persistPeople(selecionarTudo(people, true))}
              className="rounded-lg border border-v4-success px-3 py-1.5 text-xs font-medium text-v4-success transition hover:bg-[rgba(34,197,94,0.12)]"
            >
              Escolher todos
            </button>
            <button
              onClick={() => persistPeople(selecionarTudo(people, false))}
              className="rounded-lg border border-v4-border px-3 py-1.5 text-xs font-medium text-v4-text-muted transition hover:border-v4-error hover:text-v4-error"
            >
              Limpar seleção
            </button>
          </div>
        </div>
      )}
      {people.length > 0 ? (
        <div className="mb-3 space-y-2">
          {people.map((p) => (
            <div
              key={p.id}
              className={`rounded-xl bg-v4-card p-4 ${p.isPrimary ? 'border border-v4-red' : 'border border-v4-border'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex cursor-pointer items-center gap-2" title="Trabalhar este decisor nas próximas etapas (marca todos os contatos dele; desmarque os que não quiser)">
                  <input
                    type="checkbox"
                    checked={!!p.selecionado}
                    onChange={() => persistPeople(toggleDecisor(people, p.id))}
                    className="h-4 w-4 cursor-pointer accent-v4-red"
                  />
                  <span className="text-base font-bold text-v4-text">{p.nome}</span>
                </label>
                {p.isPrimary && <Pill className="bg-v4-red-muted text-v4-red-hover">principal</Pill>}
                <Pill className={DECISOR_LEVEL[decisorLevel(p)].cls}>{DECISOR_LEVEL[decisorLevel(p)].label}</Pill>
                {p.selecionado && <Pill className="bg-[rgba(34,197,94,0.15)] text-v4-success">trabalhar</Pill>}
              </div>
              {p.cargo && <div className="mt-0.5 text-sm text-v4-text-muted">{p.cargo}</div>}
              {p.companiesCount > 0 && (
                <details className="mt-2 text-sm text-v4-text-muted">
                  <summary className="flex cursor-pointer items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 font-medium text-v4-text transition hover:bg-v4-card-hover">
                    <ChevronRight size={16} className="chev text-v4-red" />
                    <Building size={14} /> Sócio em {p.companiesCount} empresas
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-2 text-sm">
                    {p.companies.map((c, i) => (
                      <li key={i}>
                        <span className="text-v4-text">{c.nome ?? '—'}</span>
                        {c.situacao && (
                          <span className={c.situacao.toUpperCase() === 'ATIVA' ? 'text-v4-success' : 'text-v4-error'}>
                            {' '}· {c.situacao}
                          </span>
                        )}
                        {c.participacao != null && <span className="text-v4-text-disabled"> · {c.participacao}%</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="mt-2 space-y-1 text-sm">
                {p.phones && p.phones.length > 0 ? (
                  p.phones.map((ph, idx) => (
                    <div key={`ph${idx}`} className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={!!ph.selecionado}
                        onChange={() => persistPeople(togglePhone(people, p.id, idx))}
                        title="Trabalhar este telefone nas próximas etapas"
                        className="h-3.5 w-3.5 cursor-pointer accent-v4-red"
                      />
                      <Phone size={13} className="text-v4-text-muted" />
                      <span className={idx === 0 ? 'font-medium text-v4-text' : 'text-v4-text'}>{ph.numero}</span>
                      {ph.whatsapp && <Tag className="bg-[rgba(34,197,94,0.15)] text-v4-success">WhatsApp</Tag>}
                      {ph.hot && <Tag className="bg-v4-red-muted text-v4-red-hover">quente</Tag>}
                      <SourceBadge sources={ph.sources} validado={ph.validado} />
                    </div>
                  ))
                ) : p.phonePersonal ? (
                  <div className="flex items-center gap-1.5">
                    <Phone size={13} className="text-v4-text-muted" />
                    {p.phonePersonal}
                    {p.phoneWhatsapp && <Tag className="bg-[rgba(34,197,94,0.15)] text-v4-success">WhatsApp</Tag>}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-v4-text-muted">
                    <Phone size={13} /> telefone não encontrado
                  </div>
                )}
                {p.emails && p.emails.length > 0 ? (
                  p.emails.map((em, idx) => (
                    <div key={`em${idx}`} className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={!!em.selecionado}
                        onChange={() => persistPeople(toggleEmail(people, p.id, idx))}
                        title="Trabalhar este e-mail nas próximas etapas"
                        className="h-3.5 w-3.5 cursor-pointer accent-v4-red"
                      />
                      <Mail size={13} className="text-v4-text-muted" />
                      <span className="break-all text-v4-text">{em.email}</span>
                      <SourceBadge sources={em.sources} validado={em.validado} />
                    </div>
                  ))
                ) : (
                  <div className="flex items-center gap-1.5 text-v4-text-muted">
                    <Mail size={13} /> {p.emailPersonal ?? 'e-mail não encontrado'}
                  </div>
                )}
              </div>
              {(p.linkedin || p.instagram) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.linkedin && <SocialLink href={p.linkedin} icon={Linkedin} label="LinkedIn" />}
                  {p.instagram && <SocialLink href={p.instagram} icon={Instagram} label="Instagram" />}
                </div>
              )}
              {p.lemit && <LemitPersonDetails data={p.lemit} />}
              {p.datastone && <DatastonePersonDetails data={p.datastone} />}
            </div>
          ))}
        </div>
      ) : (
        <div className="mb-3 rounded-xl border border-v4-border bg-v4-card p-4 text-sm text-v4-text-muted">
          Sócios ainda não enriquecidos.
        </div>
      )}
        </>
      )}

      {/* Seção: Organograma (DataStone: diretoria + gerência) */}
      {section === 'organograma' && organograma && (organograma.diretoria.length > 0 || organograma.gerencia.length > 0) && (
        <OrganogramaSection org={organograma} />
      )}

      {/* Contato da planilha (editável) — abre junto dos Decisores */}
      {section === 'decisores' && (
      <div className="mb-6 rounded-xl border border-v4-border bg-v4-card p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-v4-text-muted">Contato da planilha</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <input
              value={contact.phone}
              onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
              placeholder="Telefone"
              className="w-full rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none focus:border-v4-red"
            />
            <PhoneStatus value={contact.phone} />
          </div>
          <div>
            <input
              value={contact.email}
              onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
              placeholder="E-mail"
              className="w-full rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none focus:border-v4-red"
            />
            <EmailStatus value={contact.email} />
          </div>
        </div>
        <button
          onClick={saveContact}
          disabled={savingContact}
          className="mt-3 flex items-center gap-2 rounded-lg border border-v4-border-strong px-4 py-2 text-sm font-medium text-v4-text hover:bg-v4-surface disabled:opacity-60"
        >
          {savingContact ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Salvar contato
        </button>
      </div>
      )}

      {/* Seção: Empresa — dados completos (Receita + Lemit) + re-auditar */}
      {section === 'empresa' && (
        <>
      <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-v4-text">
        <Building2 size={20} /> Empresa
      </h2>
      <div className="mb-6 grid gap-4 rounded-xl border border-v4-border bg-v4-card p-5 text-sm md:grid-cols-2">
        <div className="space-y-1.5">
          <InfoRow label="Razão social" value={lead.razaoSocial} />
          <InfoRow label="Nome fantasia" value={lead.nomeFantasia ?? lead.lemitCompany?.nomeFantasia ?? null} />
          <InfoRow label="Segmento (CNAE)" value={lead.segmento} />
          <InfoRow label="Cidade / UF" value={[lead.cidade, lead.uf].filter(Boolean).join(' / ') || null} />
          <InfoRow label="Situação" value={lead.situacaoCadastral} />
          <InfoRow label="Fundação" value={fmtDate(lead.lemitCompany?.dataFundacao ?? null)} />
          <InfoRow label="Faturamento (planilha)" value={lead.revenueBandRaw} />
        </div>
        <div className="space-y-1.5">
          <InfoRow label="Endereço (Lemit)" value={lead.lemitCompany?.endereco ?? null} />
          {lead.lemitCompany && (lead.lemitCompany.phones.length > 0 || lead.lemitCompany.fixos.length > 0) && (
            <div>
              <p className="text-xs text-v4-text-disabled">Telefones da empresa (Lemit)</p>
              <ul className="space-y-0.5">
                {lead.lemitCompany.phones.map((t, i) => (
                  <li key={`c${i}`} className="text-v4-text">
                    {t.numero}
                    {t.whatsapp && (
                      <span className="ml-1 rounded bg-[rgba(34,197,94,0.15)] px-1 text-[10px] text-v4-success">WhatsApp</span>
                    )}
                  </li>
                ))}
                {lead.lemitCompany.fixos.map((f, i) => (
                  <li key={`f${i}`} className="text-v4-text-muted">{f} (fixo)</li>
                ))}
              </ul>
            </div>
          )}
          {lead.lemitCompany && lead.lemitCompany.emails.length > 0 && (
            <div>
              <p className="text-xs text-v4-text-disabled">E-mails da empresa (Lemit)</p>
              <ul className="space-y-0.5">
                {lead.lemitCompany.emails.map((e, i) => (
                  <li key={i} className="break-all text-v4-text">{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Re-auditar site */}
      <details className="mb-6 rounded-xl border border-v4-border bg-v4-card p-4">
        <summary className="flex cursor-pointer items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm font-medium text-v4-text transition hover:bg-v4-card-hover">
          <ChevronRight size={16} className="chev text-v4-red" />
          <ShieldCheck size={14} /> Re-auditar site
          {audit?.source ? ` (fonte: ${SITE_SOURCE_LABELS[audit.source] ?? audit.source})` : ''}
        </summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="Deixe em branco para descobrir, ou informe o site"
            className="min-w-[240px] flex-1 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm text-v4-text outline-none focus:border-v4-red"
          />
          <button
            onClick={runAudit}
            disabled={auditing}
            className="flex items-center gap-2 rounded-lg bg-v4-red px-4 py-2 text-sm font-semibold text-white hover:bg-v4-red-hover disabled:opacity-60"
          >
            {auditing ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
            Auditar
          </button>
        </div>
      </details>
        </>
      )}

      {/* Placeholder das próximas fases */}
      <div className="rounded-xl border border-v4-border bg-v4-card p-4">
        <h3 className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
          <Send size={18} /> Cadência &amp; Kommo
        </h3>
        <p className="text-sm text-v4-text-muted">
          Cadência multicanal e envio ao Kommo entram nas próximas fases.
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// Briefing por IA (Data Intel) — análise estratégica + scripts por canal
// ============================================================================
function fillScript(text: string | null, firstName: string | null): string {
  if (!text) return '';
  const nome = firstName ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase() : '{{nome}}';
  return text.replace(/\{\{\s*nome\s*\}\}/gi, nome);
}

// Oportunidades — Dores + Ganchos de abordagem (aberto pelo menu).
// `sinais` = dores determinísticas da auditoria (computeDores). Garante que o
// WhatsApp quebrado/ausente (site + LPs + Google) apareça mesmo se a IA não citou.
// Deep-links para verificar anúncios ativos (contagem real virá com headless).
function metaAdLibUrl(term: string): string {
  return `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=BR&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;
}

// Miniatura do criativo — carrega no navegador (CDN do Meta). Pode expirar.
function AdThumb({ src }: { src: string }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded bg-v4-card text-center text-[9px] text-v4-warning">
        <AlertTriangle size={14} /> expirado
      </div>
    );
  }
  return (
    <img
      src={src}
      alt="criativo"
      onError={() => setErr(true)}
      className="h-16 w-16 shrink-0 rounded object-cover"
    />
  );
}

// Linha de um anúncio, com curadoria manual (é do cliente / descartar).
function AdRow({
  a,
  status,
  onDecide,
}: {
  a: AdItem;
  status: 'validado' | 'a_validar' | 'descartado';
  onDecide: (id: string, d: 'validado' | 'a_validar' | 'descartado' | null) => void;
}) {
  const border =
    status === 'validado' ? 'border-v4-success' : status === 'a_validar' ? 'border-v4-warning' : 'border-v4-border';
  // Link direto do anúncio na Biblioteca de Anúncios do Meta (pelo ID da biblioteca).
  const libUrl = `https://www.facebook.com/ads/library/?id=${a.id}`;
  return (
    <div className={`rounded-lg border ${border} bg-v4-surface p-3 ${status === 'descartado' ? 'opacity-60' : ''}`}>
      <div className="flex gap-3">
        {a.imagem && (
          <a href={libUrl} target="_blank" rel="noreferrer" title="Abrir anúncio na Biblioteca do Meta" className="shrink-0">
            <AdThumb src={a.imagem} />
          </a>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-v4-text">
              {a.advertiser ?? 'anunciante ?'}
              {a.empreendimento ? ` · ${a.empreendimento}` : ''}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-v4-text-muted">{a.score} sinais</span>
              <a
                href={libUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-md border border-v4-border px-2 py-1 text-[11px] font-medium text-v4-text transition hover:border-v4-red hover:text-v4-red hover:shadow-[0_0_16px_rgba(230,57,70,0.35)]"
                title="Abrir na Biblioteca de Anúncios do Meta"
              >
                <ExternalLink size={12} /> Abrir na Biblioteca
              </a>
            </div>
          </div>
          {a.trecho && <p className="mt-1 text-xs text-v4-text-muted">{a.trecho}</p>}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {a.signals.map((s, i) => (
              <span key={i} className="rounded bg-v4-card px-1.5 py-0.5 text-[10px] text-v4-text-muted">{s}</span>
            ))}
            {a.dest.map((d, i) => (
              <span key={`d${i}`} className="rounded bg-v4-card px-1.5 py-0.5 text-[10px] text-v4-red-hover">{d}</span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {status !== 'validado' && (
          <button
            onClick={() => onDecide(a.id, 'validado')}
            className="rounded-md border border-v4-success px-2 py-1 text-[11px] font-medium text-v4-success hover:bg-[rgba(34,197,94,0.12)]"
          >
            ✓ É do cliente
          </button>
        )}
        {status !== 'a_validar' && (
          <button
            onClick={() => onDecide(a.id, 'a_validar')}
            className="rounded-md border border-v4-warning px-2 py-1 text-[11px] font-medium text-v4-warning hover:bg-[rgba(234,179,8,0.12)]"
          >
            ~ A validar
          </button>
        )}
        {status !== 'descartado' && (
          <button
            onClick={() => onDecide(a.id, 'descartado')}
            className="rounded-md border border-v4-border px-2 py-1 text-[11px] font-medium text-v4-text-muted hover:border-v4-error hover:text-v4-error"
          >
            ↓ Baixa confiança
          </button>
        )}
        <button
          onClick={() => onDecide(a.id, null)}
          className="rounded-md border border-v4-border px-2 py-1 text-[11px] font-medium text-v4-text-muted hover:text-v4-text"
          title="Voltar à classificação automática"
        >
          ↩ Auto
        </button>
      </div>
    </div>
  );
}

// Anúncios & mídia paga: sinais (pixels/tags no site+LPs) + verificação por link.
function AnunciosSection({
  lead,
  audit,
  companyName,
  onMeasure,
  measuring,
  onDecide,
}: {
  lead: Lead;
  audit: SiteAudit | null;
  companyName: string;
  onMeasure: () => void;
  measuring: boolean;
  onDecide: (id: string, d: 'validado' | 'a_validar' | 'descartado' | null) => void;
}) {
  const lpAudits = (lead.empreendimentos ?? [])
    .map((e) => e.lpAudit)
    .filter((a): a is EmpreendimentoLpAudit => !!a && a.isOnline);
  const pages: Array<SiteAudit | EmpreendimentoLpAudit> = [...(audit?.isOnline ? [audit] : []), ...lpAudits];
  const any = (f: 'hasMetaPixel' | 'hasGoogleTag' | 'hasGoogleAds' | 'hasTiktokPixel') =>
    pages.some((a) => !!(a as SiteAudit)[f]);
  const meta = any('hasMetaPixel');
  const googleTag = any('hasGoogleTag');
  const googleAds = any('hasGoogleAds');
  const tiktok = any('hasTiktokPixel');

  const empAtivos = (lead.empreendimentos ?? []).filter(
    (e) => e.status === 'lancamento' || e.status === 'em_obra',
  );
  const empVerif = empAtivos.length ? empAtivos : lead.empreendimentos ?? [];

  // Blindagem: só usa a estrutura nova (com validados[]). Dados antigos (array) → fallback.
  const rawMeta = lead.anuncios?.meta;
  const am =
    rawMeta && !Array.isArray(rawMeta) && Array.isArray((rawMeta as AnunciosMeta).validados)
      ? (rawMeta as AnunciosMeta)
      : null;

  // Grupos EFETIVOS = classificação automática (sugestão) + curadoria manual.
  // NADA é jogado fora: todos os 3 níveis aparecem pra auditoria do operador.
  const decisoes = am?.decisoes ?? {};
  type Auto = 'validado' | 'a_validar' | 'descartado';
  const classificados = am
    ? [
        ...am.validados.map((a) => ({ a, auto: 'validado' as const })),
        ...am.aValidar.map((a) => ({ a, auto: 'a_validar' as const })),
        ...(Array.isArray(am.descartados) ? am.descartados : []).map((a) => ({ a, auto: 'descartado' as const })),
      ]
    : [];
  const eff = (x: { a: AdItem; auto: Auto }): Auto => decisoes[x.a.id] ?? x.auto;
  const validadosFinais = classificados.filter((x) => eff(x) === 'validado').map((x) => x.a);
  const aValidarFinais = classificados.filter((x) => eff(x) === 'a_validar').map((x) => x.a);
  const descartadosFinais = classificados.filter((x) => eff(x) === 'descartado').map((x) => x.a);

  // Resumo de mídia paga: destino dos anúncios do cliente (Meta) + Google Ads.
  // Só conta anúncios que têm destino medido (dados antigos não têm → re-medir).
  const comDestino = validadosFinais.filter((a) => a.destTipo);
  const destCount = { whatsapp: 0, lp: 0, perfil: 0 };
  for (const a of comDestino) destCount[a.destTipo as 'whatsapp' | 'lp' | 'perfil'] += 1;
  const destTotal = comDestino.length;
  const destDefasado = validadosFinais.length > 0 && destTotal === 0; // medido antes do destTipo
  const pctDest = (n: number) => (destTotal ? Math.round((n / destTotal) * 100) : 0);
  const lpsDescobertas = am?.lpsDescobertas ?? [];
  // Sub-abas da aba Anúncios: Meta | Google.
  const [sub, setSub] = useState<'meta' | 'google'>('meta');
  // Menu de destino: hover abre a prévia; clique fixa. Mostra links LP/anúncio/perfil.
  const [hoverDest, setHoverDest] = useState<'whatsapp' | 'lp' | 'perfil' | null>(null);
  const [pinnedDest, setPinnedDest] = useState<'whatsapp' | 'lp' | 'perfil' | null>(null);
  const openDest = pinnedDest ?? hoverDest;
  // Seletor de nível de confiança (containers clicáveis; fechado por padrão).
  const [tierSel, setTierSel] = useState<'validado' | 'a_validar' | 'descartado' | null>(null);
  const adsByDest = (t: 'whatsapp' | 'lp' | 'perfil') => comDestino.filter((a) => a.destTipo === t);
  // Onde há Google Ads (tag de conversão): site + LPs de empreendimentos.
  const googleAdsOnde: string[] = [];
  if (audit?.hasGoogleAds) googleAdsOnde.push('site');
  for (const e of lead.empreendimentos ?? []) {
    if (e.lpAudit?.hasGoogleAds) googleAdsOnde.push(e.nome);
  }

  return (
    <div className="mb-6 space-y-4">
      {/* Sub-abas: Meta | Google */}
      <div className="flex gap-2">
        {(['meta', 'google'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSub(s)}
            className={`rounded-lg border px-5 py-2 text-sm font-semibold capitalize transition hover:border-v4-red hover:text-v4-red hover:shadow-[0_0_16px_rgba(230,57,70,0.35)] ${
              sub === s ? 'border-v4-red text-v4-red shadow-[0_0_16px_rgba(230,57,70,0.35)]' : 'border-v4-border text-v4-text-muted'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {sub === 'meta' && (
        <div className="space-y-4">
          {/* Anúncios MEDIDOS + validados na Meta Ad Library (headless) */}
          {am ? (
        <div className="rounded-2xl border border-v4-red bg-v4-card p-5 shadow-[0_0_16px_rgba(230,57,70,0.15)]">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-display text-base font-semibold text-v4-text">
              <Megaphone size={18} /> Anúncios no Meta <span className="text-sm font-normal text-v4-text-muted">(validação cruzada)</span>
            </h3>
            <button
              onClick={onMeasure}
              disabled={measuring}
              className="flex items-center gap-1.5 rounded-lg border border-v4-border px-2.5 py-1.5 text-xs font-medium text-v4-text transition hover:border-v4-red hover:text-v4-red disabled:opacity-60"
            >
              {measuring ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {measuring ? 'Medindo…' : 'Re-medir'}
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            <span className="text-v4-text">
              <span className="font-display text-2xl font-bold text-v4-success">{validadosFinais.length}</span> validados
            </span>
            <span className="text-v4-text">
              <span className="font-display text-2xl font-bold text-v4-warning">{aValidarFinais.length}</span> a validar
            </span>
            <span className="text-v4-text-muted"><span className="font-display text-2xl font-bold text-v4-text-muted">{descartadosFinais.length}</span> baixa confiança</span>
            {am.total != null && <span className="text-v4-text-disabled">· {am.total} analisados</span>}
          </div>
          {am.termosBuscados && am.termosBuscados.length > 0 && (
            <p className="mb-3 text-[11px] text-v4-text-disabled">
              Buscado por: {am.termosBuscados.map((t) => <span key={t} className="mr-1 rounded bg-v4-bg px-1.5 py-0.5 text-v4-text-muted">{t}</span>)}
              {am.termosIgnorados && am.termosIgnorados.length > 0 && (
                <span className="text-v4-warning"> · não buscados (teto anti-ban): {am.termosIgnorados.join(', ')}</span>
              )}
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
          <div>
          {/* Resumo de mídia paga: para onde a verba vai (Meta) + Google Ads */}
          <div className="flex h-full flex-col justify-between gap-3 rounded-xl border border-v4-red p-4">
            <h4 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-v4-text">
              <Megaphone size={14} className="text-v4-red" /> Resumo de mídia paga
            </h4>
            <div className="mb-2 text-sm">
              <span className="text-v4-text-muted">Destino dos anúncios do cliente ({destTotal}):</span>{' '}
              {destDefasado ? (
                <span className="text-v4-warning">medido antes desta atualização — clique <b>Re-medir</b> para ver os destinos</span>
              ) : destTotal === 0 ? (
                <span className="text-v4-text-disabled">nenhum anúncio de alta confiança ainda</span>
              ) : (
                <>
                  <span className="ml-1 inline-flex flex-wrap gap-1.5 align-middle">
                    {([['whatsapp', '💬 WhatsApp'], ['lp', '🌐 LP'], ['perfil', '👤 Perfil']] as const).map(([t, label]) => {
                      const on = openDest === t;
                      return (
                        <button
                          key={t}
                          onMouseEnter={() => setHoverDest(t)}
                          onMouseLeave={() => setHoverDest(null)}
                          onClick={() => setPinnedDest(pinnedDest === t ? null : t)}
                          className={`rounded-md border px-2 py-0.5 transition hover:border-v4-red hover:text-v4-red hover:shadow-[0_0_16px_rgba(230,57,70,0.35)] ${on ? 'border-v4-red text-v4-red shadow-[0_0_16px_rgba(230,57,70,0.35)]' : 'border-v4-border bg-v4-card text-v4-text'}`}
                        >
                          {label} <b>{destCount[t]}</b> ({pctDest(destCount[t])}%)
                        </button>
                      );
                    })}
                  </span>
                  {openDest && (
                    <div
                      onMouseEnter={() => setHoverDest(openDest)}
                      onMouseLeave={() => setHoverDest(null)}
                      className="mt-2 rounded-lg border border-v4-red bg-v4-surface p-3"
                    >
                      {adsByDest(openDest).length === 0 ? (
                        <p className="text-xs text-v4-text-disabled">Nenhum anúncio deste tipo.</p>
                      ) : openDest === 'lp' ? (
                        (() => {
                          // Deduplica por domínio: 7 anúncios podem apontar pra 4 LPs distintas.
                          const byDomain = new Map<string, { count: number; emp: string | null }>();
                          for (const a of adsByDest('lp')) {
                            for (const dm of a.dest) {
                              const cur = byDomain.get(dm) ?? { count: 0, emp: null };
                              cur.count += 1;
                              if (!cur.emp && a.empreendimento) cur.emp = a.empreendimento;
                              byDomain.set(dm, cur);
                            }
                          }
                          const rows = [...byDomain.entries()];
                          return (
                            <>
                              <p className="mb-1.5 text-[11px] text-v4-text-disabled">
                                {adsByDest('lp').length} anúncios → <b>{rows.length}</b> LP{rows.length > 1 ? 's' : ''} distinta{rows.length > 1 ? 's' : ''} (auditadas na aba Google)
                              </p>
                              <div className="space-y-1.5">
                                {rows.map(([dm, info]) => (
                                  <div key={dm} className="flex flex-wrap items-center gap-2 text-xs">
                                    <a href={`https://${dm}`} target="_blank" rel="noreferrer" className="text-v4-red-hover hover:underline">
                                      {dm} ↗
                                    </a>
                                    {info.emp && <span className="text-v4-text-muted">· {info.emp}</span>}
                                    <span className="ml-auto text-v4-text-disabled">{info.count} anúncio{info.count > 1 ? 's' : ''}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          );
                        })()
                      ) : (
                        <div className="space-y-1.5">
                          {adsByDest(openDest).map((a) => (
                            <div key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="text-v4-text-muted">
                                {a.advertiser ?? 'anunciante ?'}
                                {a.empreendimento ? ` · ${a.empreendimento}` : ''}
                              </span>
                              <a
                                href={`https://www.facebook.com/ads/library/?id=${a.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="ml-auto text-v4-text-muted transition hover:text-v4-red"
                              >
                                {openDest === 'whatsapp' ? 'ver anúncio (abre o WhatsApp) ↗' : 'ver anúncio (vai ao perfil) ↗'}
                              </a>
                            </div>
                          ))}
                        </div>
                      )}
                      {pinnedDest === openDest && (
                        <button onClick={() => setPinnedDest(null)} className="mt-2 text-[11px] text-v4-text-muted hover:text-v4-red">
                          fechar ✕
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="mb-2 text-sm">
              <span className="text-v4-text-muted">Google Ads:</span>{' '}
              {googleAdsOnde.length ? (
                <span className="text-v4-success">investe (tag de conversão em: {googleAdsOnde.join(', ')})</span>
              ) : (
                <span className="text-v4-text-disabled">não detectado (sem tag de conversão no site/LPs)</span>
              )}
            </div>
            {lpsDescobertas.length > 0 && (
              <div className="text-sm">
                <span className="text-v4-text-muted">LPs descobertas nos anúncios (alimentadas nos empreendimentos):</span>
                <span className="ml-1 inline-flex flex-wrap gap-1.5 align-middle">
                  {lpsDescobertas.map((l) => (
                    <span key={l.domain} className="rounded bg-v4-card px-2 py-0.5 text-v4-text">
                      {l.domain} → <b>{l.empreendimento}</b>{' '}
                      <span className={l.novo ? 'text-v4-success' : 'text-v4-text-muted'}>{l.novo ? '(novo)' : '(LP adicionada)'}</span>
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
          </div>
          <div>
          <div className="flex h-full flex-col rounded-xl border border-v4-red p-4">
            <h4 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-v4-text">
              <Crosshair size={14} className="text-v4-red" /> Auditoria de ads
            </h4>
            <div className="grid grid-cols-3 gap-2">
              {[
                { key: 'validado' as const, label: 'Alta', desc: 'provável do cliente', arr: validadosFinais, color: 'text-v4-success', glow: 'glow-alta' },
                { key: 'a_validar' as const, label: 'Média', desc: '1 sinal forte', arr: aValidarFinais, color: 'text-v4-warning', glow: 'glow-media' },
                { key: 'descartado' as const, label: 'Baixa', desc: 'revise/promova', arr: descartadosFinais, color: 'text-v4-text-muted', glow: 'glow-baixa' },
              ].map((c) => {
                const on = tierSel === c.key;
                return (
                  <button
                    key={c.key}
                    onClick={() => setTierSel(on ? null : c.key)}
                    className={`${c.glow} rounded-xl border bg-v4-surface p-3 text-left ${on ? 'border-v4-red' : 'border-v4-border'}`}
                  >
                    <p className="text-[11px] text-v4-text-muted">{c.label} confiança</p>
                    <p className={`font-display text-xl font-bold ${c.color}`}>{c.arr.length}</p>
                    <p className="text-[10px] text-v4-text-disabled">{c.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>
          </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-v4-border p-5">
          <p className="text-sm text-v4-text-muted">
            Anúncios do Meta ainda não medidos. A fila em background mede aos poucos — ou clique para medir este lead agora.
          </p>
          <button
            onClick={onMeasure}
            disabled={measuring}
            className="flex items-center gap-2 rounded-lg bg-v4-red px-4 py-2 text-sm font-semibold text-white transition hover:bg-v4-red-hover disabled:opacity-60"
          >
            {measuring ? <Loader2 size={16} className="animate-spin" /> : <Megaphone size={16} />}
            {measuring ? 'Medindo anúncios…' : 'Medir anúncios agora'}
          </button>
        </div>
      )}

          {/* Avaliação dos criativos da categoria selecionada — container próprio,
              entre o card de anúncios e a análise do GT. Fecha → volta a ordem. */}
          {am && tierSel && (
            <div className="rounded-2xl border border-v4-red bg-v4-card p-5 shadow-[0_0_16px_rgba(230,57,70,0.15)]">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 font-display text-base font-semibold text-v4-text">
                  <Megaphone size={18} className="text-v4-red" /> Criativos — {tierSel === 'validado' ? 'Alta' : tierSel === 'a_validar' ? 'Média' : 'Baixa'} confiança{' '}
                  <span className="text-sm font-normal text-v4-text-muted">({(tierSel === 'validado' ? validadosFinais : tierSel === 'a_validar' ? aValidarFinais : descartadosFinais).length})</span>
                </h3>
                <button
                  onClick={() => setTierSel(null)}
                  className="rounded-lg border border-v4-border px-3 py-1.5 text-xs font-medium text-v4-text-muted transition hover:border-v4-red hover:text-v4-red"
                >
                  Fechar ✕
                </button>
              </div>
              {(tierSel === 'validado' ? validadosFinais : tierSel === 'a_validar' ? aValidarFinais : descartadosFinais).length === 0 ? (
                <p className="text-sm text-v4-text-disabled">Nenhum anúncio nesta categoria.</p>
              ) : (
                <div className="grid gap-2 lg:grid-cols-2">
                  {(tierSel === 'validado' ? validadosFinais : tierSel === 'a_validar' ? aValidarFinais : descartadosFinais).map((a) => (
                    <AdRow key={a.id} a={a} status={tierSel} onDecide={onDecide} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Análise do GT dos criativos do Meta (só alta confiança) */}
          <MetaGtContainer lead={lead} />

          {/* Sinais no Meta (pixel) */}
          <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
            <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
              <Megaphone size={18} /> Sinais no Meta <span className="text-sm font-normal text-v4-text-muted">(site + LPs)</span>
            </h3>
            {pages.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  <Chip ok={meta} label="Meta Pixel" />
                  <Chip ok={tiktok} label="TikTok Pixel" />
                </div>
                <p className="mt-3 text-sm leading-relaxed text-v4-text-muted">
                  {meta
                    ? 'Meta Pixel presente — provavelmente investe/rastreia anúncios no Meta.'
                    : googleTag
                      ? 'Meta Pixel não detectado no HTML — pode estar via Google Tag Manager (JS); confirme na Ad Library.'
                      : 'Sem Meta Pixel — provavelmente NÃO roda anúncios no Meta (oportunidade).'}
                </p>
              </>
            ) : (
              <p className="text-sm text-v4-text-muted">Site/LPs não auditados — re-enriquecer para detectar os pixels.</p>
            )}
          </div>

          {/* Abrir no Meta (deep-links) */}
          <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
            <h3 className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
              <Megaphone size={18} /> Abrir no Meta <span className="text-sm font-normal text-v4-text-muted">(busca bruta)</span>
            </h3>
            <p className="mb-3 text-xs text-v4-warning">
              ⚠️ Abre a busca CRUA por palavra-chave — pode conter ruído. A lista validada (sem ruído) é a de cima.
            </p>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 border-b border-v4-border pb-2">
                <span className="min-w-[120px] text-sm font-medium text-v4-text">Empresa</span>
                <MatLink href={metaAdLibUrl(companyName)} label="Meta Ad Library" />
              </div>
              {empVerif.map((e, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 border-b border-v4-border pb-2 last:border-0">
                  <span className="min-w-[120px] text-sm text-v4-text">{e.nome}</span>
                  <MatLink href={metaAdLibUrl(e.nome)} label="Meta Ad Library" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {sub === 'google' && (
        <div className="space-y-4">
          {/* Anúncios no Google (2/3) + Google Meu Negócio ao lado (1/3) */}
          {lead.googleBusiness ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <GoogleAdsContainer lead={lead} googleAds={googleAds} googleTag={googleTag} googleAdsOnde={googleAdsOnde} />
              </div>
              <GmnCard gmn={lead.googleBusiness} />
            </div>
          ) : (
            <GoogleAdsContainer lead={lead} googleAds={googleAds} googleTag={googleTag} googleAdsOnde={googleAdsOnde} />
          )}

          {/* Análise do Gestor de Tráfego — leitura de conversão por gravidade */}
          <GtAnalysisContainer lead={lead} />

          {/* Auditoria rica das LPs (Lighthouse = Google) */}
          <LpGmnAuditContainer lead={lead} />
        </div>
      )}
    </div>
  );
}

// Container (na sub-aba Google): auditoria rica das LPs (Lighthouse = Google) +
// Google Meu Negócio. Mostra TODAS as LPs com endereço — inclusive as descobertas
// nos anúncios do Meta (mesmo antes de auditadas).
// Card compacto de LP (estado recolhido) — mesmo padrão dos tiles do GT.
function LpMini({ e }: { e: Lead['empreendimentos'][number] }) {
  const a = e.lpAudit;
  const conv = a ? notaConversaoLp(a) : null;
  const tone: Tone = conv ? notaSiteTone(conv.nota) : 'neutral';
  const color = tone === 'success' ? 'text-v4-success' : tone === 'warning' ? 'text-v4-warning' : tone === 'error' ? 'text-v4-error' : 'text-v4-text';
  return (
    <div className="rounded-xl border border-v4-border bg-v4-surface p-3">
      <p className="truncate text-[11px] font-medium text-v4-text-muted" title={e.nome}>{e.nome}</p>
      <p className={`font-display text-xl font-bold ${color}`}>{conv ? `${conv.nota}/10` : '—'}</p>
      <p className="text-[10px] text-v4-text-disabled">{conv ? 'nota de conversão' : 'auditoria pendente'}</p>
    </div>
  );
}

function LpGmnAuditContainer({ lead }: { lead: Lead }) {
  const [aberto, setAberto] = useState(false);
  const emps = (lead.empreendimentos ?? []).filter((e) => e.lp);
  // Anúncios do Meta (alta confiança) que apontam pra cada LP — por domínio.
  const validados = lead.anuncios?.meta?.validados ?? [];
  const hostOf = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const adsForLp = (lp: string | null): AdItem[] => {
    const h = hostOf(lp);
    if (!h) return [];
    return validados.filter((ad) => ad.destTipo === 'lp' && ad.dest?.some((d) => d.toLowerCase().replace(/^www\./, '') === h));
  };
  return (
    <div className="rounded-2xl border border-v4-red bg-v4-card p-5 shadow-[0_0_16px_rgba(230,57,70,0.15)]">
      <h3 className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
        <Gauge size={18} /> Auditoria das LPs{' '}
        <span className="text-sm font-normal text-v4-text-muted">({emps.length}) — velocidade, SEO, WhatsApp e formulário</span>
      </h3>
      <p className="mb-3 text-[11px] text-v4-text-disabled">
        Notas do Google Lighthouse (mobile + desktop). Inclui as LPs descobertas nos anúncios do Meta.
      </p>
      {emps.length === 0 ? (
        <p className="text-sm text-v4-text-muted">Nenhuma LP ainda. Meça os anúncios para descobrir e auditar as LPs.</p>
      ) : aberto ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {emps.map((e, i) => (
            <LpNotes key={i} e={e} ads={adsForLp(e.lp)} conversao />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {emps.map((e, i) => (
            <LpMini key={i} e={e} />
          ))}
        </div>
      )}
      {emps.length > 0 && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => setAberto(!aberto)}
            className={
              aberto
                ? 'rounded-lg border border-v4-border px-6 py-2 text-sm font-medium text-v4-text-muted transition hover:border-v4-red hover:text-v4-red'
                : 'animate-pulse-red rounded-lg px-6 py-2.5 text-sm font-semibold text-white'
            }
          >
            {aberto ? 'Recolher ▴' : 'Ver análise completa ▾'}
          </button>
        </div>
      )}
    </div>
  );
}

// Google Meu Negócio (card próprio, na sub-aba Google).
function GmnCard({ gmn }: { gmn: NonNullable<Lead['googleBusiness']> }) {
  const rTone = ratingTone(gmn.rating);
  const rColor = rTone === 'success' ? 'text-v4-success' : rTone === 'warning' ? 'text-v4-warning' : 'text-v4-error';
  // Telefone: detecta celular BR (provável WhatsApp) e monta o link wa.me.
  const digits = (gmn.phone ?? '').replace(/\D/g, '');
  const nac = digits.startsWith('55') ? digits.slice(2) : digits; // tira DDI se houver
  const isCelular = nac.length === 11 && nac[2] === '9'; // DDD + 9 + 8 dígitos
  const waHref = isCelular ? `https://wa.me/55${nac}` : null;
  const mapsHref = gmn.cid
    ? `https://www.google.com/maps?cid=${gmn.cid}`
    : `https://www.google.com/maps/search/${encodeURIComponent(gmn.title ?? '')}`;
  const hoursEntries = gmn.openingHours ? Object.entries(gmn.openingHours) : [];
  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
      <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
        <MapPin size={18} className="text-v4-red" /> Google Meu Negócio
      </h3>
      <div className="flex flex-wrap gap-4">
        {gmn.thumbnail && (
          <img src={gmn.thumbnail} alt="foto do perfil" className="h-24 w-24 shrink-0 rounded-lg object-cover" />
        )}
        <div className="min-w-[240px] flex-1 space-y-2">
          <div>
            {gmn.title && <p className="text-base font-semibold text-v4-text">{gmn.title}</p>}
            {gmn.category && <p className="text-xs text-v4-text-muted">{gmn.category}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`font-display text-2xl font-bold ${rColor}`}>{gmn.rating ?? '—'}</span>
            {gmn.rating != null && (
              <span className="text-lg leading-none">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span key={n} className={n <= Math.round(gmn.rating!) ? 'text-v4-warning' : 'text-v4-text-disabled'}>
                    ★
                  </span>
                ))}
              </span>
            )}
            <span className="text-sm text-v4-text-muted">· {gmn.reviews ?? 0} avaliações</span>
            {gmn.reviews != null && gmn.reviews > 0 && (
              <a href={mapsHref} target="_blank" rel="noreferrer" className="text-xs text-v4-red-hover transition hover:underline">
                ver avaliações no Google ↗
              </a>
            )}
          </div>
          {/* Contato / WhatsApp */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {gmn.phone ? (
              <>
                <span className="inline-flex items-center gap-1 text-v4-text">
                  <PhoneCall size={13} className="text-v4-text-muted" /> {gmn.phone}
                </span>
                {isCelular ? (
                  <a
                    href={waHref!}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-v4-success px-2 py-0.5 text-xs font-medium text-v4-success transition hover:bg-[rgba(34,197,94,0.12)]"
                  >
                    <MessageSquare size={12} /> celular · provável WhatsApp ↗
                  </a>
                ) : (
                  <span className="rounded bg-v4-card px-2 py-0.5 text-xs text-v4-text-disabled">fixo · sem WhatsApp no telefone</span>
                )}
              </>
            ) : (
              <span className="text-v4-text-disabled">sem telefone no perfil</span>
            )}
          </div>
          {gmn.address && (
            <p className="flex items-start gap-1 text-sm text-v4-text-muted">
              <MapPin size={13} className="mt-0.5 shrink-0" /> {gmn.address}
            </p>
          )}
        </div>
      </div>

      {/* Horário de funcionamento (quando o Google expõe) */}
      {hoursEntries.length > 0 && (
        <div className="mt-3 border-t border-v4-border pt-3">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-v4-text-disabled">Horário</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-v4-text-muted sm:grid-cols-3">
            {hoursEntries.map(([dia, h]) => (
              <span key={dia}>
                <span className="text-v4-text">{dia}:</span> {h}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Ações */}
      <div className="mt-3 flex flex-wrap gap-2 border-t border-v4-border pt-3">
        <MatLink href={mapsHref} label="Ver no Google Maps" />
        {gmn.website && <MatLink href={gmn.website} label="Site do perfil" />}
        {waHref && <MatLink href={waHref} label="Abrir WhatsApp" />}
      </div>
    </div>
  );
}

// Container "Anúncios no Google" + resumo de contexto das LPs auditadas.
function GoogleAdsContainer({
  lead,
  googleAds,
  googleTag,
  googleAdsOnde,
}: {
  lead: Lead;
  googleAds: boolean;
  googleTag: boolean;
  googleAdsOnde: string[];
}) {
  const emps = (lead.empreendimentos ?? []).filter((e) => e.lp && e.lpAudit?.isOnline);
  const validados = lead.anuncios?.meta?.validados ?? [];
  const hostOf = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const adsForDomain = (h: string | null) =>
    h ? validados.filter((a) => a.destTipo === 'lp' && a.dest?.some((d) => d.toLowerCase().replace(/^www\./, '') === h)).length : 0;
  const perLp = emps.map((e) => ({ nome: e.nome, ads: adsForDomain(hostOf(e.lp)) })).sort((a, b) => b.ads - a.ads);
  const n = emps.length;
  const totalAds = perLp.reduce((s, l) => s + l.ads, 0);
  const faltaMeta = emps.filter((e) => !e.lpAudit!.hasMetaPixel).length;
  const faltaGads = emps.filter((e) => !e.lpAudit!.hasGoogleAds).length;
  const faltaGtag = emps.filter((e) => !e.lpAudit!.hasGoogleTag).length;
  let waFound = 0;
  let waErro = 0;
  for (const e of emps) {
    const wa = e.lpAudit!.whatsappButtons ?? [];
    waFound += wa.length;
    waErro += wa.filter((b) => !b.working).length;
  }
  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
      <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
        <Megaphone size={18} /> Anúncios no Google <span className="text-sm font-normal text-v4-text-muted">(sinais + contexto das LPs)</span>
      </h3>
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <span className="text-v4-text">
          <span className={`font-display text-2xl font-bold ${googleAds ? 'text-v4-success' : 'text-v4-text-disabled'}`}>{googleAds ? 'Sim' : 'Não'}</span> investe em Google Ads
        </span>
      </div>
      <div className="mb-3 space-y-2 rounded-xl border border-v4-red p-4 text-sm">
        <div>
          <span className="text-v4-text-muted">Tag de conversão do Google Ads:</span>{' '}
          {googleAdsOnde.length ? (
            <span className="text-v4-success">detectada em: {googleAdsOnde.join(', ')}</span>
          ) : (
            <span className="text-v4-text-disabled">não detectada no site/LPs</span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip ok={googleAds} label="Google Ads (conversão)" />
          <Chip ok={googleTag} label="Google Tag / Analytics" />
        </div>
      </div>

      {/* Resumo de contexto das LPs auditadas */}
      {n > 0 && (
        <div className="mb-3 border-t border-v4-border pt-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Contexto das LPs auditadas</p>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <GtKpi label="LPs auditadas" value={n} />
            <GtKpi label="Anúncios → LPs" value={totalAds} sub="somando todas" />
            <GtKpi label="Rastreio faltando" value={`${faltaMeta}/${n}`} tone={faltaMeta > 0 ? 'error' : 'success'} sub="sem Meta Pixel" />
            <GtKpi label="WhatsApp com erro" value={`${waErro}/${waFound}`} tone={waErro > 0 ? 'error' : 'success'} sub="botões testados" />
          </div>
          {/* Anúncios que levam a cada LP */}
          <div className="mb-2 text-sm">
            <span className="text-v4-text-muted">Anúncios que levam a cada LP:</span>
            <span className="ml-1 inline-flex flex-wrap gap-1.5 align-middle">
              {perLp.map((l) => (
                <span key={l.nome} className="rounded bg-v4-card px-2 py-0.5 text-xs text-v4-text">
                  {l.nome}: <b>{l.ads}</b>
                </span>
              ))}
            </span>
          </div>
          {/* Pixels e tags faltando nas LPs auditadas */}
          <div className="mb-2 text-sm">
            <span className="text-v4-text-muted">Pixels/tags faltando (nas {n} LPs):</span>
            <span className="ml-1 inline-flex flex-wrap gap-1.5 align-middle">
              <span className={`rounded px-2 py-0.5 text-xs ${faltaMeta > 0 ? 'bg-[rgba(230,57,70,0.15)] text-v4-error' : 'bg-v4-card text-v4-text-muted'}`}>Meta Pixel: {faltaMeta}/{n}</span>
              <span className={`rounded px-2 py-0.5 text-xs ${faltaGads > 0 ? 'bg-[rgba(234,179,8,0.15)] text-v4-warning' : 'bg-v4-card text-v4-text-muted'}`}>Google Ads (conv.): {faltaGads}/{n}</span>
              <span className={`rounded px-2 py-0.5 text-xs ${faltaGtag > 0 ? 'bg-[rgba(234,179,8,0.15)] text-v4-warning' : 'bg-v4-card text-v4-text-muted'}`}>Google Tag: {faltaGtag}/{n}</span>
            </span>
          </div>
          {/* WhatsApp: encontrado / testado / com erro */}
          <div className="text-sm">
            <span className="text-v4-text-muted">Botões de WhatsApp:</span>{' '}
            <span className="text-v4-text">{waFound} encontrado{waFound !== 1 ? 's' : ''}/testado{waFound !== 1 ? 's' : ''}</span>
            {' · '}
            <span className={waErro > 0 ? 'text-v4-error' : 'text-v4-success'}>{waErro} com erro</span>
          </div>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-v4-warning">
        <AlertTriangle size={12} /> Os criativos reais (Centro de Transparência do Google) são um próximo passo. Hoje mostramos os sinais de tag/conversão do site e das LPs.
      </p>
    </div>
  );
}

// --- Análise de Gestor de Tráfego (GT) das LPs -----------------------------
// KPIs por GRAVIDADE de conversão: rastreio ausente (paga cego) e CTA quebrado
// são críticos; mobile pesa mais que desktop (maioria do tráfego); e o peso do
// problema é amplificado pela verba (nº de anúncios apontando pra LP).
type GtNivel = 'critico' | 'alerta' | 'ok';
interface GtLp {
  nome: string;
  adCount: number;
  metaPixel: boolean;
  googleAds: boolean;
  perfMobile: number | null;
  lcpMobileS: number | null;
  waBroken: boolean;
  formFields: number | null;
  formBroken: boolean;
  issues: string[];
  risco: number;
  nivel: GtNivel;
  texto: string;
}
function analyzeGt(lead: Lead): {
  lps: GtLp[];
  findings: GtLp[];
  strategy: string[];
  kpis: { anunciosLp: number; destinoLpPct: number | null; rastreioMeta: number; baseCount: number; perfMobileMedia: number | null; lpsLcpAlto: number; ctaQuebrado: number };
  gmn: { rating: number | null; reviews: number; contato: 'whatsapp' | 'fixo' | 'nenhum'; nivel: GtNivel; issues: string[] } | null;
} | null {
  const meta = lead.anuncios?.meta;
  const validados = meta?.validados ?? [];
  const hostOf = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const adsForDomain = (h: string) =>
    validados.filter((a) => a.destTipo === 'lp' && a.dest?.some((d) => d.toLowerCase().replace(/^www\./, '') === h)).length;

  const emps = (lead.empreendimentos ?? []).filter((e) => e.lp && e.lpAudit?.isOnline);
  if (emps.length === 0 && !lead.googleBusiness) return null;

  const lps: GtLp[] = emps.map((e) => {
    const a = e.lpAudit!;
    const h = hostOf(e.lp);
    const adCount = h ? adsForDomain(h) : 0;
    const metaPixel = !!a.hasMetaPixel;
    const googleAds = !!a.hasGoogleAds;
    const perfMobile = a.pagespeed?.performance ?? null;
    const lcpMobileS = a.pagespeed?.lcpMs != null ? a.pagespeed.lcpMs / 1000 : null;
    const waBroken = (a.whatsappButtons ?? []).some((b) => !b.working);
    const formFields = a.form?.fields ?? null;
    const formBroken = !!a.form?.hasForm && (!a.form.hasSubmit || !!a.form.actionSuspeita);

    const mult = 1 + Math.min(adCount, 6) * 0.4; // verba amplifica a gravidade
    const issues: string[] = [];
    let risco = 0;
    if (adCount > 0 && !metaPixel) { issues.push('sem Meta Pixel'); risco += 5 * mult; }
    if (adCount > 0 && !googleAds) { issues.push('sem conversão do Google Ads'); risco += 3 * mult; }
    if (lcpMobileS != null && lcpMobileS > 4) { issues.push(`LCP mobile de ${lcpMobileS.toFixed(1)}s`); risco += 4 * mult; }
    else if (perfMobile != null && perfMobile < 50) { issues.push(`performance mobile ${perfMobile}`); risco += 3 * mult; }
    if (waBroken) { issues.push('botão de WhatsApp quebrado'); risco += 5 * mult; }
    if (formBroken) { issues.push('formulário com envio suspeito'); risco += 4; }
    else if (formFields != null && formFields > 6) { issues.push(`formulário longo (${formFields} campos)`); risco += 2; }

    const nivel: GtNivel = risco >= 8 ? 'critico' : risco >= 3 ? 'alerta' : 'ok';
    // Texto na voz do GT
    const consequencias: string[] = [];
    if (adCount > 0 && !metaPixel) consequencias.push('a verba roda sem rastreio (o algoritmo não otimiza nem gera público de remarketing)');
    if ((lcpMobileS != null && lcpMobileS > 4) || (perfMobile != null && perfMobile < 50)) consequencias.push('a página é lenta no mobile (onde está a maioria do tráfego) — sobe o CPA e cai a conversão');
    if (waBroken) consequencias.push('o clique pago chega e não consegue falar no WhatsApp');
    const texto =
      (adCount > 0 ? `${adCount} anúncio${adCount > 1 ? 's' : ''} ativo${adCount > 1 ? 's' : ''} apontam pra cá. ` : '') +
      (issues.length ? `Problemas: ${issues.join('; ')}. ` : '') +
      (consequencias.length ? `Impacto: ${consequencias.join('; ')}.` : '');
    return { nome: e.nome, adCount, metaPixel, googleAds, perfMobile, lcpMobileS, waBroken, formFields, formBroken, issues, risco, nivel, texto };
  }).sort((x, y) => y.risco - x.risco);

  const comTrafego = lps.filter((l) => l.adCount > 0);
  const base = comTrafego.length ? comTrafego : lps;
  const perfVals = base.map((l) => l.perfMobile).filter((n): n is number => n != null);
  const kpis = {
    anunciosLp: validados.filter((a) => a.destTipo === 'lp').length,
    destinoLpPct: meta && meta.validados.length ? Math.round((validados.filter((a) => a.destTipo === 'lp').length / meta.validados.length) * 100) : null,
    rastreioMeta: base.filter((l) => l.metaPixel).length,
    baseCount: base.length,
    perfMobileMedia: perfVals.length ? Math.round(perfVals.reduce((a, b) => a + b, 0) / perfVals.length) : null,
    lpsLcpAlto: base.filter((l) => l.lcpMobileS != null && l.lcpMobileS > 4).length,
    ctaQuebrado: base.filter((l) => l.waBroken).length,
  };

  // Plano de ação (o que um GT faria), priorizado
  const strategy: string[] = [];
  const semPixel = comTrafego.filter((l) => !l.metaPixel);
  if (semPixel.length) strategy.push(`Prioridade nº1 — instalar Meta Pixel nas ${semPixel.length} LP(s) com tráfego sem rastreio (${semPixel.slice(0, 4).map((l) => l.nome).join(', ')}${semPixel.length > 4 ? '…' : ''}): sem pixel não há conversão pro algoritmo otimizar nem público de remarketing; a verba roda cega.`);
  const semGads = comTrafego.filter((l) => !l.googleAds);
  if (semGads.length) strategy.push(`Configurar a tag de conversão do Google Ads em ${semGads.length} LP(s) — sem ela não dá pra medir ROAS nem otimizar por conversão.`);
  const lentas = base.filter((l) => (l.lcpMobileS != null && l.lcpMobileS > 4) || (l.perfMobile != null && l.perfMobile < 50));
  if (lentas.length) strategy.push(`Otimizar a velocidade MOBILE de ${lentas.length} LP(s) — comprimir imagens, lazy-load, cortar scripts pesados. Mobile é a maioria do tráfego pago; LCP alto = bounce e CPA maior.`);
  if (kpis.ctaQuebrado > 0) strategy.push(`Corrigir o botão de WhatsApp quebrado em ${kpis.ctaQuebrado} LP(s) — o lead pago clica e não converte; é perda direta.`);
  const formPesado = base.filter((l) => l.formFields != null && l.formFields > 6);
  if (formPesado.length) strategy.push(`Enxugar o formulário de ${formPesado.length} LP(s) com mais de 6 campos — menos atrito, mais leads pelo mesmo tráfego.`);
  if (comTrafego.length) strategy.push('Foque nas LPs com mais anúncios ativos — é onde a verba está concentrada e onde consertar rende mais.');

  // Google Meu Negócio — reputação e canal de contato impactam a conversão do pago.
  let gmn: { rating: number | null; reviews: number; contato: 'whatsapp' | 'fixo' | 'nenhum'; nivel: GtNivel; issues: string[] } | null = null;
  const gb = lead.googleBusiness;
  if (gb) {
    const digits = (gb.phone ?? '').replace(/\D/g, '');
    const nac = digits.startsWith('55') ? digits.slice(2) : digits;
    const isCelular = nac.length === 11 && nac[2] === '9';
    const contato: 'whatsapp' | 'fixo' | 'nenhum' = !gb.phone ? 'nenhum' : isCelular ? 'whatsapp' : 'fixo';
    const reviews = gb.reviews ?? 0;
    const gIssues: string[] = [];
    if (gb.rating != null && gb.rating < 4) gIssues.push(`reputação baixa (${gb.rating}★) — quem vem do anúncio pesquisa a marca e desiste ao ver nota fraca`);
    if (reviews < 15) gIssues.push(`poucas avaliações (${reviews}) — prova social fraca reduz a confiança e a conversão`);
    if (contato === 'fixo') gIssues.push('contato do perfil é telefone FIXO — para tráfego mobile isso gera atrito e perde lead (WhatsApp converteria muito mais)');
    else if (contato === 'nenhum') gIssues.push('sem telefone no perfil — dificulta o contato do lead');
    const gNivel: GtNivel = (gb.rating != null && gb.rating < 3.5) || contato === 'fixo' ? 'alerta' : gIssues.length ? 'alerta' : 'ok';
    gmn = { rating: gb.rating, reviews, contato, nivel: gNivel, issues: gIssues };
    // Estratégia de GT ligada ao GMN
    if (gb.rating != null && gb.rating < 4) strategy.push('Trabalhar a reputação no Google (campanha de pedido de avaliação aos clientes satisfeitos) — nota baixa derruba a conversão de quem pesquisa a marca vinda do anúncio.');
    else if (reviews < 15) strategy.push('Aumentar o volume de avaliações no Google Meu Negócio — prova social forte melhora a conversão do tráfego pago.');
    if (contato === 'fixo' || contato === 'nenhum') strategy.push('Adicionar um WhatsApp como contato no Google Meu Negócio — a maioria do tráfego pago é mobile; telefone fixo gera atrito e perde lead.');
  }

  const findings = lps.filter((l) => l.nivel !== 'ok');
  return { lps, findings, strategy, kpis, gmn };
}

function GtKpi({ label, value, sub, tone = 'neutral' }: { label: string; value: string | number; sub?: string; tone?: Tone }) {
  const color = tone === 'success' ? 'text-v4-success' : tone === 'warning' ? 'text-v4-warning' : tone === 'error' ? 'text-v4-error' : 'text-v4-text';
  return (
    <div className="rounded-xl border border-v4-border bg-v4-surface p-3">
      <p className="text-[10px] uppercase tracking-wide text-v4-text-disabled">{label}</p>
      <p className={`font-display text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-v4-text-muted">{sub}</p>}
    </div>
  );
}

function GtAnalysisContainer({ lead }: { lead: Lead }) {
  const [aberto, setAberto] = useState(false);
  const gt = analyzeGt(lead);
  if (!gt) return null;
  const { kpis } = gt;
  const perfTone: Tone = kpis.perfMobileMedia == null ? 'neutral' : kpis.perfMobileMedia >= 90 ? 'success' : kpis.perfMobileMedia >= 50 ? 'warning' : 'error';
  const nivelColor = (n: GtNivel) => (n === 'critico' ? 'text-v4-error' : n === 'alerta' ? 'text-v4-warning' : 'text-v4-success');
  const nivelBorder = (n: GtNivel) => (n === 'critico' ? 'border-v4-error' : n === 'alerta' ? 'border-v4-warning' : 'border-v4-border');
  return (
    <div className="rounded-2xl border border-v4-red bg-v4-card p-5 shadow-[0_0_16px_rgba(230,57,70,0.15)]">
      <h3 className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
        <Crosshair size={18} className="text-v4-red" /> Análise do Gestor de Tráfego
      </h3>
      <p className="mb-3 text-[11px] text-v4-text-disabled">
        Leitura de conversão das LPs que recebem verba, por gravidade: rastreio ausente e CTA quebrado são críticos; mobile pesa mais que desktop; e o peso do erro é amplificado pela verba (anúncios apontando pra LP).
      </p>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <GtKpi label="Anúncios → LP" value={kpis.anunciosLp} sub={kpis.destinoLpPct != null ? `${kpis.destinoLpPct}% da verba` : undefined} />
        <GtKpi label="Rastreio Meta Pixel" value={`${kpis.rastreioMeta}/${kpis.baseCount}`} tone={kpis.rastreioMeta < kpis.baseCount ? 'error' : 'success'} sub="LPs com tráfego" />
        <GtKpi label="Perf. mobile média" value={kpis.perfMobileMedia ?? '—'} tone={perfTone} sub={kpis.lpsLcpAlto > 0 ? `${kpis.lpsLcpAlto} com LCP>4s` : 'LCP ok'} />
        <GtKpi label="CTA quebrado" value={kpis.ctaQuebrado} tone={kpis.ctaQuebrado > 0 ? 'error' : 'success'} sub="WhatsApp" />
      </div>

      {aberto && (
        <>
      {/* Reputação e contato no Google Meu Negócio (impacta conversão do pago) */}
      {gt.gmn && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Reputação no Google (impacta a conversão do pago)</p>
          <div className="mb-2 grid grid-cols-3 gap-2">
            <GtKpi
              label="Reputação"
              value={gt.gmn.rating != null ? `${gt.gmn.rating}★` : '—'}
              tone={gt.gmn.rating == null ? 'neutral' : gt.gmn.rating >= 4 ? 'success' : gt.gmn.rating >= 3.5 ? 'warning' : 'error'}
            />
            <GtKpi label="Avaliações" value={gt.gmn.reviews} tone={gt.gmn.reviews >= 15 ? 'success' : gt.gmn.reviews > 0 ? 'warning' : 'error'} sub="prova social" />
            <GtKpi
              label="Contato"
              value={gt.gmn.contato === 'whatsapp' ? 'WhatsApp' : gt.gmn.contato === 'fixo' ? 'Fixo' : 'Nenhum'}
              tone={gt.gmn.contato === 'whatsapp' ? 'success' : 'error'}
              sub={gt.gmn.contato === 'fixo' ? 'atrito p/ mobile' : gt.gmn.contato === 'whatsapp' ? 'ótimo p/ lead' : 'sem telefone'}
            />
          </div>
          {gt.gmn.issues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-v4-text-muted">
              {gt.gmn.issues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {gt.findings.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Achados prioritários (verba × erro)</p>
          <div className="space-y-2">
            {gt.findings.map((f, i) => (
              <div key={i} className={`rounded-lg border ${nivelBorder(f.nivel)} bg-v4-surface p-2.5`}>
                <p className="text-sm font-medium text-v4-text">
                  <span className={nivelColor(f.nivel)}>{f.nivel === 'critico' ? '🔴 CRÍTICO' : '🟡 ALERTA'}</span> · {f.nome}
                  {f.adCount > 0 && <span className="ml-1 text-xs text-v4-text-muted">({f.adCount} anúncio{f.adCount > 1 ? 's' : ''})</span>}
                </p>
                <p className="mt-0.5 text-xs text-v4-text-muted">{f.texto}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {gt.strategy.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Plano de ação (o que um GT faria)</p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-v4-text">
            {gt.strategy.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
        </>
      )}
      <div className="mt-4 flex justify-center">
        <button
          onClick={() => setAberto(!aberto)}
          className={
            aberto
              ? 'rounded-lg border border-v4-border px-6 py-2 text-sm font-medium text-v4-text-muted transition hover:border-v4-red hover:text-v4-red'
              : 'animate-pulse-red rounded-lg px-6 py-2.5 text-sm font-semibold text-white'
          }
        >
          {aberto ? 'Recolher análise ▴' : 'Ver análise completa ▾'}
        </button>
      </div>
    </div>
  );
}

// --- Análise de GT dos CRIATIVOS do Meta (só alta confiança) ----------------
// Viés de mídia social paga: destino/captação, fadiga de criativo (1 só anúncio
// por produto), cobertura de empreendimentos e qualidade do criativo.
function analyzeMetaGt(lead: Lead): {
  total: number;
  media: { video: number; imagem: number; carrossel: number };
  midiaConhecida: boolean;
  videoPct: number;
  dest: { whatsapp: number; lp: number; perfil: number };
  whatsDireto: number;
  lpComForm: number;
  lpSemForm: number;
  lpSemFormComWhats: number;
  lpSemFormWhatsQuebrado: number;
  lpSemFormSemNada: number;
  duplicados: number;
  dupGrupos: { copy: string; dest: string; qtd: number; mesmaLp: boolean }[];
  anunciados: number;
  ativosCount: number;
  ativosSemAnuncio: string[];
  findings: { nivel: GtNivel; titulo: string; texto: string }[];
  strategy: string[];
} | null {
  const meta = lead.anuncios?.meta;
  if (!meta) return null;
  // ALTA CONFIANÇA EFETIVA = classificação automática + curadoria manual do operador.
  // Assim, ao promover/rebaixar criativos, a análise do GT se refaz sozinha.
  const decisoes = meta.decisoes ?? {};
  const validados = [
    ...(meta.validados ?? []).map((a) => ({ a, auto: 'validado' as const })),
    ...(meta.aValidar ?? []).map((a) => ({ a, auto: 'a_validar' as const })),
    ...(Array.isArray(meta.descartados) ? meta.descartados : []).map((a) => ({ a, auto: 'descartado' as const })),
  ]
    .filter((x) => (decisoes[x.a.id] ?? x.auto) === 'validado')
    .map((x) => x.a);
  if (validados.length === 0) return null; // sem criativos de alta confiança
  const total = validados.length;
  const norm = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Formato do criativo — vídeo costuma converter mais e baixar CPM.
  const media = { video: 0, imagem: 0, carrossel: 0 };
  for (const a of validados) media[(a.midiaTipo ?? 'imagem') as 'video' | 'imagem' | 'carrossel'] += 1;
  const midiaConhecida = validados.some((a) => a.midiaTipo);
  const videoPct = Math.round((media.video / total) * 100);

  // Destino do clique.
  const dest = { whatsapp: 0, lp: 0, perfil: 0 };
  for (const a of validados) dest[(a.destTipo ?? 'perfil') as 'whatsapp' | 'lp' | 'perfil'] += 1;

  // Domínio da LP → tem formulário? (qualificação antes de virar lead)
  const hostOf = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  // Cruzamento: por domínio de LP, sabe se tem formulário E o status do WhatsApp.
  const lpInfo = new Map<string, { hasForm: boolean; waOk: boolean; waBroken: boolean }>();
  for (const e of lead.empreendimentos ?? []) {
    const h = hostOf(e.lp);
    if (!h || !e.lpAudit) continue;
    const wa = e.lpAudit.whatsappButtons ?? [];
    lpInfo.set(h, { hasForm: !!e.lpAudit.form?.hasForm, waOk: wa.some((b) => b.working), waBroken: wa.some((b) => !b.working) });
  }
  let whatsDireto = 0;
  let lpComForm = 0;
  let lpSemForm = 0;
  let lpSemFormComWhats = 0; // sem form MAS com WhatsApp OK → capta mesmo assim
  let lpSemFormWhatsQuebrado = 0; // sem form E WhatsApp quebrado → captação zero
  let lpSemFormSemNada = 0; // sem form E sem WhatsApp → sem caminho de conversão
  for (const a of validados) {
    if (a.destTipo === 'whatsapp') { whatsDireto += 1; continue; }
    if (a.destTipo !== 'lp') continue;
    const h = (a.dest?.[0] || '').toLowerCase().replace(/^www\./, '');
    const info = lpInfo.get(h);
    if (info?.hasForm) { lpComForm += 1; continue; }
    lpSemForm += 1;
    if (info?.waOk) lpSemFormComWhats += 1;
    else if (info?.waBroken) lpSemFormWhatsQuebrado += 1;
    else lpSemFormSemNada += 1;
  }

  // Duplicados: mesma peça (texto+destino). Repetição = fadiga / verba pulverizada.
  const sig = (a: AdItem) => norm(a.trecho || a.id).replace(/[^a-z0-9]/g, '').slice(0, 90) + '|' + (a.dest?.[0] || a.destTipo || '');
  const grupos = new Map<string, AdItem[]>();
  for (const a of validados) {
    const k = sig(a);
    const arr = grupos.get(k) ?? [];
    arr.push(a);
    grupos.set(k, arr);
  }
  const dupArrays = [...grupos.values()].filter((g) => g.length > 1);
  const duplicados = dupArrays.reduce((s, g) => s + (g.length - 1), 0);
  const dupGrupos = dupArrays
    .map((g) => ({
      copy: (g[0].trecho || '(criativo sem texto)').slice(0, 60),
      dest: g[0].dest?.[0] ?? (g[0].destTipo === 'whatsapp' ? 'WhatsApp' : g[0].destTipo === 'perfil' ? 'perfil' : '—'),
      qtd: g.length,
      mesmaLp: g[0].destTipo === 'lp' && !!g[0].dest?.length,
    }))
    .sort((a, b) => b.qtd - a.qtd);

  // Cobertura de empreendimentos ativos.
  const empKeys = [...new Set(validados.map((a) => a.empreendimento).filter(Boolean) as string[])];
  const ativos = (lead.empreendimentos ?? []).filter((e) => e.status === 'lancamento' || e.status === 'em_obra');
  const temAnuncio = (nome: string) => {
    const k = norm(nome).replace(/[^a-z0-9]/g, '');
    return k.length >= 4 && empKeys.some((ek) => { const kk = norm(ek).replace(/[^a-z0-9]/g, ''); return kk.length >= 4 && (kk.includes(k) || k.includes(kk)); });
  };
  const ativosSemAnuncio = ativos.filter((e) => !temAnuncio(e.nome)).map((e) => e.nome);
  const anunciados = ativos.length - ativosSemAnuncio.length;

  const findings: { nivel: GtNivel; titulo: string; texto: string }[] = [];
  if (midiaConhecida && videoPct < 30)
    findings.push({ nivel: 'alerta', titulo: 'Pouco vídeo', texto: `só ${videoPct}% dos criativos são vídeo (${media.video} de ${total}). Vídeo costuma ter CTR maior, CPM menor e mais conversão — produza mais criativos em vídeo, começando pelos produtos com mais verba.` });
  for (const g of dupGrupos.filter((x) => x.mesmaLp && x.qtd >= 2))
    findings.push({ nivel: g.qtd >= 3 ? 'critico' : 'alerta', titulo: 'Criativo duplicado na mesma LP', texto: `${g.qtd}× praticamente a mesma peça apontando pra ${g.dest} — fadiga de criativo e pulverização de verba entre anúncios iguais competindo no mesmo leilão. Consolide o orçamento ou varie a peça (ângulo/oferta/formato).` });
  if (whatsDireto > 0)
    findings.push({ nivel: 'alerta', titulo: 'WhatsApp sem qualificação', texto: `${whatsDireto} criativo(s) mandam direto pro WhatsApp, sem formulário de qualificação antes — tende a gerar lead desqualificado e sobrecarregar o time comercial. Avalie uma LP com filtro (orçamento, região, intenção) antes do WhatsApp.` });
  if (lpSemFormWhatsQuebrado > 0)
    findings.push({ nivel: 'critico', titulo: 'LP sem captação funcional', texto: `${lpSemFormWhatsQuebrado} criativo(s) levam a LP sem formulário E com WhatsApp QUEBRADO — captação zero, verba de anúncio jogada fora.` });
  if (lpSemFormSemNada > 0)
    findings.push({ nivel: 'alerta', titulo: 'LP sem caminho de conversão', texto: `${lpSemFormSemNada} criativo(s) levam a LP sem formulário e sem botão de WhatsApp — o clique pago não tem como virar lead.` });
  for (const nome of ativosSemAnuncio)
    findings.push({ nivel: 'alerta', titulo: nome, texto: 'empreendimento ativo SEM criativo no Meta — oportunidade: produto com verba zero no social.' });

  const strategy: string[] = [];
  if (midiaConhecida && videoPct < 30) strategy.push(`Produzir criativos em VÍDEO (hoje ${videoPct}%) — no Meta o vídeo costuma baixar o CPM e subir a conversão; priorize os produtos com mais verba.`);
  if (dupGrupos.some((x) => x.mesmaLp && x.qtd >= 2)) strategy.push('Consolidar/variar os criativos duplicados que apontam pra mesma LP — evita competição interna no leilão e fadiga; troque por variações reais (ângulo, oferta, formato).');
  if (whatsDireto > 0) strategy.push('Inserir uma etapa de qualificação (LP com formulário curto) antes do WhatsApp nos criativos de conversa — melhora a qualidade do lead que chega ao time.');
  if (ativosSemAnuncio.length) strategy.push(`Subir campanha para ${ativosSemAnuncio.length} empreendimento(s) ativo(s) sem anúncio (${ativosSemAnuncio.slice(0, 4).join(', ')}${ativosSemAnuncio.length > 4 ? '…' : ''}).`);
  strategy.push('Rodar teste de criativos contínuo (2-3 variações por conjunto) e trocar os fatigados — o criativo é o maior alavancador de CPA no Meta.');

  return { total, media, midiaConhecida, videoPct, dest, whatsDireto, lpComForm, lpSemForm, lpSemFormComWhats, lpSemFormWhatsQuebrado, lpSemFormSemNada, duplicados, dupGrupos, anunciados, ativosCount: ativos.length, ativosSemAnuncio, findings, strategy };
}

function MetaGtContainer({ lead }: { lead: Lead }) {
  const [aberto, setAberto] = useState(false);
  const [formatoSel, setFormatoSel] = useState<'video' | 'imagem' | 'carrossel' | null>(null);
  const gt = analyzeMetaGt(lead);
  if (!gt) return null;
  const validados = lead.anuncios?.meta?.validados ?? [];
  const nivelColor = (n: GtNivel) => (n === 'critico' ? 'text-v4-error' : n === 'alerta' ? 'text-v4-warning' : 'text-v4-success');
  const nivelBorder = (n: GtNivel) => (n === 'critico' ? 'border-v4-error' : n === 'alerta' ? 'border-v4-warning' : 'border-v4-border');
  const pct = (n: number) => (gt.total ? Math.round((n / gt.total) * 100) : 0);
  return (
    <div className="rounded-2xl border border-v4-red bg-v4-card p-5 shadow-[0_0_16px_rgba(230,57,70,0.15)]">
      <h3 className="mb-1 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
        <Crosshair size={18} className="text-v4-red" /> Análise do Gestor de Tráfego <span className="text-sm font-normal text-v4-text-muted">(criativos do Meta · alta confiança)</span>
      </h3>
      <p className="mb-3 text-[11px] text-v4-text-disabled">
        Analisa os criativos que estão em <b>alta confiança</b> (classificação automática + sua curadoria) — ao promover/rebaixar um criativo, esta análise se refaz sozinha. Olha destino/captação, fadiga, cobertura e formato. No social, o criativo é o maior alavancador de CPA.
      </p>

      <div className="mb-4 grid grid-cols-3 gap-2 lg:grid-cols-6">
        <GtKpi label="Criativos ativos" value={gt.total} sub="alta confiança" />
        {([['video', '🎬'], ['imagem', '🖼️'], ['carrossel', '🎠']] as const).map(([t, icon]) => {
          const count = gt.media[t];
          const on = formatoSel === t;
          const clicavel = gt.midiaConhecida && count > 0;
          return (
            <button
              key={t}
              disabled={!clicavel}
              title={t}
              onClick={() => setFormatoSel(on ? null : t)}
              className={`rounded-xl border bg-v4-surface p-3 text-left transition ${
                !clicavel
                  ? 'cursor-default border-v4-border opacity-60'
                  : on
                    ? 'border-v4-red shadow-[0_0_16px_rgba(230,57,70,0.35)]'
                    : 'border-v4-border hover:border-v4-red'
              }`}
            >
              <p className="text-base leading-none">{icon}</p>
              <p className="font-display text-xl font-bold text-v4-text">{gt.midiaConhecida ? count : '—'}</p>
              <p className="text-[10px] text-v4-text-muted">{gt.midiaConhecida ? `(${pct(count)}%)` : 're-medir'}</p>
            </button>
          );
        })}
        <GtKpi label="Duplicados" value={gt.duplicados} tone={gt.duplicados > 0 ? 'error' : 'success'} sub="peças repetidas" />
        <GtKpi label="Empreend." value={gt.ativosCount ? `${gt.anunciados}/${gt.ativosCount}` : '—'} tone={gt.ativosCount && gt.anunciados < gt.ativosCount ? 'error' : 'success'} sub="anunciados" />
      </div>
      {formatoSel && gt.midiaConhecida && (
        <div className="mb-4 rounded-lg border border-v4-red bg-v4-surface p-3">
          <p className="mb-1.5 text-[11px] font-medium text-v4-text-muted">Criativos em {formatoSel === 'video' ? 'vídeo' : formatoSel === 'imagem' ? 'estático' : 'carrossel'}:</p>
          <div className="space-y-1.5">
            {validados
              .filter((a) => (a.midiaTipo ?? 'imagem') === formatoSel)
              .map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-v4-text-muted">
                    {a.advertiser ?? 'anunciante ?'}
                    {a.empreendimento ? ` · ${a.empreendimento}` : ''}
                  </span>
                  {a.trecho && <span className="min-w-0 flex-1 truncate text-v4-text-disabled">"{a.trecho.slice(0, 50)}…"</span>}
                  <a href={`https://www.facebook.com/ads/library/?id=${a.id}`} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-v4-red-hover transition hover:underline">
                    ver anúncio ↗
                  </a>
                </div>
              ))}
          </div>
        </div>
      )}

      {aberto && (
        <>
          {/* Destino & qualificação do lead */}
          <div className="mb-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Destino &amp; qualificação</p>
            <div className="flex flex-wrap gap-1.5 text-sm">
              <span className={`rounded px-2 py-0.5 ${gt.whatsDireto > 0 ? 'bg-[rgba(234,179,8,0.15)] text-v4-warning' : 'bg-v4-card text-v4-text-muted'}`}>💬 WhatsApp direto <b>{gt.whatsDireto}</b>{gt.whatsDireto > 0 ? ' · sem qualificação' : ''}</span>
              <span className="rounded bg-v4-card px-2 py-0.5 text-v4-text">🌐 LP c/ formulário <b>{gt.lpComForm}</b></span>
              {gt.lpSemForm > 0 && <span className="rounded bg-v4-card px-2 py-0.5 text-v4-text">🌐 LP s/ formulário <b>{gt.lpSemForm}</b></span>}
              {gt.lpSemFormComWhats > 0 && (
                <span className="rounded bg-[rgba(34,197,94,0.15)] px-2 py-0.5 text-v4-success">↳ {gt.lpSemFormComWhats} captam por WhatsApp</span>
              )}
              {gt.lpSemFormWhatsQuebrado > 0 && (
                <span className="rounded bg-[rgba(230,57,70,0.15)] px-2 py-0.5 text-v4-error">↳ {gt.lpSemFormWhatsQuebrado} c/ WhatsApp quebrado</span>
              )}
              {gt.lpSemFormSemNada > 0 && (
                <span className="rounded bg-[rgba(234,179,8,0.15)] px-2 py-0.5 text-v4-warning">↳ {gt.lpSemFormSemNada} sem captação</span>
              )}
              {gt.dest.perfil > 0 && <span className="rounded bg-[rgba(230,57,70,0.15)] px-2 py-0.5 text-v4-error">👤 Perfil <b>{gt.dest.perfil}</b></span>}
            </div>
          </div>

          {/* Criativos duplicados */}
          {gt.dupGrupos.length > 0 && (
            <div className="mb-4">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Criativos duplicados (fadiga / verba pulverizada)</p>
              <div className="space-y-1">
                {gt.dupGrupos.map((g, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded bg-v4-surface px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate text-v4-text-muted">"{g.copy}…" → {g.dest}</span>
                    <span className="shrink-0 font-bold text-v4-warning">{g.qtd}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {gt.findings.length > 0 && (
            <div className="mb-4">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Achados dos criativos</p>
              <div className="space-y-2">
                {gt.findings.map((f, i) => (
                  <div key={i} className={`rounded-lg border ${nivelBorder(f.nivel)} bg-v4-surface p-2.5`}>
                    <p className="text-sm font-medium text-v4-text">
                      <span className={nivelColor(f.nivel)}>{f.nivel === 'critico' ? '🔴 CRÍTICO' : '🟡 ALERTA'}</span> · {f.titulo}
                    </p>
                    <p className="mt-0.5 text-xs text-v4-text-muted">{f.texto}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {gt.strategy.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">Plano de ação (criativos Meta)</p>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-v4-text">
                {gt.strategy.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="mt-4 flex justify-center">
        <button
          onClick={() => setAberto(!aberto)}
          className={
            aberto
              ? 'rounded-lg border border-v4-border px-6 py-2 text-sm font-medium text-v4-text-muted transition hover:border-v4-red hover:text-v4-red'
              : 'animate-pulse-red rounded-lg px-6 py-2.5 text-sm font-semibold text-white'
          }
        >
          {aberto ? 'Recolher análise ▴' : 'Ver análise completa ▾'}
        </button>
      </div>
    </div>
  );
}

function OportunidadesSection({ briefing, sinais }: { briefing: Briefing; sinais: string[] }) {
  const b = briefing;
  const waSinal = sinais.find((s) => /whatsapp/i.test(s));
  const iaDores = b.dores ?? [];
  const iaGanchos = b.ganchos ?? [];
  const dores = waSinal && !iaDores.some((d) => /whatsapp/i.test(d)) ? [waSinal, ...iaDores] : iaDores;
  const ganchos = waSinal && !iaGanchos.some((h) => /whatsapp/i.test(h)) ? [waSinal, ...iaGanchos] : iaGanchos;
  if (dores.length === 0 && ganchos.length === 0) return null;
  return (
    <div className="mb-6 grid gap-3 md:grid-cols-2">
      {dores.length > 0 && (
        <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-v4-text">
            <Target size={15} className="text-v4-red" /> Dores
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-v4-text">
            {dores.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {ganchos.length > 0 && (
        <div className="rounded-2xl border border-v4-red bg-[rgba(230,57,70,0.08)] p-5">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-v4-red-hover">
            <Lightbulb size={15} /> Ganchos de abordagem
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-v4-text">
            {ganchos.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Análise estratégica — submenu: botões por tópico (Negócio / Estratégia);
// o conteúdo do tópico aparece ao clicar. Mesmo padrão de botão (hover vermelho).
function AnaliseSection({ briefing }: { briefing: Briefing }) {
  const [open, setOpen] = useState<string | null>(null);
  const b = briefing;
  const negocio = [
    { key: 'ramo', label: 'Ramo de atividade', text: b.ramoAtividade, accent: '#60a5fa', icon: Briefcase },
    { key: 'setor', label: 'Indústria / setor', text: b.setor, accent: '#f472b6', icon: Factory },
    { key: 'produtos', label: 'Produtos e serviços', text: b.produtosServicos, accent: '#34d399', icon: Package },
    { key: 'publico', label: 'Público-alvo', text: b.publicoAlvo, accent: '#fbbf24', icon: Users },
    { key: 'modelo', label: 'Modelo de negócio', text: b.modeloNegocio, accent: '#f87171', icon: Workflow },
    { key: 'diferenciais', label: 'Diferenciais', text: b.diferenciais, accent: '#a78bfa', icon: Award },
  ].filter((i) => i.text);
  const estrategia = [
    { key: 'mercado', label: 'Mercado de atuação', text: b.mercadoAtuacao, accent: '#f87171', icon: MapPin },
    { key: 'icp', label: 'ICP presumido', text: b.icpPresumido, accent: '#60a5fa', icon: Crosshair },
    { key: 'rapport', label: 'Pontos de rapport', text: b.pontosRapport, accent: '#34d399', icon: Handshake },
    { key: 'tipoVenda', label: 'Tipo de venda', text: b.tipoVenda, accent: '#a78bfa', icon: ShoppingCart },
    { key: 'presenca', label: 'Presença digital', text: b.presencaDigital, accent: '#fbbf24', icon: Globe },
    { key: 'historia', label: 'História da empresa', text: b.historia, accent: '#94a3b8', icon: History },
  ].filter((i) => i.text);
  const toggle = (k: string) => setOpen((p) => (p === k ? null : k));
  const current = [...negocio, ...estrategia].find((i) => i.key === open);
  return (
    <div className="mb-6 space-y-3">
      {b.resumo && (
        <div className="rounded-2xl border border-v4-border-strong bg-v4-card p-5 text-base leading-relaxed text-v4-text">
          {b.resumo}
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-v4-red">Negócio</p>
        <div className="flex flex-wrap gap-2">
          {negocio.map((i) => (
            <MenuBtn key={i.key} active={open === i.key} onClick={() => toggle(i.key)} label={i.label} icon={i.icon} />
          ))}
        </div>
        {current && negocio.some((i) => i.key === open) && (
          <BriefBlock label={current.label} text={current.text} />
        )}
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-v4-red">Estratégia</p>
        <div className="flex flex-wrap gap-2">
          {estrategia.map((i) => (
            <MenuBtn key={i.key} active={open === i.key} onClick={() => toggle(i.key)} label={i.label} icon={i.icon} />
          ))}
        </div>
        {current && estrategia.some((i) => i.key === open) && (
          <BriefBlock label={current.label} text={current.text} />
        )}
      </div>
    </div>
  );
}

// Scripts de abordagem — aberto pelo menu.
function ScriptsSection({
  briefing,
  primaryFirstName,
}: {
  briefing: Briefing;
  primaryFirstName: string | null;
}) {
  const b = briefing;
  if (!b.scripts) return null;
  const emailFull =
    b.scripts.email && (b.scripts.email.assunto || b.scripts.email.corpo)
      ? `Assunto: ${fillScript(b.scripts.email.assunto, primaryFirstName)}\n\n${fillScript(b.scripts.email.corpo, primaryFirstName)}`
      : '';
  return (
    <div className="mb-6">
      <div className="grid gap-3 md:grid-cols-2">
        <ScriptCard icon={PhoneCall} title="Ligação" text={fillScript(b.scripts.ligacao, primaryFirstName)} />
        <ScriptCard icon={MessageSquare} title="WhatsApp" text={fillScript(b.scripts.whatsapp, primaryFirstName)} />
        <ScriptCard icon={Mail} title="E-mail" text={emailFull} />
        <ScriptCard icon={Instagram} title="Instagram (DM)" text={fillScript(b.scripts.instagram, primaryFirstName)} />
        <ScriptCard icon={Linkedin} title="LinkedIn" text={fillScript(b.scripts.linkedin, primaryFirstName)} />
      </div>
      <p className="mt-2 text-xs text-v4-text-disabled">
        {'Placeholders: {{nome}} = decisor · {{sdr}} = seu nome.'}
        {b.model ? ` Gerado por ${b.model}.` : ''}
      </p>
    </div>
  );
}

function BriefBlock({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className="mt-3 rounded-xl border border-v4-red bg-v4-red-muted p-4 shadow-[0_0_16px_rgba(230,57,70,0.30)]">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-v4-red-hover">{label}</p>
      <p className="text-sm leading-relaxed text-v4-text">{text}</p>
    </div>
  );
}

function ScriptCard({
  icon: Icon,
  title,
  text,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  text: string;
}) {
  if (!text.trim()) return null;
  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-semibold text-v4-text">
          <Icon size={15} /> {title}
        </span>
        <CopyBtn text={text} />
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-v4-text-muted">{text}</p>
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Copiado.');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Não foi possível copiar.');
    }
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 rounded-lg border border-v4-border bg-v4-surface px-2 py-1 text-xs font-medium text-v4-text-muted hover:bg-v4-card-hover hover:text-v4-text"
    >
      {copied ? <Check size={13} className="text-v4-success" /> : <Copy size={13} />}
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}

// Botão do menu de seções (abre/fecha o bloco). `alert` marca um ponto crítico.
function MenuBtn({
  active,
  onClick,
  icon: Icon,
  label,
  alert,
}: {
  active: boolean;
  onClick: () => void;
  icon?: React.ComponentType<{ size?: number }>;
  label: string;
  alert?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition hover:border-v4-red hover:text-v4-red hover:shadow-[0_0_16px_rgba(230,57,70,0.35)] ${
        active
          ? 'border-v4-red bg-v4-red-muted text-v4-red-hover'
          : 'border-v4-border bg-v4-card text-v4-text'
      }`}
    >
      {Icon && <Icon size={16} />} {label}
      {alert && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-v4-red" />}
    </button>
  );
}

// ============================================================================
// Organograma (DataStone) — diretoria + gerência
// ============================================================================
function OrganogramaSection({ org }: { org: Organograma }) {
  return (
    <div className="mb-6">
      <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-v4-text">
        <Network size={20} /> Organograma
        <span className="text-sm font-normal text-v4-text-muted">
          {org.diretoria.length + org.gerencia.length} pessoas
        </span>
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <OrgColumn title="Diretoria" icon={Briefcase} people={org.diretoria} showShare />
        <OrgColumn title="Gerência" icon={Users} people={org.gerencia} />
      </div>
    </div>
  );
}

function OrgColumn({
  title,
  icon: Icon,
  people,
  showShare,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  people: Organograma['diretoria'];
  showShare?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
      <h3 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-v4-text">
        <Icon size={16} /> {title}
        <span className="text-xs font-normal text-v4-text-muted">{people.length}</span>
      </h3>
      {people.length > 0 ? (
        <ul className="space-y-2">
          {people.map((p, i) => (
            <li key={i} className="border-b border-v4-border pb-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-v4-text">{p.nome}</span>
                {showShare && p.participacao != null && p.participacao > 0 && (
                  <span className="rounded bg-v4-surface px-1.5 py-0.5 text-[11px] text-v4-text-muted">
                    {p.participacao}%
                  </span>
                )}
              </div>
              {p.cargo && <div className="text-xs capitalize text-v4-text-muted">{p.cargo.toLowerCase()}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-v4-text-muted">Nenhum registro.</p>
      )}
    </div>
  );
}

function EmpreendimentosCard({
  title,
  items,
  tone,
  withMaterials,
  companyName,
}: {
  title: string;
  items: Lead['empreendimentos'];
  tone: Tone;
  withMaterials?: boolean;
  companyName: string;
}) {
  const comLp = items.filter((e) => e.lp);
  return (
    <div className="rounded-2xl border border-v4-border bg-v4-card p-5">
      <h3 className="mb-3 font-display text-base font-semibold text-v4-text">{title}</h3>
      <KpiTile value={items.length} label={title} tone={items.length > 0 ? tone : 'neutral'} />

      {items.length > 0 ? (
        <>
          {/* LPs encontradas com nota + PageSpeed + WhatsApp de cada uma */}
          {withMaterials && comLp.length > 0 && (
            <details className="mt-3">
              <summary className="flex cursor-pointer items-center gap-2 rounded-lg bg-v4-surface px-3 py-2 text-sm font-medium text-v4-text transition hover:bg-v4-card-hover">
                <ChevronRight size={16} className="chev text-v4-red" />
                {comLp.length} {comLp.length === 1 ? 'LP encontrada' : 'LPs encontradas'}
              </summary>
              <div className="mt-2 space-y-3">
                {comLp.map((e, i) => (
                  <LpNotes key={i} e={e} />
                ))}
              </div>
            </details>
          )}

          {/* Lista completa (nome, cidade, materiais) */}
          <details className="mt-2">
            <summary className="flex cursor-pointer items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm font-medium text-v4-text transition hover:bg-v4-card-hover">
              <ChevronRight size={16} className="chev text-v4-red" /> Ver empreendimentos
            </summary>
            <ul className="mt-2 space-y-2">
              {items.map((e, i) => {
                const q = encodeURIComponent(`${e.nome} ${e.cidade ?? ''} ${companyName}`.trim());
                return (
                  <li key={i} className="border-b border-v4-border pb-2 last:border-0">
                    <div className="text-sm font-medium text-v4-text">{e.nome}</div>
                    {e.cidade && <div className="text-xs text-v4-text-muted">{e.cidade}</div>}
                    {withMaterials && (
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                        {e.lp && (
                          <a
                            href={e.lp}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded bg-v4-red px-2 py-0.5 font-semibold text-white hover:bg-v4-red-hover"
                          >
                            Ver LP
                          </a>
                        )}
                        <MatLink href={`https://www.google.com/search?q=${q}`} label="Google" />
                        <MatLink href={`https://www.google.com/search?tbm=isch&q=${q}`} label="Fotos" />
                        <MatLink
                          href={`https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=BR&q=${encodeURIComponent(e.nome)}`}
                          label="Anúncios"
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        </>
      ) : (
        <p className="mt-2 text-xs text-v4-text-muted">Nenhum.</p>
      )}
    </div>
  );
}

// Notas da LP de um empreendimento (mesma estrutura do quadro "Nota do site").
// Link do anúncio com PREVIEW no hover (imagem do criativo + anunciante + trecho).
// Some sozinho ao tirar o mouse (group-hover, sem estado). Preview não captura o
// mouse (pointer-events-none) — clicar no link abre o anúncio na Biblioteca.
function AdHoverLink({ ad, index }: { ad: AdItem; index: number }) {
  return (
    <span className="group relative inline-block">
      <a
        href={`https://www.facebook.com/ads/library/?id=${ad.id}`}
        target="_blank"
        rel="noreferrer"
        className="rounded bg-v4-card px-2 py-0.5 text-[11px] text-v4-red-hover transition hover:underline"
      >
        anúncio {index + 1} ↗
      </a>
      <div className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-56 rounded-lg border border-v4-red bg-v4-card p-2 text-left shadow-[0_6px_28px_rgba(0,0,0,0.55)] group-hover:block">
        {ad.imagem ? (
          <img src={ad.imagem} alt="criativo" className="mb-1.5 max-h-40 w-full rounded object-cover" />
        ) : (
          <div className="mb-1.5 flex h-16 items-center justify-center rounded bg-v4-surface text-[10px] text-v4-text-disabled">sem imagem</div>
        )}
        <p className="text-[11px] font-semibold text-v4-text">{ad.advertiser ?? 'anunciante ?'}</p>
        {ad.empreendimento && <p className="text-[10px] text-v4-red-hover">{ad.empreendimento}</p>}
        {ad.trecho && <p className="mt-0.5 text-[10px] leading-snug text-v4-text-muted">{ad.trecho.slice(0, 160)}</p>}
      </div>
    </span>
  );
}

// Nota de CONVERSÃO da LP (0-10) para tráfego pago: pesa o que importa —
// rastreio ausente e CTA quebrado penalizam forte; mobile pesa mais que desktop;
// SEO pesa pouco (pago não depende de orgânico). Retorna a nota + os porquês.
function notaConversaoLp(a: EmpreendimentoLpAudit): { nota: number; motivos: string[] } {
  let nota = 10;
  const motivos: string[] = [];
  const ded = (pts: number, txt: string) => { nota -= pts; motivos.push(`−${pts} ${txt}`); };
  // Rastreio (sem isso a campanha roda cega)
  if (!a.hasMetaPixel) ded(3, 'sem Meta Pixel');
  if (!a.hasGoogleAds) ded(1, 'sem conversão Google Ads');
  // CTA / captação
  const wa = a.whatsappButtons ?? [];
  if (wa.some((b) => !b.working)) ded(3, 'WhatsApp quebrado');
  else if (wa.length === 0 && !a.hasWhatsappWidget && !a.form?.hasForm) ded(2, 'sem CTA (WhatsApp/form)');
  // Experiência MOBILE (maioria do tráfego → peso maior)
  const lcpM = a.pagespeed?.lcpMs != null ? a.pagespeed.lcpMs / 1000 : null;
  const perfM = a.pagespeed?.performance ?? null;
  if (lcpM != null && lcpM > 4) ded(3, `LCP mobile ${lcpM.toFixed(1)}s`);
  else if (perfM != null && perfM < 50) ded(2, `perf mobile ${perfM}`);
  else if (perfM != null && perfM < 90) ded(1, 'perf mobile regular');
  // Experiência DESKTOP (peso menor)
  const perfD = a.pagespeedDesktop?.performance ?? null;
  if (perfD != null && perfD < 50) ded(1, `perf desktop ${perfD}`);
  else if (perfD != null && perfD < 90) ded(0.5, 'perf desktop regular');
  // Formulário
  if (a.form?.hasForm && (!a.form.hasSubmit || a.form.actionSuspeita)) ded(2, 'formulário quebrado');
  else if (a.form?.fields != null && a.form.fields > 6) ded(1, `formulário longo (${a.form.fields} campos)`);
  // SEO (peso baixo pra tráfego pago)
  if (a.pagespeed?.seo != null && a.pagespeed.seo < 50) ded(0.5, 'SEO baixo');
  return { nota: Math.max(0, Math.round(nota * 10) / 10), motivos };
}

function LpNotes({ e, ads = [], conversao = false }: { e: Lead['empreendimentos'][number]; ads?: AdItem[]; conversao?: boolean }) {
  const a = e.lpAudit;
  const ps = a?.pagespeed ?? null;
  const g = a ? siteGrade(a) : null;
  const conv = a && conversao ? notaConversaoLp(a) : null;
  return (
    <div className="rounded-lg border border-v4-red bg-v4-surface p-3 shadow-[0_0_12px_rgba(230,57,70,0.20)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-v4-text">{e.nome}</span>
        {e.lp && (
          <a
            href={e.lp}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-v4-red px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-v4-red-hover"
          >
            Ver LP
          </a>
        )}
      </div>
      {a ? (
        <div className="mt-2 space-y-2 text-sm">
          {conv ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-v4-text-muted">Nota de conversão:</span>
              <span className={`rounded px-2 py-0.5 font-bold ${TONE_BG[notaSiteTone(conv.nota)]}`}>{conv.nota}/10</span>
              {conv.motivos.length > 0 && (
                <span className="text-[10px] text-v4-text-muted" title="Descontos aplicados na nota de conversão">{conv.motivos.join(' · ')}</span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-v4-text-muted">Nota do site:</span>
              {g && <span className={`rounded px-2 py-0.5 font-bold ${TONE_BG[notaSiteTone(g.nota)]}`}>{g.nota}/10</span>}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <MessageSquare size={13} className="text-v4-text-muted" />
            <WhatsappStatus audit={a} />
          </div>
          {a.loadTimeMs != null && (
            <p className="text-xs text-v4-text-muted">
              Carregamento: {(a.loadTimeMs / 1000).toFixed(1)}s
            </p>
          )}
          {/* Pixels e tags de rastreamento (Meta + Google + TikTok) desta LP */}
          <div>
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-v4-text-disabled">Pixels &amp; tags</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <PixelChip ok={a.hasMetaPixel} viaGtm={a.hasGoogleTag} confirmed={a.pixelsConfirmed} label="Meta Pixel" />
              <PixelChip ok={!!a.hasGoogleAds} viaGtm={a.hasGoogleTag} confirmed={a.pixelsConfirmed} label="Google Ads (conv.)" />
              <Chip ok={a.hasGoogleTag} label="Google Tag/Analytics" />
              <PixelChip ok={!!a.hasTiktokPixel} viaGtm={a.hasGoogleTag} confirmed={a.pixelsConfirmed} label="TikTok Pixel" />
              {a.pixelsConfirmed && <span className="text-[10px] text-v4-success">✓ confirmado (headless)</span>}
            </div>
            {!a.pixelsConfirmed && a.hasGoogleTag && !a.hasMetaPixel && (
              <p className="mt-1 text-[10px] text-v4-text-disabled">
                Detecção por HTML: pixels via GTM não aparecem. Re-medir confirma rodando o JS.
              </p>
            )}
          </div>

          {/* PageSpeed COMPLETO: mobile e desktop */}
          {ps || a.pagespeedDesktop ? (
            <div className="space-y-1.5">
              {ps && (
                <>
                  <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-v4-text-disabled">
                    <Smartphone size={11} /> PageSpeed mobile
                  </p>
                  <div className="grid grid-cols-4 gap-1.5">
                    <PsTile label="Perf" value={ps.performance} />
                    <PsTile label="SEO" value={ps.seo} />
                    <PsTile label="Práticas" value={ps.bestPractices} />
                    <PsTile label="Acess." value={ps.accessibility} />
                  </div>
                  {ps.lcpMs != null && (
                    <p className="text-[11px] text-v4-text-muted">LCP mobile (maior conteúdo): {(ps.lcpMs / 1000).toFixed(1)}s</p>
                  )}
                </>
              )}
              {a.pagespeedDesktop && (
                <>
                  <p className="flex items-center gap-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-v4-text-disabled">
                    <Monitor size={11} /> PageSpeed desktop
                  </p>
                  <div className="grid grid-cols-4 gap-1.5">
                    <PsTile label="Perf" value={a.pagespeedDesktop.performance} />
                    <PsTile label="SEO" value={a.pagespeedDesktop.seo} />
                    <PsTile label="Práticas" value={a.pagespeedDesktop.bestPractices} />
                    <PsTile label="Acess." value={a.pagespeedDesktop.accessibility} />
                  </div>
                  {a.pagespeedDesktop.lcpMs != null && (
                    <p className="text-[11px] text-v4-text-muted">LCP desktop: {(a.pagespeedDesktop.lcpMs / 1000).toFixed(1)}s</p>
                  )}
                </>
              )}
            </div>
          ) : (
            a.isOnline && (
              <p className="text-xs text-v4-warning">PageSpeed indisponível agora — re-enriquecer para tentar de novo.</p>
            )
          )}

          {/* Formulário de cadastro — DETALHE dos campos */}
          {a.form && (
            <div className="text-xs">
              <p className="flex items-center gap-1 text-v4-text-muted">
                <FileText size={12} />
                {!a.form.hasForm ? (
                  'sem formulário de cadastro'
                ) : a.form.viaEmbed ? (
                  'formulário embutido (RD/Typeform/HubSpot…) — campos não legíveis no HTML'
                ) : (
                  <span className={!a.form.hasSubmit ? 'text-v4-error' : 'text-v4-text'}>
                    Formulário: <b>{a.form.fields}</b> campos{!a.form.hasSubmit ? ' · sem botão de envio' : ''}
                  </span>
                )}
              </p>
              {a.form.hasForm && !a.form.viaEmbed && a.form.fieldList && a.form.fieldList.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {a.form.fieldList.map((fl, i) => (
                    <span key={i} className="rounded bg-v4-card px-1.5 py-0.5 text-[10px] text-v4-text">
                      {fl.placeholder || fl.nome || fl.tipo}
                      <span className="ml-1 text-v4-text-disabled">({fl.tipo})</span>
                    </span>
                  ))}
                </div>
              )}
              {a.form.hasForm && a.form.actionSuspeita && (
                <p className="mt-1 text-[11px] text-v4-error">
                  ⚠ Envio suspeito: o form aponta para "{a.form.action || '(vazio)'}" — pode não estar enviando os leads (confirmar).
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="mt-1 text-xs text-v4-text-muted">
          LP encontrada, auditoria ainda não disponível — re-enriquecer o lead.
        </p>
      )}
      {ads.length > 0 && (
        <div className="mt-2 border-t border-v4-border pt-2">
          <p className="mb-1 text-[11px] font-medium text-v4-text-muted">
            {ads.length} anúncio{ads.length > 1 ? 's' : ''} do Meta apontam pra esta LP:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ads.map((ad, i) => (
              <AdHoverLink key={ad.id} ad={ad} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type Tone = 'success' | 'warning' | 'error' | 'neutral';
const TONE_BG: Record<Tone, string> = {
  success: 'bg-v4-success text-black',
  warning: 'bg-v4-warning text-black',
  error: 'bg-v4-error text-black',
  neutral: 'bg-v4-surface text-v4-text',
};
const scoreTone = (v: number | null): Tone => (v == null ? 'neutral' : v >= 90 ? 'success' : v >= 50 ? 'warning' : 'error');
const notaSiteTone = (v: number | null): Tone => (v == null ? 'neutral' : v >= 8 ? 'success' : v >= 5 ? 'warning' : 'error');
const ratingTone = (v: number | null): Tone => (v == null ? 'neutral' : v >= 4 ? 'success' : v >= 3 ? 'warning' : 'error');

// Tile de destaque com cor por qualidade e número em preto (dados principais).
function KpiTile({
  value,
  label,
  sub,
  tone = 'neutral',
  small,
}: {
  value: React.ReactNode;
  label: string;
  sub?: string | null;
  tone?: Tone;
  small?: boolean;
}) {
  return (
    <div className={`rounded-xl px-4 py-3 text-center ${TONE_BG[tone]}`}>
      <div className={`font-display font-bold leading-none ${small ? 'text-lg' : 'text-3xl'}`}>{value}</div>
      <div className="mt-1 text-xs font-semibold">{label}</div>
      {sub && <div className={`text-[11px] font-medium ${tone === 'neutral' ? 'text-v4-text-muted' : 'text-black/70'}`}>{sub}</div>}
    </div>
  );
}

function PsTile({ label, value }: { label: string; value: number | null }) {
  const tone = scoreTone(value);
  const q = value == null ? '' : value >= 90 ? 'ótimo' : value >= 50 ? 'regular' : 'ruim';
  return (
    <div className={`rounded-xl px-3 py-3 text-center ${TONE_BG[tone]}`}>
      <div className="font-display text-2xl font-bold leading-none">{value ?? '—'}</div>
      <div className="mt-1 text-[11px] font-semibold">{label}</div>
      {q && <div className="text-[10px] font-medium text-black/70">{q}</div>}
    </div>
  );
}

// Etiqueta compacta (WhatsApp / quente).
function Tag({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${className}`}>{children}</span>;
}

// Origem do contato: "validado · 2 fontes" (verde) ou a fonte única.
function SourceBadge({ sources, validado }: { sources: string[]; validado: boolean }) {
  if (validado) {
    return <Tag className="bg-[rgba(34,197,94,0.15)] text-v4-success">validado · 2 fontes</Tag>;
  }
  const label = sources.includes('datastone') ? 'DataStone' : sources.includes('lemit') ? 'Lemit' : '';
  return label ? <Tag className="bg-v4-surface text-v4-text-muted">{label}</Tag> : null;
}

// Explica a origem/validação de um contato.
function fonteLabel(sources: string[], validado: boolean): string {
  if (validado) return 'Validado por Lemit + DataStone';
  if (!sources || sources.length === 0) return 'Origem não identificada';
  const nomes = sources.map((s) => (s === 'datastone' ? 'DataStone' : s === 'lemit' ? 'Lemit' : s));
  return `Fonte: ${nomes.join(' + ')}`;
}

// Card de destaque de um contato (com o "porquê" da validação).
function DestaqueContato({
  icon: Icon,
  tipo,
  valor,
  sources,
  validado,
  whatsapp,
  hot,
}: {
  icon: React.ComponentType<{ size?: number }>;
  tipo: string;
  valor: string | null;
  sources: string[];
  validado: boolean;
  whatsapp?: boolean;
  hot?: boolean;
}) {
  const found = !!valor;
  return (
    <div
      className={`rounded-2xl border p-4 ${
        found && validado ? 'border-v4-success bg-[rgba(34,197,94,0.06)]' : 'border-v4-border bg-v4-card'
      }`}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-v4-text-disabled">
        <Icon size={13} /> {tipo}
      </p>
      <p className={`mt-1 font-display text-lg font-bold ${found ? 'text-v4-text' : 'text-v4-text-muted'}`}>
        {valor ?? 'não encontrado'}
      </p>
      {found && (whatsapp || hot) && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {whatsapp && <Tag className="bg-[rgba(34,197,94,0.15)] text-v4-success">WhatsApp</Tag>}
          {hot && <Tag className="bg-v4-red-muted text-v4-red-hover">quente</Tag>}
        </div>
      )}
      {found && (
        <p className={`mt-2 flex items-center gap-1 text-xs ${validado ? 'text-v4-success' : 'text-v4-text-muted'}`}>
          {validado && <Check size={12} />} {fonteLabel(sources, validado)}
        </p>
      )}
    </div>
  );
}

// Destaques do decisor principal: melhor WhatsApp, telefone e e-mail validados.
function BestContacts({ person }: { person: DecisionMaker }) {
  const phones = person.phones ?? [];
  const emails = person.emails ?? [];
  const bestWa = phones.find((p) => p.whatsapp) ?? null;
  const bestPhone = phones[0] ?? null;
  const bestEmail = emails[0] ?? null;
  if (!bestWa && !bestPhone && !bestEmail) return null;
  const firstName = person.nome.split(/\s+/)[0];
  return (
    <div className="mb-4">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-v4-text-disabled">
        Melhor contato — {firstName} {person.isPrimary ? '(decisor principal)' : ''}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <DestaqueContato
          icon={MessageSquare}
          tipo="WhatsApp mais validado"
          valor={bestWa?.numero ?? null}
          sources={bestWa?.sources ?? []}
          validado={!!bestWa?.validado}
          whatsapp
          hot={bestWa?.hot}
        />
        <DestaqueContato
          icon={Phone}
          tipo="Telefone principal"
          valor={bestPhone?.numero ?? null}
          sources={bestPhone?.sources ?? []}
          validado={!!bestPhone?.validado}
          whatsapp={bestPhone?.whatsapp}
          hot={bestPhone?.hot}
        />
        <DestaqueContato
          icon={Mail}
          tipo="E-mail mais validado"
          valor={bestEmail?.email ?? null}
          sources={bestEmail?.sources ?? []}
          validado={!!bestEmail?.validado}
        />
      </div>
    </div>
  );
}

function DatastonePersonDetails({ data }: { data: NonNullable<DecisionMaker['datastone']> }) {
  const has =
    data.phones.length ||
    data.emails.length ||
    data.fixos.length ||
    data.renda ||
    data.ocupacao ||
    data.empregador ||
    data.pep ||
    data.idade != null ||
    data.empresas.length ||
    data.familia.length;
  if (!has) return null;
  return (
    <details className="mt-2">
      <summary className="flex cursor-pointer items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm font-medium text-v4-text transition hover:bg-v4-card-hover">
        <ChevronRight size={16} className="chev text-v4-red" /> Dados completos (DataStone)
      </summary>
      <div className="mt-2 grid gap-3 pl-2 text-sm sm:grid-cols-2">
        {data.phones.length > 0 && (
          <LemitBlock label="Telefones">
            {data.phones.map((t, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1 text-v4-text">
                {t.numero}
                {t.whatsapp && <Tag className="bg-[rgba(34,197,94,0.15)] text-v4-success">WhatsApp</Tag>}
                {t.hot && <Tag className="bg-v4-red-muted text-v4-red-hover">quente</Tag>}
              </li>
            ))}
          </LemitBlock>
        )}
        {data.emails.length > 0 && (
          <LemitBlock label="E-mails">
            {data.emails.map((e, i) => (
              <li key={i} className="break-all text-v4-text">{e}</li>
            ))}
          </LemitBlock>
        )}
        {(data.renda || data.ocupacao || data.empregador || data.idade != null || data.pep) && (
          <LemitBlock label="Dados pessoais">
            {data.renda && <li className="text-v4-text">Renda estimada: {data.renda}</li>}
            {data.ocupacao && <li className="text-v4-text">Ocupação: {data.ocupacao}</li>}
            {data.empregador && <li className="text-v4-text">Empregador: {data.empregador}</li>}
            {data.idade != null && <li className="text-v4-text">Idade: {data.idade}</li>}
            {data.pep && <li className="text-v4-warning">PEP — pessoa politicamente exposta</li>}
          </LemitBlock>
        )}
        {data.empresas.length > 0 && (
          <LemitBlock label={`Empresas vinculadas (${data.empresas.length})`}>
            {data.empresas.slice(0, 12).map((c, i) => (
              <li key={i}>
                <span className="text-v4-text">{c.nome ?? '—'}</span>
                {c.situacao && (
                  <span className={c.situacao.toUpperCase() === 'ATIVA' ? 'text-v4-success' : 'text-v4-error'}> · {c.situacao}</span>
                )}
                {c.cargo && <span className="text-v4-text-disabled"> · {c.cargo}</span>}
              </li>
            ))}
          </LemitBlock>
        )}
        {data.familia.length > 0 && (
          <LemitBlock label="Família / vínculos">
            {data.familia.map((f, i) => (
              <li key={i} className="text-v4-text">
                {f.nome}
                {f.tipo && <span className="text-v4-text-disabled"> — {f.tipo}</span>}
              </li>
            ))}
          </LemitBlock>
        )}
      </div>
    </details>
  );
}

function LemitPersonDetails({ data }: { data: NonNullable<DecisionMaker['lemit']> }) {
  const has =
    data.phones.length ||
    data.emails.length ||
    data.enderecos.length ||
    data.dataNascimento ||
    data.renda != null ||
    data.ocupacao ||
    data.situacaoCpf ||
    data.scoreCredito ||
    data.vinculos.length ||
    data.carros.length;
  if (!has) return null;
  return (
    <details className="mt-3">
      <summary className="flex cursor-pointer items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-3 py-2 text-sm font-medium text-v4-text transition hover:bg-v4-card-hover">
        <ChevronRight size={16} className="chev text-v4-red" /> Dados completos (Lemit)
      </summary>
      <div className="mt-2 grid gap-3 pl-2 text-sm sm:grid-cols-2">
        {data.phones.length > 0 && (
          <LemitBlock label="Telefones">
            {data.phones.map((t, i) => (
              <li key={i} className="text-v4-text">
                {t.numero}
                {i === 0 && (
                  <span className="ml-1 rounded bg-v4-red-muted px-1 text-[10px] font-medium text-v4-red-hover">melhor</span>
                )}
                {t.whatsapp && (
                  <span className="ml-1 rounded bg-[rgba(34,197,94,0.15)] px-1 text-[10px] text-v4-success">WhatsApp</span>
                )}
              </li>
            ))}
          </LemitBlock>
        )}
        {data.emails.length > 0 && (
          <LemitBlock label="E-mails">
            {data.emails.map((e, i) => (
              <li key={i} className="break-all text-v4-text">{e}</li>
            ))}
          </LemitBlock>
        )}
        {data.enderecos.length > 0 && (
          <LemitBlock label="Endereços">
            {data.enderecos.map((e, i) => (
              <li key={i} className="text-v4-text">{e}</li>
            ))}
          </LemitBlock>
        )}
        {(data.dataNascimento || data.renda != null || data.ocupacao || data.situacaoCpf || data.scoreCredito) && (
          <LemitBlock label="Dados pessoais">
            {data.dataNascimento && <li className="text-v4-text">Nascimento: {fmtDate(data.dataNascimento)}</li>}
            {data.renda != null && <li className="text-v4-text">Renda estimada: {fmtRenda(data.renda)}</li>}
            {data.ocupacao && <li className="text-v4-text">Ocupação: {data.ocupacao}</li>}
            {data.situacaoCpf && <li className="text-v4-text">Situação CPF: {data.situacaoCpf}</li>}
            {data.scoreCredito && <li className="text-v4-text">Score de crédito: {data.scoreCredito}</li>}
          </LemitBlock>
        )}
        {data.vinculos.length > 0 && (
          <LemitBlock label="Vínculos (familiares)">
            {data.vinculos.map((v, i) => (
              <li key={i} className="text-v4-text">
                {v.nome} <span className="text-v4-text-disabled">— {v.tipo}</span>
              </li>
            ))}
          </LemitBlock>
        )}
        {data.carros.length > 0 && (
          <LemitBlock label="Veículos">
            {data.carros.map((c, i) => (
              <li key={i} className="text-v4-text">{[c.marca, c.ano, c.placa].filter(Boolean).join(' · ')}</li>
            ))}
          </LemitBlock>
        )}
      </div>
    </details>
  );
}

function WhatsappStatus({
  audit,
}: {
  audit: Pick<SiteAudit, 'whatsappButtons' | 'hasWhatsappWidget'>;
}) {
  const broken = audit.whatsappButtons.filter((b) => !b.working);
  const working = audit.whatsappButtons.filter((b) => b.working);
  if (broken.length > 0) return <span className="text-v4-error">Botão de WhatsApp quebrado ({broken.length})</span>;
  if (working.length > 0)
    return (
      <span className="text-v4-success">
        Botão de WhatsApp OK{working[0].numberFound ? ` — ${working[0].numberFound}` : ''}
      </span>
    );
  if (audit.hasWhatsappWidget) return <span className="text-v4-warning">WhatsApp via widget — conferir manualmente</span>;
  return <span className="text-v4-text-muted">Nenhum sinal de WhatsApp no site</span>;
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-v4-text-muted">{label}</span>
      <span className="text-right text-v4-text">{value ?? '—'}</span>
    </div>
  );
}

function LemitBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-v4-text-disabled">{label}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Pill({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

function MatLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded bg-v4-surface px-2 py-0.5 font-medium text-v4-text-muted hover:bg-v4-card-hover hover:text-v4-text"
    >
      {label}
    </a>
  );
}

// Rede social em destaque (ícone maior + cor da marca) para o card da empresa.
function BrandSocial({
  href,
  icon: Icon,
  label,
  color,
}: {
  href: string | null;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  color: string;
}) {
  if (!href) {
    return (
      <span className="flex items-center gap-2 rounded-lg border border-v4-border bg-v4-surface px-4 py-2 text-sm text-v4-text-disabled">
        <Icon size={22} /> {label}: —
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-lg border border-v4-border-strong bg-v4-surface px-4 py-2 text-sm font-medium text-v4-text transition hover:bg-v4-card-hover"
    >
      <Icon size={22} color={color} /> {label}
    </a>
  );
}

function SocialLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 rounded-lg bg-v4-surface px-3 py-1.5 text-xs font-medium text-v4-text hover:bg-v4-card-hover"
    >
      <Icon size={14} /> {label}
    </a>
  );
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? 'bg-[rgba(34,197,94,0.15)] text-v4-success' : 'bg-v4-surface text-v4-text-muted'
      }`}
    >
      {label}
    </span>
  );
}

// Chip de pixel. Com `confirmed` (headless rodou o JS): verde = tem, cinza = não.
// Sem confirmação (só HTML estático): verde = achou; azul "?" = não achou mas tem
// GTM (pode estar via GTM); cinza = não achou e sem GTM.
function PixelChip({ ok, viaGtm, confirmed, label }: { ok: boolean; viaGtm: boolean; confirmed?: boolean; label: string }) {
  if (ok) {
    return (
      <span
        title={confirmed ? 'Confirmado: o pixel disparou ao rodar a página.' : undefined}
        className="rounded-full bg-[rgba(34,197,94,0.15)] px-2 py-0.5 text-xs font-medium text-v4-success"
      >
        {label} ✓
      </span>
    );
  }
  if (!confirmed && viaGtm) {
    return (
      <span
        title="Não encontrado no HTML, mas o site usa Google Tag Manager — pode estar carregado via GTM. Confirmação exige headless."
        className="rounded-full bg-[rgba(59,130,246,0.15)] px-2 py-0.5 text-xs font-medium text-[#60a5fa]"
      >
        {label}?
      </span>
    );
  }
  return (
    <span
      title={confirmed ? 'Confirmado: o pixel NÃO disparou ao rodar a página.' : undefined}
      className="rounded-full bg-v4-surface px-2 py-0.5 text-xs font-medium text-v4-text-muted"
    >
      {label}: não
    </span>
  );
}

function PhoneStatus({ value }: { value: string }) {
  if (!value.trim()) return null;
  const c = checkPhone(value);
  const text = !c.valid
    ? 'Telefone inválido'
    : c.isMobile
      ? 'Celular válido (provável WhatsApp)'
      : 'Fixo válido (não é celular)';
  const color = !c.valid ? 'text-v4-error' : c.isMobile ? 'text-v4-success' : 'text-v4-warning';
  return <p className={`mt-1 text-xs ${color}`}>{text}</p>;
}

function EmailStatus({ value }: { value: string }) {
  if (!value.trim()) return null;
  const c = checkEmail(value);
  const text = !c.valid ? 'E-mail inválido' : c.disposable ? 'E-mail descartável' : 'E-mail válido';
  const color = !c.valid ? 'text-v4-error' : c.disposable ? 'text-v4-warning' : 'text-v4-success';
  return <p className={`mt-1 text-xs ${color}`}>{text}</p>;
}
