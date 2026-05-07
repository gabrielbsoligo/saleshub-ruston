// =============================================================
// useCompromissos — hooks para Compromisso do Dia (Dashboard v2)
// =============================================================
// useCompromissoDia(memberId, data) -> { compromisso, entrega, percentual_total }
// useCompromissosDoDia(data)        -> { compromissos[], entregas{}, isLoading }
// =============================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CompromissoDia, EntregaDia } from '../../types';

const todayStr = () => new Date().toISOString().slice(0, 10);

interface PerCampoProgress {
  meta: number;
  real: number;
  pct: number; // 0-100, capped
}

export interface CompromissoComProgresso {
  compromisso: CompromissoDia | null;
  entrega: EntregaDia | null;
  campos: {
    ligacoes: PerCampoProgress;
    reunioes_marcadas: PerCampoProgress;
    reunioes_realizadas: PerCampoProgress;
    contratos_rua: PerCampoProgress;
    contratos_fechados: PerCampoProgress;
  };
  percentual_total: number; // media simples, capped 100
}

function computeProgresso(c: CompromissoDia | null, e: EntregaDia | null): CompromissoComProgresso {
  const campos = {
    ligacoes: progressOne(c?.meta_ligacoes ?? 0, e?.ligacoes ?? 0),
    reunioes_marcadas: progressOne(c?.meta_reunioes_marcadas ?? 0, e?.reunioes_marcadas ?? 0),
    reunioes_realizadas: progressOne(c?.meta_reunioes_realizadas ?? 0, e?.reunioes_realizadas ?? 0),
    contratos_rua: progressOne(c?.meta_contratos_rua ?? 0, e?.contratos_rua ?? 0),
    contratos_fechados: progressOne(c?.meta_contratos_fechados ?? 0, e?.contratos_fechados ?? 0),
  };
  // media simples dos campos que tinham meta > 0
  const ativos = Object.values(campos).filter(v => v.meta > 0);
  const percentual_total = ativos.length === 0 ? 0 : Math.round(ativos.reduce((s, v) => s + v.pct, 0) / ativos.length);
  return { compromisso: c, entrega: e, campos, percentual_total };
}

function progressOne(meta: number, real: number): PerCampoProgress {
  if (meta <= 0) return { meta: 0, real, pct: real > 0 ? 100 : 0 };
  return { meta, real, pct: Math.min(100, Math.round((real / meta) * 100)) };
}

/** Compromisso + entrega de UM membro em UMA data (default: hoje). */
export function useCompromissoDia(memberId: string | null | undefined, data: string = todayStr()) {
  const [compromisso, setCompromisso] = useState<CompromissoDia | null>(null);
  const [entrega, setEntrega] = useState<EntregaDia | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!memberId) return;
    setIsLoading(true);
    try {
      const [{ data: c }, { data: e }] = await Promise.all([
        supabase.from('compromissos_dia').select('*').eq('member_id', memberId).eq('data', data).maybeSingle(),
        supabase.rpc('get_entrega_dia', { p_member_id: memberId, p_data: data }),
      ]);
      setCompromisso(c as CompromissoDia | null);
      setEntrega(e as EntregaDia | null);
    } finally {
      setIsLoading(false);
    }
  }, [memberId, data]);

  useEffect(() => { load(); }, [load]);

  // Realtime: re-fetch quando atividades do dia mudam (qualquer ligacao/reuniao/deal do member)
  useEffect(() => {
    if (!memberId) return;
    const channel = supabase
      .channel(`compr-${memberId}-${data}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ligacoes_4com', filter: `member_id=eq.${memberId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reunioes' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'compromissos_dia', filter: `member_id=eq.${memberId}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [memberId, data, load]);

  return useMemo(() => ({ ...computeProgresso(compromisso, entrega), isLoading, refetch: load }), [compromisso, entrega, isLoading, load]);
}

/** Compromissos + entregas de TODOS os membros ativos numa data. Usado pelo TeamPanel e TV. */
export function useCompromissosDoDia(data: string = todayStr()) {
  const [compromissos, setCompromissos] = useState<CompromissoDia[]>([]);
  const [entregas, setEntregas] = useState<Record<string, EntregaDia>>({});
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: cs } = await supabase
        .from('compromissos_dia')
        .select('*')
        .eq('data', data);

      setCompromissos((cs || []) as CompromissoDia[]);

      // entregas em paralelo
      const memberIds = (cs || []).map((c: any) => c.member_id);
      if (memberIds.length === 0) {
        setEntregas({});
      } else {
        const results = await Promise.all(
          memberIds.map(id => supabase.rpc('get_entrega_dia', { p_member_id: id, p_data: data }))
        );
        const map: Record<string, EntregaDia> = {};
        memberIds.forEach((id, i) => {
          if (results[i]?.data) map[id] = results[i].data as EntregaDia;
        });
        setEntregas(map);
      }
    } finally {
      setIsLoading(false);
    }
  }, [data]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel(`compromissos-dia-${data}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'compromissos_dia' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ligacoes_4com' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reunioes' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [data, load]);

  const rows = useMemo(() => compromissos.map(c => {
    const prog = computeProgresso(c, entregas[c.member_id] || null);
    return { ...prog, member_id: c.member_id };
  }), [compromissos, entregas]);

  return { rows, isLoading, refetch: load };
}
