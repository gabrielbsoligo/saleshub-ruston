// =============================================================
// useResumoDia — agrega dados de UMA data específica pra Dashboard
// =============================================================
// Usado pelo ResumoDoDia (componente de rituais de daily).
//
// Retorna:
//   - reuniões agendadas naquele dia (created_at = data)
//   - reuniões pra realizar naquele dia (data_reuniao = data, !realizada)
//   - reuniões realizadas no dia (data_reuniao = data, realizada=true)
//   - status changes do dia (deal_status_log) — pra rua, fechado, perdido
//   - ligações por membro
//   - compromissos do time + entregas
// =============================================================
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Reuniao } from '../types';

export interface StatusChange {
  deal_id: string;
  empresa: string;
  status_anterior: string | null;
  status_novo: string;
  mudou_em: string;
  mudou_por: string | null;
  member_name: string | null;
  valor_recorrente: number | null;
  valor_escopo: number | null;
}

export interface LigacoesPorMembro {
  member_id: string;
  total: number;
  atendidas: number;
}

export interface ResumoDia {
  reunioesAgendadas: Reuniao[];
  reunioesParaRealizar: Reuniao[];
  reunioesRealizadas: Reuniao[];
  statusChanges: StatusChange[];
  ligacoesPorMembro: LigacoesPorMembro[];
  totalLigacoes: number;
  isLoading: boolean;
  refetch: () => void;
}

const RELATIONS = '*, sdr:team_members!sdr_id(*), closer:team_members!closer_id(*)';

export function useResumoDia(data: string): ResumoDia {
  const [reunioesAgendadas, setReunioesAgendadas] = useState<Reuniao[]>([]);
  const [reunioesParaRealizar, setReunioesParaRealizar] = useState<Reuniao[]>([]);
  const [reunioesRealizadas, setReunioesRealizadas] = useState<Reuniao[]>([]);
  const [statusChanges, setStatusChanges] = useState<StatusChange[]>([]);
  const [ligacoesPorMembro, setLigacoesPorMembro] = useState<LigacoesPorMembro[]>([]);
  const [totalLigacoes, setTotalLigacoes] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!data) return;
    setIsLoading(true);
    try {
      // Range do dia em local TZ
      const start = new Date(`${data}T00:00:00`);
      const end = new Date(start.getTime() + 24 * 3600 * 1000);
      const startISO = start.toISOString();
      const endISO = end.toISOString();

      const [
        rAgendadas,
        rParaRealizar,
        rRealizadas,
        sc,
        ligacoes,
      ] = await Promise.all([
        // Reuniões CRIADAS no dia (independente de quando vão acontecer)
        supabase.from('reunioes').select(RELATIONS)
          .gte('created_at', startISO).lt('created_at', endISO)
          .order('created_at', { ascending: false }),

        // Pra realizar: data_reuniao = data E ainda não realizada
        supabase.from('reunioes').select(RELATIONS)
          .gte('data_reuniao', startISO).lt('data_reuniao', endISO)
          .eq('realizada', false)
          .order('data_reuniao'),

        // Realizadas: data_reuniao = data E realizada=true
        supabase.from('reunioes').select(RELATIONS)
          .gte('data_reuniao', startISO).lt('data_reuniao', endISO)
          .eq('realizada', true)
          .order('data_reuniao', { ascending: false }),

        // Status changes do dia via RPC
        supabase.rpc('get_status_changes_no_dia', { p_data: data }),

        // Ligações do dia
        supabase.from('ligacoes_4com').select('member_id, atendida')
          .gte('started_at', startISO).lt('started_at', endISO),
      ]);

      setReunioesAgendadas((rAgendadas.data as Reuniao[]) || []);
      setReunioesParaRealizar((rParaRealizar.data as Reuniao[]) || []);
      setReunioesRealizadas((rRealizadas.data as Reuniao[]) || []);
      setStatusChanges((sc.data as StatusChange[]) || []);

      // Agrega ligações por membro
      const ligs = (ligacoes.data || []) as Array<{ member_id: string | null; atendida: boolean | null }>;
      setTotalLigacoes(ligs.length);
      const mapByMember = new Map<string, { total: number; atendidas: number }>();
      for (const l of ligs) {
        if (!l.member_id) continue;
        const cur = mapByMember.get(l.member_id) || { total: 0, atendidas: 0 };
        cur.total++;
        if (l.atendida) cur.atendidas++;
        mapByMember.set(l.member_id, cur);
      }
      setLigacoesPorMembro(
        Array.from(mapByMember.entries())
          .map(([member_id, v]) => ({ member_id, ...v }))
          .sort((a, b) => b.total - a.total)
      );
    } finally {
      setIsLoading(false);
    }
  }, [data]);

  useEffect(() => { load(); }, [load]);

  // Realtime: atualiza quando dado muda
  useEffect(() => {
    const ch = supabase
      .channel(`resumo-dia-${data}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reunioes' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deal_status_log' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ligacoes_4com' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [data, load]);

  return {
    reunioesAgendadas, reunioesParaRealizar, reunioesRealizadas,
    statusChanges, ligacoesPorMembro, totalLigacoes,
    isLoading, refetch: load,
  };
}
