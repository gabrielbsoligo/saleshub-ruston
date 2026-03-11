import React, { useState } from "react";
import { AppProvider, useAppStore } from "./store";
import { LoginView } from "./components/LoginView";
import { Layout } from "./components/Layout";
import { KanbanBoard } from "./components/KanbanBoard";
import { MembersView } from "./components/MembersView";
import { ProjectsView } from "./components/ProjectsView";
import { StakeholdersView } from "./components/StakeholdersView";
import { CompanyView } from "./components/CompanyView";
import { ProjectDrawer } from "./components/ProjectDrawer";
import { Project } from "./types";
import { Toaster } from "react-hot-toast";

type View = "dashboard" | "projects" | "members" | "stakeholders" | "company";

const MainApp: React.FC = () => {
  const { currentUser, isLoadingAuth } = useAppStore();
  const [currentView, setCurrentView] = useState<View>("dashboard");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

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
      case "dashboard":
        return <KanbanBoard onProjectClick={setSelectedProject} />;
      case "projects":
        return <ProjectsView onProjectClick={setSelectedProject} />;
      case "members":
        return <MembersView />;
      case "stakeholders":
        return <StakeholdersView />;
      case "company":
        return <CompanyView />;
      default:
        return <KanbanBoard onProjectClick={setSelectedProject} />;
    }
  };

  return (
    <Layout currentView={currentView} onViewChange={setCurrentView}>
      {renderView()}
      {selectedProject && (
        <ProjectDrawer
          project={selectedProject}
          onClose={() => setSelectedProject(null)}
        />
      )}
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
