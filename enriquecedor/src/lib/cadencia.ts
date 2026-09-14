// ============================================================================
// Cadência outbound (WABA) — lógica compartilhada da configuração que o SDR
// valida no arquiteto (F7): quais falhas virar gancho, qual decisor recebe,
// nome do SDR, marca, frases dentro dos tetos e variante do template. O motor
// (/api/cadencia/preparar) devolve as OPÇÕES (falhas detectadas com frases do
// catálogo + templates ativos) e monta o pacote final com a config; aqui fica a
// prévia local (interpolação) e os padrões. UI em views/LeadDetail (CadenciaSection).
// ============================================================================
import type { CadenciaConfig, DecisionMaker, FalhaCadencia, Lead } from '../types';
import { motorFetch } from './motorClient';

export const FALHA_LABEL: Record<string, string> = {
  https: 'Site sem HTTPS / fora do ar',
  whatsapp: 'WhatsApp ausente ou quebrado',
  destino: 'Anuncia com página lenta',
  semanuncio: 'Nenhum anúncio ativo',
  gmn: 'Google Meu Negócio fraco',
  pixel: 'Sem pixel de rastreamento',
};

// Tetos das variáveis (o template WABA aprovado não muda; só o conteúdo).
export const LIMITES = { nome1: 20, sdr: 20, fantasia: 40, fraseFalha: 140, fraseImpacto: 180, rotulo: 60, corpo: 1024 } as const;

export interface FalhaOpcao {
  codigo: FalhaCadencia;
  evidencia?: { situacao?: string; nota?: number; avaliacoes?: number; semPerfil?: boolean };
  falha: string; // frase da falha (catálogo, já interpolada)
  impacto: string; // frase do impacto
  rotulo: string; // rótulo curto (passo 2)
}
export interface TemplateOpcao {
  nome: string;
  passo: 1 | 2 | 3;
  versao: number;
  corpo: string;
  variaveis: string[];
  botoes: string[];
  statusMeta: string;
  review: string | null;
  temBot: boolean;
}
export interface PacoteMsg {
  template: string;
  templateId?: string;
  statusMeta: string;
  variaveis: string[];
  botoes: string[];
  corpoPreview: string;
}
export interface PacoteCadencia {
  ok: boolean;
  error?: string;
  aptoCadencia?: boolean;
  motivo?: string;
  falhas?: { codigo: FalhaCadencia }[];
  falhaPrimaria?: (FalhaOpcao & { codigo: FalhaCadencia }) | null;
  falhaSecundaria?: (FalhaOpcao & { codigo: FalhaCadencia }) | null;
  whatsapp?: { p1: PacoteMsg | null; p2: PacoteMsg | null; p3: PacoteMsg | null };
  variaveis?: { nome1: string; sdr: string; fantasia: string; fraseFalha: string; fraseImpacto: string; rotuloSecundaria: string | null };
  decisorId?: string | null;
  validado?: boolean;
  opcoes?: { falhas: FalhaOpcao[]; templates: TemplateOpcao[]; limites: typeof LIMITES };
  config?: CadenciaConfig | null;
  avisos?: string[];
}

/** Chama o motor: detecta falhas, devolve opções e o pacote com a config (prévia = não grava no lead). */
export async function prepararCadencia(leadId: string, config: CadenciaConfig | null, opts: { persistir?: boolean } = {}): Promise<PacoteCadencia> {
  const res = await motorFetch('/api/cadencia/preparar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId, config: config ?? undefined, persistir: opts.persistir !== false }),
  });
  const j = (await res.json()) as PacoteCadencia;
  if (!res.ok && j.ok !== false) return { ok: false, error: `motor HTTP ${res.status}` };
  return j;
}

export const montarCorpo = (corpo: string, vars: string[]): string => corpo.replace(/\{\{(\d)\}\}/g, (_, i) => vars[Number(i) - 1] ?? '');

export const primeiroNome = (nome: string | null | undefined): string => {
  const n = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : '';
};

// Corta no fim da última palavra inteira que cabe em max (mesma regra do motor).
export function cortaPalavra(s: string, max: number): string {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  const corte = t.slice(0, max + 1);
  const i = corte.lastIndexOf(' ');
  return (i > 0 ? corte.slice(0, i) : t.slice(0, max)).trim();
}

// Destinatários da cadência = decisores ESCOLHIDOS no F2 (selecionado). Sem
// escolha, o primário; sem primário, o primeiro. Mesma regra do motor
// (destinatariosDe) — cada um vira um card no Kommo e recebe as mensagens.
export function destinatarios(people: DecisionMaker[]): DecisionMaker[] {
  const sel = people.filter((p) => p.selecionado);
  if (sel.length) return sel;
  const prim = people.find((p) => p.isPrimary);
  return prim ? [prim] : people.slice(0, 1);
}
export const semEscolhaNoF2 = (people: DecisionMaker[]) => people.length > 0 && !people.some((p) => p.selecionado);
export const nome1De = (cfg: CadenciaConfig, d: DecisionMaker): string => cortaPalavra((cfg.nomes1?.[d.id] ?? '').trim() || primeiroNome(d.nome), LIMITES.nome1);

/** Config efetiva pra edição: o que está salvo + padrões derivados das opções (nada é inventado). */
export function configEfetiva(lead: Lead, _people: DecisionMaker[], pac: PacoteCadencia | null): CadenciaConfig {
  const salvo = lead.cadenciaConfig ?? {};
  const falhas = pac?.opcoes?.falhas ?? [];
  const primaria = falhas.find((f) => f.codigo === salvo.falhaPrimaria)?.codigo ?? pac?.falhaPrimaria?.codigo ?? falhas[0]?.codigo ?? null;
  const temSec = Object.prototype.hasOwnProperty.call(salvo, 'falhaSecundaria');
  const secundaria = temSec ? (falhas.find((f) => f.codigo === salvo.falhaSecundaria && f.codigo !== primaria)?.codigo ?? null) : (falhas.find((f) => f.codigo !== primaria)?.codigo ?? null);
  const tpls = pac?.opcoes?.templates ?? [];
  const tplPadrao = (passo: 1 | 2 | 3) => pac?.whatsapp?.[`p${passo}`]?.template ?? tpls.find((t) => t.passo === passo)?.nome ?? null;
  return {
    falhaPrimaria: primaria,
    falhaSecundaria: secundaria,
    nomes1: { ...(salvo.nomes1 ?? {}) },
    sdrNome: salvo.sdrNome ?? null,
    fantasia: salvo.fantasia ?? null,
    fraseFalha: salvo.falhaPrimaria === primaria ? salvo.fraseFalha ?? null : null,
    fraseImpacto: salvo.falhaPrimaria === primaria ? salvo.fraseImpacto ?? null : null,
    rotuloSecundaria: salvo.falhaSecundaria === secundaria ? salvo.rotuloSecundaria ?? null : null,
    templates: { p1: salvo.templates?.p1 ?? tplPadrao(1), p2: salvo.templates?.p2 ?? tplPadrao(2), p3: salvo.templates?.p3 ?? tplPadrao(3) },
    validadoEm: salvo.validadoEm ?? null,
    validadoPor: salvo.validadoPor ?? null,
  };
}

// Variáveis resolvidas localmente (prévia instantânea — mesma regra do motor).
export function variaveisDe(lead: Lead, people: DecisionMaker[], cfg: CadenciaConfig, opcoes: PacoteCadencia['opcoes'] | undefined, decisorId?: string | null) {
  const f1 = opcoes?.falhas.find((f) => f.codigo === cfg.falhaPrimaria) ?? null;
  const f2 = cfg.falhaSecundaria ? opcoes?.falhas.find((f) => f.codigo === cfg.falhaSecundaria) ?? null : null;
  const dests = destinatarios(people);
  const decisor = (decisorId ? dests.find((p) => p.id === decisorId) : null) ?? dests[0] ?? null;
  const nome1 = decisor ? nome1De(cfg, decisor) || 'tudo bem?' : 'tudo bem?';
  const sdr = cortaPalavra((cfg.sdrNome ?? '').trim() || '[SDR]', LIMITES.sdr);
  const fantasia = cortaPalavra((cfg.fantasia ?? '').trim() || lead.nomeFantasia || lead.razaoSocial || lead.companyNameRaw || '', LIMITES.fantasia);
  const fraseFalha = cortaPalavra((cfg.fraseFalha ?? '').trim() || f1?.falha || '', LIMITES.fraseFalha);
  const fraseImpacto = cortaPalavra((cfg.fraseImpacto ?? '').trim() || f1?.impacto || '', LIMITES.fraseImpacto);
  const rotuloSecundaria = f2 ? cortaPalavra((cfg.rotuloSecundaria ?? '').trim() || f2.rotulo, LIMITES.rotulo) : null;
  return { nome1, sdr, fantasia, fraseFalha, fraseImpacto, rotuloSecundaria, decisor, f1, f2 };
}

/** Prévia local das 3 mensagens a partir dos templates das opções (sem ida ao motor). */
export function previaLocal(lead: Lead, people: DecisionMaker[], cfg: CadenciaConfig, opcoes: PacoteCadencia['opcoes'] | undefined, decisorId?: string | null) {
  const v = variaveisDe(lead, people, cfg, opcoes, decisorId);
  const tpls = opcoes?.templates ?? [];
  const t = (passo: 1 | 2 | 3) => {
    const nome = cfg.templates?.[`p${passo}`];
    return tpls.find((x) => x.nome === nome && x.passo === passo) ?? tpls.find((x) => x.passo === passo) ?? null;
  };
  const t1 = t(1);
  let t2 = t(2);
  // Passo 2 "segunda falha" só faz sentido com segunda falha; sem ela cai no "aprofunda".
  if (t2?.nome === 'sdna_p2_segunda_falha_v1' && !v.f2) t2 = tpls.find((x) => x.nome === 'sdna_p2_aprofunda_v1') ?? t2;
  const t3 = t(3);
  const vars2 = t2?.nome === 'sdna_p2_segunda_falha_v1' ? [v.nome1, v.fantasia, v.rotuloSecundaria ?? ''] : [v.nome1, v.fantasia];
  const mk = (tp: TemplateOpcao | null, vars: string[]): PacoteMsg | null =>
    tp ? { template: tp.nome, statusMeta: tp.statusMeta, variaveis: vars, botoes: tp.botoes, corpoPreview: montarCorpo(tp.corpo, vars) } : null;
  return { variaveis: v, p1: mk(t1, [v.nome1, v.sdr, v.fantasia, v.fraseFalha, v.fraseImpacto]), p2: mk(t2, vars2), p3: mk(t3, [v.nome1, v.fantasia]) };
}

/** Pendências que impedem validar (o SDR precisa resolver antes de mandar pro "Pronto p/ importar"). */
export function pendenciasValidacao(lead: Lead, people: DecisionMaker[], cfg: CadenciaConfig, pac: PacoteCadencia | null): string[] {
  const out: string[] = [];
  if (lead.optout) out.push('lead pediu pra não receber (opt-out)');
  if (!pac?.opcoes?.falhas.length) out.push('nenhuma falha verificável medida — rode F3/F4 antes');
  if (!cfg.falhaPrimaria) out.push('escolha o gancho principal (falha da mensagem 1)');
  const v = variaveisDe(lead, people, cfg, pac?.opcoes);
  const dests = destinatarios(people);
  if (!dests.length) out.push('nenhum decisor pra receber — marque quem vai pro Kommo no F2 (Decisores)');
  for (const d of dests) if (!nome1De(cfg, d)) out.push(`primeiro nome vazio pra ${d.nome} — ajuste o {{1}}`);
  if (v.sdr === '[SDR]') out.push('informe o nome do SDR ({{2}})');
  if (!v.fantasia) out.push('informe a marca ({{3}})');
  if ((cfg.fraseFalha ?? '').length > LIMITES.fraseFalha) out.push(`frase da falha passa de ${LIMITES.fraseFalha} caracteres`);
  if ((cfg.fraseImpacto ?? '').length > LIMITES.fraseImpacto) out.push(`frase do impacto passa de ${LIMITES.fraseImpacto} caracteres`);
  const pv = previaLocal(lead, people, cfg, pac?.opcoes);
  for (const [k, m] of [['1', pv.p1], ['2', pv.p2], ['3', pv.p3]] as const) {
    if (!m) out.push(`sem template ativo pro passo ${k}`);
    else if (m.corpoPreview.length > LIMITES.corpo) out.push(`mensagem ${k} passa de ${LIMITES.corpo} caracteres`);
  }
  return out;
}

export function limparConfig(cfg: CadenciaConfig): CadenciaConfig {
  // Remove strings vazias (vazio = "usar padrão"); mantém falhaSecundaria null explícito.
  const t = (s: string | null | undefined) => ((s ?? '').trim() ? (s as string).trim() : null);
  return {
    falhaPrimaria: cfg.falhaPrimaria ?? null,
    falhaSecundaria: cfg.falhaSecundaria ?? null,
    nomes1: Object.fromEntries(Object.entries(cfg.nomes1 ?? {}).filter(([, v]) => (v ?? '').trim()).map(([k, v]) => [k, v.trim()])),
    sdrNome: t(cfg.sdrNome),
    fantasia: t(cfg.fantasia),
    fraseFalha: t(cfg.fraseFalha),
    fraseImpacto: t(cfg.fraseImpacto),
    rotuloSecundaria: t(cfg.rotuloSecundaria),
    templates: { p1: cfg.templates?.p1 ?? null, p2: cfg.templates?.p2 ?? null, p3: cfg.templates?.p3 ?? null },
    validadoEm: cfg.validadoEm ?? null,
    validadoPor: cfg.validadoPor ?? null,
  };
}
