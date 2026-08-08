import type { Permissions, Role } from '../types';

// Defaults por role. Permissões customizadas por usuário (custom_permissions
// no banco) fazem override destes valores via mergePermissions().
const ROLE_DEFAULTS: Record<Role, Permissions> = {
  admin: {
    canViewDashboard: true,
    canImport: true,
    canViewLeads: true,
    canViewWorkflow: true,
    canViewArquiteto: true,
    canEditLeads: true,
    canViewCadencia: true,
    canSendCadencia: true,
    canViewClienteOculto: true,
    canManageUsers: true,
    canManageConfig: true,
  },
  gestor: {
    canViewDashboard: true,
    canImport: true,
    canViewLeads: true,
    canViewWorkflow: true,
    canViewArquiteto: true,
    canEditLeads: true,
    canViewCadencia: true,
    canSendCadencia: true,
    canViewClienteOculto: true,
    canManageUsers: false,
    canManageConfig: false,
  },
  sdr: {
    canViewDashboard: true,
    canImport: false,
    canViewLeads: true,
    canViewWorkflow: true,
    canViewArquiteto: true,
    canEditLeads: true,
    canViewCadencia: true,
    canSendCadencia: true,
    canViewClienteOculto: true,
    canManageUsers: false,
    canManageConfig: false,
  },
  viewer: {
    canViewDashboard: true,
    canImport: false,
    canViewLeads: true,
    canViewWorkflow: true,
    canViewArquiteto: true,
    canEditLeads: false,
    canViewCadencia: true,
    canSendCadencia: false,
    canViewClienteOculto: true,
    canManageUsers: false,
    canManageConfig: false,
  },
};

export function mergePermissions(
  role: Role,
  custom: Partial<Permissions> | null | undefined,
): Permissions {
  return { ...ROLE_DEFAULTS[role], ...(custom ?? {}) };
}
