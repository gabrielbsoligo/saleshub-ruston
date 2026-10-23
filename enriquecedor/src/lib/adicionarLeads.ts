// Entrada de leads num projeto — pela lista inicial, por uma lista NOVA num
// projeto já aberto ou por cadastro manual. Um único caminho: linhas → Triagem
// (validação na Receita = F1) → dedupe contra o projeto → grava → projeção WfLead.
import type { Projeto, WfLead } from './projectsStore';
import type { RawLeadRow } from './parseSpreadsheet';
import { buildLeadsFromRows, type ImportProgress } from './importPipeline';
import { leadsRepo } from './leadsRepo';
import { chaveCnpj, chaveFone, deduplicar, toWf } from './dedupeLeads';

export interface ResultadoEntrada {
  /** Leads que entram no projeto, já gravados, na etapa 0 (F1). */
  novos: WfLead[];
  invalidos: number; // CNPJ com dígito errado — nunca entram
  repetidosNoLote: number; // CNPJ repetido na própria lista
  jaNoProjeto: number; // CNPJ que o projeto já tinha
  telefoneNoProjeto: number; // telefone de um lead que já está no projeto (só na adição)
  telefoneNoLote: number; // telefone repetido na própria lista (só na adição)
  /** Já existiam no banco (enriquecidos por outro projeto): mantêm id, dados e PERFIL. */
  jaExistiam: number;
  perfilDivergente: number; // desses, quantos têm perfil diferente do deste projeto
}

/**
 * modo 'inicial' = importação da primeira lista (regra antiga: dedupe só por CNPJ);
 * modo 'adicao'  = lista nova ou manual num projeto aberto (CNPJ + telefone).
 */
export async function entrarLeads(
  projeto: Projeto,
  rows: RawLeadRow[],
  leadsAtuais: WfLead[],
  modo: 'inicial' | 'adicao',
  onProgress?: (p: ImportProgress) => void,
): Promise<ResultadoEntrada> {
  const built = await buildLeadsFromRows(rows, onProgress);
  const validos = built.filter((l) => l.dataQuality !== 'invalido');
  for (const l of validos) l.perfil = projeto.perfil; // perfil de auditoria do projeto (só vale pra lead NOVO)
  // O que o projeto já tem, com CNPJ e telefone reais (a projeção WfLead só tem o CNPJ formatado).
  const atuais = leadsAtuais.length ? await leadsRepo.getMany(leadsAtuais.map((l) => l.id)) : [];
  // Lead que já existe no banco (outro projeto) entra com o telefone PRESERVADO de lá
  // quando a linha não traz um — a dedupe precisa olhar o telefone que vai ficar
  // vinculado, não só o recebido (cadastro manual só com CNPJ).
  let paraDedupe = validos;
  if (modo === 'adicao') {
    const existentes = await leadsRepo.findByCnpjs(validos.map((l) => l.cnpj).filter((c): c is string => !!c));
    const porCnpj = new Map(existentes.map((e) => [chaveCnpj(e.cnpj), e]));
    paraDedupe = validos.map((l) => {
      const ex = porCnpj.get(chaveCnpj(l.cnpj));
      return ex && l.phoneRaw == null && ex.phoneRaw != null ? { ...l, phoneRaw: ex.phoneRaw } : l;
    });
  }
  const ded = deduplicar(paraDedupe, atuais.map((l) => ({ cnpj: l.cnpj ?? l.cnpjRaw, phone: l.phoneRaw })), { porTelefone: modo === 'adicao' });
  const idsAceitos = new Set(ded.aceitos.map((l) => l.id));
  const aceitos = validos.filter((l) => idsAceitos.has(l.id)); // os originais (sem o telefone emprestado)
  // Devolve os leads como ficaram no banco. CNPJ já existente (enriquecido por outro
  // projeto) mantém id, enriquecimento e perfil; campos da planilha só atualizam o
  // que veio preenchido — nunca apagam o que já havia (ver leadsRepo.upsertMany).
  const gravados = aceitos.length ? await leadsRepo.upsertMany(aceitos) : [];
  const idsNoProjeto = new Set(leadsAtuais.map((l) => l.id));
  const novosLeads = gravados.filter((g) => !idsNoProjeto.has(g.id));
  const existentes = novosLeads.filter((g) => !idsAceitos.has(g.id)); // id veio do banco, não do lote
  return {
    novos: novosLeads.map(toWf),
    invalidos: built.length - validos.length,
    repetidosNoLote: ded.repetidosNoLote,
    jaNoProjeto: ded.jaNoProjeto + (gravados.length - novosLeads.length),
    telefoneNoProjeto: ded.telefoneNoProjeto,
    telefoneNoLote: ded.telefoneNoLote,
    jaExistiam: existentes.length,
    perfilDivergente: existentes.filter((g) => g.perfil && g.perfil !== projeto.perfil).length,
  };
}

/**
 * Na hora de gravar o vínculo, o projeto pode ter ganhado leads de OUTRA aba enquanto
 * a Triagem rodava. Revalida os novos contra esses (CNPJ e telefone) e tira os que
 * colidem — eles já estão gravados em enriquecedor_leads, só não entram neste projeto.
 */
export async function revalidarNovos(novos: WfLead[], idsRemotosNovos: string[]): Promise<{ novos: WfLead[]; removidos: number }> {
  if (!novos.length || !idsRemotosNovos.length) return { novos, removidos: 0 };
  const [remotos, meus] = await Promise.all([leadsRepo.getMany(idsRemotosNovos), leadsRepo.getMany(novos.map((n) => n.id))]);
  const cnpjs = new Set(remotos.map((r) => chaveCnpj(r.cnpj ?? r.cnpjRaw)).filter(Boolean));
  const fones = new Set(remotos.map((r) => chaveFone(r.phoneRaw)).filter(Boolean));
  const porId = new Map(meus.map((m) => [m.id, m]));
  const ok = novos.filter((n) => {
    const m = porId.get(n.id);
    if (!m) return true;
    return !cnpjs.has(chaveCnpj(m.cnpj ?? m.cnpjRaw)) && !(chaveFone(m.phoneRaw) && fones.has(chaveFone(m.phoneRaw)));
  });
  return { novos: ok, removidos: novos.length - ok.length };
}

/** Frase do resultado pra toast (as três primeiras são as mensagens originais da importação). */
export function resumoEntrada(r: ResultadoEntrada): string {
  const partes = [`${r.novos.length} leads na Triagem (F1)`];
  if (r.invalidos) partes.push(`${r.invalidos} inválidos descartados`);
  if (r.repetidosNoLote) partes.push(`${r.repetidosNoLote} CNPJ(s) repetido(s) na planilha (ficou o primeiro)`);
  if (r.jaNoProjeto) partes.push(`${r.jaNoProjeto} já estava(m) no projeto`);
  if (r.telefoneNoProjeto) partes.push(`${r.telefoneNoProjeto} com telefone de lead que já está no projeto`);
  if (r.telefoneNoLote) partes.push(`${r.telefoneNoLote} com telefone repetido na lista (ficou o primeiro)`);
  if (r.jaExistiam) partes.push(`${r.jaExistiam} já enriquecido(s) em outro projeto (mantidos como estavam${r.perfilDivergente ? `; ${r.perfilDivergente} com outro perfil de auditoria` : ''})`);
  return partes.join(' · ');
}
