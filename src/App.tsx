import React, { useState, useEffect } from "react";
import { AppProvider, useAppStore } from "./store";
import { LoginView } from "./components/LoginView";
import { Layout, type View } from "./components/Layout";
import { DashboardView } from "./components/DashboardView";
import { PipelineView } from "./components/PipelineView";
import { LeadsView } from "./components/LeadsView";
import { ReunioesView } from "./components/ReunioesView";
import { AgendasTimeView } from "./components/AgendasTimeView";
import { PerformanceView } from "./components/PerformanceView";
import { MetasView } from "./components/MetasView";
import { EquipeView } from "./components/EquipeView";
import { BlackBoxView } from "./components/BlackBoxView";
import { LeadBrokerView } from "./components/LeadBrokerView";
import { ComissoesView } from "./components/ComissoesView";
import { ContratosView } from "./components/ContratosView";
import { AuditoriaView } from "./components/AuditoriaView";
import { PrepCallView } from "./components/PrepCallView";
import { ThreeCManualView } from "./components/ThreeCManualView";
import { PlaybookView } from "./components/PlaybookView";
import { RoletaHistoricoView } from "./components/RoletaHistoricoView";
import { AuditPanel } from "./components/AuditPanel";
import { BriefingApresentacao } from "./components/BriefingApresentacao";
import { TVMode } from "./components/TVMode";
import { RoletaAssignModal } from "./components/RoletaAssignModal";
import type { Lead } from "./types";
import { supabase } from "./lib/supabase";
import { parseBRL } from "./lib/parseBRL";
import { Toaster } from "react-hot-toast";
import toast from "react-hot-toast";
import { Loader2, AlertTriangle } from "lucide-react";

// ============================================================
// AuditPanelBootstrap — restaura auth ANTES do AppProvider
// evita race condition com checkSession do store.
// ============================================================
const AuditPanelBootstrap: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const hash = window.location.hash.slice(1);
        const hashParams = new URLSearchParams(hash);
        const at = hashParams.get('at');
        const rt = hashParams.get('rt');

        if (at && rt) {
          // Caminho feliz — tokens vieram fresh do parent
          const { error } = await supabase.auth.setSession({ access_token: at, refresh_token: rt });
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
          if (error) {
            // Tokens foram rejeitados (expirados?), tenta refresh
            const { error: refreshErr } = await supabase.auth.refreshSession();
            if (refreshErr) {
              setErrorMsg('Os tokens enviados expiraram. Volte ao SalesHub e clique em "Reabrir Kommo / reinjetar painel".');
              setStatus('error');
              return;
            }
          }
        } else {
          // Sem tokens no hash — iframe remontou. Tenta sessão persistida.
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) {
            setErrorMsg('Sessão não encontrada. Volte ao SalesHub e clique em "Reabrir Kommo / reinjetar painel".');
            setStatus('error');
            return;
          }
          // Faz refresh pra garantir token vivo
          const { error: refreshErr } = await supabase.auth.refreshSession();
          if (refreshErr) {
            setErrorMsg('Sua sessão expirou. Clique em "Reabrir Kommo / reinjetar painel" no SalesHub.');
            setStatus('error');
            return;
          }
        }
        setStatus('ready');
      } catch (err: any) {
        setErrorMsg(err?.message || 'Erro ao restaurar sessão.');
        setStatus('error');
      }
    })();
  }, []);

  const requestReinject = () => {
    // Avisa o parent (Kommo bridge) que precisa de tokens novos
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: 'saleshub-audit-panel', action: 'need-new-tokens' }, '*');
    }
  };

  if (status === 'loading') {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0a0e1a] text-slate-400 gap-2 text-sm">
        <Loader2 size={18} className="animate-spin" /> Autenticando…
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0a0e1a] text-white gap-4 p-6 text-center">
        <AlertTriangle size={36} className="text-yellow-400" />
        <div className="text-sm text-slate-300 max-w-xs">{errorMsg}</div>
        <button
          onClick={requestReinject}
          className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm"
        >
          Pedir tokens novos
        </button>
      </div>
    );
  }

  return (
    <AppProvider>
      <Toaster position="top-right" />
      <AuditPanel sessionId={sessionId} />
    </AppProvider>
  );
};

const MainApp: React.FC = () => {
  const { currentUser, isLoadingAuth, addLead } = useAppStore();
  const [currentView, setCurrentView] = useState<View>(
    currentUser?.role === 'financeiro' ? 'comissoes' : 'dashboard'
  );
  const [importProcessed, setImportProcessed] = useState(false);
  // Roleta INBOUND: lead recém-criado aguardando atribuição no modal (flag-gated).
  const [roletaLead, setRoletaLead] = useState<Lead | null>(null);

  // Listener: SendToAuditoriaButton dispara este evento ao criar sessao.
  useEffect(() => {
    const handler = (_e: Event) => setCurrentView('auditoria');
    window.addEventListener('saleshub:open-auditoria', handler);
    return () => window.removeEventListener('saleshub:open-auditoria', handler);
  }, []);

  // Auto-import from mktlab via URL parameter
  useEffect(() => {
    if (!currentUser || importProcessed) return;

    const params = new URLSearchParams(window.location.search);

    // Handle Google OAuth callback
    const googleAuth = params.get('google_auth');
    if (googleAuth) {
      if (googleAuth === 'success') {
        toast.success('Google Calendar conectado com sucesso!', { icon: '📅', duration: 5000 });
        // Refresh members to get updated calendar status
        setTimeout(() => window.location.href = window.location.pathname, 1000);
      } else {
        toast.error('Falha ao conectar Google Calendar: ' + (params.get('msg') || 'erro desconhecido'));
      }
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    const importData = params.get('mktlab_import');
    if (!importData) return;

    setImportProcessed(true);

    try {
      const data = JSON.parse(decodeURIComponent(importData));

      // Clean payload
      const payload: any = {
        empresa: data.empresa || 'Sem nome',
        nome_contato: data.nome_contato || null,
        telefone: data.telefone || null,
        email: data.email || null,
        cnpj: data.cnpj || null,
        faturamento: data.faturamento || null,
        produto: data.produto || null,
        canal: data.canal || 'leadbroker',
        fonte: data.fonte || null,
        status: 'sem_contato',
        valor_lead: parseBRL(data.valor_lead),
        // data_cadastro = hoje (TZ local): import single acontece no dia da
        // compra do lead. Sem isso o lead nao agrupa por mes no LeadBroker.
        data_cadastro: (() => {
          const n = new Date();
          return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
        })(),
        mktlab_link: data.mktlab_link || null,
        mktlab_id: data.mktlab_id || null,
        sdr_id: data.auto_assign_sdr ? currentUser.id : null,
      };

      // Remove null fields
      Object.keys(payload).forEach(k => {
        if (payload[k] === null || payload[k] === '') delete payload[k];
      });
      // Ensure required
      payload.empresa = payload.empresa || 'Sem nome';
      payload.canal = payload.canal || 'leadbroker';
      payload.status = 'sem_contato';

      // Roleta INBOUND (flag-gated): se ligada e canal ∈ (leadbroker, blackbox),
      // cria o lead SEM dono e abre o modal de atribuição (sugere próximo da fila).
      // Senão, mantém o comportamento atual (dono = quem clicou no bookmarklet).
      (async () => {
        const { data: cfg } = await supabase
          .from('integracao_config').select('value').eq('key', 'roleta_inbound_ativa').maybeSingle();
        const roletaOn = cfg?.value === 'true';
        const viaRoleta = roletaOn && ['leadbroker', 'blackbox'].includes(payload.canal);

        if (viaRoleta) delete payload.sdr_id;   // fica pendente até o modal atribuir

        const lead = await addLead(payload);
        if (lead) {
          toast.success(`Lead "${payload.empresa}" importado do MKTLAB!`, { duration: 5000, icon: '⚡' });
          if (viaRoleta) setRoletaLead(lead);    // abre o modal de atribuição
          else setCurrentView('leads');
        }
        // Clean URL
        window.history.replaceState({}, '', window.location.pathname);
      })();
    } catch (e) {
      console.error('Failed to import from mktlab:', e);
      toast.error('Erro ao importar do MKTLAB');
    }
  }, [currentUser, importProcessed, addLead]);

  if (isLoadingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-v4-bg)]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-slate-700 border-t-[var(--color-v4-red)] rounded-full animate-spin"></div>
          <p className="text-slate-400 font-medium">Validando sessão...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginView />;
  }

  const renderView = () => {
    switch (currentView) {
      case "dashboard": return <DashboardView />;
      case "pipeline": return <PipelineView />;
      case "leads": return <LeadsView />;
      case "reunioes": return <ReunioesView />;
      case "agendas_time": return <AgendasTimeView />;
      case "performance": return <PerformanceView />;
      case "metas": return <MetasView />;
      case "comissoes": return <ComissoesView />;
      case "contratos": return <ContratosView />;
      case "blackbox": return <BlackBoxView />;
      case "leadbroker": return <LeadBrokerView />;
      case "auditoria": return <AuditoriaView />;
      case "prepcall": return <PrepCallView />;
      case "3c_manual": return <ThreeCManualView />;
      case "playbook": return <PlaybookView />;
      case "roleta_historico": return <RoletaHistoricoView />;
      case "equipe": return <EquipeView />;
      default: return <DashboardView />;
    }
  };

  return (
    <Layout currentView={currentView} onViewChange={setCurrentView}>
      {renderView()}
      {roletaLead && (
        <RoletaAssignModal
          lead={roletaLead}
          onClose={() => { setRoletaLead(null); setCurrentView('leads'); }}
        />
      )}
    </Layout>
  );
};

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const auditPanelSession = params.get('audit_panel') === '1' ? params.get('session') : null;
  const briefingId = params.get('briefing');
  const tvMode = params.get('tv') === '1';

  // Rota pública /?briefing=<uuid> → página de apresentação (sem login, sem AppProvider)
  if (briefingId) {
    return <BriefingApresentacao briefingId={briefingId} />;
  }

  // Rota /?tv=1 → TV mode (sem login, fullscreen 4 quadrantes)
  if (tvMode) {
    return (
      <AppProvider>
        <Toaster position="top-right" />
        <TVMode />
      </AppProvider>
    );
  }

  if (auditPanelSession) {
    return <AuditPanelBootstrap sessionId={auditPanelSession} />;
  }

  return (
    <AppProvider>
      <Toaster position="top-right" />
      <MainApp />
    </AppProvider>
  );
}
