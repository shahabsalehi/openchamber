import React from 'react';
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiChat4Line,
  RiCloseLine,
  RiFileTextLine,
  RiFolderAddLine,
  RiFolder6Line,
  RiGitBranchLine,
  RiNodeTree,
  RiSearchLine,
  RiSettings3Line,
} from '@remixicon/react';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { ChatView } from '@/components/views/ChatView';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { SettingsView } from '@/components/views/SettingsView';
import { toast } from '@/components/ui';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Input } from '@/components/ui/input';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider, useAllLiveSessions } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';
import { SyncAppEffects } from './AppEffects';
import { MobileChangesSurface } from './MobileChangesSurface';
import { MobileFilesSurface } from './MobileFilesSurface';
import { useAppFontEffects } from './useAppFontEffects';

type MobileSurface = 'chat' | 'files' | 'changes' | 'settings';

const MOBILE_SETTINGS_PAGES = [
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'git',
  'magic-prompts',
  'behavior',
  'mcp',
  'providers',
  'usage',
  'voice',
] as const;

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const MOBILE_NAV_ITEMS: Array<{
  surface: MobileSurface;
  labelKey: 'layout.mainTab.chat' | 'layout.mainTab.files' | 'mobile.nav.changes' | 'mobile.nav.settings';
  Icon: typeof RiChat4Line;
}> = [
  { surface: 'chat', labelKey: 'layout.mainTab.chat', Icon: RiChat4Line },
  { surface: 'files', labelKey: 'layout.mainTab.files', Icon: RiFileTextLine },
  { surface: 'changes', labelKey: 'mobile.nav.changes', Icon: RiGitBranchLine },
  { surface: 'settings', labelKey: 'mobile.nav.settings', Icon: RiSettings3Line },
];

const normalizePath = (value?: string | null): string => {
  return (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');
};

const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & { directory?: string | null; project?: { worktree?: string | null } | null };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const getProjectLabel = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
};

const formatSessionTime = (session: Session): string => {
  const raw = session.time?.updated ?? session.time?.created;
  const timestamp = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
};

const getWorktreeLabel = (worktree: WorktreeMetadata | null, directory: string): string => {
  if (!worktree) return getProjectLabel(directory);
  return worktree.branch || getProjectLabel(worktree.path);
};

const getWorktreeKey = (directory: string): string => normalizePath(directory) || '__root__';

const pathBelongsToRoot = (path: string, root: string): boolean => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return Boolean(normalizedPath && normalizedRoot && (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)));
};

const MobileProjectIcon: React.FC<{
  project: {
    id: string;
    icon?: string | null;
    color?: string | null;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
    iconBackground?: string | null;
  };
}> = ({ project }) => {
  const { currentTheme } = useThemeSystem();
  const [imageFailed, setImageFailed] = React.useState(false);
  React.useEffect(() => setImageFailed(false), [project.id, project.iconImage?.updatedAt]);
  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? (PROJECT_COLOR_MAP[project.color] ?? null) : null;
  const imageUrl = !imageFailed
    ? getProjectIconImageUrl({ id: project.id, iconImage: project.iconImage ?? undefined }, {
      themeVariant: currentTheme.metadata.variant,
      iconColor: currentTheme.colors.surface.foreground,
    })
    : null;

  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-muted)] text-muted-foreground" style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}>
      {imageUrl ? (
        <img src={imageUrl} alt="" className="size-full object-contain" draggable={false} onError={() => setImageFailed(true)} />
      ) : ProjectIcon ? (
        <ProjectIcon className="size-4" style={iconColor ? { color: iconColor } : undefined} />
      ) : (
        <RiFolder6Line className="size-4" style={iconColor ? { color: iconColor } : undefined} />
      )}
    </span>
  );
};

const MobileSessionsSheet: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const sessions = useAllLiveSessions();
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const [query, setQuery] = React.useState('');
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());
  const [collapsedWorktrees, setCollapsedWorktrees] = React.useState<Set<string>>(new Set());
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreesByProject, setWorktreesByProject] = React.useState<Map<string, WorktreeMetadata[]>>(new Map());
  const [archivingSessionId, setArchivingSessionId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  React.useEffect(() => {
    if (!open || projects.length === 0) return;
    let cancelled = false;
    const run = async () => {
      const entries = await Promise.all(projects.map(async (project) => {
        const path = normalizePath(project.path);
        if (!path) return null;
        const worktrees = await listProjectWorktrees({ id: project.id, path }).catch(() => []);
        return [path, worktrees] as const;
      }));
      if (cancelled) return;
      const next = new Map<string, WorktreeMetadata[]>();
      for (const entry of entries) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setWorktreesByProject(next);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open, projects]);

  const filteredSessions = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...sessions, ...archivedSessions]
      .filter((session) => {
        if (!normalizedQuery) return true;
        const haystack = `${session.title ?? ''} ${session.id} ${getSessionDirectory(session)}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((a, b) => {
        const aTime = Number(a.time?.updated ?? a.time?.created ?? 0);
        const bTime = Number(b.time?.updated ?? b.time?.created ?? 0);
        return bTime - aTime;
      });
  }, [archivedSessions, query, sessions]);

  const groupedProjects = React.useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const knownProjects = projects.map((project) => ({
      id: project.id,
      label: project.label?.trim() || getProjectLabel(project.path),
      path: normalizePath(project.path),
      sessions: [] as Session[],
      worktrees: worktreesByProject.get(normalizePath(project.path)) ?? [],
      icon: project.icon,
      color: project.color,
      iconImage: project.iconImage,
      iconBackground: project.iconBackground,
    }));
    for (const session of filteredSessions) {
      const directory = getSessionDirectory(session);
      const project = knownProjects.find((entry) => {
        if (pathBelongsToRoot(directory, entry.path)) return true;
        return entry.worktrees.some((worktree) => pathBelongsToRoot(directory, worktree.path));
      });
      project?.sessions.push(session);
    }

    const visibleKnownProjects = knownProjects.filter((project) => {
      if (!normalizedQuery) return true;
      if (project.sessions.length > 0) return true;
      return `${project.label} ${project.path}`.toLowerCase().includes(normalizedQuery);
    });

    return visibleKnownProjects;
  }, [filteredSessions, projects, query, worktreesByProject]);

  const groupedSessionBuckets = React.useCallback((project: { path: string; sessions: Session[]; worktrees: WorktreeMetadata[] }) => {
    const buckets = new Map<string, { key: string; label: string; directory: string; worktree: WorktreeMetadata | null; sessions: Session[] }>();
    const ensureBucket = (directory: string, worktree: WorktreeMetadata | null) => {
      const normalized = normalizePath(directory);
      const key = getWorktreeKey(normalized);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, label: getWorktreeLabel(worktree, normalized), directory: normalized, worktree, sessions: [] };
        buckets.set(key, bucket);
      }
      return bucket;
    };

    if (project.path) ensureBucket(project.path, null);
    for (const worktree of project.worktrees) ensureBucket(worktree.path, worktree);
    for (const session of project.sessions) {
      const directory = getSessionDirectory(session) || project.path;
      const worktree = project.worktrees.find((entry) => pathBelongsToRoot(directory, entry.path)) ?? null;
      ensureBucket(worktree?.path ?? directory, worktree).sessions.push(session);
    }
    return Array.from(buckets.values()).filter((bucket) => bucket.sessions.length > 0 || bucket.worktree || bucket.directory === project.path);
  }, []);

  if (!open) {
    return null;
  }

  const handleSelectSession = (session: Session) => {
    void setCurrentSession(session.id, getSessionDirectory(session) || null);
    onOpenChange(false);
  };

  const handleSelectProject = (project: { id: string; path: string }) => {
    if (project.id === '__unassigned__') return;
    setActiveProject(project.id);
    onOpenChange(false);
  };

  const handleNewSession = (project: { id: string; path: string }) => {
    openNewSessionDraft({
      selectedProjectId: project.id === '__unassigned__' ? null : project.id,
      directoryOverride: project.path || null,
      preserveDirectoryOverride: Boolean(project.path),
    });
    onOpenChange(false);
  };

  const handleNewWorktree = (project: { id: string }) => {
    if (project.id === '__unassigned__') return;
    setActiveProjectIdOnly(project.id);
    setNewWorktreeDialogOpen(true);
  };

  const handleArchiveSession = async (session: Session) => {
    setArchivingSessionId(session.id);
    try {
      const ok = await archiveSession(session.id);
      if (ok) toast.success(t('sessions.sidebar.session.archive.success'));
      else toast.error(t('sessions.sidebar.session.archive.error'));
    } finally {
      setArchivingSessionId(null);
    }
  };

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleWorktree = (key: string) => {
    setCollapsedWorktrees((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-[rgb(0_0_0_/_0.45)]" role="dialog" aria-modal="true" aria-label={t('mobile.sessions.sheet.title')}>
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        aria-label={t('mobile.sessions.closeSheetAria')}
        onClick={() => onOpenChange(false)}
      />
      <section className="relative flex h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-border/60 bg-background text-foreground shadow-xl">
        <div className="flex shrink-0 flex-col gap-3 border-b border-border/50 px-4 pb-3 pt-2">
          <div className="mx-auto h-1 w-10 rounded-full bg-[var(--surface-muted)]" aria-hidden />
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="typography-title text-foreground">{t('mobile.sessions.sheet.title')}</h2>
              <p className="typography-meta text-muted-foreground">{t('mobile.sessions.sheet.description')}</p>
            </div>
            <button
              type="button"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('mobile.sessions.closeSheetAria')}
              onClick={() => onOpenChange(false)}
            >
              <RiCloseLine className="size-5" />
            </button>
          </div>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 bg-[var(--surface-elevated)] px-3 py-2 typography-ui-label text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => setDirectoryDialogOpen(true)}
          >
            <RiFolderAddLine className="size-4" />
            {t('sessions.sidebar.header.actions.addProject')}
          </button>
          <div className="relative">
            <RiSearchLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('mobile.sessions.search.placeholder')}
              className="pl-9"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {groupedProjects.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="typography-body text-muted-foreground">{t('mobile.sessions.empty')}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)]">
              {groupedProjects.map((project, projectIndex) => {
                const activeProject = project.id === activeProjectId;
                const projectCollapsed = collapsedProjects.has(project.id);
                const buckets = groupedSessionBuckets(project);
                return (
                  <section key={project.id} className={cn(projectIndex > 0 && 'border-t border-border/50')}>
                    <div className={cn('flex items-center gap-2 px-3 py-2', activeProject && 'bg-interactive-selection text-interactive-selection-foreground')}>
                      <button
                        type="button"
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={projectCollapsed
                          ? t('sessions.sidebar.group.expandAria', { label: project.label })
                          : t('sessions.sidebar.group.collapseAria', { label: project.label })}
                        onClick={() => toggleProject(project.id)}
                      >
                        {projectCollapsed ? <RiArrowRightSLine className="size-4" /> : <RiArrowDownSLine className="size-4" />}
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => handleSelectProject(project)}
                      >
                        <MobileProjectIcon project={project} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate typography-ui-label text-foreground">{project.label}</span>
                          <span className="block truncate typography-micro text-muted-foreground">
                            {project.sessions.length === 1
                              ? t('mobile.sessions.project.sessionsSingle')
                              : t('mobile.sessions.project.sessionsPlural', { count: project.sessions.length })}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        aria-label={t('mobile.sessions.newSessionAria')}
                        onClick={() => handleNewSession(project)}
                      >
                        <RiAddLine className="size-5" />
                      </button>
                      {project.id !== '__unassigned__' ? (
                        <button
                          type="button"
                          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          aria-label={t('sessions.sidebar.project.actions.newWorktree')}
                          onClick={() => handleNewWorktree(project)}
                        >
                          <RiNodeTree className="size-4" />
                        </button>
                      ) : null}
                    </div>
                    {!projectCollapsed ? (
                      <div className="border-t border-border/40 bg-background/40">
                        {buckets.map((bucket, bucketIndex) => {
                          const worktreeCollapsed = collapsedWorktrees.has(bucket.key);
                          return (
                            <div key={bucket.key} className={cn(bucketIndex > 0 && 'border-t border-border/40')}>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                onClick={() => toggleWorktree(bucket.key)}
                              >
                                {worktreeCollapsed ? <RiArrowRightSLine className="size-3.5" /> : <RiArrowDownSLine className="size-3.5" />}
                                <RiNodeTree className="size-3.5" />
                                <span className="min-w-0 flex-1 truncate typography-micro">{bucket.label}</span>
                                <span className="typography-micro">{bucket.sessions.length}</span>
                              </button>
                              {!worktreeCollapsed ? bucket.sessions.map((session, index) => {
                          const active = currentSessionId === session.id;
                          return (
                            <button
                              key={session.id}
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-3 px-3 py-2.5 pl-12 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                index > 0 && 'border-t border-border/50',
                                active ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
                              )}
                              onClick={() => handleSelectSession(session)}
                            >
                              <RiChat4Line className="size-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate typography-ui-label text-foreground">{session.title || t('mobile.sessions.untitled')}</span>
                                <span className="block truncate typography-micro text-muted-foreground">{formatSessionTime(session) || session.id}</span>
                              </span>
                              {!session.time?.archived ? (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                                  aria-label={t('sessions.sidebar.bulkActions.archive')}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void handleArchiveSession(session);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key !== 'Enter' && event.key !== ' ') return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    void handleArchiveSession(session);
                                  }}
                                >
                                  <RiArchiveLine className={cn('size-4', archivingSessionId === session.id && 'animate-pulse')} />
                                </span>
                              ) : null}
                            </button>
                          );
                              }) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </div>
        <DirectoryExplorerDialog open={directoryDialogOpen} onOpenChange={setDirectoryDialogOpen} />
        <NewWorktreeDialog
          open={newWorktreeDialogOpen}
          onOpenChange={setNewWorktreeDialogOpen}
          onWorktreeCreated={(worktreePath, options) => {
            if (options?.sessionId) void setCurrentSession(options.sessionId, worktreePath);
            else openNewSessionDraft({ directoryOverride: worktreePath });
            onOpenChange(false);
          }}
        />
      </section>
    </div>
  );
};

const MobileHeader: React.FC<{ onOpenSessions: () => void }> = ({ onOpenSessions }) => {
  const { t } = useI18n();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useAllLiveSessions();
  const projects = useProjectsStore((state) => state.projects);

  const currentSession = React.useMemo(
    () => sessions.find((session) => session.id === currentSessionId) ?? null,
    [currentSessionId, sessions],
  );
  const projectLabel = React.useMemo(() => {
    const directory = normalizePath(currentDirectory);
    if (!directory) return t('mobile.header.noProject');
    const project = projects.find((entry) => {
      const projectPath = normalizePath(entry.path);
      return directory === projectPath || directory.startsWith(`${projectPath}/`);
    });
    return project?.label?.trim() || getProjectLabel(project?.path || directory);
  }, [currentDirectory, projects, t]);

  const sessionLabel = currentSession?.title?.trim() || (currentSessionId ? t('mobile.sessions.untitled') : t('mobile.header.noSession'));

  return (
    <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/50 bg-background px-3 text-foreground">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={t('mobile.sessions.openSheetAria')}
        onClick={onOpenSessions}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-elevated)] text-muted-foreground">
          <RiFolder6Line className="size-4" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate typography-ui-label text-foreground">{sessionLabel}</span>
          <span className="truncate typography-micro text-muted-foreground">{projectLabel}</span>
        </span>
      </button>
    </header>
  );
};

const MobileBottomNav: React.FC<{
  activeSurface: MobileSurface;
  onSurfaceChange: (surface: MobileSurface) => void;
}> = ({ activeSurface, onSurfaceChange }) => {
  const { t } = useI18n();

  return (
    <nav className="grid shrink-0 grid-cols-4 border-t border-border/50 bg-background pb-[var(--oc-safe-area-bottom,0px)]" aria-label={t('mobile.nav.aria')}>
      {MOBILE_NAV_ITEMS.map(({ surface, labelKey, Icon }) => {
        const active = activeSurface === surface;
        return (
          <button
            key={surface}
            type="button"
            className={cn(
              'flex min-h-14 flex-col items-center justify-center gap-1 px-2 typography-micro transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              active
                ? 'bg-interactive-selection text-interactive-selection-foreground'
                : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
            )}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSurfaceChange(surface)}
          >
            <Icon className="size-5" />
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
};

const MobileShell: React.FC = () => {
  const [activeSurface, setActiveSurface] = React.useState<MobileSurface>('chat');
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);

  return (
    <div className="main-content-safe-area flex h-[100dvh] flex-col bg-background text-foreground" data-page-scroll-lock="true">
      {activeSurface === 'chat' ? <MobileHeader onOpenSessions={() => setSessionsSheetOpen(true)} /> : null}
      <main className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
        <div className={cn('absolute inset-0', activeSurface !== 'chat' && 'invisible')}>
          <ErrorBoundary>
            <ChatView />
          </ErrorBoundary>
        </div>
        {activeSurface === 'files' ? (
          <ErrorBoundary>
            <MobileFilesSurface />
          </ErrorBoundary>
        ) : null}
        {activeSurface === 'changes' ? (
          <ErrorBoundary>
            <MobileChangesSurface />
          </ErrorBoundary>
        ) : null}
        {activeSurface === 'settings' ? (
          <ErrorBoundary>
            <SettingsView forceMobile isWindowed visiblePageSlugs={[...MOBILE_SETTINGS_PAGES]} />
          </ErrorBoundary>
        ) : null}
      </main>
      <MobileBottomNav activeSurface={activeSurface} onSurfaceChange={setActiveSurface} />
      <MobileSessionsSheet open={sessionsSheetOpen} onOpenChange={setSessionsSheetOpen} />
    </div>
  );
};

export function MobileApp({ apis }: MobileAppProps) {
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    void initializeApp();
  }, [initializeApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders();
    if (agentsCount === 0) void loadAgents();
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await fetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | { planModeExperimentalEnabled?: unknown };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      setPlanModeEnabled(raw === true || raw === 1 || raw === '1' || raw === 'true');
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRouter();

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full bg-background text-foreground">
              <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized} />
              <MobileShell />
              <Toaster />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
