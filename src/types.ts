export type Role =
  | "owner"
  | "admin"
  | "coord_geral"
  | "coord_equipe"
  | "comercial"
  | "copywriter"
  | "designer"
  | "gestor_trafego"
  | "gestor_projetos"
  | "membro";

export type Stage =
  | "aguardando_comercial"
  | "atribuir_coordenador"
  | "atribuir_equipe"
  | "criar_workspace"
  | "boas_vindas"
  | "kickoff"
  | "planejamento"
  | "ongoing";

export interface Member {
  id: string;
  name: string;
  nickname?: string;
  email: string;
  phone: string;
  role: Role;
  isActive: boolean;
  avatarUrl?: string;
}

export interface Project {
  id: string;
  name: string;
  clientName: string;
  clientCnpj?: string;
  clientPhone?: string;
  clientEmail?: string;
  kommoLeadId?: string;
  kommoLink?: string;
  product?: string[];
  contractValue?: number;
  firstPaymentDate?: string;
  projectStartDate?: string;
  meetingLinks?: string[];

  assignedCoordinatorId?: string;
  assignedById?: string;

  gchatSpaceId?: string;
  gchatLink?: string;
  wppGroupId?: string;
  wppGroupLink?: string;
  gdriveFolderId?: string;
  gdriveFolderLink?: string;
  gdriveSharedFolderId?: string;
  gdriveSharedFolderLink?: string;
  metaAdsAccountId?: string;
  googleAdsAccountId?: string;
  ekyteId?: string;
  ekyteLink?: string;

  workspaceStatus?: {
    gchat: 'pending' | 'creating' | 'created' | 'error';
    whatsapp: 'pending' | 'creating' | 'created' | 'error';
    gdrive: 'pending' | 'creating' | 'created' | 'error';
    ekyte: 'pending' | 'creating' | 'created' | 'error';
  };

  stage: Stage;
  welcomeSent: boolean;

  createdAt: string;
  updatedAt: string;
}

export interface ProjectMember {
  id: string;
  projectId: string;
  memberId: string;
  roleInProject:
    | "coord_equipe"
    | "copywriter"
    | "designer"
    | "gestor_trafego"
    | "gestor_projetos";
}

export interface Stakeholder {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  role?: string;
  projectId: string;
}

export interface Company {
  id: string;
  name: string;
  cnpj?: string;
  address?: string;
  phone?: string;
}

export interface OnboardingLog {
  id: string;
  projectId: string;
  action: string;
  details?: any;
  performedBy?: string;
  createdAt: string;
}
