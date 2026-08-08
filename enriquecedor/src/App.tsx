import { useState } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { NovoProjetoModal } from './components/NovoProjetoModal';
import { useAuth } from './lib/auth';
import type { View } from './types';
import { Dashboard } from './views/Dashboard';
import { LeadsView } from './views/LeadsView';
import { LeadDetail } from './views/LeadDetail';
import { WorkflowView } from './views/WorkflowView';
import { ArquitetoView } from './views/ArquitetoView';
import { Placeholder } from './views/Placeholder';

export default function App() {
  const { profile, loading } = useAuth();
  const [view, setView] = useState<View>('dashboard');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [projetoInicial, setProjetoInicial] = useState<string | null>(null);
  const [leadBackView, setLeadBackView] = useState<View>('leads');
  const [novoProjetoOpen, setNovoProjetoOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Carregando…
      </div>
    );
  }

  if (!profile) return <Login />;

  const openLead = (id: string, from: View = 'leads') => {
    setSelectedLeadId(id);
    setLeadBackView(from);
    setView('lead_detalhe');
  };

  const renderView = () => {
    switch (view) {
      case 'dashboard':
        return <Dashboard onNavigate={setView} />;
      case 'leads':
        return <LeadsView onOpenLead={openLead} />;
      case 'lead_detalhe':
        return selectedLeadId ? (
          <LeadDetail leadId={selectedLeadId} onBack={() => setView(leadBackView)} />
        ) : (
          <LeadsView onOpenLead={openLead} />
        );
      case 'workflow':
        return (
          <WorkflowView projetoInicial={projetoInicial} onConsumirInicial={() => setProjetoInicial(null)} />
        );
      case 'arquiteto':
        return <ArquitetoView />;
      case 'cadencia':
        return <Placeholder title="Cadência multicanal" phase="Fase 4" />;
      case 'cliente_oculto':
        return <Placeholder title="Cliente oculto" phase="Fase 3" />;
      case 'usuarios':
        return <Placeholder title="Usuários" phase="Fase 1 (em breve)" />;
      case 'configuracoes':
        return <Placeholder title="Configurações e integrações (Kommo, canais)" phase="Fase 4" />;
      default:
        return <Dashboard onNavigate={setView} />;
    }
  };

  return (
    <>
      <Layout currentView={view} onNavigate={setView} onNovoProjeto={() => setNovoProjetoOpen(true)}>
        {renderView()}
      </Layout>
      {novoProjetoOpen && (
        <NovoProjetoModal
          onClose={() => setNovoProjetoOpen(false)}
          onCreated={(id) => {
            setNovoProjetoOpen(false);
            setProjetoInicial(id);
            setView('workflow');
          }}
        />
      )}
    </>
  );
}
