// ============================================================================
// Seleção de decisores/contatos (F2 — Qualificação).
// O operador escolhe QUAIS decisores e QUAIS telefones/e-mails de cada um
// seguem para as próximas fases (e, na Fase 4, para o payload do Kommo).
// Lógica compartilhada — a UI (LeadDetail) só chama estes helpers.
// ============================================================================
import type { DecisionMaker } from '../types';

// Marca/desmarca TODOS os decisores e TODOS os contatos de cada um.
export function selecionarTudo(people: DecisionMaker[], on: boolean): DecisionMaker[] {
  return people.map((p) => ({
    ...p,
    selecionado: on,
    phones: p.phones?.map((ph) => ({ ...ph, selecionado: on })),
    emails: p.emails?.map((em) => ({ ...em, selecionado: on })),
  }));
}

// Marca/desmarca UM decisor. Ao marcar, os contatos dele vêm todos marcados
// (o operador então desmarca o que não quiser); ao desmarcar, limpa os contatos.
export function toggleDecisor(people: DecisionMaker[], id: string): DecisionMaker[] {
  return people.map((p) => {
    if (p.id !== id) return p;
    const on = !p.selecionado;
    return {
      ...p,
      selecionado: on,
      phones: p.phones?.map((ph) => ({ ...ph, selecionado: on })),
      emails: p.emails?.map((em) => ({ ...em, selecionado: on })),
    };
  });
}

// Marca/desmarca um telefone (por índice) de um decisor. Selecionar um contato
// implica trabalhar o decisor (marca o decisor junto).
export function togglePhone(people: DecisionMaker[], id: string, idx: number): DecisionMaker[] {
  return people.map((p) => {
    if (p.id !== id || !p.phones?.[idx]) return p;
    const phones = p.phones.map((ph, i) => (i === idx ? { ...ph, selecionado: !ph.selecionado } : ph));
    const ligouAlgo = phones[idx].selecionado;
    return { ...p, phones, selecionado: ligouAlgo ? true : p.selecionado };
  });
}

// Marca/desmarca um e-mail (por índice) de um decisor — mesma regra do telefone.
export function toggleEmail(people: DecisionMaker[], id: string, idx: number): DecisionMaker[] {
  return people.map((p) => {
    if (p.id !== id || !p.emails?.[idx]) return p;
    const emails = p.emails.map((em, i) => (i === idx ? { ...em, selecionado: !em.selecionado } : em));
    const ligouAlgo = emails[idx].selecionado;
    return { ...p, emails, selecionado: ligouAlgo ? true : p.selecionado };
  });
}

// Resumo da seleção (pro chip da UI e pra quem consome depois).
export function resumoSelecao(people: DecisionMaker[]): { decisores: number; phones: number; emails: number } {
  let decisores = 0;
  let phones = 0;
  let emails = 0;
  for (const p of people) {
    if (p.selecionado) decisores++;
    phones += p.phones?.filter((ph) => ph.selecionado).length ?? 0;
    emails += p.emails?.filter((em) => em.selecionado).length ?? 0;
  }
  return { decisores, phones, emails };
}

// O que segue pro funil/Kommo: só decisores selecionados, cada um só com os
// contatos selecionados. Se NINGUÉM foi selecionado, devolve tudo (sem filtro
// explícito, vale o comportamento padrão — as sugestões mais validadas).
export function contatosParaTrabalhar(people: DecisionMaker[]): DecisionMaker[] {
  const algumaSelecao = people.some((p) => p.selecionado);
  if (!algumaSelecao) return people;
  return people
    .filter((p) => p.selecionado)
    .map((p) => ({
      ...p,
      phones: p.phones?.filter((ph) => ph.selecionado),
      emails: p.emails?.filter((em) => em.selecionado),
    }));
}
