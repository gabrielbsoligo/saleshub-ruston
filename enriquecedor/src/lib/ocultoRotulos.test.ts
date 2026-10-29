import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({ supabase: {} }));
import { avisoAberturaPendente, estadoEnvios, explicacaoFaixa, numeroExibido, rotuloStatus } from './ocultoRotulos';

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
  it('número só aparece quando a Evolution informou', () => {
    expect(numeroExibido({ numero: null })).toBeNull();
    expect(numeroExibido({ numero: '5512981234567' })).toBe('+5512981234567');
  });
});
