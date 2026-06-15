/**
 * Reproduction test for issue #1662
 * "Web UI: switching agents doesn't update provider/model display"
 *
 * This test verifies that setAgent() correctly propagates the agent's
 * configured model (agent.model) to currentProviderId/currentModelId.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

const DIRECTORY = '/workspace/project';
const STORAGE_KEY = 'config-store';

let storage = new Map<string, string>();

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size; },
}) as Storage;

mock.module('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => makeStorage(),
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => DIRECTORY),
    checkHealth: mock(async () => true),
    withDirectory: mock(async (directory: string | null, callback: () => Promise<unknown>) => callback()),
    getProviders: mock(async () => ({ providers: [], default: {} })),
    listAgents: mock(async () => []),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify({}), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async () => undefined),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) =>
    event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock(() => () => {}),
}));

mock.module('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionAgentSelection: mock(() => {}),
      getAgentModelForSession: mock(() => null),
      getAgentModelVariantForSession: mock(() => undefined),
      saveSessionModelSelection: mock(() => {}),
      saveAgentModelForSession: mock(() => {}),
    }),
    setState: mock(() => {}),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: null,
      isOpenChamberCreatedSession: mock(() => false),
      initializeNewOpenChamberSession: mock(() => {}),
    }),
    setState: mock(() => {}),
  },
}));

// Helper: create a provider with an array of models (store format)
const provider = (id: string, modelId = `${id}-model`) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: [
    {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true, reasoning: false, attachment: false, toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
    },
  ],
});

describe('Issue #1662: setAgent model propagation', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
  });

  test('setAgent propagates agent.model to currentProviderId/currentModelId', async () => {
    const { useConfigStore } = await import('./packages/ui/src/stores/useConfigStore');

    // Setup: two providers, two agents with different configured models
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [provider('openai', 'gpt-4o'), provider('anthropic', 'claude-3.5-sonnet')],
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      currentAgentName: undefined,
      selectedProviderId: '',
      isConnected: true,
      isInitialized: false,
      agents: [
        { name: 'AgentA', mode: 'primary' as const, model: { providerID: 'openai', modelID: 'gpt-4o' } },
        { name: 'AgentB', mode: 'primary' as const, model: { providerID: 'anthropic', modelID: 'claude-3.5-sonnet' } },
      ],
    });

    // Select AgentA
    useConfigStore.getState().setAgent('AgentA');
    let state = useConfigStore.getState();

    expect(state.currentAgentName).toBe('AgentA');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-4o');

    // Switch to AgentB — the bug would show stale provider/model here
    useConfigStore.getState().setAgent('AgentB');
    state = useConfigStore.getState();

    expect(state.currentAgentName).toBe('AgentB');
    // If the bug were present, currentProviderId would still be 'openai':
    expect(state.currentProviderId).toBe('anthropic');
    expect(state.currentModelId).toBe('claude-3.5-sonnet');
  });

  test('setAgent preserves current model when switching to an agent without model', async () => {
    const { useConfigStore } = await import('./packages/ui/src/stores/useConfigStore');

    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [provider('openai', 'gpt-4o')],
      defaultProviders: {},
      currentProviderId: 'openai',
      currentModelId: 'gpt-4o',
      currentVariant: undefined,
      currentAgentName: undefined,
      selectedProviderId: 'openai',
      isConnected: true,
      isInitialized: false,
      agents: [
        { name: 'AgentA', mode: 'primary' as const, model: { providerID: 'openai', modelID: 'gpt-4o' } },
        { name: 'AgentB', mode: 'primary' as const }, // No model configured
      ],
    });

    // Switch to AgentA (has model), then to AgentB (no model)
    useConfigStore.getState().setAgent('AgentA');
    useConfigStore.getState().setAgent('AgentB');

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('AgentB');
    // Preserves previous valid selection when target agent has no model config
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-4o');
  });

  test('setAgent falls back when agent model references unknown provider', async () => {
    const { useConfigStore } = await import('./packages/ui/src/stores/useConfigStore');

    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [provider('openai', 'gpt-4o')],
      defaultProviders: {},
      currentProviderId: 'openai',
      currentModelId: 'gpt-4o',
      currentVariant: undefined,
      currentAgentName: undefined,
      selectedProviderId: 'openai',
      isConnected: true,
      isInitialized: false,
      agents: [
        { name: 'AgentC', mode: 'primary' as const, model: { providerID: 'unknown-provider', modelID: 'unknown-model' } },
      ],
    });

    useConfigStore.getState().setAgent('AgentC');

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('AgentC');
    // Falls through: agent's model references unknown provider, keeps previous
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-4o');
  });
});
