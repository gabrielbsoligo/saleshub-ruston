// Entrada de leads num projeto — pela lista inicial, por uma lista NOVA num
// projeto já aberto ou por cadastro manual. Um único caminho: linhas → Triagem
// (validação na Receita = F1) → dedupe contra o projeto → grava → projeção WfLead.
import type { Projeto, WfLead } from './projectsStore';
import type { RawLeadRow } from './parseSpreadsheet';
import { buildLeadsFromRows, type ImportProgress } from './importPipeline';
import { leadsRepo } from './leadsRepo';
import { deduplicar, toWf } from './dedupeLeads';

export interface ResultadoEntrada {
  /** Leads que entram no projeto, já gravados, na etapa 0 (F1). */
  novos: WfLead[];
  invalidos: number; // CNPJ com dígito errado — nunca entram
  repetidosNoLote: number;
  jaNoProjeto: number;
  telefoneRepetido: number;
}

export async function entrarLeads(
  projeto: Projeto,
  rows: RawLeadRow[],
  leadsAtuais: WfLead[],
  onProgress?: (p: ImportProgress) => void,
): Promise<ResultadoEntrada> {
  const built = await buildLeadsFromRows(rows, onProgress);
  const validos = built.filter((l) => l.dataQuality !== 'invalido');
  for (const l of validos) l.perfil = projeto.perfil; // perfil de auditoria do projeto
  // O que o projeto já tem, com CNPJ e telefone reais (a projeção WfLead só tem o CNPJ formatado).
  const atuais = leadsAtuais.length ? await leadsRepo.getMany(leadsAtuais.map((l) => l.id)) : [];
  const ded = deduplicar(validos, atuais.map((l) => ({ cnpj: l.cnpj ?? l.cnpjRaw, phone: l.phoneRaw })));
  // Devolve os leads como ficaram no banco: CNPJ já existente EM OUTRO PROJETO mantém
  // o id e o enriquecimento (site, redes, chaves validadas, briefing) — só a planilha atualiza.
  const gravados = ded.aceitos.length ? await leadsRepo.upsertMany(ded.aceitos) : [];
  const idsNoProjeto = new Set(leadsAtuais.map((l) => l.id));
  const novos = gravados.filter((g) => !idsNoProjeto.has(g.id)).map(toWf);
  return {
    novos,
    invalidos: built.length - validos.length,
    repetidosNoLote: ded.repetidosNoLote,
    jaNoProjeto: ded.jaNoProjeto + (gravados.length - novos.length),
    telefoneRepetido: ded.telefoneRepetido,
  };
}

/** Frase curta do resultado pra toast. */
export function resumoEntrada(r: ResultadoEntrada): string {
  const partes = [`${r.novos.length} lead(s) na Triagem (F1)`];
  if (r.invalidos) partes.push(`${r.invalidos} CNPJ(s) inválido(s) descartado(s)`);
  if (r.repetidosNoLote) partes.push(`${r.repetidosNoLote} repetido(s) na lista (ficou o primeiro)`);
  if (r.jaNoProjeto) partes.push(`${r.jaNoProjeto} já estava(m) no projeto`);
  if (r.telefoneRepetido) partes.push(`${r.telefoneRepetido} com telefone de lead que já está no projeto`);
  return partes.join(' · ');
}
