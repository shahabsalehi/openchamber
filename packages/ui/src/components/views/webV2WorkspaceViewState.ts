export const areWorkspaceResourceControlsDisabled = (
  membershipState: 'pending' | 'active' | undefined,
  mutation: 'project' | 'file' | 'session' | null | undefined,
) => membershipState !== 'active' || mutation !== null;
