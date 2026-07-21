import type { I18nKey } from '@/lib/i18n';
import type {
  WebV2API,
  WebV2RuntimeOperationKind,
  WebV2RuntimeStatus,
  WebV2SessionRecord,
} from '@/lib/api/types';

export const areWorkspaceResourceControlsDisabled = (
  membershipState: 'pending' | 'active' | undefined,
  mutation: 'project' | 'file' | 'session' | null | undefined,
) => membershipState !== 'active' || mutation !== null;

export const hasWebV2RuntimePanelCapability = (webV2: Pick<WebV2API, 'runtime'> | undefined): boolean => webV2?.runtime !== undefined;

export type WebV2RuntimePanelAction = {
  kind: WebV2RuntimeOperationKind;
  enabled: boolean;
};

export type WebV2RuntimePanelState = {
  actions: Record<WebV2RuntimeOperationKind, WebV2RuntimePanelAction>;
  statusLabelKey: I18nKey;
  showOutcomeUnknownWarning: boolean;
  showReadinessNotice: boolean;
  showRefreshRetry: boolean;
};

export const selectWebV2RuntimeSessionId = (
  sessions: readonly WebV2SessionRecord[],
  selectedSessionId: string | null,
  statusSessionId: string | null | undefined,
): string | null => {
  if (selectedSessionId && sessions.some((session) => session.sessionId === selectedSessionId)) {
    return selectedSessionId;
  }
  if (statusSessionId && sessions.some((session) => session.sessionId === statusSessionId)) {
    return statusSessionId;
  }
  return sessions[0]?.sessionId ?? null;
};

const statusLabelKey = (
  status: WebV2RuntimeStatus | null,
  statusResolved: boolean,
  statusLoading: boolean,
  statusFailed: boolean,
): I18nKey => {
  if (statusFailed) return 'workspace.runtime.status.refreshFailed';
  if (!statusResolved || status === null) {
    return statusLoading ? 'workspace.runtime.status.loading' : 'workspace.runtime.status.unresolved';
  }
  switch (status.status) {
    case 'pending': return 'workspace.runtime.status.pending';
    case 'running': return 'workspace.runtime.status.running';
    case 'pausing': return 'workspace.runtime.status.pausing';
    case 'paused': return 'workspace.runtime.status.paused';
    case 'resuming': return 'workspace.runtime.status.resuming';
    case 'stopping': return 'workspace.runtime.status.stopping';
    case 'terminated': return 'workspace.runtime.status.terminated';
    case 'failed': return 'workspace.runtime.status.failed';
    case 'unknown': return 'workspace.runtime.status.unknown';
  }
};

export const getWebV2RuntimePanelState = ({
  projectActive,
  sessionId,
  status,
  statusResolved,
  statusLoading,
  statusFailed,
  pendingOperation,
  workspaceRevision,
}: {
  projectActive: boolean;
  sessionId: string | null;
  status: WebV2RuntimeStatus | null;
  statusResolved: boolean;
  statusLoading: boolean;
  statusFailed: boolean;
  pendingOperation: WebV2RuntimeOperationKind | null;
  workspaceRevision: number | null;
}): WebV2RuntimePanelState => {
  const actions = (enabledKinds: readonly WebV2RuntimeOperationKind[]): Record<WebV2RuntimeOperationKind, WebV2RuntimePanelAction> => ({
    ensure: { kind: 'ensure', enabled: enabledKinds.includes('ensure') },
    pause: { kind: 'pause', enabled: enabledKinds.includes('pause') },
    resume: { kind: 'resume', enabled: enabledKinds.includes('resume') },
    destroy: { kind: 'destroy', enabled: enabledKinds.includes('destroy') },
    checkpoint: { kind: 'checkpoint', enabled: enabledKinds.includes('checkpoint') },
    replace: { kind: 'replace', enabled: enabledKinds.includes('replace') },
  });
  const blocked = !projectActive
    || !sessionId
    || !statusResolved
    || status === null
    || statusFailed
    || pendingOperation !== null
    || status.outcomeUnknown
    || status.checkpoint?.state === 'outcomeUnknown'
    || status.readiness === 'disabled';

  if (blocked || status === null) {
    return {
      actions: actions([]),
      statusLabelKey: statusLabelKey(status, statusResolved, statusLoading, statusFailed),
      showOutcomeUnknownWarning: status?.outcomeUnknown === true || status?.checkpoint?.state === 'outcomeUnknown',
      showReadinessNotice: status?.readiness === 'disabled',
      showRefreshRetry: statusFailed,
    };
  }

  const enabledKinds: WebV2RuntimeOperationKind[] = [];
  if (!status.exists || status.status === 'terminated' || status.status === 'failed') {
    enabledKinds.push('ensure');
  }
  if (status.exists && status.status === 'running') {
    enabledKinds.push('pause');
    if (workspaceRevision !== null) enabledKinds.push('checkpoint');
  }
  if (status.exists && status.status === 'paused') {
    enabledKinds.push('resume');
  }
  if (status.exists && status.status !== 'terminated') {
    enabledKinds.push('destroy');
  }
  if (status.exists && ['running', 'paused', 'failed', 'unknown'].includes(status.status)) {
    enabledKinds.push('replace');
  }

  return {
    actions: actions(enabledKinds),
    statusLabelKey: statusLabelKey(status, statusResolved, statusLoading, statusFailed),
    showOutcomeUnknownWarning: false,
    showReadinessNotice: false,
    showRefreshRetry: false,
  };
};
