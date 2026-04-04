import React, { useState } from "react";
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
import { Toaster } from "react-hot-toast";

const MainApp: React.FC = () => {
  const { currentUser, isLoadingAuth } = useAppStore();
  const [currentView, setCurrentView] = useState<View>("dashboard");

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
  return (
    <AppProvider>
      <Toaster position="top-right" />
      <MainApp />
    </AppProvider>
  );
}
