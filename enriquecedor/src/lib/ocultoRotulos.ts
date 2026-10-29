// Cliente oculto — textos de estado (puros, testados). O status 'pendente' depende do MOTIVO:
// número desconectado, envios desligados (oculto_config.ativo) ou agendada (ritmo humano: atraso e janela de horário).
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
  return { sem_numero: 'na fila (sem número)', desligado: 'na fila (envios desligados)', pronto: 'na fila (agendada)' }[estadoEnvios(cfg)];
}

/** texto da conversa vazia de uma sessão pendente */
export function avisoAberturaPendente(cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null): string {
  return {
    sem_numero: 'Abertura ainda não enviada (sem número conectado).',
    desligado: 'Abertura ainda não enviada (envios desligados — um gestor liga no interruptor acima).',
    pronto: 'Abertura agendada para o horário de atendimento (veja "abre às" na lista).',
  }[estadoEnvios(cfg)];
}

/** linha de explicação da faixa do número */
export function explicacaoFaixa(cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null): string {
  return {
    sem_numero: 'Sem número conectado: as sondagens ficam na fila e saem quando o número estiver pronto.',
    desligado: 'Envios DESLIGADOS: nada é enviado (nem abertura, nem resposta). As sondagens ficam na fila até um gestor ligar.',
    pronto: 'Envios LIGADOS: aberturas e respostas saem no horário de atendimento, com o atraso do Ritmo (a fila é varrida a cada minuto).',
  }[estadoEnvios(cfg)];
}

/** número exibido: só quando a Evolution informou */
export const numeroExibido = (cfg: Pick<OcultoConfig, 'numero'> | null): string | null => (cfg?.numero ? `+${cfg.numero}` : null);

/** "responde às 14:37" (resposta represada) ou "abre às 08:05" (abertura na fila): envios prontos e horário agendado no futuro */
export function respondeAs(s: Pick<OcultoSessao, 'status' | 'ultima_in_em' | 'ultima_out_em' | 'proximo_em'>, cfg: Pick<OcultoConfig, 'conectado' | 'ativo'> | null, agoraMs = Date.now()): string | null {
  const verbo = s.status === 'pendente' ? 'abre' : respostaPendente(s) ? 'responde' : null;
  if (!verbo || estadoEnvios(cfg) !== 'pronto' || !s.proximo_em) return null;
  const t = new Date(s.proximo_em);
  if (t.getTime() <= agoraMs) return null;
  const mesmoDia = t.toDateString() === new Date(agoraMs).toDateString();
  const hora = t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  return mesmoDia ? `${verbo} às ${hora}` : `${verbo} ${t.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })} às ${hora}`;
}
/** dias ativos de "0,1,…" (inválido/vazio = todos) */
export function diasDaConfig(v: string | null | undefined): number[] {
  const xs = String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (!xs.length || xs.some(x => !/^[0-6]$/.test(x))) return [0, 1, 2, 3, 4, 5, 6];
  return [...new Set(xs.map(Number))].sort((a, b) => a - b);
}
const SIGLAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
/** "todos os dias" / "seg–sex" / "sáb, dom" */
export function resumoDias(dias: number[]): string {
  const d = [...new Set(dias)].sort((a, b) => a - b);
  if (d.length === 7) return 'todos os dias';
  if (d.join(',') === '1,2,3,4,5') return 'seg–sex';
  return d.map(x => SIGLAS[x]).join(', ') || 'nenhum dia';
}
/** ritmo atual para o formulário do gestor (padrões quando a coluna ainda não existe) */
export const ritmoAtual = (c: OcultoConfig | null) => ({
  resposta_min_s: c?.resposta_min_s ?? 40, resposta_max_s: c?.resposta_max_s ?? 240,
  janela_inicio: c?.janela_inicio ?? '07:00', janela_fim: c?.janela_fim ?? '22:00', janela_dias: diasDaConfig(c?.janela_dias),
});
