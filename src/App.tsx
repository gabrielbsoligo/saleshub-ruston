import React, { useState, useEffect } from "react";
import { AppProvider, useAppStore } from "./store";
import { LoginView } from "./components/LoginView";
import { Layout, type View } from "./components/Layout";
import { DashboardView } from "./components/DashboardView";
import { PipelineView } from "./components/PipelineView";
import { LeadsView } from "./components/LeadsView";
import { ReunioesView } from "./components/ReunioesView";
import { PerformanceView } from "./components/PerformanceView";
import { MetasView } from "./components/MetasView";
import { EquipeView } from "./components/EquipeView";
import { BlackBoxView } from "./components/BlackBoxView";
import { ComissoesView } from "./components/ComissoesView";
import { AuditoriaView } from "./components/AuditoriaView";
import { AuditPanel } from "./components/AuditPanel";
import { Toaster } from "react-hot-toast";
import toast from "react-hot-toast";

const MainApp: React.FC = () => {
  const { currentUser, isLoadingAuth, addLead } = useAppStore();
  const [currentView, setCurrentView] = useState<View>(
    currentUser?.role === 'financeiro' ? 'comissoes' : 'dashboard'
  );
  const [importProcessed, setImportProcessed] = useState(false);

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
        valor_lead: data.valor_lead ? Number(data.valor_lead) : null,
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

      // Create lead
      addLead(payload).then((lead) => {
        if (lead) {
          toast.success(`Lead "${payload.empresa}" importado do MKTLAB!`, { duration: 5000, icon: '⚡' });
          setCurrentView('leads');
        }
      });

      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
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
      case "performance": return <PerformanceView />;
      case "metas": return <MetasView />;
      case "comissoes": return <ComissoesView />;
      case "blackbox": return <BlackBoxView />;
      case "auditoria": return <AuditoriaView />;
      case "equipe": return <EquipeView />;
      default: return <DashboardView />;
    }
  };

  return (
    <Layout currentView={currentView} onViewChange={setCurrentView}>
      {renderView()}
    </Layout>
  );
};

export default function App() {
  const params = new URLSearchParams(window.location.search);
  const auditPanelSession = params.get('audit_panel') === '1' ? params.get('session') : null;

  if (auditPanelSession) {
    return (
      <AppProvider>
        <Toaster position="top-right" />
        <AuditPanel sessionId={auditPanelSession} />
      </AppProvider>
    );
  }

  return (
    <AppProvider>
      <Toaster position="top-right" />
      <MainApp />
    </AppProvider>
  );
}
