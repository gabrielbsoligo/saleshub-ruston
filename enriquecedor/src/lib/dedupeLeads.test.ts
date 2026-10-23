import { describe, expect, it } from 'vitest';
import { deduplicar, mesclarLeads, toWf } from './dedupeLeads';
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

describe('mesclarLeads', () => {
  const w = (id: string, etapa = 0): WfLead => ({ id, score: 0, empresa: id, cnpj: '', uf: '', etapa });
  it('não perde lead acrescentado por outra aba e mantém a etapa desta aba', () => {
    const locais = [w('L0', 3)];
    const remotos = [w('L0', 1), w('LB')];
    const novos = [w('LA')];
    const r = mesclarLeads(locais, remotos, novos);
    expect(r.map((l) => l.id)).toEqual(['L0', 'LB', 'LA']);
    expect(r[0].etapa).toBe(3);
  });
  it('novo que já existe (mesmo id) não duplica', () => {
    expect(mesclarLeads([w('A')], [], [w('A')])).toHaveLength(1);
  });
});
