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

type View = "dashboard" | "projects" | "members" | "stakeholders" | "company";

const MainApp: React.FC = () => {
  const { currentUser } = useAppStore();
  const [currentView, setCurrentView] = useState<View>("dashboard");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);

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
      <MainApp />
    </AppProvider>
  );
}
