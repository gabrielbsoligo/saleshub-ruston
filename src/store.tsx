import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from './lib/supabase';
import type { TeamMember, Lead, Deal, Reuniao, Meta, ComissaoConfig, PerformanceSdr, PerformanceCloser, CustoComercial, DealStatus, Ligacao4com, PostMeetingAutomation, AutomationStatus } from './types';
// Kommo integration is handled server-side via Postgres trigger (pg_net)
import { createCalendarEvent, deleteCalendarEvent } from './lib/googleCalendar';
import { runPostMeetingAutomation } from './lib/postMeetingOrchestrator';
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
  ligacoes: Ligacao4com[];

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
  fetchLigacoes: () => Promise<void>;

  // Post-Meeting Automations
  automations: PostMeetingAutomation[];
  createAutomation: (reuniaoId: string, dealId?: string) => Promise<PostMeetingAutomation | null>;
  updateAutomation: (id: string, updates: Partial<PostMeetingAutomation>) => Promise<void>;
  getAutomationByReuniao: (reuniaoId: string) => Promise<PostMeetingAutomation | null>;
  startPostMeetingAutomation: (reuniaoId: string) => Promise<void>;
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
  const [ligacoes, setLigacoes] = useState<Ligacao4com[]>([]);
  const [automations, setAutomations] = useState<PostMeetingAutomation[]>([]);

  // ===================== AUTH =====================
  const checkSession = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        // 1) Tenta achar por auth_user_id (já vinculado)
        const { data: member } = await supabase
          .from('team_members')
          .select('*')
          .eq('auth_user_id', session.user.id)
          .single();

        if (member) {
          setCurrentUser(member);
        } else {
          // 2) Busca por email (primeiro login — trigger do banco já deveria ter vinculado)
          const { data: memberByEmail } = await supabase
            .from('team_members')
            .select('*')
            .eq('email', session.user.email)
            .single();

          if (memberByEmail) {
            if (!memberByEmail.auth_user_id) {
              // Trigger não rodou ainda — tenta vincular pelo frontend como fallback
              const { error: updateError } = await supabase
                .from('team_members')
                .update({ auth_user_id: session.user.id })
                .eq('id', memberByEmail.id);

              if (updateError) {
                console.warn('Auto-link fallback failed (trigger should handle):', updateError.message);
                // Mesmo falhando, seta o user local pra não bloquear a UI
              }
            }
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
  // Paginação manual para contornar limite padrão de 1000 linhas do PostgREST.
  // Sem isso, leads além dos 1000 mais recentes por created_at não apareciam
  // nas views (BlackBox pace mostrava 84 ao invés de 91, etc).
  const fetchLeads = useCallback(async () => {
    const pageSize = 1000;
    let from = 0;
    const acc: any[] = [];
    // Loop até a página vir vazia ou menor que pageSize
    // (limite defensivo de 50 páginas = 50k leads)
    for (let i = 0; i < 50; i++) {
      const { data, error } = await supabase
        .from('leads')
        .select('*, sdr:team_members!sdr_id(*)')
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) break;
      if (!data || data.length === 0) break;
      acc.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    setLeads(acc);
  }, []);

  const addLead = async (l: Partial<Lead>) => {
    // Verificação de duplicata SERVER-SIDE (query no banco, não depende do array em memória)
    // 1. Checa mktlab_link (identificador único mais confiável)
    if (l.mktlab_link) {
      const { data: dupLink } = await supabase
        .from('leads')
        .select('id, empresa')
        .eq('mktlab_link', l.mktlab_link)
        .limit(1)
        .maybeSingle();
      if (dupLink) {
        toast.error(`Lead "${dupLink.empresa}" já importado do MKTLAB!`, { duration: 5000, icon: '⚠️' });
        return null;
      }
    }
    // 2. Checa mktlab_id (caso link mude mas ID seja o mesmo)
    if (l.mktlab_id) {
      const { data: dupId } = await supabase
        .from('leads')
        .select('id, empresa')
        .eq('mktlab_id', l.mktlab_id)
        .limit(1)
        .maybeSingle();
      if (dupId) {
        toast.error(`Lead "${dupId.empresa}" já existe (MKTLAB ID: ${l.mktlab_id})!`, { duration: 5000, icon: '⚠️' });
        return null;
      }
    }
    // 3. Checa empresa por nome (case insensitive) — fallback no banco
    if (l.empresa) {
      const nomeNorm = l.empresa.trim().toLowerCase();
      const { data: dupEmpresa } = await supabase
        .from('leads')
        .select('id, empresa')
        .ilike('empresa', nomeNorm)
        .limit(1)
        .maybeSingle();
      if (dupEmpresa) {
        toast.error(`Lead "${l.empresa}" já existe no sistema!`, { duration: 4000, icon: '⚠️' });
        return null;
      }
    }

    const { data, error } = await supabase.from('leads').insert(l).select('*, sdr:team_members!sdr_id(*)').single();
    if (error) { toast.error(error.message); return null; }
    if (data) {
      setLeads(prev => [data, ...prev]);
      // Poll for Kommo ID (trigger runs server-side, response processed by pg_cron)
      if (data.id) {
        setTimeout(async () => {
          const { data: updated } = await supabase.from('leads').select('kommo_id, kommo_link').eq('id', data.id).single();
          if (updated?.kommo_id) {
            setLeads(prev => prev.map(l => l.id === data.id ? { ...l, ...updated } : l));
            toast.success('Kommo sincronizado!', { icon: '🔗' });
          }
        }, 5000); // Check after 5 seconds
      }
    }
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

    const deal = deals.find(d => d.id === id);
    const wasNotGanho = deal && deal.status !== 'contrato_assinado';
    const isNowGanho = updates.status === 'contrato_assinado';

    setDeals(prev => prev.map(d => d.id === id ? { ...d, ...updates } : d));

    // Auto-generate comissao records when deal becomes ganho
    if (wasNotGanho && isNowGanho) {
      const merged = { ...deal, ...updates };
      const categoria = ['blackbox', 'leadbroker'].includes(merged.origem || '') ? 'inbound' : 'outbound';
      const comissaoRecords: any[] = [];

      const buildRecord = (memberId: string | undefined, memberName: string, role: string, tipo: 'mrr' | 'ot', valor: number, dataPgto: string | null) => {
        if (!valor || valor <= 0) return;
        const rule = comissoes.find(c => c.role === role && c.tipo_origem === categoria && c.tipo_valor === tipo);
        const pct = rule?.percentual || 0;
        const dataLib = dataPgto ? new Date(new Date(dataPgto).getTime() + 30 * 86400000).toISOString().split('T')[0] : null;
        comissaoRecords.push({
          deal_id: id, member_id: memberId || null, member_name: memberName,
          role_comissao: role, tipo, categoria, valor_base: valor,
          percentual: pct, valor_comissao: valor * pct,
          data_pgto: dataPgto, data_liberacao: dataLib,
          empresa: merged.empresa, origem: merged.origem,
        });
      };

      // Closer
      if (merged.closer_id) {
        const closer = members.find(m => m.id === merged.closer_id);
        buildRecord(merged.closer_id, closer?.name || '?', 'closer', 'mrr', merged.valor_recorrente || merged.valor_mrr || 0, merged.data_pgto_recorrente || merged.data_primeiro_pagamento || null);
        buildRecord(merged.closer_id, closer?.name || '?', 'closer', 'ot', merged.valor_escopo || merged.valor_ot || 0, merged.data_pgto_escopo || merged.data_primeiro_pagamento || null);
      }
      // SDR
      if (merged.sdr_id) {
        const sdr = members.find(m => m.id === merged.sdr_id);
        buildRecord(merged.sdr_id, sdr?.name || '?', 'sdr', 'mrr', merged.valor_recorrente || merged.valor_mrr || 0, merged.data_pgto_recorrente || merged.data_primeiro_pagamento || null);
        buildRecord(merged.sdr_id, sdr?.name || '?', 'sdr', 'ot', merged.valor_escopo || merged.valor_ot || 0, merged.data_pgto_escopo || merged.data_primeiro_pagamento || null);
      }

      if (comissaoRecords.length > 0) {
        await supabase.from('comissoes_registros').insert(comissaoRecords);
      }
    }

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
    const tipo = r.tipo || 'primeira_call';

    // Regra: 1 reunião ativa por lead — SÓ para primeira_call
    if (tipo === 'primeira_call' && r.lead_id) {
      const existingActive = reunioes.find(
        re => re.lead_id === r.lead_id && !re.realizada && re.tipo !== 'retorno'
      );
      if (existingActive && !replaceExisting) {
        throw new Error('REUNIAO_ATIVA_EXISTENTE');
      }
      if (existingActive && replaceExisting) {
        const calEventId = (existingActive as any).calendar_event_id;
        if (calEventId) {
          const organizer = existingActive.sdr_id || existingActive.closer_id;
          if (organizer) {
            deleteCalendarEvent(organizer, calEventId).catch(e => console.error('Failed to delete calendar event:', e));
          }
        }
        await supabase.from('reunioes').update({ realizada: true, show: false, notas: 'Substituída por nova reunião' }).eq('id', existingActive.id);
        setReunioes(prev => prev.map(re => re.id === existingActive.id ? { ...re, realizada: true, show: false, notas: 'Substituída por nova reunião' } : re));
      }
    }

    const { data, error } = await supabase.from('reunioes').insert({ ...r, tipo }).select('*, sdr:team_members!sdr_id(*), closer:team_members!closer_id(*)').single();
    if (error) { toast.error(error.message); return; }
    if (data) setReunioes(prev => [data, ...prev]);

    // AUTOMACAO: agendar reuniao → lead muda pra reuniao_marcada (SÓ primeira_call)
    if (tipo === 'primeira_call' && r.lead_id) {
      await supabase.from('leads').update({ status: 'reuniao_marcada' }).eq('id', r.lead_id);
      setLeads(prev => prev.map(l => l.id === r.lead_id ? { ...l, status: 'reuniao_marcada' } : l));
    }

    // Google Calendar - create event
    if (data && data.data_reuniao) {
      const closerId = data.closer_id || r.closer_id;
      const sdrId = data.sdr_id || r.sdr_id;
      const closer = closerId ? members.find(m => m.id === closerId) : null;
      const sdrMember = sdrId ? members.find(m => m.id === sdrId) : null;
      const calendarAvailable = sdrMember?.google_calendar_connected || closer?.google_calendar_connected;

      if (calendarAvailable) {
        const lead = (r.lead_id || data.lead_id) ? leads.find(l => l.id === (r.lead_id || data.lead_id)) : null;
        try {
          const calResult = await createCalendarEvent({
            empresa: data.empresa || lead?.empresa || 'Reunião',
            nome_contato: data.nome_contato || lead?.nome_contato || undefined,
            canal: data.canal || lead?.canal || undefined,
            data_reuniao: data.data_reuniao,
            closer_id: closerId || undefined,
            sdr_id: sdrId || undefined,
            lead_email: (r as any).lead_email || lead?.email || undefined,
            participantes_extras: (r as any).participantes_extras || undefined,
            lead_id: data.lead_id || r.lead_id || undefined,
            reuniao_id: data.id,
          } as any);

          if (calResult) {
            const { error: calUpdateErr } = await supabase.from('reunioes').update({
              calendar_event_id: calResult.event_id,
              meet_link: calResult.meet_link,
            }).eq('id', data.id);

            if (calUpdateErr) {
              console.error('Meet link save failed:', calUpdateErr);
              toast.error('Evento criado mas link do Meet não salvou. Recarregue a página.');
            } else {
              setReunioes(prev => prev.map(re => re.id === data.id ? { ...re, calendar_event_id: calResult.event_id, meet_link: calResult.meet_link } : re));
              toast.success('Google Meet criado!', { icon: '📅' });
            }
          }
        } catch (e: any) {
          console.error('Calendar failed:', e);
          if (e.message === 'GOOGLE_NOT_CONNECTED') {
            toast.error('Google Calendar não conectado. Conecte na tela de Equipe.');
          } else {
            toast.error('Erro ao criar evento no Calendar: ' + (e.message || 'erro desconhecido'));
          }
        }
      }
    }

    toast.success('Reunião agendada!');
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
        // Fonte-da-verdade: reunião confirma quem REALMENTE fez a call.
        // Prioridade: updates atuais → campos confirmados da reunião → agendados (fallback).
        const closerForDeal = updates.closer_confirmado_id || reuniao.closer_confirmado_id || reuniao.closer_id;
        const sdrForDeal = (updates as any).sdr_confirmado_id || reuniao.sdr_confirmado_id || reuniao.sdr_id || lead?.sdr_id;
        const dealPayload = {
          empresa: reuniao.empresa || lead?.empresa || 'Sem nome',
          lead_id: reuniao.lead_id || undefined,
          reuniao_id: id, // FK pro trigger SQL propagar closer/sdr no futuro
          sdr_id: sdrForDeal || undefined,
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

  // ===================== LIGACOES 4COM =====================
  const fetchLigacoes = useCallback(async () => {
    const { data } = await supabase.from('ligacoes_4com').select('*').order('started_at', { ascending: false }).limit(2000);
    if (data) setLigacoes(data);
  }, []);

  // ===================== POST-MEETING AUTOMATIONS =====================
  const createAutomation = async (reuniaoId: string, dealId?: string): Promise<PostMeetingAutomation | null> => {
    const { data, error } = await supabase.from('post_meeting_automations')
      .insert({ reuniao_id: reuniaoId, deal_id: dealId || null, status: 'pending' })
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') { // unique violation - ja existe automacao para esta reuniao
        toast.error('Automacao ja foi executada para esta reuniao');
      } else {
        toast.error(error.message);
      }
      return null;
    }
    if (data) setAutomations(prev => [data, ...prev]);
    return data;
  };

  const updateAutomation = async (id: string, updates: Partial<PostMeetingAutomation>) => {
    const { error } = await supabase.from('post_meeting_automations')
      .update(updates)
      .eq('id', id);
    if (error) { toast.error(error.message); return; }
    setAutomations(prev => prev.map(a => a.id === id ? { ...a, ...updates } : a));
  };

  const getAutomationByReuniao = async (reuniaoId: string): Promise<PostMeetingAutomation | null> => {
    const { data, error } = await supabase.from('post_meeting_automations')
      .select('*')
      .eq('reuniao_id', reuniaoId)
      .maybeSingle();
    if (error) { console.error('Erro ao buscar automacao:', error); return null; }
    return data;
  };

  const startPostMeetingAutomation = async (reuniaoId: string) => {
    // Verificar se ja existe automacao para esta reuniao
    const existing = await getAutomationByReuniao(reuniaoId);
    if (existing && existing.status === 'completed') {
      toast.error('Automacao ja foi executada para esta reuniao');
      return;
    }
    if (existing && existing.status !== 'error') {
      toast.error('Automacao ja esta em andamento');
      return;
    }

    toast.success('Iniciando automacao pos-reuniao...', { icon: '🤖', duration: 3000 });

    await runPostMeetingAutomation(reuniaoId, {
      onStatusChange: (automationId, status) => {
        setAutomations(prev => {
          const exists = prev.find(a => a.id === automationId);
          if (exists) return prev.map(a => a.id === automationId ? { ...a, status } : a);
          return [{ id: automationId, reuniao_id: reuniaoId, status, created_at: new Date().toISOString() } as PostMeetingAutomation, ...prev];
        });

        const statusMessages: Record<string, string> = {
          fetching_transcript: '🔍 Buscando transcricao no Google Drive...',
          analyzing: '🧠 Analisando call com IA...',
          applying: '⚡ Aplicando acoes automaticas...',
        };
        if (statusMessages[status]) toast(statusMessages[status], { duration: 2000 });
      },
      onPollingUpdate: (attempt, maxAttempts) => {
        if (attempt === 1) return; // primeira tentativa ja foi notificada
        if (attempt % 5 === 0) { // a cada 10 minutos
          toast(`🔍 Ainda buscando transcricao... (tentativa ${attempt}/${maxAttempts})`, { duration: 3000 });
        }
      },
      onComplete: (automationId, actions) => {
        setAutomations(prev => prev.map(a => a.id === automationId ? { ...a, status: 'completed', actions_taken: actions } : a));

        // Refresh dados que podem ter mudado
        fetchDeals();
        fetchLeads();
        fetchReunioes();

        const parts: string[] = [];
        if (actions.deal_updated) parts.push(`Deal atualizado (${actions.deal_fields.length} campos)`);
        if (actions.leads_created > 0) parts.push(`${actions.leads_created} indicacao(oes) criada(s)`);
        if (actions.meeting_scheduled) parts.push('Proxima reuniao agendada');

        toast.success(`✅ Automacao concluida!\n${parts.join(' | ')}`, { duration: 6000 });
      },
      onError: (automationId, error) => {
        if (automationId) {
          setAutomations(prev => prev.map(a => a.id === automationId ? { ...a, status: 'error', error_message: error } : a));
        }
        toast.error(`❌ Erro na automacao: ${error}`, { duration: 8000 });
      },
    });
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
      fetchLigacoes();
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
      ligacoes, fetchLigacoes,
      automations, createAutomation, updateAutomation, getAutomationByReuniao, startPostMeetingAutomation,
    }}>
      {children}
    </AppContext.Provider>
  );
}
