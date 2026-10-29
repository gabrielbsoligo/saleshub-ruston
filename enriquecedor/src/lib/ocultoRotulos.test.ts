import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
import { avisoAberturaPendente, estadoEnvios, explicacaoFaixa, numeroExibido, oQueSaiAoLigar, respostaPendente, rotuloStatus } from './ocultoRotulos';

describe('cliente oculto — rótulos de estado', () => {
  it('pendente diz o motivo real', () => {
    expect(rotuloStatus('pendente', { conectado: false, ativo: false })).toBe('na fila (sem número)');
    expect(rotuloStatus('pendente', { conectado: true, ativo: false })).toBe('na fila (envios desligados)');
    expect(rotuloStatus('pendente', { conectado: true, ativo: true })).toBe('na fila (sai no próximo ciclo)');
    expect(rotuloStatus('pendente', null)).toBe('na fila (sem número)');
  });
  it('outros status não dependem da config', () => {
    expect(rotuloStatus('conversando', { conectado: false, ativo: false })).toBe('conversando');
    expect(rotuloStatus('cancelada', { conectado: true, ativo: true })).toBe('cancelada');
  });
  it('estado dos envios: sem número tem precedência sobre o interruptor', () => {
    expect(estadoEnvios({ conectado: false, ativo: true })).toBe('sem_numero');
    expect(estadoEnvios({ conectado: true, ativo: false })).toBe('desligado');
    expect(estadoEnvios({ conectado: true, ativo: true })).toBe('pronto');
  });
  it('faixa e aviso explicam o desligado e quem liga', () => {
    expect(explicacaoFaixa({ conectado: true, ativo: false })).toMatch(/DESLIGADOS/);
    expect(avisoAberturaPendente({ conectado: true, ativo: false })).toMatch(/gestor liga/);
    expect(avisoAberturaPendente({ conectado: true, ativo: true })).toMatch(/próximo ciclo/);
  });
  it('resposta presa: empresa escreveu depois da persona, com envios desligados', () => {
    const presa = { status: 'conversando' as const, ultima_in_em: '2026-10-29T17:21:47Z', ultima_out_em: '2026-10-29T17:21:30Z' };
    const emDia = { status: 'conversando' as const, ultima_in_em: '2026-10-29T17:21:24Z', ultima_out_em: '2026-10-29T17:21:30Z' };
    expect(respostaPendente(presa)).toBe(true);
    expect(respostaPendente(emDia)).toBe(false);
    expect(respostaPendente({ status: 'aguardando_followup', ultima_in_em: presa.ultima_in_em, ultima_out_em: presa.ultima_out_em })).toBe(false);
    expect(rotuloStatus('conversando', { conectado: true, ativo: false }, true)).toBe('conversando (resposta presa: envios desligados)');
    expect(rotuloStatus('conversando', { conectado: true, ativo: true }, true)).toBe('conversando');
  });
  it('ao ligar: conta aberturas na fila e respostas represadas', () => {
    expect(oQueSaiAoLigar([
      { status: 'pendente', ultima_in_em: null, ultima_out_em: null },
      { status: 'conversando', ultima_in_em: '2026-10-29T17:21:47Z', ultima_out_em: '2026-10-29T17:21:30Z' },
      { status: 'enviada', ultima_in_em: null, ultima_out_em: '2026-10-29T17:20:05Z' },
    ])).toEqual({ aberturas: 1, respostas: 1 });
  });
  it('número só aparece quando a Evolution informou', () => {
    expect(numeroExibido({ numero: null })).toBeNull();
    expect(numeroExibido({ numero: '5512981234567' })).toBe('+5512981234567');
  });
});
