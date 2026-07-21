import { describe, expect, it, mock } from 'bun:test';

import { createSandboxLifecycleCoordinator } from './coordinator.js';
import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';

const FUTURE_EXPIRY = '2099-01-01T00:00:00.000Z';
const CREATE_INPUT = Object.freeze({
  imageUri: 'sandbox:test',
  entrypoint: ['sleep', '3600'],
  resourceLimits: { cpu: '1', memory: '1Gi' },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const supervision = (providerHandle, generation, commandId = 'command-0001') => ({
  commandId,
  providerHandle,
  generation,
  port: 13009,
  username: 'opencode',
});

const claim = ({
  operationId,
  kind,
  effect,
  generation,
  lifecycleRevision,
  providerHandle = 'sandbox-handle-0001',
  currentSupervision = null,
  workspaceRevision = null,
  leaseId = 'lease-runtime-0001',
}) => ({
  operationId,
  kind,
  effect,
  sessionId: 'session-runtime-0001',
  leaseId,
  generation,
  lifecycleRevision,
  workspaceRevision,
  claimFence: lifecycleRevision,
  attempt: 1,
  provider: effect === 'start'
    ? null
    : { providerId: 'fake-provider', providerHandle },
  supervision: currentSupervision,
});

const operation = (value) => ({
  operationId: value.operationId,
  expectedGeneration: value.generation,
  expectedRevision: value.lifecycleRevision,
  effect: value.effect,
});

const createAuthority = (claims, overrides = {}) => {
  const byId = new Map(claims.map((item) => [item.operationId, item]));
  const completions = [];
  return {
    completions,
    claimSandboxRuntimeOperation: mock(async ({ operationId }) => {
      const value = byId.get(operationId);
      if (!value) return { ok: false, error: { code: 'NOT_FOUND' } };
      return value;
    }),
    beginSandboxRuntimeEffect: mock(async ({ operationId }) => byId.get(operationId)),
    completeSandboxRuntimeOperation: mock(async (payload) => {
      completions.push(payload);
      return {
        operationId: payload.operationId,
        accepted: true,
        orphanCleanupRecorded: payload.provider?.status === 'unknown',
        runtime: { status: payload.outcome === 'succeeded' ? 'running' : payload.outcome },
      };
    }),
    ...overrides,
  };
};

const createRuntime = (overrides = {}) => {
  const leases = [];
  const runtime = {
    leases,
    create: mock(async () => {
      const record = {
        providerId: 'fake-provider',
        handle: 'sandbox-handle-0001',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: FUTURE_EXPIRY,
        cleanupPending: false,
      };
      leases.push(record);
      return record;
    }),
    list: mock(() => [...leases]),
    destroy: mock(async (handle) => {
      const index = leases.findIndex((entry) => entry.handle === handle);
      if (index < 0) throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
      leases.splice(index, 1);
      return { handle, destroyed: true };
    }),
    ...overrides,
  };
  return runtime;
};

const createBridge = (events = [], overrides = {}) => ({
  hydrate: mock(async (input) => {
    events.push(`hydrate:${input.operationId}`);
    return {
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      fileCount: input.snapshot.files.length,
      totalBytes: 5,
    };
  }),
  pause: mock(async (input) => {
    events.push(`pause:${input.operationId}`);
    return { status: 'paused' };
  }),
  resume: mock(async (input) => {
    events.push(`resume:${input.operationId}`);
    return { status: 'running', expiresAt: FUTURE_EXPIRY };
  }),
  destroy: mock(async (input) => {
    events.push(`bridge-destroy:${input.operationId}`);
    return { destroyed: true };
  }),
  checkpoint: mock(async (input) => {
    events.push(`capture:${input.operationId}`);
    return {
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      baseRevision: 'workspace-6',
      files: [{ path: 'README.md', content: 'hello', size: 5 }],
      fileCount: 1,
      totalBytes: 5,
    };
  }),
  openCodeStart: mock(async (input) => {
    events.push(`opencode-start:${input.operationId}`);
    return {
      supervision: supervision(
        input.providerHandle,
        input.generation,
        `command-${input.operationId}`,
      ),
    };
  }),
  openCodeStop: mock(async (input) => {
    events.push(`opencode-stop:${input.operationId}`);
    return { stopped: true };
  }),
  ...overrides,
});

const createSnapshotSource = (events = [], overrides = {}) => ({
  read: mock(async ({ operationId }) => {
    events.push(`snapshot:${operationId}`);
    return {
      complete: true,
      revision: 6,
      files: [{ path: 'README.md', content: 'hello' }],
    };
  }),
  ...overrides,
});

const createPublisher = (events = [], overrides = {}) => ({
  publish: mock(async ({ operationId, expectedWorkspaceRevision }) => {
    events.push(`publish:${operationId}`);
    return {
      operationId,
      workspaceRevision: expectedWorkspaceRevision,
      published: true,
    };
  }),
  ...overrides,
});

const createCoordinator = ({
  claims,
  authority = createAuthority(claims),
  runtime = createRuntime(),
  bridge = createBridge(),
  snapshotSource = createSnapshotSource(),
  checkpointPublisher = createPublisher(),
  diagnostics = null,
  maxConcurrent = 2,
  maxQueued = 4,
  operationDeadlineMs = 1_000,
  completionTimeoutMs = 100,
} = {}) => ({
  coordinator: createSandboxLifecycleCoordinator({
    authority,
    runtime,
    bridge,
    snapshotSource,
    checkpointPublisher,
    createInput: CREATE_INPUT,
    maxConcurrent,
    maxQueued,
    operationDeadlineMs,
    completionTimeoutMs,
    diagnostics,
  }),
  authority,
  runtime,
  bridge,
  snapshotSource,
  checkpointPublisher,
});

describe('sandbox lifecycle coordinator', () => {
  it('runs the complete start, checkpoint, pause, resume, and destroy fake flow', async () => {
    const events = [];
    const providerHandle = 'sandbox-handle-0001';
    const startedSupervision = supervision(
      providerHandle,
      1,
      'command-runtime-flow-start-0001',
    );
    const resumedSupervision = supervision(
      providerHandle,
      1,
      'command-runtime-flow-resume-0001',
    );
    const claims = [
      claim({
        operationId: 'runtime-flow-start-0001',
        kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
      }),
      claim({
        operationId: 'runtime-flow-checkpoint-0001',
        kind: 'checkpoint', effect: 'checkpoint', generation: 1, lifecycleRevision: 2,
        workspaceRevision: 7, currentSupervision: startedSupervision,
      }),
      claim({
        operationId: 'runtime-flow-pause-0001',
        kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 3,
        currentSupervision: startedSupervision,
      }),
      claim({
        operationId: 'runtime-flow-resume-0001',
        kind: 'resume', effect: 'resume', generation: 1, lifecycleRevision: 4,
      }),
      claim({
        operationId: 'runtime-flow-destroy-0001',
        kind: 'destroy', effect: 'destroy', generation: 1, lifecycleRevision: 5,
        currentSupervision: resumedSupervision,
      }),
    ];
    const authority = createAuthority(claims, {
      completeSandboxRuntimeOperation: mock(async (payload) => {
        events.push(`complete:${payload.operationId}`);
        return {
          operationId: payload.operationId,
          accepted: true,
          orphanCleanupRecorded: false,
          runtime: { status: payload.outcome },
        };
      }),
    });
    const runtime = createRuntime();
    const bridge = createBridge(events, {
      openCodeStart: mock(async (input) => {
        events.push(`opencode-start:${input.operationId}`);
        return {
          supervision: input.operationId === 'runtime-flow-start-0001'
            ? startedSupervision
            : resumedSupervision,
        };
      }),
    });
    const setup = createCoordinator({
      claims,
      authority,
      runtime,
      bridge,
      snapshotSource: createSnapshotSource(events),
      checkpointPublisher: createPublisher(events),
    });

    for (const item of claims) {
      await expect(setup.coordinator.dispatch(operation(item))).resolves.toMatchObject({
        accepted: true,
        outcome: 'succeeded',
      });
    }

    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(bridge.hydrate).toHaveBeenCalledTimes(1);
    expect(bridge.checkpoint).toHaveBeenCalledTimes(1);
    expect(setup.checkpointPublisher.publish).toHaveBeenCalledTimes(1);
    expect(bridge.pause).toHaveBeenCalledTimes(1);
    expect(bridge.resume).toHaveBeenCalledTimes(1);
    expect(bridge.openCodeStart).toHaveBeenCalledTimes(2);
    expect(bridge.openCodeStop).toHaveBeenCalledTimes(2);
    expect(runtime.destroy).toHaveBeenCalledWith(providerHandle);
    expect(bridge.destroy).not.toHaveBeenCalled();
    expect(events.indexOf('snapshot:runtime-flow-start-0001'))
      .toBeLessThan(events.indexOf('hydrate:runtime-flow-start-0001'));
    expect(events.indexOf('capture:runtime-flow-checkpoint-0001'))
      .toBeLessThan(events.indexOf('publish:runtime-flow-checkpoint-0001'));
    expect(events.indexOf('publish:runtime-flow-checkpoint-0001'))
      .toBeLessThan(events.indexOf('complete:runtime-flow-checkpoint-0001'));
    expect(events.filter((event) => event.startsWith('capture:'))).toHaveLength(1);
  });

  it('bounds and validates authoritative snapshots before begin or create', async () => {
    const oneMiBUtf8 = 'é'.repeat(512 * 1024);
    const cases = [
      {
        label: 'file count',
        snapshot: {
          complete: true,
          revision: 1,
          files: Array.from({ length: 8193 }, (_value, index) => ({
            path: `file-${index}.txt`,
            content: '',
          })),
        },
      },
      {
        label: 'per-file UTF-8 bytes',
        snapshot: {
          complete: true,
          revision: 1,
          files: [{ path: 'large.txt', content: `${oneMiBUtf8}é` }],
        },
      },
      {
        label: 'aggregate UTF-8 bytes',
        snapshot: {
          complete: true,
          revision: 1,
          files: Array.from({ length: 65 }, (_value, index) => ({
            path: `large-${index}.txt`,
            content: oneMiBUtf8,
          })),
        },
      },
      {
        label: 'revision',
        snapshot: { complete: true, revision: {}, files: [] },
      },
      {
        label: 'snapshot keys',
        snapshot: { complete: true, revision: 1, files: [], secret: 'not-allowed' },
      },
      {
        label: 'entry shape',
        snapshot: {
          complete: true,
          revision: 1,
          files: [{ path: 'file.txt', content: 'safe', extra: true }],
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const item = claim({
        operationId: `runtime-snapshot-limit-${String(index).padStart(4, '0')}`,
        kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
      });
      const authority = createAuthority([item]);
      const runtime = createRuntime();
      const bridge = createBridge();
      const snapshotSource = {
        read: mock(async () => testCase.snapshot),
      };
      const setup = createCoordinator({
        claims: [item], authority, runtime, bridge, snapshotSource,
      });

      await expect(setup.coordinator.dispatch(operation(item)), testCase.label).resolves.toMatchObject({
        accepted: false,
        outcome: 'ignored',
        code: SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED,
      });
      expect(authority.beginSandboxRuntimeEffect, testCase.label).not.toHaveBeenCalled();
      expect(runtime.create, testCase.label).not.toHaveBeenCalled();
      expect(bridge.hydrate, testCase.label).not.toHaveBeenCalled();
    }
  });

  it('coalesces queued and running duplicates and creates exactly once', async () => {
    const item = claim({
      operationId: 'runtime-duplicate-start-0001',
      kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
    });
    const creation = deferred();
    const runtime = createRuntime({
      create: mock(async () => creation.promise),
      destroy: mock(async (handle) => ({ handle, destroyed: true })),
    });
    const setup = createCoordinator({ claims: [item], runtime });

    const first = setup.coordinator.dispatch(operation(item));
    const duplicate = setup.coordinator.dispatch(operation(item));
    expect(duplicate).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.create).toHaveBeenCalledTimes(1);

    creation.resolve({
      providerId: 'fake-provider',
      handle: 'sandbox-handle-0001',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: FUTURE_EXPIRY,
      cleanupPending: false,
    });
    await expect(first).resolves.toMatchObject({ accepted: true, outcome: 'succeeded' });
    expect(runtime.create).toHaveBeenCalledTimes(1);
    expect(setup.bridge.openCodeStart).toHaveBeenCalledTimes(1);
  });

  it('never retries ambiguous create and permits only an explicit replacement operation', async () => {
    const first = claim({
      operationId: 'runtime-ambiguous-create-0001',
      kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
    });
    const replacement = claim({
      operationId: 'runtime-explicit-replace-0001',
      kind: 'replace', effect: 'start', generation: 2, lifecycleRevision: 2,
      leaseId: 'lease-runtime-0002',
    });
    let createCount = 0;
    const runtime = createRuntime({
      create: mock(async () => {
        createCount += 1;
        if (createCount === 1) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
        }
        return {
          providerId: 'fake-provider',
          handle: 'replacement-handle-0001',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: FUTURE_EXPIRY,
          cleanupPending: false,
        };
      }),
    });
    const setup = createCoordinator({ claims: [first, replacement], runtime });

    await expect(setup.coordinator.dispatch(operation(first))).resolves.toMatchObject({
      accepted: true,
      outcome: 'outcomeUnknown',
    });
    expect(runtime.create).toHaveBeenCalledTimes(1);
    await expect(setup.coordinator.dispatch(operation(replacement))).resolves.toMatchObject({
      accepted: true,
      outcome: 'succeeded',
    });
    expect(runtime.create).toHaveBeenCalledTimes(2);
  });

  it('reports a late unconfirmed create handle only through outcomeUnknown completion', async () => {
    const item = claim({
      operationId: 'runtime-late-handle-0001',
      kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
    });
    const creation = deferred();
    const runtime = createRuntime({
      create: mock(async () => creation.promise),
      destroy: mock(async () => {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
      }),
    });
    const setup = createCoordinator({
      claims: [item],
      runtime,
      operationDeadlineMs: 10,
      completionTimeoutMs: 100,
    });

    const pending = setup.coordinator.dispatch(operation(item));
    await new Promise((resolve) => setTimeout(resolve, 20));
    creation.resolve({
      providerId: 'fake-provider',
      handle: 'late-provider-handle-0001',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: FUTURE_EXPIRY,
      cleanupPending: false,
    });

    await expect(pending).resolves.toMatchObject({
      accepted: true,
      outcome: 'outcomeUnknown',
    });
    expect(setup.authority.completions).toHaveLength(1);
    expect(setup.authority.completions[0]).toMatchObject({
      outcome: 'outcomeUnknown',
      provider: {
        providerId: 'fake-provider',
        providerHandle: 'late-provider-handle-0001',
        status: 'unknown',
        expiresAt: null,
      },
      supervision: null,
    });
    expect(setup.bridge.hydrate).not.toHaveBeenCalled();
  });

  it('classifies known absence or failure as failed and mutation ambiguity as outcomeUnknown', async () => {
    const failedStart = claim({
      operationId: 'runtime-known-failure-0001',
      kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
    });
    const ambiguousPause = claim({
      operationId: 'runtime-unknown-pause-0001',
      kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 2,
    });
    const runtime = createRuntime({
      create: mock(async () => {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED);
      }),
    });
    const bridge = createBridge([], {
      pause: mock(async () => {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
      }),
    });
    const setup = createCoordinator({ claims: [failedStart, ambiguousPause], runtime, bridge });

    await expect(setup.coordinator.dispatch(operation(failedStart))).resolves.toMatchObject({
      outcome: 'failed',
    });
    await expect(setup.coordinator.dispatch(operation(ambiguousPause))).resolves.toMatchObject({
      outcome: 'outcomeUnknown',
    });
    expect(setup.authority.completions.map((entry) => entry.outcome)).toEqual([
      'failed',
      'outcomeUnknown',
    ]);
  });

  it('retries only the exact serialized completion payload without repeating the effect', async () => {
    const item = claim({
      operationId: 'runtime-completion-replay-0001',
      kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 2,
    });
    const serialized = [];
    let attempts = 0;
    const authority = createAuthority([item], {
      completeSandboxRuntimeOperation: mock(async (payload) => {
        serialized.push(JSON.stringify(payload));
        attempts += 1;
        if (attempts === 1) throw new Error('transport secret');
        return {
          operationId: payload.operationId,
          accepted: true,
          orphanCleanupRecorded: false,
          runtime: { status: 'paused' },
        };
      }),
    });
    const setup = createCoordinator({ claims: [item], authority });

    await expect(setup.coordinator.dispatch(operation(item))).resolves.toMatchObject({
      accepted: true,
      outcome: 'succeeded',
    });
    expect(serialized).toHaveLength(2);
    expect(serialized[1]).toBe(serialized[0]);
    expect(setup.bridge.pause).toHaveBeenCalledTimes(1);
  });

  it('orders checkpoint capture, atomic publication, and completion and coalesces replay', async () => {
    const events = [];
    const item = claim({
      operationId: 'runtime-checkpoint-order-0001',
      kind: 'checkpoint', effect: 'checkpoint', generation: 1, lifecycleRevision: 2,
      workspaceRevision: 19,
    });
    const publication = deferred();
    const authority = createAuthority([item], {
      completeSandboxRuntimeOperation: mock(async (payload) => {
        events.push('complete');
        return {
          operationId: payload.operationId,
          accepted: true,
          orphanCleanupRecorded: false,
          runtime: { status: 'running' },
        };
      }),
    });
    const bridge = createBridge(events);
    const publisher = createPublisher(events, {
      publish: mock(async (input) => {
        events.push('publish');
        await publication.promise;
        return {
          operationId: input.operationId,
          workspaceRevision: input.expectedWorkspaceRevision,
          published: true,
        };
      }),
    });
    const setup = createCoordinator({
      claims: [item], authority, bridge, checkpointPublisher: publisher,
    });

    const first = setup.coordinator.dispatch(operation(item));
    const replay = setup.coordinator.dispatch(operation(item));
    expect(replay).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['capture:runtime-checkpoint-order-0001', 'publish']);
    publication.resolve();
    await first;
    expect(events).toEqual([
      'capture:runtime-checkpoint-order-0001',
      'publish',
      'complete',
    ]);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(publisher.publish.mock.calls[0][0]).toMatchObject({
      operationId: item.operationId,
      expectedWorkspaceRevision: 19,
    });
  });

  it('maps checkpoint capture and CAS rejection to failed but publication ambiguity to outcomeUnknown', async () => {
    const captureFailure = claim({
      operationId: 'runtime-checkpoint-capture-failed-0001',
      kind: 'checkpoint', effect: 'checkpoint', generation: 1, lifecycleRevision: 2,
      workspaceRevision: 7,
    });
    const casFailure = claim({
      operationId: 'runtime-checkpoint-cas-failed-0001',
      kind: 'checkpoint', effect: 'checkpoint', generation: 1, lifecycleRevision: 3,
      workspaceRevision: 8,
    });
    const ambiguous = claim({
      operationId: 'runtime-checkpoint-ambiguous-0001',
      kind: 'checkpoint', effect: 'checkpoint', generation: 1, lifecycleRevision: 4,
      workspaceRevision: 9,
    });
    const bridge = createBridge([], {
      checkpoint: mock(async (input) => {
        if (input.operationId === captureFailure.operationId) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED);
        }
        return {
          operationId: input.operationId,
          leaseId: input.leaseId,
          generation: input.generation,
          claimFence: input.claimFence,
          baseRevision: 'rev-1',
          files: [],
          fileCount: 0,
          totalBytes: 0,
        };
      }),
    });
    const publisher = createPublisher([], {
      publish: mock(async ({ operationId }) => {
        if (operationId === casFailure.operationId) {
          throw { code: 'VERSION_CONFLICT', private: 'secret-cas-state' };
        }
        throw new Error('network response contained a secret object key');
      }),
    });
    const setup = createCoordinator({
      claims: [captureFailure, casFailure, ambiguous],
      bridge,
      checkpointPublisher: publisher,
    });

    await expect(setup.coordinator.dispatch(operation(captureFailure))).resolves.toMatchObject({
      outcome: 'failed',
    });
    await expect(setup.coordinator.dispatch(operation(casFailure))).resolves.toMatchObject({
      outcome: 'failed',
    });
    await expect(setup.coordinator.dispatch(operation(ambiguous))).resolves.toMatchObject({
      outcome: 'outcomeUnknown',
    });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it('applies fixed pre-claim backpressure and retains a timed-out slot until work settles', async () => {
    const first = claim({
      operationId: 'runtime-scheduler-first-0001',
      kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
    });
    const second = claim({
      operationId: 'runtime-scheduler-second-0001',
      kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 2,
    });
    const overflow = claim({
      operationId: 'runtime-scheduler-overflow-0001',
      kind: 'destroy', effect: 'destroy', generation: 1, lifecycleRevision: 3,
    });
    const creation = deferred();
    const diagnosticEvents = [];
    const authority = createAuthority([first, second, overflow]);
    const runtime = createRuntime({
      create: mock(async () => creation.promise),
      destroy: mock(async (handle) => ({ handle, destroyed: true })),
    });
    const setup = createCoordinator({
      claims: [first, second, overflow],
      authority,
      runtime,
      maxConcurrent: 1,
      maxQueued: 1,
      operationDeadlineMs: 10,
      completionTimeoutMs: 100,
      diagnostics: (event) => diagnosticEvents.push(event),
    });

    const firstFlight = setup.coordinator.dispatch(operation(first));
    const secondFlight = setup.coordinator.dispatch(operation(second));
    await expect(setup.coordinator.dispatch(operation(overflow))).resolves.toEqual({
      operationId: overflow.operationId,
      accepted: false,
      outcome: 'backpressure',
      code: 'SANDBOX_COORDINATOR_BACKPRESSURE',
    });
    expect(diagnosticEvents.find((event) => event.operationId === overflow.operationId)).toEqual({
      type: 'sandbox.lifecycle',
      operationId: overflow.operationId,
      phase: 'queued',
      effect: 'destroy',
      outcome: 'backpressured',
      code: 'SANDBOX_COORDINATOR_BACKPRESSURE',
    });
    expect(authority.claimSandboxRuntimeOperation).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(authority.claimSandboxRuntimeOperation).toHaveBeenCalledTimes(1);

    creation.resolve({
      providerId: 'fake-provider',
      handle: 'sandbox-handle-0001',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: FUTURE_EXPIRY,
      cleanupPending: false,
    });
    await firstFlight;
    await secondFlight;
    expect(authority.claimSandboxRuntimeOperation).toHaveBeenCalledTimes(2);
    expect(authority.claimSandboxRuntimeOperation.mock.calls.map(([input]) => input.operationId))
      .toEqual([first.operationId, second.operationId]);
  });

  it('emits failure-isolated allowlist-only diagnostics with no sensitive values', async () => {
    const item = claim({
      operationId: 'runtime-diagnostic-redaction-0001',
      kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 2,
    });
    const secret = 'https://provider.example/private?credential=secret-token';
    const events = [];
    const diagnostics = mock((event) => {
      events.push(event);
      if (events.length === 1) throw new Error('diagnostic sink failure');
    });
    const bridge = createBridge([], {
      pause: mock(async () => {
        throw new Error(secret);
      }),
    });
    const setup = createCoordinator({ claims: [item], bridge, diagnostics });

    await expect(setup.coordinator.dispatch(operation(item))).resolves.toMatchObject({
      outcome: 'outcomeUnknown',
    });
    expect(events).toEqual([
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'queued',
        effect: 'stop',
        outcome: null,
        code: null,
      },
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'claimed',
        effect: 'stop',
        outcome: null,
        code: null,
      },
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'begun',
        effect: 'stop',
        outcome: null,
        code: null,
      },
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'effect',
        effect: 'stop',
        outcome: 'outcomeUnknown',
        code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
      },
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'completion',
        effect: 'stop',
        outcome: 'outcomeUnknown',
        code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
      },
    ]);
    for (const event of events) {
      expect(Object.keys(event)).toEqual([
        'type',
        'operationId',
        'phase',
        'effect',
        'outcome',
        'code',
      ]);
      expect(['queued', 'claimed', 'begun', 'effect', 'completion']).toContain(event.phase);
      expect([null, 'start', 'stop', 'resume', 'destroy', 'checkpoint']).toContain(event.effect);
      expect([
        null,
        'succeeded',
        'failed',
        'outcomeUnknown',
        'backpressured',
        'ignored',
      ]).toContain(event.outcome);
    }
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('credential');
    expect(JSON.stringify(events)).not.toContain('provider.example');
  });

  it('treats a rejected replay/no-op claim as ignored without dispatching or beginning', async () => {
    const item = claim({
      operationId: 'runtime-noop-replay-0001',
      kind: 'ensure', effect: 'start', generation: 1, lifecycleRevision: 1,
    });
    const authority = createAuthority([item], {
      claimSandboxRuntimeOperation: mock(async () => ({
        ok: false,
        error: { code: 'INVALID_TRANSITION' },
      })),
    });
    const diagnosticEvents = [];
    const setup = createCoordinator({
      claims: [item],
      authority,
      diagnostics: (event) => diagnosticEvents.push(event),
    });

    await expect(setup.coordinator.dispatch({
      operationId: item.operationId,
      expectedGeneration: item.generation,
      expectedRevision: item.lifecycleRevision,
    })).resolves.toEqual({
      operationId: item.operationId,
      accepted: false,
      outcome: 'ignored',
      code: 'INVALID_TRANSITION',
    });
    expect(diagnosticEvents).toEqual([
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'queued',
        effect: null,
        outcome: null,
        code: null,
      },
      {
        type: 'sandbox.lifecycle',
        operationId: item.operationId,
        phase: 'claimed',
        effect: null,
        outcome: 'ignored',
        code: 'INVALID_TRANSITION',
      },
    ]);
    expect(authority.beginSandboxRuntimeEffect).not.toHaveBeenCalled();
    expect(setup.snapshotSource.read).not.toHaveBeenCalled();
    expect(setup.runtime.create).not.toHaveBeenCalled();
    expect(setup.bridge.hydrate).not.toHaveBeenCalled();
  });

  it('lets an unconfirmed begin recover without running any provider mutation', async () => {
    const item = claim({
      operationId: 'runtime-begin-unconfirmed-0001',
      kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 2,
    });
    const authority = createAuthority([item], {
      beginSandboxRuntimeEffect: mock(async () => {
        throw new Error('private authority transport details');
      }),
    });
    const setup = createCoordinator({ claims: [item], authority });

    await expect(setup.coordinator.dispatch(operation(item))).resolves.toMatchObject({
      accepted: false,
      outcome: 'ignored',
      code: 'SANDBOX_COORDINATOR_BEGIN_UNCONFIRMED',
    });
    expect(setup.bridge.pause).not.toHaveBeenCalled();
    expect(authority.completeSandboxRuntimeOperation).not.toHaveBeenCalled();
  });

  it('always attempts destroy after stop and falls back only from local not-found', async () => {
    const item = claim({
      operationId: 'runtime-destroy-fallback-0001',
      kind: 'destroy', effect: 'destroy', generation: 1, lifecycleRevision: 2,
      currentSupervision: supervision('sandbox-handle-0001', 1),
    });
    const runtime = createRuntime({
      list: mock(() => [{ handle: 'sandbox-handle-0001' }]),
      destroy: mock(async () => {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
      }),
    });
    const bridge = createBridge([], {
      openCodeStop: mock(async () => {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
      }),
    });
    const setup = createCoordinator({ claims: [item], runtime, bridge });

    await expect(setup.coordinator.dispatch(operation(item))).resolves.toMatchObject({
      accepted: true,
      outcome: 'succeeded',
    });
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(bridge.destroy.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it('rejects unsafe resume expiry and never starts OpenCode with it', async () => {
    const item = claim({
      operationId: 'runtime-resume-expiry-0001',
      kind: 'resume', effect: 'resume', generation: 1, lifecycleRevision: 2,
    });
    const bridge = createBridge([], {
      resume: mock(async () => ({
        status: 'running',
        expiresAt: '2000-01-01T00:00:00.000Z',
      })),
    });
    const setup = createCoordinator({ claims: [item], bridge });

    await expect(setup.coordinator.dispatch(operation(item))).resolves.toMatchObject({
      accepted: true,
      outcome: 'outcomeUnknown',
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });
    expect(bridge.resume).toHaveBeenCalledTimes(1);
    expect(bridge.openCodeStart).not.toHaveBeenCalled();
  });

  it('enforces the coordinator deadline relation at construction', () => {
    const item = claim({
      operationId: 'runtime-deadline-config-0001',
      kind: 'pause', effect: 'stop', generation: 1, lifecycleRevision: 2,
    });
    expect(() => createCoordinator({
      claims: [item],
      operationDeadlineMs: 29_000,
      completionTimeoutMs: 1_000,
    })).toThrow(expect.objectContaining({
      code: SANDBOX_ERROR_CODES.CONFIGURATION_INVALID,
    }));
  });
});
