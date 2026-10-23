import { describe, expect, it } from 'vitest';
import { deduplicar, mesclarProjeto, toWf } from './dedupeLeads';
import type { Lead } from '../types';
import type { WfLead } from './projectsStore';

const lead = (over: Partial<Lead>): Lead =>
  ({
    id: Math.random().toString(36).slice(2),
    cnpjRaw: '',
    companyNameRaw: 'Empresa',
    revenueBandRaw: null,
    phoneRaw: null,
    emailRaw: null,
    siteUrl: null,
    cnpj: null,
    razaoSocial: null,
    nomeFantasia: null,
    cnae: null,
    segmento: null,
    cidade: null,
    uf: null,
    situacaoCadastral: null,
    socios: [],
    companyInstagram: null,
    companyFacebook: null,
    empreendimentos: [],
    googleBusiness: null,
    lemitCompany: null,
    organograma: null,
    datastone: null,
    briefing: null,
    dataQuality: 'valido',
    validationNotes: [],
    status: 'importado',
    score: null,
    kommoLeadId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }) as Lead;

describe('deduplicar', () => {
  it('fica a primeira ocorrência de CNPJ repetido no lote', () => {
    const r = deduplicar([lead({ cnpj: '11222333000181' }), lead({ cnpjRaw: '11.222.333/0001-81' })], []);
    expect(r.aceitos).toHaveLength(1);
    expect(r.repetidosNoLote).toBe(1);
  });

  it('não entra CNPJ que o projeto já tem (independente de formatação)', () => {
    const r = deduplicar([lead({ cnpj: '11222333000181' })], [{ cnpj: '11.222.333/0001-81', phone: null }]);
    expect(r.aceitos).toHaveLength(0);
    expect(r.jaNoProjeto).toBe(1);
  });

  it('importação inicial (sem porTelefone): telefone igual NÃO bloqueia — regra antiga só por CNPJ', () => {
    const r = deduplicar(
      [lead({ cnpj: '11222333000181', phoneRaw: '11999991234' }), lead({ cnpj: '22333444000172', phoneRaw: '(11) 99999-1234' })],
      [{ cnpj: '99888777000166', phone: '11999991234' }],
    );
    expect(r.aceitos).toHaveLength(2);
    expect(r.telefoneNoProjeto).toBe(0);
    expect(r.telefoneNoLote).toBe(0);
  });

  it('adição (porTelefone): telefone válido igual ao de um lead do projeto não entra; inválido não bloqueia', () => {
    const existentes = [{ cnpj: '99888777000166', phone: '+55 (11) 99999-1234' }];
    const r = deduplicar(
      [lead({ cnpj: '11222333000181', phoneRaw: '11999991234' }), lead({ cnpj: '22333444000172', phoneRaw: '123' })],
      existentes,
      { porTelefone: true },
    );
    expect(r.aceitos.map((l) => l.cnpj)).toEqual(['22333444000172']);
    expect(r.telefoneNoProjeto).toBe(1);
  });

  it('adição (porTelefone): dois leads do lote com o mesmo telefone — fica o primeiro, contado à parte', () => {
    const r = deduplicar(
      [lead({ cnpj: '11222333000181', phoneRaw: '11999991234' }), lead({ cnpj: '22333444000172', phoneRaw: '(11) 99999-1234' })],
      [],
      { porTelefone: true },
    );
    expect(r.aceitos).toHaveLength(1);
    expect(r.telefoneNoLote).toBe(1);
    expect(r.telefoneNoProjeto).toBe(0);
  });

  it('telefone fixo também deduplica (é um telefone válido)', () => {
    const r = deduplicar([lead({ cnpj: '11222333000181', phoneRaw: '1133334444' })], [{ cnpj: 'x', phone: '(11) 3333-4444' }], { porTelefone: true });
    expect(r.aceitos).toHaveLength(0);
  });

  it('lead sem CNPJ nenhum não entra', () => {
    const r = deduplicar([lead({})], []);
    expect(r.aceitos).toHaveLength(0);
  });
});

describe('toWf', () => {
  it('projeta o lead na Triagem (etapa 0) com CNPJ formatado', () => {
    const w = toWf(lead({ id: 'x', cnpj: '11222333000181', razaoSocial: 'ACME LTDA', uf: 'SP', score: 7 }));
    expect(w).toEqual({ id: 'x', score: 7, empresa: 'ACME LTDA', cnpj: '11.222.333/0001-81', uf: 'SP', segmento: null, etapa: 0 });
  });
});

describe('mesclarProjeto (3 vias: esta aba x banco x base)', () => {
  const w = (id: string, etapa = 0, extra: Partial<WfLead> = {}): WfLead => ({ id, score: 0, empresa: id, cnpj: '', uf: '', etapa, ...extra });
  const est = (leads: WfLead[], leadStatus: Record<string, 'ok' | 'run' | 'erro' | 'fila'> = {}) => ({ leads, leadStatus });

  it('lead acrescentado por outra aba não se perde; etapa avançada por ESTA aba é mantida', () => {
    const base = est([w('L0', 1)]);
    const local = est([w('L0', 3)]);
    const remoto = est([w('L0', 1), w('LB')]);
    const r = mesclarProjeto(local, remoto, base, [w('LA')]);
    expect(r.leads.map((l) => l.id)).toEqual(['L0', 'LB', 'LA']);
    expect(r.leads[0].etapa).toBe(3);
  });

  it('avanço/descarte feito por OUTRA aba não é revertido por estado local antigo', () => {
    const base = est([w('L0', 1), w('L1', 1)]);
    const local = est([w('L0', 1), w('L1', 1)]); // esta aba não mexeu
    const remoto = est([w('L0', 3), w('L1', 1, { descartado: true, motivoDescarte: 'sem_fit' })]);
    const r = mesclarProjeto(local, remoto, base, []);
    expect(r.leads.find((l) => l.id === 'L0')?.etapa).toBe(3);
    expect(r.leads.find((l) => l.id === 'L1')?.descartado).toBe(true);
  });

  it('os dois mudaram: vale o mais adiantado (descartado > maior etapa > banco)', () => {
    const base = est([w('A', 1), w('B', 1), w('C', 1)]);
    const local = est([w('A', 2), w('B', 1, { descartado: true }), w('C', 2, { parcial: true })]);
    const remoto = est([w('A', 3), w('B', 2), w('C', 2)]);
    const r = mesclarProjeto(local, remoto, base, []);
    expect(r.leads.find((l) => l.id === 'A')?.etapa).toBe(3);
    expect(r.leads.find((l) => l.id === 'B')?.descartado).toBe(true);
    expect(r.leads.find((l) => l.id === 'C')?.parcial).toBeUndefined(); // empate: banco
  });

  it('leadStatus: job concluído no banco não é sobrescrito por run/fila antigo desta aba', () => {
    const base = est([], { '1:L0': 'run' });
    const local = est([], { '1:L0': 'run' });
    const remoto = est([], { '1:L0': 'ok', '2:LB': 'fila' });
    const r = mesclarProjeto(local, remoto, base, []);
    expect(r.leadStatus).toEqual({ '1:L0': 'ok', '2:LB': 'fila' });
  });

  it('leadStatus: mudança só local é preservada; os dois mudaram → terminado vence andamento', () => {
    const base = est([], { '1:A': 'fila', '1:B': 'fila' });
    const local = est([], { '1:A': 'ok', '1:B': 'run' });
    const remoto = est([], { '1:A': 'fila', '1:B': 'erro' });
    const r = mesclarProjeto(local, remoto, base, []);
    expect(r.leadStatus).toEqual({ '1:A': 'ok', '1:B': 'erro' });
  });

  it('autosave ainda pendente (base confirmada = etapa 1, local = etapa 2, banco = etapa 1): a edição local fica', () => {
    const base = est([w('L0', 1)], { '1:L0': 'run' });
    const local = est([w('L0', 2)], { '1:L0': 'ok' });
    const remoto = est([w('L0', 1)], { '1:L0': 'run' });
    const r = mesclarProjeto(local, remoto, base, []);
    expect(r.leads[0].etapa).toBe(2);
    expect(r.leadStatus['1:L0']).toBe('ok');
  });

  it('re-mesclagem após gravar: evento ok recebido durante o UPDATE não regride para o run do snapshot enviado', () => {
    const snapshot = est([w('L0', 1)], { '1:L0': 'run' }); // o que foi mandado gravar
    const salvo = est([w('L0', 1), w('LA')], { '1:L0': 'run' }); // o que o banco confirmou
    const atual = est([w('L0', 1)], { '1:L0': 'ok' }); // a UI já recebeu o job concluído
    const r = mesclarProjeto(atual, salvo, snapshot, []);
    expect(r.leadStatus['1:L0']).toBe('ok');
    expect(r.leads.map((l) => l.id)).toEqual(['L0', 'LA']);
  });

  it('autosave confirmou etapa 2 (base = 2); outra aba voltou pra 1 e gravou; adicionar preserva o 1', () => {
    const base = est([w('L0', 2)]);
    const local = est([w('L0', 2)]);
    const remoto = est([w('L0', 1)]);
    expect(mesclarProjeto(local, remoto, base, []).leads[0].etapa).toBe(1);
  });

  it('descarte confirmado por esta aba e restauração feita por outra aba: fica restaurado', () => {
    const base = est([w('L0', 1, { descartado: true, motivoDescarte: 'sem_fit' })]);
    const local = est([w('L0', 1, { descartado: true, motivoDescarte: 'sem_fit' })]);
    const remoto = est([w('L0', 1)]);
    expect(mesclarProjeto(local, remoto, base, []).leads[0].descartado).toBeUndefined();
  });

  it('novo que já existe (mesmo id) não duplica', () => {
    expect(mesclarProjeto(est([w('A')]), est([]), est([]), [w('A')]).leads).toHaveLength(1);
  });
});
