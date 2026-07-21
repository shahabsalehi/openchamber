import { describe, expect, test } from 'bun:test';
import type { WebV2RuntimeStatus, WebV2SessionRecord } from '@/lib/api/types';
import {
  areWorkspaceResourceControlsDisabled,
  getWebV2RuntimePanelState,
  hasWebV2RuntimePanelCapability,
  selectWebV2RuntimeSessionId,
} from './webV2WorkspaceViewState';

const status = (overrides: Partial<WebV2RuntimeStatus> = {}): WebV2RuntimeStatus => ({
  projectId: 'project_0001',
  exists: true,
  sessionId: 'session_0001',
  leaseId: null,
  status: 'running',
  generation: 2,
  lifecycleRevision: 5,
  outcomeUnknown: false,
  activeOperation: null,
  checkpoint: null,
  readiness: 'disabled',
  updatedAt: 1,
  ...overrides,
});

const sessions: WebV2SessionRecord[] = [
  { sessionId: 'session_0001', title: 'First', revision: 1, createdAt: 1, updatedAt: 1 },
  { sessionId: 'session_0002', title: 'Second', revision: 1, createdAt: 1, updatedAt: 1 },
];

const panelState = (overrides: Partial<Parameters<typeof getWebV2RuntimePanelState>[0]> = {}) => getWebV2RuntimePanelState({
  projectActive: true,
  sessionId: 'session_0001',
  status: status(),
  statusResolved: true,
  statusLoading: false,
  statusFailed: false,
  pendingOperation: null,
  workspaceRevision: null,
  ...overrides,
});

describe('WebV2WorkspaceView', () => {
  test('disables resource controls for pending projects and in-flight mutations', () => {
    expect(areWorkspaceResourceControlsDisabled('pending', null)).toBe(true);
    expect(areWorkspaceResourceControlsDisabled('active', 'file')).toBe(true);
    expect(areWorkspaceResourceControlsDisabled('active', null)).toBe(false);
  });

  test('keeps the runtime panel hidden without the independent runtime capability', () => {
    expect(hasWebV2RuntimePanelCapability(undefined)).toBe(false);
    expect(hasWebV2RuntimePanelCapability({})).toBe(false);
  });

  test('selects durable runtime sessions deterministically', () => {
    expect(selectWebV2RuntimeSessionId(sessions, 'session_0002', 'session_0001')).toBe('session_0002');
    expect(selectWebV2RuntimeSessionId(sessions, 'missing', 'session_0002')).toBe('session_0002');
    expect(selectWebV2RuntimeSessionId(sessions, null, 'missing')).toBe('session_0001');
    expect(selectWebV2RuntimeSessionId([], 'session_0001', 'session_0001')).toBeNull();
  });

  test('shows the disabled readiness explanation and enables no lifecycle actions', () => {
    const state = panelState();

    expect(Object.values(state.actions).every((action) => action.enabled === false)).toBe(true);
    expect(state.showReadinessNotice).toBe(true);
    expect(state.statusLabelKey).toBe('workspace.runtime.status.ready');
  });

  test('blocks actions and shows recovery guidance for unknown outcomes and active operations', () => {
    const unknown = panelState({ status: status({ outcomeUnknown: true }) });
    const active = panelState({ status: status({ activeOperation: { operationId: 'operation_0001', kind: 'pause', state: 'inProgress' } }), pendingOperation: 'pause' });

    expect(unknown.showOutcomeUnknownWarning).toBe(true);
    expect(unknown.statusLabelKey).toBe('workspace.runtime.status.recovering');
    expect(Object.values(unknown.actions).every((action) => action.enabled === false)).toBe(true);
    expect(Object.values(active.actions).every((action) => action.enabled === false)).toBe(true);
  });

  test('keeps status semantics explicit across lifecycle states', () => {
    expect(panelState({ status: status({ status: 'pending' }) }).statusLabelKey).toBe('workspace.runtime.status.starting');
    expect(panelState({ status: status({ status: 'running' }) }).statusLabelKey).toBe('workspace.runtime.status.ready');
    expect(panelState({ status: status({ status: 'stopping' }) }).statusLabelKey).toBe('workspace.runtime.status.stopping');
    expect(panelState({ status: status({ status: 'resuming' }) }).statusLabelKey).toBe('workspace.runtime.status.recovering');
    expect(panelState({ status: status({ status: 'unknown' }) }).statusLabelKey).toBe('workspace.runtime.status.recovering');
    expect(panelState({ status: status({ status: 'paused' }) }).statusLabelKey).toBe('workspace.runtime.status.paused');
    expect(panelState({ status: status({ status: 'terminated', exists: false }) }).statusLabelKey).toBe('workspace.runtime.status.terminated');
    expect(panelState({ status: status({ status: 'failed' }) }).statusLabelKey).toBe('workspace.runtime.status.failed');
    expect(panelState({ statusFailed: true }).statusLabelKey).toBe('workspace.runtime.status.retryable');
  });
});
