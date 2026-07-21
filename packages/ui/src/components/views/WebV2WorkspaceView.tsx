import React from 'react';

import type { WebV2SessionRecord } from '@/lib/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWebV2RuntimeStore } from '@/stores/useWebV2RuntimeStore';
import { useWebV2WorkspaceStore } from '@/stores/useWebV2WorkspaceStore';
import { cn } from '@/lib/utils';
import {
  areWorkspaceResourceControlsDisabled,
  getWebV2RuntimePanelState,
  hasWebV2RuntimePanelCapability,
  selectWebV2RuntimeSessionId,
} from './webV2WorkspaceViewState';

const errorKey = (error: ReturnType<typeof useWebV2WorkspaceStore.getState>['error']) => {
  if (error === 'conflict') return 'workspace.error.conflict';
  return 'workspace.error.operation';
};

const EMPTY_RUNTIME_SESSIONS: ReadonlyArray<WebV2SessionRecord> = [];

export const WebV2WorkspaceView: React.FC = () => {
  const { t } = useI18n();
  const { webV2 } = useRuntimeAPIs();
  const runtimeKey = getRuntimeKey();
  const runtimeApi = webV2?.runtime;
  const [projectName, setProjectName] = React.useState('');
  const [newFilePath, setNewFilePath] = React.useState('');
  const [sessionTitle, setSessionTitle] = React.useState('');
  const [selectedRuntimeSessionId, setSelectedRuntimeSessionId] = React.useState<string | null>(null);

  const projects = useWebV2WorkspaceStore((state) => state.projects);
  const projectsResolved = useWebV2WorkspaceStore((state) => state.projectsResolved);
  const projectsLoading = useWebV2WorkspaceStore((state) => state.projectsLoading);
  const selectedProjectId = useWebV2WorkspaceStore((state) => state.selectedProjectId);
  const projectWorkspaces = useWebV2WorkspaceStore((state) => state.projectWorkspaces);
  const storeError = useWebV2WorkspaceStore((state) => state.error);
  const configure = useWebV2WorkspaceStore((state) => state.configure);
  const loadProjects = useWebV2WorkspaceStore((state) => state.loadProjects);
  const createProject = useWebV2WorkspaceStore((state) => state.createProject);
  const selectProject = useWebV2WorkspaceStore((state) => state.selectProject);
  const loadFiles = useWebV2WorkspaceStore((state) => state.loadFiles);
  const openFile = useWebV2WorkspaceStore((state) => state.openFile);
  const setDraft = useWebV2WorkspaceStore((state) => state.setDraft);
  const saveFile = useWebV2WorkspaceStore((state) => state.saveFile);
  const createFile = useWebV2WorkspaceStore((state) => state.createFile);
  const deleteFile = useWebV2WorkspaceStore((state) => state.deleteFile);
  const reloadFile = useWebV2WorkspaceStore((state) => state.reloadFile);
  const loadSessions = useWebV2WorkspaceStore((state) => state.loadSessions);
  const createSession = useWebV2WorkspaceStore((state) => state.createSession);
  const updateSession = useWebV2WorkspaceStore((state) => state.updateSession);
  const retryMutation = useWebV2WorkspaceStore((state) => state.retryMutation);
  const runtimeStatus = useWebV2RuntimeStore((state) => state.status);
  const runtimeStatusResolved = useWebV2RuntimeStore((state) => state.statusResolved);
  const runtimeStatusLoading = useWebV2RuntimeStore((state) => state.statusLoading);
  const runtimeStatusFailed = useWebV2RuntimeStore((state) => state.statusFailed);
  const runtimePendingOperation = useWebV2RuntimeStore((state) => state.pendingOperation);
  const runtimeOperationFailed = useWebV2RuntimeStore((state) => state.operationFailed);
  const configureRuntime = useWebV2RuntimeStore((state) => state.configure);
  const resetRuntime = useWebV2RuntimeStore((state) => state.reset);
  const refreshRuntimeStatus = useWebV2RuntimeStore((state) => state.refreshStatus);
  const ensureRuntime = useWebV2RuntimeStore((state) => state.ensure);
  const pauseRuntime = useWebV2RuntimeStore((state) => state.pause);
  const resumeRuntime = useWebV2RuntimeStore((state) => state.resume);
  const destroyRuntime = useWebV2RuntimeStore((state) => state.destroy);
  const checkpointRuntime = useWebV2RuntimeStore((state) => state.checkpoint);
  const replaceRuntime = useWebV2RuntimeStore((state) => state.replace);

  const selectedProject = projects.find((item) => item.projectId === selectedProjectId) ?? null;
  const workspace = selectedProjectId ? projectWorkspaces[selectedProjectId] : undefined;
  const isPending = selectedProject?.membershipState === 'pending';
  const activeRuntimeProjectId = selectedProject?.membershipState === 'active' ? selectedProject.projectId : null;
  const runtimeSessions = activeRuntimeProjectId ? workspace?.sessions ?? EMPTY_RUNTIME_SESSIONS : EMPTY_RUNTIME_SESSIONS;
  const runtimeSessionId = selectWebV2RuntimeSessionId(runtimeSessions, selectedRuntimeSessionId, runtimeStatus?.sessionId);

  React.useEffect(() => {
    configure(webV2, runtimeKey);
    if (webV2) void loadProjects();
  }, [configure, loadProjects, runtimeKey, webV2]);

  React.useEffect(() => {
    if (!selectedProjectId) return;
    const project = projects.find((item) => item.projectId === selectedProjectId);
    if (!project || project.membershipState === 'pending') return;
    void loadFiles(selectedProjectId);
    void loadSessions(selectedProjectId);
  }, [loadFiles, loadSessions, projects, selectedProjectId]);

  React.useEffect(() => {
    setSelectedRuntimeSessionId((current) => selectWebV2RuntimeSessionId(runtimeSessions, current, runtimeStatus?.sessionId));
  }, [runtimeSessions, runtimeStatus?.sessionId]);

  React.useEffect(() => {
    if (!runtimeApi) {
      resetRuntime();
      return;
    }
    configureRuntime(runtimeApi, runtimeKey, activeRuntimeProjectId, runtimeSessionId);
    if (activeRuntimeProjectId) void refreshRuntimeStatus();
    return resetRuntime;
  }, [activeRuntimeProjectId, configureRuntime, refreshRuntimeStatus, resetRuntime, runtimeApi, runtimeKey, runtimeSessionId]);

  if (!webV2) return null;

  const controlsDisabled = areWorkspaceResourceControlsDisabled(selectedProject?.membershipState, workspace?.mutation);
  const retrySelectedWorkspaceFailure = (failure: 'files' | 'file' | 'sessions' | 'mutation') => {
    if (!selectedProjectId) return;
    if (failure === 'files') {
      void loadFiles(selectedProjectId);
      return;
    }
    if (failure === 'sessions') {
      void loadSessions(selectedProjectId);
      return;
    }
    if (failure === 'file') {
      void reloadFile(selectedProjectId);
      return;
    }
    if (failure === 'mutation') {
      void retryMutation(selectedProjectId);
    }
  };
  const workspaceFailures = workspace
    ? (['files', 'file', 'sessions', 'mutation'] as const).filter((failure) => workspace.failures[failure])
    : [];

  const submitProject = async (event: React.FormEvent) => {
    event.preventDefault();
    await createProject(projectName);
    setProjectName('');
  };
  const submitFile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    await createFile(selectedProjectId, newFilePath);
    setNewFilePath('');
  };
  const submitSession = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    await createSession(selectedProjectId, sessionTitle);
    setSessionTitle('');
  };

  return (
    <div className="h-full overflow-auto bg-background p-3 sm:p-5" data-page-scroll-lock="false">
      <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-4">
        <header className="flex flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="typography-ui-label text-lg font-semibold text-foreground">{t('workspace.title')}</h1>
            <p className="typography-ui-label text-sm text-muted-foreground">{t('workspace.description')}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadProjects()} disabled={projectsLoading} aria-label={t('workspace.projects.refreshAria')}>
            <Icon name="refresh" className="size-4" />
            {t('workspace.actions.refresh')}
          </Button>
        </header>

        {hasWebV2RuntimePanelCapability(webV2) ? <RuntimePanel
          projectActive={activeRuntimeProjectId !== null}
          sessions={runtimeSessions}
          selectedSessionId={runtimeSessionId}
          onSessionChange={setSelectedRuntimeSessionId}
          status={runtimeStatus}
          statusResolved={runtimeStatusResolved}
          statusLoading={runtimeStatusLoading}
          statusFailed={runtimeStatusFailed}
          pendingOperation={runtimePendingOperation}
          operationFailed={runtimeOperationFailed}
          onRefresh={refreshRuntimeStatus}
          onEnsure={ensureRuntime}
          onPause={pauseRuntime}
          onResume={resumeRuntime}
          onDestroy={destroyRuntime}
          onCheckpoint={checkpointRuntime}
          onReplace={replaceRuntime}
        /> : null}

        {storeError ? <p role="alert" className="rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 text-sm text-[var(--status-error-foreground)]">{t(errorKey(storeError))}</p> : null}
        {workspaceFailures.map((failure) => <div key={failure} role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3 text-sm text-[var(--status-error-foreground)]"><span>{t('workspace.error.operation')}</span><Button variant="outline" size="xs" onClick={() => retrySelectedWorkspaceFailure(failure)} disabled={controlsDisabled}>{failure === 'file' ? t('workspace.actions.reload') : t('workspace.actions.refresh')}</Button></div>)}

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('workspace.projects.title')}</h2>
              <Button variant="ghost" size="icon" onClick={() => void loadProjects()} disabled={projectsLoading} aria-label={t('workspace.projects.refreshAria')}>
                <Icon name="refresh" className="size-4" />
              </Button>
            </div>
            <form className="mb-3 flex gap-2" onSubmit={submitProject}>
              <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder={t('workspace.projects.namePlaceholder')} aria-label={t('workspace.projects.nameAria')} disabled={projectsLoading} />
              <Button size="sm" type="submit" disabled={!projectName.trim() || projectsLoading} aria-label={t('workspace.projects.createAria')}><Icon name="add" className="size-4" /></Button>
            </form>
            {!projectsResolved && projectsLoading ? <p className="text-sm text-muted-foreground">{t('workspace.loading')}</p> : null}
            {projectsResolved && projects.length === 0 ? <p className="text-sm text-muted-foreground">{t('workspace.projects.empty')}</p> : null}
            <div className="flex flex-col gap-1">
              {projects.map((project) => {
                const active = project.projectId === selectedProjectId;
                return <button key={project.projectId} type="button" onClick={() => selectProject(project.projectId)} className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]', active ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-foreground hover:bg-interactive-hover')}>
                  <span className="min-w-0 truncate">{project.name}</span>
                  {project.membershipState === 'pending' ? <span className="shrink-0 text-xs text-status-warning">{t('workspace.projects.pending')}</span> : null}
                </button>;
              })}
            </div>
          </aside>

          <section className="grid min-h-0 gap-4 xl:grid-cols-[16rem_minmax(0,1fr)]">
            <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3">
              <h2 className="mb-3 typography-ui-label font-semibold text-foreground">{t('workspace.files.title')}</h2>
              {!selectedProject ? <p className="text-sm text-muted-foreground">{t('workspace.projects.select')}</p> : isPending ? <p className="text-sm text-muted-foreground">{t('workspace.projects.pendingDescription')}</p> : <>
                <form className="mb-3 flex gap-2" onSubmit={submitFile}>
                  <Input value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder={t('workspace.files.pathPlaceholder')} aria-label={t('workspace.files.pathAria')} disabled={controlsDisabled} />
                  <Button size="sm" type="submit" disabled={!newFilePath.trim() || controlsDisabled} aria-label={t('workspace.files.createAria')}><Icon name="add" className="size-4" /></Button>
                </form>
                {workspace?.filesLoading ? <p className="text-sm text-muted-foreground">{t('workspace.loading')}</p> : null}
                {workspace?.filesResolved && workspace.files.length === 0 ? <p className="text-sm text-muted-foreground">{t('workspace.files.empty')}</p> : null}
                <div className="flex flex-col gap-1">
                  {workspace?.files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => <button key={file.path} type="button" onClick={() => void openFile(selectedProject.projectId, file.path)} disabled={controlsDisabled} className={cn('w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]', workspace.selectedFilePath === file.path && 'bg-interactive-selection text-interactive-selection-foreground')}><span className="block truncate">{file.path}</span></button>)}
                </div>
              </>}
            </div>

            <div className="flex min-h-[24rem] flex-col rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="typography-ui-label font-semibold text-foreground">{t('workspace.editor.title')}</h2>
                  {workspace?.selectedFilePath ? <p className="text-xs text-muted-foreground">{workspace.selectedFilePath}</p> : null}
                </div>
                {workspace?.selectedFilePath && workspace.fileVersion !== null ? <span className="text-xs text-muted-foreground">{t('workspace.editor.version', { version: workspace.fileVersion, etag: workspace.fileEtag ?? '-' })}</span> : null}
              </div>
              {workspace?.fileConflict ? <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-2 text-sm text-[var(--status-warning-foreground)]"><span>{t('workspace.editor.conflict')}</span><Button variant="outline" size="xs" onClick={() => void reloadFile(selectedProjectId!)}>{t('workspace.actions.reload')}</Button></div> : null}
              {!workspace?.selectedFilePath ? <p className="text-sm text-muted-foreground">{t('workspace.editor.empty')}</p> : <>
                <Textarea value={workspace.draft} onChange={(event) => setDraft(selectedProjectId!, event.target.value)} disabled={controlsDisabled || workspace.fileLoading} placeholder={t('workspace.editor.placeholder')} aria-label={t('workspace.editor.aria')} fillContainer className="min-h-64 flex-1 font-mono" />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void saveFile(selectedProjectId!)} disabled={controlsDisabled || workspace.fileLoading}><Icon name="save-3" className="size-4" />{t('workspace.actions.save')}</Button>
                  <Button variant="destructive" size="sm" onClick={() => void deleteFile(selectedProjectId!)} disabled={controlsDisabled || workspace.fileLoading}><Icon name="delete-bin" className="size-4" />{t('workspace.actions.delete')}</Button>
                </div>
              </>}
            </div>
          </section>
        </div>

        <section className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3">
          <div className="mb-3"><h2 className="typography-ui-label font-semibold text-foreground">{t('workspace.sessions.title')}</h2><p className="text-sm text-muted-foreground">{t('workspace.sessions.metadataOnly')}</p></div>
          {!selectedProject ? <p className="text-sm text-muted-foreground">{t('workspace.projects.select')}</p> : <>
            <form className="mb-3 flex max-w-md gap-2" onSubmit={submitSession}><Input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} placeholder={t('workspace.sessions.titlePlaceholder')} aria-label={t('workspace.sessions.titleAria')} disabled={controlsDisabled} /><Button size="sm" type="submit" disabled={!sessionTitle.trim() || controlsDisabled}>{t('workspace.sessions.create')}</Button></form>
            {workspace?.sessionsResolved && workspace.sessions.length === 0 ? <p className="text-sm text-muted-foreground">{t('workspace.sessions.empty')}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{workspace?.sessions.map((session) => <SessionMetadataCard key={session.sessionId} title={session.title} disabled={controlsDisabled} onSave={(title) => void updateSession(selectedProjectId!, session.sessionId, title)} />)}</div>
          </>}
        </section>
      </div>
    </div>
  );
};

const SessionMetadataCard: React.FC<{ title: string; disabled: boolean; onSave: (title: string) => void }> = ({ title, disabled, onSave }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(title);
  React.useEffect(() => setDraft(title), [title]);
  return <div className="flex gap-2 rounded-lg border border-border/60 p-2"><Input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t('workspace.sessions.editAria')} disabled={disabled} /><Button variant="outline" size="sm" onClick={() => onSave(draft)} disabled={disabled || !draft.trim()}>{t('workspace.actions.save')}</Button></div>;
};

type RuntimePanelProps = {
  projectActive: boolean;
  sessions: ReadonlyArray<{ sessionId: string; title: string }>;
  selectedSessionId: string | null;
  onSessionChange: (sessionId: string) => void;
  status: ReturnType<typeof useWebV2RuntimeStore.getState>['status'];
  statusResolved: boolean;
  statusLoading: boolean;
  statusFailed: boolean;
  pendingOperation: ReturnType<typeof useWebV2RuntimeStore.getState>['pendingOperation'];
  operationFailed: boolean;
  onRefresh: () => Promise<void>;
  onEnsure: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onDestroy: () => Promise<void>;
  onCheckpoint: (workspaceRevision: number) => Promise<void>;
  onReplace: () => Promise<void>;
};

const runtimeStatusTone = (status: RuntimePanelProps['status']): string => {
  if (status?.status === 'failed') return 'text-[var(--status-error)]';
  if (status?.status === 'unknown') return 'text-[var(--status-warning)]';
  if (status?.status === 'running') return 'text-[var(--status-success)]';
  if (status?.status === 'pending' || status?.status === 'pausing' || status?.status === 'resuming' || status?.status === 'stopping') return 'text-[var(--status-info)]';
  return 'text-muted-foreground';
};

const runtimeOperationLabelKey = (kind: NonNullable<RuntimePanelProps['pendingOperation']>) => {
  switch (kind) {
    case 'ensure': return 'workspace.runtime.operation.ensure';
    case 'pause': return 'workspace.runtime.operation.pause';
    case 'resume': return 'workspace.runtime.operation.resume';
    case 'destroy': return 'workspace.runtime.operation.destroy';
    case 'checkpoint': return 'workspace.runtime.operation.checkpoint';
    case 'replace': return 'workspace.runtime.operation.replace';
  }
};

const runtimeOperationStateLabelKey = (state: 'pending' | 'inProgress') => {
  switch (state) {
    case 'pending': return 'workspace.runtime.operationState.pending';
    case 'inProgress': return 'workspace.runtime.operationState.inProgress';
  }
};

const runtimeCheckpointLabelKey = (state: NonNullable<NonNullable<RuntimePanelProps['status']>['checkpoint']>['state']) => {
  switch (state) {
    case 'requested': return 'workspace.runtime.checkpointState.requested';
    case 'ready': return 'workspace.runtime.checkpointState.ready';
    case 'failed': return 'workspace.runtime.checkpointState.failed';
    case 'outcomeUnknown': return 'workspace.runtime.checkpointState.outcomeUnknown';
  }
};

const RuntimePanel: React.FC<RuntimePanelProps> = ({
  projectActive,
  sessions,
  selectedSessionId,
  onSessionChange,
  status,
  statusResolved,
  statusLoading,
  statusFailed,
  pendingOperation,
  operationFailed,
  onRefresh,
  onEnsure,
  onPause,
  onResume,
  onDestroy,
  onCheckpoint,
  onReplace,
}) => {
  const { t } = useI18n();
  // File revisions are per-file storage versions, not a coherent workspace revision.
  const workspaceRevision = null;
  const panelState = getWebV2RuntimePanelState({
    projectActive,
    sessionId: selectedSessionId,
    status,
    statusResolved,
    statusLoading,
    statusFailed,
    pendingOperation,
    workspaceRevision,
  });
  const activeOperation = status?.activeOperation;

  return (
    <section className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-3" aria-labelledby="workspace-runtime-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="workspace-runtime-title" className="typography-ui-label font-semibold text-foreground">{t('workspace.runtime.title')}</h2>
          <p className={cn('text-sm font-medium', runtimeStatusTone(status))}>{t(panelState.statusLabelKey)}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void onRefresh()} disabled={!projectActive || statusLoading} aria-label={t('workspace.runtime.refreshAria')}>
          <Icon name="refresh" className={cn('size-4', statusLoading && 'animate-spin')} />
        </Button>
      </div>

      {!projectActive ? <p className="mt-2 text-sm text-muted-foreground">{t('workspace.runtime.noProject')}</p> : <>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <span className="typography-meta text-muted-foreground">{t('workspace.runtime.session')}</span>
          <Select value={selectedSessionId ?? ''} onValueChange={onSessionChange} disabled={sessions.length === 0}>
            <SelectTrigger size="sm" className="w-full min-w-0 sm:w-56" aria-label={t('workspace.runtime.selectSessionAria')}>
              <SelectValue placeholder={t('workspace.runtime.noSession')} />
            </SelectTrigger>
            <SelectContent align="end">
              {sessions.map((session) => <SelectItem key={session.sessionId} value={session.sessionId}>{session.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {status ? <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <p className="min-w-0 text-muted-foreground">{t('workspace.runtime.generationRevision', { generation: status.generation, revision: status.lifecycleRevision })}</p>
          <p className="min-w-0 text-muted-foreground">{t('workspace.runtime.activeOperation')}: {activeOperation ? <><span className="text-foreground">{t(runtimeOperationLabelKey(activeOperation.kind))}</span><span aria-hidden="true"> · </span>{t(runtimeOperationStateLabelKey(activeOperation.state))}</> : pendingOperation ? <><span className="text-foreground">{t(runtimeOperationLabelKey(pendingOperation))}</span><span aria-hidden="true"> · </span>{t('workspace.runtime.operationState.pending')}</> : t('workspace.runtime.none')}</p>
          <p className="min-w-0 text-muted-foreground">{t('workspace.runtime.checkpoint')}: {status.checkpoint ? t(runtimeCheckpointLabelKey(status.checkpoint.state)) : t('workspace.runtime.none')}</p>
        </div> : null}

        {!selectedSessionId ? <p className="mt-3 text-sm text-muted-foreground">{t('workspace.runtime.noSession')}</p> : null}
        {panelState.showReadinessNotice ? <p role="status" className="mt-3 rounded-lg border border-[var(--status-info-border)] bg-[var(--status-info-background)] p-2 text-sm text-[var(--status-info-foreground)]">{t('workspace.runtime.readinessDisabled')}</p> : null}
        {panelState.showOutcomeUnknownWarning ? <p role="alert" className="mt-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-2 text-sm text-[var(--status-warning-foreground)]">{t('workspace.runtime.outcomeUnknown')}</p> : null}
        {operationFailed ? <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-2 text-sm text-[var(--status-warning-foreground)]"><span>{t('workspace.runtime.operationFailed')}</span><Button variant="outline" size="xs" onClick={() => void onRefresh()} disabled={statusLoading}>{t('workspace.actions.refresh')}</Button></div> : null}
        {panelState.showRefreshRetry ? <Button variant="outline" size="xs" className="mt-3" onClick={() => void onRefresh()} disabled={statusLoading}>{t('workspace.actions.refresh')}</Button> : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="xs" onClick={() => void onEnsure()} disabled={!panelState.actions.ensure.enabled}>{t('workspace.runtime.action.ensure')}</Button>
          <Button variant="outline" size="xs" onClick={() => void onPause()} disabled={!panelState.actions.pause.enabled}>{t('workspace.runtime.action.pause')}</Button>
          <Button variant="outline" size="xs" onClick={() => void onResume()} disabled={!panelState.actions.resume.enabled}>{t('workspace.runtime.action.resume')}</Button>
          <Button variant="outline" size="xs" onClick={() => { if (workspaceRevision !== null) void onCheckpoint(workspaceRevision); }} disabled={!panelState.actions.checkpoint.enabled}>{t('workspace.runtime.action.checkpoint')}</Button>
          <Button variant="secondary" size="xs" onClick={() => void onReplace()} disabled={!panelState.actions.replace.enabled}>{t('workspace.runtime.action.replace')}</Button>
          <Button variant="destructive" size="xs" onClick={() => void onDestroy()} disabled={!panelState.actions.destroy.enabled}>{t('workspace.runtime.action.destroy')}</Button>
        </div>
      </>}
    </section>
  );
};
