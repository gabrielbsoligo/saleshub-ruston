import React, { createContext, useContext, useState, ReactNode } from "react";
import {
  Member,
  Project,
  ProjectMember,
  Stakeholder,
  Company,
  OnboardingLog,
  Stage,
} from "./types";
import {
  mockMembers,
  mockProjects,
  mockProjectMembers,
  mockStakeholders,
  mockCompany,
  mockLogs,
} from "./data";

interface AppState {
  currentUser: Member | null;
  members: Member[];
  projects: Project[];
  projectMembers: ProjectMember[];
  stakeholders: Stakeholder[];
  company: Company;
  logs: OnboardingLog[];

  login: (email: string) => void;
  logout: () => void;

  updateProject: (id: string, updates: Partial<Project>) => void;
  moveProject: (id: string, newStage: Stage) => void;

  addMember: (member: Member) => void;
  updateMember: (id: string, updates: Partial<Member>) => void;

  addProjectMember: (pm: ProjectMember) => void;
  removeProjectMember: (id: string) => void;

  addStakeholder: (stakeholder: Stakeholder) => void;
  updateStakeholder: (id: string, updates: Partial<Stakeholder>) => void;

  updateCompany: (updates: Partial<Company>) => void;

  addLog: (log: OnboardingLog) => void;
}

const AppContext = createContext<AppState | undefined>(undefined);

export const AppProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [currentUser, setCurrentUser] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>(mockMembers);
  const [projects, setProjects] = useState<Project[]>(mockProjects);
  const [projectMembers, setProjectMembers] =
    useState<ProjectMember[]>(mockProjectMembers);
  const [stakeholders, setStakeholders] =
    useState<Stakeholder[]>(mockStakeholders);
  const [company, setCompany] = useState<Company>(mockCompany);
  const [logs, setLogs] = useState<OnboardingLog[]>(mockLogs);

  const login = (email: string) => {
    const user = members.find((m) => m.email === email);
    if (user) {
      setCurrentUser(user);
    } else {
      throw new Error("Usuário não encontrado ou email inválido.");
    }
  };

  const logout = () => setCurrentUser(null);

  const updateProject = (id: string, updates: Partial<Project>) => {
    setProjects((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, ...updates, updatedAt: new Date().toISOString() }
          : p,
      ),
    );
  };

  const moveProject = (id: string, newStage: Stage) => {
    setProjects((prev) =>
      prev.map((p) => {
        if (p.id === id) {
          addLog({
            id: Math.random().toString(36).substring(7),
            projectId: id,
            action: "stage_changed",
            details: { from: p.stage, to: newStage },
            performedBy: currentUser?.id,
            createdAt: new Date().toISOString(),
          });
          return { ...p, stage: newStage, updatedAt: new Date().toISOString() };
        }
        return p;
      }),
    );
  };

  const addMember = (member: Member) => setMembers((prev) => [...prev, member]);
  const updateMember = (id: string, updates: Partial<Member>) =>
    setMembers((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    );

  const addProjectMember = (pm: ProjectMember) =>
    setProjectMembers((prev) => [...prev, pm]);
  const removeProjectMember = (id: string) =>
    setProjectMembers((prev) => prev.filter((pm) => pm.id !== id));

  const addStakeholder = (stakeholder: Stakeholder) =>
    setStakeholders((prev) => [...prev, stakeholder]);
  const updateStakeholder = (id: string, updates: Partial<Stakeholder>) =>
    setStakeholders((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    );

  const updateCompany = (updates: Partial<Company>) =>
    setCompany((prev) => ({ ...prev, ...updates }));

  const addLog = (log: OnboardingLog) => setLogs((prev) => [log, ...prev]);

  return (
    <AppContext.Provider
      value={{
        currentUser,
        members,
        projects,
        projectMembers,
        stakeholders,
        company,
        logs,
        login,
        logout,
        updateProject,
        moveProject,
        addMember,
        updateMember,
        addProjectMember,
        removeProjectMember,
        addStakeholder,
        updateStakeholder,
        updateCompany,
        addLog,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppStore = () => {
  const context = useContext(AppContext);
  if (!context) throw new Error("useAppStore must be used within AppProvider");
  return context;
};
