import { describe, expect, it } from 'vitest';
import { deduplicar, toWf } from './dedupeLeads';
import type { Lead } from '../types';

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

  it('não entra telefone válido igual ao de um lead do projeto; telefone inválido não bloqueia', () => {
    const existentes = [{ cnpj: '99888777000166', phone: '+55 (11) 99999-1234' }];
    const r = deduplicar(
      [
        lead({ cnpj: '11222333000181', phoneRaw: '11999991234' }),
        lead({ cnpj: '22333444000172', phoneRaw: '123' }),
      ],
      existentes,
    );
    expect(r.aceitos.map((l) => l.cnpj)).toEqual(['22333444000172']);
    expect(r.telefoneRepetido).toBe(1);
  });

  it('dois leads do lote com o mesmo telefone: fica o primeiro', () => {
    const r = deduplicar([lead({ cnpj: '11222333000181', phoneRaw: '11999991234' }), lead({ cnpj: '22333444000172', phoneRaw: '(11) 99999-1234' })], []);
    expect(r.aceitos).toHaveLength(1);
    expect(r.telefoneRepetido).toBe(1);
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
