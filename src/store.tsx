import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from './lib/supabase';
import type { TeamMember, Lead, Deal, Reuniao, Meta, ComissaoConfig, PerformanceSdr, PerformanceCloser, CustoComercial, DealStatus } from './types';
import toast from 'react-hot-toast';

interface AppState {
  currentUser: TeamMember | null;
  isLoadingAuth: boolean;
  members: TeamMember[];
  leads: Lead[];
  deals: Deal[];
  reunioes: Reuniao[];
  metas: Meta[];
  comissoes: ComissaoConfig[];
  performanceSdr: PerformanceSdr[];
  performanceCloser: PerformanceCloser[];
  custos: CustoComercial[];

  login: (email: string, password?: string) => Promise<void>;
  logout: () => Promise<void>;

  fetchMembers: () => Promise<void>;
  addMember: (m: Partial<TeamMember>) => Promise<void>;
  updateMember: (id: string, updates: Partial<TeamMember>) => Promise<void>;

  fetchLeads: () => Promise<void>;
  addLead: (l: Partial<Lead>) => Promise<Lead | null>;
  updateLead: (id: string, updates: Partial<Lead>) => Promise<void>;
  deleteLead: (id: string) => Promise<void>;

  fetchDeals: () => Promise<void>;
  addDeal: (d: Partial<Deal>) => Promise<Deal | null>;
  updateDeal: (id: string, updates: Partial<Deal>) => Promise<void>;
  moveDeal: (id: string, newStatus: DealStatus) => Promise<void>;
  deleteDeal: (id: string) => Promise<void>;

  fetchReunioes: () => Promise<void>;
  addReuniao: (r: Partial<Reuniao>, replaceExisting?: boolean) => Promise<void>;
  updateReuniao: (id: string, updates: Partial<Reuniao>) => Promise<void>;

  fetchMetas: () => Promise<void>;
  saveMeta: (m: Partial<Meta>) => Promise<void>;

  fetchPerformanceSdr: () => Promise<void>;
  savePerformanceSdr: (p: Partial<PerformanceSdr>) => Promise<void>;
  fetchPerformanceCloser: () => Promise<void>;
  savePerformanceCloser: (p: Partial<PerformanceCloser>) => Promise<void>;

  fetchComissoes: () => Promise<void>;

  fetchCustos: () => Promise<void>;
  saveCusto: (c: Partial<CustoComercial>) => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function useAppStore() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppStore must be used within AppProvider');
  return ctx;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<TeamMember | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [reunioes, setReunioes] = useState<Reuniao[]>([]);
  const [metas, setMetas] = useState<Meta[]>([]);
  const [comissoes, setComissoes] = useState<ComissaoConfig[]>([]);
  const [performanceSdr, setPerformanceSdr] = useState<PerformanceSdr[]>([]);
  const [performanceCloser, setPerformanceCloser] = useState<PerformanceCloser[]>([]);
  const [custos, setCustos] = useState<CustoComercial[]>([]);

  // ===================== AUTH =====================
  const checkSession = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const { data: member } = await supabase
          .from('team_members')
          .select('*')
          .eq('auth_user_id', session.user.id)
          .single();

        if (member) {
          setCurrentUser(member);
        } else {
          const { data: memberByEmail } = await supabase
            .from('team_members')
            .select('*')
            .eq('email', session.user.email)
            .single();

          if (memberByEmail) {
            await supabase
              .from('team_members')
              .update({ auth_user_id: session.user.id })
              .eq('id', memberByEmail.id);
            setCurrentUser({ ...memberByEmail, auth_user_id: session.user.id });
          }
        }
      }
    } catch (err) {
      console.error('Session check error:', err);
    } finally {
      setIsLoadingAuth(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setCurrentUser(null);
      } else {
        checkSession();
      }
    });
    return () => subscription.unsubscribe();
  }, [checkSession]);

  const login = async (email: string, password?: string) => {
    if (password) {
      // Try sign in first
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        // If user doesn't exist, sign up
        if (signInError.message.includes('Invalid login')) {
          const { error: signUpError } = await supabase.auth.signUp({ email, password });
          if (signUpError) throw signUpError;
          // Auto sign in after sign up
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
        } else {
          throw signInError;
        }
      }
    } else {
      const { error } = await supabase.auth.signInWithOtp({ email });
      if (error) throw error;
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setCurrentUser(null);
  };

  // ===================== MEMBERS =====================
  const fetchMembers = useCallback(async () => {
    const { data } = await supabase.from('team_members').select('*').order('name');
    if (data) setMembers(data);
  }, []);

  const addMember = async (m: Partial<TeamMember>) => {
    const { data, error } = await supabase.from('team_members').insert(m).select().single();
    if (error) { toast.error(error.message); return; }
    if (data) setMembers(prev => [...prev, data]);
    toast.success('Membro adicionado!');
  };

  const updateMember = async (id: string, updates: Partial<TeamMember>) => {
    const { error } = await supabase.from('team_members').update(updates).eq('id', id);
    if (error) { toast.error(error.message); return; }
    setMembers(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
    toast.success('Membro atualizado!');
  };

  // ===================== LEADS =====================
  const fetchLeads = useCallback(async () => {
    const { data } = await supabase
      .from('leads')
      .select('*, sdr:team_members!sdr_id(*)')
      .order('created_at', { ascending: false });
    if (data) setLeads(data);
  }, []);

  const addLead = async (l: Partial<Lead>) => {
    const { data, error } = await supabase.from('leads').insert(l).select('*, sdr:team_members!sdr_id(*)').single();
    if (error) { toast.error(error.message); return null; }
    if (data) setLeads(prev => [data, ...prev]);
    toast.success('Lead cadastrado!');
    return data;
  };

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    const { error } = await supabase.from('leads').update(updates).eq('id', id);
    if (error) { toast.error(error.message); return; }
    setLeads(prev => prev.map(l => l.id === id ? { ...l, ...updates } : l));
    toast.success('Lead atualizado!');
  };

  const deleteLead = async (id: string) => {
    const { error } = await supabase.from('leads').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    setLeads(prev => prev.filter(l => l.id !== id));
  };

  // ===================== DEALS =====================
  const fetchDeals = useCallback(async () => {
    const { data } = await supabase
      .from('deals')
      .select('*, closer:team_members!closer_id(*), sdr:team_members!sdr_id(*)')
      .order('created_at', { ascending: false });
    if (data) setDeals(data);
  }, []);

  const addDeal = async (d: Partial<Deal>) => {
    const { data, error } = await supabase
      .from('deals')
      .insert(d)
      .select('*, closer:team_members!closer_id(*), sdr:team_members!sdr_id(*)')
      .single();
    if (error) { toast.error(error.message); return null; }
    if (data) setDeals(prev => [data, ...prev]);
    toast.success('Negociação criada!');
    return data;
  };

  const updateDeal = async (id: string, updates: Partial<Deal>) => {
    const { error } = await supabase.from('deals').update(updates).eq('id', id);
    if (error) { toast.error(error.message); return; }
    setDeals(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));
    toast.success('Negociação atualizada!');
  };

  const moveDeal = async (id: string, newStatus: DealStatus) => {
    const { error } = await supabase.from('deals').update({ status: newStatus }).eq('id', id);
    if (error) { toast.error(error.message); return; }
    setDeals(prev => prev.map(d => d.id === id ? { ...d, status: newStatus } : d));
  };

  const deleteDeal = async (id: string) => {
    const { error } = await supabase.from('deals').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    setDeals(prev => prev.filter(d => d.id !== id));
  };

  // ===================== REUNIOES =====================
  const fetchReunioes = useCallback(async () => {
    const { data } = await supabase
      .from('reunioes')
      .select('*, sdr:team_members!sdr_id(*), closer:team_members!closer_id(*)')
      .order('data_reuniao', { ascending: false });
    if (data) setReunioes(data);
  }, []);

  const addReuniao = async (r: Partial<Reuniao>, replaceExisting?: boolean) => {
    // Regra: 1 reunião ativa por lead
    if (r.lead_id) {
      const existingActive = reunioes.find(
        re => re.lead_id === r.lead_id && !re.realizada
      );
      if (existingActive && !replaceExisting) {
        // Retorna a reuniao existente pra o componente decidir
        throw new Error('REUNIAO_ATIVA_EXISTENTE');
      }
      if (existingActive && replaceExisting) {
        // Marca a anterior como realizada (cancelada) antes de criar nova
        await supabase.from('reunioes').update({ realizada: true, show: false, notas: 'Substituída por nova reunião' }).eq('id', existingActive.id);
        setReunioes(prev => prev.map(re => re.id === existingActive.id ? { ...re, realizada: true, show: false, notas: 'Substituída por nova reunião' } : re));
      }
    }

    const { data, error } = await supabase.from('reunioes').insert(r).select('*, sdr:team_members!sdr_id(*), closer:team_members!closer_id(*)').single();
    if (error) { toast.error(error.message); return; }
    if (data) setReunioes(prev => [data, ...prev]);

    // AUTOMACAO: agendar reuniao → lead muda pra reuniao_marcada
    if (r.lead_id) {
      await supabase.from('leads').update({ status: 'reuniao_marcada' }).eq('id', r.lead_id);
      setLeads(prev => prev.map(l => l.id === r.lead_id ? { ...l, status: 'reuniao_marcada' } : l));
    }
    toast.success('Reunião agendada! Lead atualizado automaticamente.');
  };

  // Lock para impedir dupla execução
  const reuniaoProcessingRef = React.useRef<Set<string>>(new Set());

  const updateReuniao = async (id: string, updates: Partial<Reuniao>) => {
    // Guard: impedir processamento duplicado
    if (reuniaoProcessingRef.current.has(id)) {
      console.warn('updateReuniao: já processando', id);
      return;
    }
    reuniaoProcessingRef.current.add(id);

    try {
      const { error } = await supabase.from('reunioes').update(updates).eq('id', id);
      if (error) { toast.error(error.message); return; }

      const reuniao = reunioes.find(r => r.id === id);
      setReunioes(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r));

      // AUTOMACAO: reuniao realizada (show=true) → cria deal automaticamente
      if (updates.realizada && updates.show && reuniao) {
        if (reuniao.lead_id) {
          await supabase.from('leads').update({ status: 'reuniao_realizada' }).eq('id', reuniao.lead_id);
          setLeads(prev => prev.map(l => l.id === reuniao.lead_id ? { ...l, status: 'reuniao_realizada' as any } : l));
        }

        const lead = leads.find(l => l.id === reuniao.lead_id);
        const closerForDeal = updates.closer_confirmado_id || reuniao.closer_id;
        const dealPayload = {
          empresa: reuniao.empresa || lead?.empresa || 'Sem nome',
          lead_id: reuniao.lead_id || undefined,
          sdr_id: reuniao.sdr_id || lead?.sdr_id || undefined,
          closer_id: closerForDeal || undefined,
          kommo_id: reuniao.kommo_id || lead?.kommo_id || undefined,
          kommo_link: lead?.kommo_link || undefined,
          origem: lead?.canal || undefined,
          produto: lead?.produto || undefined,
          data_call: new Date().toISOString().split('T')[0],
          status: 'dar_feedback' as const,
        };

        const { data: newDeal } = await supabase
          .from('deals')
          .insert(dealPayload)
          .select('*, closer:team_members!closer_id(*), sdr:team_members!sdr_id(*)')
          .single();

        if (newDeal) {
          setDeals(prev => [newDeal, ...prev]);
          toast.success('Reunião realizada! Negociação criada → Closer precisa dar feedback.');
          return;
        }
      }

      // AUTOMACAO: no-show → update lead
      if (updates.realizada && updates.show === false && reuniao?.lead_id) {
        // Só atualiza lead se a nota não indicar substituição (reunião cancelada por reagendamento)
        if (!updates.notas?.includes('Substituída')) {
          await supabase.from('leads').update({ status: 'noshow' }).eq('id', reuniao.lead_id);
          setLeads(prev => prev.map(l => l.id === reuniao.lead_id ? { ...l, status: 'noshow' as any } : l));
          toast.success('No-show registrado. Lead atualizado.');
        }
        return;
      }
    } finally {
      reuniaoProcessingRef.current.delete(id);
    }
  };

  // ===================== METAS =====================
  const fetchMetas = useCallback(async () => {
    const { data } = await supabase.from('metas').select('*, member:team_members!member_id(*)').order('mes', { ascending: false });
    if (data) setMetas(data);
  }, []);

  const saveMeta = async (m: Partial<Meta>) => {
    const { data, error } = await supabase
      .from('metas')
      .upsert(m, { onConflict: 'member_id,mes' })
      .select()
      .single();
    if (error) { toast.error(error.message); return; }
    if (data) {
      setMetas(prev => {
        const exists = prev.find(x => x.id === data.id);
        return exists ? prev.map(x => x.id === data.id ? data : x) : [...prev, data];
      });
    }
    toast.success('Meta salva!');
  };

  // ===================== PERFORMANCE =====================
  const fetchPerformanceSdr = useCallback(async () => {
    const { data } = await supabase.from('performance_sdr').select('*, member:team_members!member_id(*)').order('data', { ascending: false });
    if (data) setPerformanceSdr(data);
  }, []);

  const savePerformanceSdr = async (p: Partial<PerformanceSdr>) => {
    const { data, error } = await supabase
      .from('performance_sdr')
      .upsert(p, { onConflict: 'member_id,data' })
      .select()
      .single();
    if (error) { toast.error(error.message); return; }
    if (data) {
      setPerformanceSdr(prev => {
        const exists = prev.find(x => x.id === data.id);
        return exists ? prev.map(x => x.id === data.id ? data : x) : [...prev, data];
      });
    }
    toast.success('Performance salva!');
  };

  const fetchPerformanceCloser = useCallback(async () => {
    const { data } = await supabase.from('performance_closer').select('*, member:team_members!member_id(*)').order('mes', { ascending: false });
    if (data) setPerformanceCloser(data);
  }, []);

  const savePerformanceCloser = async (p: Partial<PerformanceCloser>) => {
    const { data, error } = await supabase
      .from('performance_closer')
      .upsert(p, { onConflict: 'member_id,mes,canal' })
      .select()
      .single();
    if (error) { toast.error(error.message); return; }
    if (data) {
      setPerformanceCloser(prev => {
        const exists = prev.find(x => x.id === data.id);
        return exists ? prev.map(x => x.id === data.id ? data : x) : [...prev, data];
      });
    }
    toast.success('Performance salva!');
  };

  // ===================== COMISSOES =====================
  const fetchComissoes = useCallback(async () => {
    const { data } = await supabase.from('comissoes_config').select('*').eq('active', true);
    if (data) setComissoes(data);
  }, []);

  // ===================== CUSTOS =====================
  const fetchCustos = useCallback(async () => {
    const { data } = await supabase.from('custos_comercial').select('*').order('mes', { ascending: false });
    if (data) setCustos(data);
  }, []);

  const saveCusto = async (c: Partial<CustoComercial>) => {
    const { data, error } = c.id
      ? await supabase.from('custos_comercial').update(c).eq('id', c.id).select().single()
      : await supabase.from('custos_comercial').insert(c).select().single();
    if (error) { toast.error(error.message); return; }
    if (data) {
      setCustos(prev => {
        const exists = prev.find(x => x.id === data.id);
        return exists ? prev.map(x => x.id === data.id ? data : x) : [...prev, data];
      });
    }
    toast.success('Custo salvo!');
  };

  // ===================== LOAD DATA ON LOGIN =====================
  useEffect(() => {
    if (currentUser) {
      fetchMembers();
      fetchDeals();
      fetchLeads();
      fetchReunioes();
      fetchMetas();
      fetchComissoes();
      fetchPerformanceSdr();
      fetchPerformanceCloser();
      fetchCustos();
    }
  }, [currentUser, fetchMembers, fetchDeals, fetchLeads, fetchReunioes, fetchMetas, fetchComissoes, fetchPerformanceSdr, fetchPerformanceCloser, fetchCustos]);

  return (
    <AppContext.Provider value={{
      currentUser, isLoadingAuth, members, leads, deals, reunioes, metas, comissoes, performanceSdr, performanceCloser, custos,
      login, logout,
      fetchMembers, addMember, updateMember,
      fetchLeads, addLead, updateLead, deleteLead,
      fetchDeals, addDeal, updateDeal, moveDeal, deleteDeal,
      fetchReunioes, addReuniao, updateReuniao,
      fetchMetas, saveMeta,
      fetchPerformanceSdr, savePerformanceSdr,
      fetchPerformanceCloser, savePerformanceCloser,
      fetchComissoes,
      fetchCustos, saveCusto,
    }}>
      {children}
    </AppContext.Provider>
  );
}
