import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
import { estadoModelo, type ModeloCadencia, type VinculoCadencia } from './cadenciaPainel';

const m = (p: Partial<ModeloCadencia> = {}): ModeloCadencia => ({
  id: 't1', nome: 'sdna_p2_aprofunda_v1', passo: 2, versao: 1, ativo: true, padrao: false, cidades: null,
  chaves_vars: ['nome1', 'fantasia'], corpo: '', botoes: [], review_status: 'aprovado',
  kommo_template_id: '66791', kommo_bot_id: 81797, kommo_bots_por_responsavel: {}, ...p,
});
const v = (p: Partial<VinculoCadencia> = {}): VinculoCadencia => ({
  template_id: 't1', source_id: 70787, kommo_template_id: '66791', kommo_bot_id: 81797,
  review_status: 'aprovado', verificado_em: null, bot_verificado_em: null, erro: null, ...p,
});

describe('estadoModelo', () => {
  it('vínculo aprovado com bot = verde (inativo = cinza)', () => {
    expect(estadoModelo(m(), 70787, [v()]).sinal).toBe('verde');
    expect(estadoModelo(m({ ativo: false }), 70787, [v()]).sinal).toBe('cinza');
  });
  it('vínculo bloqueado = vermelho com o motivo', () => {
    expect(estadoModelo(m(), 70787, [v({ review_status: 'ausente' })])).toMatchObject({ sinal: 'vermelho', texto: 'Meta: ausente neste número' });
    expect(estadoModelo(m(), 70787, [v({ kommo_bot_id: null })]).texto).toBe('sem bot neste número');
    expect(estadoModelo(m(), 70787, [v({ erro: 'bot 1 está desativado no Kommo' })]).texto).toBe('bot 1 está desativado no Kommo');
  });
  it('sem vínculo no canal ativo: legado = amarelo; sem bot legado = vermelho', () => {
    expect(estadoModelo(m(), 70787, [v({ source_id: 1 })]).sinal).toBe('amarelo');
    expect(estadoModelo(m({ kommo_bot_id: null }), 70787, []).sinal).toBe('vermelho');
    expect(estadoModelo(m(), null, [v({ review_status: 'ausente' })]).sinal).toBe('amarelo');
  });
  it('sem chaves_vars nunca serve', () => {
    expect(estadoModelo(m({ chaves_vars: null }), 70787, [v()]).sinal).toBe('vermelho');
  });
});
