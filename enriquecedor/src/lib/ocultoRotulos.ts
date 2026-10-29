// Cliente oculto — textos de estado (puros, testados). O status 'pendente' depende do MOTIVO:
// número desconectado, envios desligados (oculto_config.ativo) ou só esperando o próximo ciclo.
import type { OcultoConfig, OcultoSessao } from './ocultoRepo';

export type EstadoEnvios = 'sem_numero' | 'desligado' | 'pronto';

export function estadoEnvios(cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null): EstadoEnvios {
  if (!cfg?.conectado) return 'sem_numero';
  return cfg.ativo ? 'pronto' : 'desligado';
}

const FIXOS: Record<Exclude<OcultoSessao['status'], 'pendente'>, string> = {
  enviada: 'abertura enviada', conversando: 'conversando', aguardando_followup: 'esperando follow-up',
  avaliando: 'avaliando (IA)', concluida: 'concluída', erro: 'erro', cancelada: 'cancelada',
};

/** a empresa escreveu depois da última fala da persona: há resposta da persona a enviar */
export function respostaPendente(s: Pick<OcultoSessao, 'status' | 'ultima_in_em' | 'ultima_out_em'>): boolean {
  if (s.status !== 'enviada' && s.status !== 'conversando') return false;
  if (!s.ultima_in_em) return false;
  return !s.ultima_out_em || new Date(s.ultima_in_em).getTime() > new Date(s.ultima_out_em).getTime();
}

/** o que sai quando os envios forem ligados: aberturas na fila + respostas da persona represadas */
export function oQueSaiAoLigar(sessoes: Pick<OcultoSessao, 'status' | 'ultima_in_em' | 'ultima_out_em'>[]): { aberturas: number; respostas: number } {
  return { aberturas: sessoes.filter(s => s.status === 'pendente').length, respostas: sessoes.filter(respostaPendente).length };
}

export function rotuloStatus(status: OcultoSessao['status'], cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null, comRespostaPendente = false): string {
  if (status !== 'pendente') return comRespostaPendente && estadoEnvios(cfg) !== 'pronto' ? `${FIXOS[status]} (resposta presa: ${estadoEnvios(cfg) === 'desligado' ? 'envios desligados' : 'sem número'})` : FIXOS[status];
  return { sem_numero: 'na fila (sem número)', desligado: 'na fila (envios desligados)', pronto: 'na fila (sai no próximo ciclo)' }[estadoEnvios(cfg)];
}

/** texto da conversa vazia de uma sessão pendente */
export function avisoAberturaPendente(cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null): string {
  return {
    sem_numero: 'Abertura ainda não enviada (sem número conectado).',
    desligado: 'Abertura ainda não enviada (envios desligados — um gestor liga no interruptor acima).',
    pronto: 'Abertura sai no próximo ciclo (até 10 min).',
  }[estadoEnvios(cfg)];
}

/** linha de explicação da faixa do número */
export function explicacaoFaixa(cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null): string {
  return {
    sem_numero: 'Sem número conectado: as sondagens ficam na fila e saem quando o número estiver pronto.',
    desligado: 'Envios DESLIGADOS: nada é enviado (nem abertura, nem resposta). As sondagens ficam na fila até um gestor ligar.',
    pronto: 'Envios LIGADOS: sondagens novas saem na hora; as da fila saem em até 10 min.',
  }[estadoEnvios(cfg)];
}

/** número exibido: só quando a Evolution informou */
export const numeroExibido = (cfg: Pick<OcultoConfig, 'numero'> | null): string | null => (cfg?.numero ? `+${cfg.numero}` : null);
