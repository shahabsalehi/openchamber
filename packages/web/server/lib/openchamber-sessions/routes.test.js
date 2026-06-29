import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorktreeMock = vi.fn(async () => ({
  head: 'abc123',
  name: 'side-task',
  branch: 'openchamber/side-task',
  path: '/repo/worktrees/side-task',
}));
globalThis.__openchamberCreateWorktreeMock = createWorktreeMock;

let registerOpenChamberSessionRoutes;

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: () => ({
    session: {
      create: vi.fn(async () => ({ data: { id: 'ses_123' } })),
      command: vi.fn(async () => ({ data: {} })),
    },
    command: {
      list: vi.fn(async () => ({ data: [] })),
    },
  }),
}));

vi.mock('../git/index.js', () => ({
  createWorktree: (...args) => globalThis.__openchamberCreateWorktreeMock(...args),
}));

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const calls = [];
  registerOpenChamberSessionRoutes(app, {
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'proj_1', path: '/repo/app' }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
    waitForOpenCodeReady: vi.fn(async () => undefined),
    ...overrides,
  });
  return { app, calls };
};

describe('openchamber session routes', () => {
  beforeAll(async () => {
    ({ registerOpenChamberSessionRoutes } = await import('./routes.js'));
  });

  beforeEach(() => {
    createWorktreeMock.mockClear();
  });

  it('creates a session for a directory', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(response.body.sessionId).toBeTruthy();
      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.directory).toBe('/repo/app');
      expect(response.body.promptDispatched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits a session-created event after creating a session', async () => {
    const originalFetch = globalThis.fetch;
    const emitSessionCreatedEvent = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    try {
      const { app } = createApp({ emitSessionCreatedEvent });
      await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', title: 'Side task' })
        .expect(200);

      expect(emitSessionCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({
        sessionID: 'ses_123',
        directory: '/repo/app',
        title: 'Side task',
        promptDispatched: false,
        dispatchedAsCommand: false,
      }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires a model when prompt is provided', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/openchamber/sessions')
      .send({ directory: '/repo/app', prompt: 'Run this' })
      .expect(400);

    expect(response.body.error).toBe('model is required when prompt is provided');
  });

  it('dispatches an initial prompt when model is provided', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => '' }));
    globalThis.fetch = fetchMock;
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({ directory: '/repo/app', prompt: 'Run this', model: 'anthropic/claude-sonnet-4' })
        .expect(200);

      expect(response.body.sessionId).toBe('ses_123');
      expect(response.body.promptDispatched).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fapp',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates a worktree before creating a session', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => '' }));
    try {
      const { app } = createApp();
      const response = await request(app)
        .post('/api/openchamber/sessions')
        .send({
          directory: '/repo/app',
          worktree: { name: 'side-task', branchName: 'openchamber/side-task', startRef: 'main' },
          setUpstream: false,
          prompt: 'Run this',
          model: 'anthropic/claude-sonnet-4',
        })
        .expect(200);

      expect(createWorktreeMock).toHaveBeenCalledWith('/repo/app', {
        mode: 'new',
        name: 'side-task',
        branchName: 'openchamber/side-task',
        startRef: 'main',
        setUpstream: false,
      });
      expect(response.body.directory).toBe('/repo/worktrees/side-task');
      expect(response.body.worktree.path).toBe('/repo/worktrees/side-task');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://opencode.test/session/ses_123/prompt_async?directory=%2Frepo%2Fworktrees%2Fside-task',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
