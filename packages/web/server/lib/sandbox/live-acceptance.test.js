import { EventEmitter } from 'node:events';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_ACCEPTANCE_CHECKS,
  LIVE_ACCEPTANCE_LIMITS,
  createBoundedNativeFetch,
  getOpenSandboxLiveAcceptanceExitCode,
  loadOpenSandboxLiveAcceptanceConfig,
  runOpenSandboxLiveAcceptance,
} from './live-acceptance.js';
import { runOpenSandboxLiveAcceptanceCli } from './live-acceptance-cli.js';

const API_KEY_SECRET = 'api-key-sentinel-must-not-escape';
const ROUTING_SECRET = 'routing-header-sentinel-must-not-escape';
const SECURE_ROUTING_SECRET = 'secure-routing-sentinel-must-not-escape';
const PROVIDER_BODY_SECRET = 'provider-body-sentinel-must-not-escape';
const ENDPOINT_HOST = '10.23.45.67';
const ENDPOINT_PORT = '19090';
const HANDLE_PREFIX = 'handle-sentinel';
const IMAGE_SECRET = 'node-image-sentinel:22';
const FIXED_NOW_MS = Date.parse('2026-07-22T00:00:00.000Z');
const FIXED_SUFFIX = 'acceptance123456';
const OWNERSHIP_LABELS = Object.freeze({
  environment: 'drarticle.io/environment',
  project: 'drarticle.io/project',
  session: 'drarticle.io/session',
  generation: 'drarticle.io/generation',
  operation: 'drarticle.io/operation',
});

const tempDirectories = new Set();

afterEach(async () => {
  await Promise.all(Array.from(tempDirectories, async (directory) => {
    await fsPromises.rm(directory, { recursive: true, force: true });
    tempDirectories.delete(directory);
  }));
  vi.restoreAllMocks();
});

const systemClock = Object.freeze({
  now: () => new Date(FIXED_NOW_MS),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});

const headerValue = (headers, name) => new Headers(headers ?? {}).get(name);

const metadataMatches = (left, right) => Object.entries(right)
  .every(([name, value]) => left?.[name] === value);

const resourcePayload = (resource) => ({
  id: resource.id,
  status: { state: resource.status },
  createdAt: resource.createdAt,
  expiresAt: resource.expiresAt,
  metadata: resource.metadata,
});

const paginationPayload = (items, page, pageSize, forcedTotalItems = null) => {
  const totalItems = forcedTotalItems ?? items.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  const start = (page - 1) * pageSize;
  const pageItems = forcedTotalItems === null ? items.slice(start, start + pageSize) : items;
  return {
    items: pageItems.map(resourcePayload),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
    },
  };
};

const createFakeLane = (options = {}) => {
  const calls = [];
  const resources = new Map();
  const commands = new Map();
  const createBodies = [];
  const websocketCalls = [];
  const counters = {
    ttlPosts: 0,
    mainPosts: 0,
    pausePosts: 0,
    resumePosts: 0,
    renewPosts: 0,
    deletes: 0,
    commandPosts: 0,
    commandDeletes: 0,
    postDeleteCommandEndpointRequests: 0,
    mainListPages: 0,
    mainGets: 0,
  };
  let nextResource = 1;
  let nextCommand = 1;
  let mainCreated = false;
  let failedGet = false;
  let failedOwnershipList = false;
  let failedEndpoint = false;
  let failedVisibilityList = false;

  const unrelatedId = 'unrelated-resource-must-survive';
  resources.set(unrelatedId, {
    id: unrelatedId,
    status: 'Running',
    createdAt: new Date(FIXED_NOW_MS).toISOString(),
    expiresAt: new Date(FIXED_NOW_MS + 600_000).toISOString(),
    metadata: {
      [OWNERSHIP_LABELS.environment]: 'non-production',
      [OWNERSHIP_LABELS.project]: 'another-project',
      [OWNERSHIP_LABELS.session]: 'another-session',
      [OWNERSHIP_LABELS.generation]: '9',
      [OWNERSHIP_LABELS.operation]: 'another-operation',
    },
  });

  const allocate = (body, suffix = '') => {
    const id = `${HANDLE_PREFIX}-${nextResource}${suffix}`;
    nextResource += 1;
    const resource = {
      id,
      status: 'Running',
      createdAt: new Date(FIXED_NOW_MS).toISOString(),
      expiresAt: new Date(FIXED_NOW_MS + (body.timeout * 1000)).toISOString(),
      metadata: { ...body.metadata },
    };
    resources.set(id, resource);
    return resource;
  };

  const protectedRequest = (init) => headerValue(init.headers, 'OPEN-SANDBOX-API-KEY') === API_KEY_SECRET;

  const fetchImpl = vi.fn(async (rawUrl, init = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      url: url.toString(),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
      body: init.body,
    });

    if (url.hostname === ENDPOINT_HOST) {
      if (headerValue(init.headers, 'OPEN-SANDBOX-API-KEY') !== null) {
        throw new Error(PROVIDER_BODY_SECRET);
      }
      if (headerValue(init.headers, 'X-Route-Secret') !== ROUTING_SECRET
        || headerValue(init.headers, 'OpenSandbox-Secure-Access') !== SECURE_ROUTING_SECRET) {
        return new Response(PROVIDER_BODY_SECRET, { status: 403 });
      }
      if (/\/port\/18080$/.test(url.pathname)) {
        if (options.failHttpProbe) return new Response(PROVIDER_BODY_SECRET, { status: 503 });
        return new Response('openchamber-stage7b-http', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      const execdPrefix = /^\/sandboxes\/[^/]+\/port\/44772/;
      const execdMatch = execdPrefix.exec(url.pathname);
      const execdPath = execdMatch ? url.pathname.slice(execdMatch[0].length) : null;
      if (execdPath === '/command' && init.method === 'POST') {
        counters.commandPosts += 1;
        const body = JSON.parse(init.body);
        const kind = body.command.includes('example.com') ? 'egress' : 'echo';
        const commandId = `command-${nextCommand}`;
        nextCommand += 1;
        commands.set(commandId, {
          commandId,
          kind,
          status: kind === 'echo' ? 'running' : 'completed',
          exitCode: kind === 'egress' ? (options.egressAllowed ? 9 : 0) : null,
        });
        if (options.ambiguousCommandStart && kind === 'echo') {
          throw new Error(PROVIDER_BODY_SECRET);
        }
        return new Response(`data: ${JSON.stringify({
          commandId,
          event: 'accepted',
          exitCode: null,
        })}\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (execdPath?.startsWith('/command/status/') && init.method === 'GET') {
        const commandId = decodeURIComponent(url.pathname.split('/').at(-1));
        const command = commands.get(commandId);
        return command
          ? Response.json(command)
          : Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
      }
      if (execdPath === '/command' && init.method === 'DELETE') {
        counters.commandDeletes += 1;
        const command = commands.get(url.searchParams.get('id'));
        if (command) command.status = 'completed';
        return new Response(null, { status: 200 });
      }
      return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
    }

    if (url.pathname === '/health') {
      return Response.json({ healthy: true, secret: PROVIDER_BODY_SECRET });
    }
    if (!url.pathname.startsWith('/v1/sandboxes')) {
      return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
    }
    if (!protectedRequest(init)) {
      return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 401 });
    }

    if (url.pathname === '/v1/sandboxes' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      createBodies.push(body);
      const operationId = body.metadata?.[OWNERSHIP_LABELS.operation] ?? '';
      const isTtl = operationId.startsWith('ttl-probe-');
      if (isTtl) counters.ttlPosts += 1;
      else counters.mainPosts += 1;
      if (isTtl && options.ttlMode !== 'accept' && options.ttlMode !== 'ambiguous') {
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 400 });
      }
      const resource = allocate(body);
      if (!isTtl) {
        mainCreated = true;
        if (options.duplicateExactOnAmbiguousMain) allocate(body, '-duplicate');
      }
      if ((isTtl && options.ttlMode === 'ambiguous')
        || (!isTtl && options.ambiguousMainCreate)) {
        throw new Error(PROVIDER_BODY_SECRET);
      }
      return Response.json(resourcePayload(resource), { status: 202 });
    }

    if (url.pathname === '/v1/sandboxes' && init.method === 'GET') {
      const page = Number.parseInt(url.searchParams.get('page'), 10);
      const pageSize = Number.parseInt(url.searchParams.get('pageSize'), 10);
      const filters = Object.fromEntries(url.searchParams.getAll('metadata').map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
      const isMainFilter = filters[OWNERSHIP_LABELS.operation]?.startsWith('main-');
      if (isMainFilter) counters.mainListPages += 1;
      if (isMainFilter && options.failCleanupReconciliation && counters.commandPosts > 0) {
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 503 });
      }
      if (isMainFilter && options.failOwnershipListOnce && mainCreated && !failedOwnershipList) {
        failedOwnershipList = true;
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 503 });
      }
      if (isMainFilter && options.failVisibilityListOnce
        && counters.renewPosts > 0 && !failedVisibilityList) {
        failedVisibilityList = true;
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 503 });
      }
      const matching = Array.from(resources.values())
        .filter((resource) => metadataMatches(resource.metadata, filters));
      if (isMainFilter && options.endlessMainPagination) {
        return Response.json(paginationPayload(matching.slice(0, 1), page, pageSize, 250));
      }
      return Response.json(paginationPayload(matching, page, pageSize));
    }

    const endpointMatch = /^\/v1\/sandboxes\/([^/]+)\/endpoints\/(\d+)$/.exec(url.pathname);
    if (endpointMatch && init.method === 'GET') {
      const endpointHandle = decodeURIComponent(endpointMatch[1]);
      if (options.failCommandEndpointAfterDelete
        && endpointMatch[2] === '44772'
        && !resources.has(endpointHandle)) {
        counters.postDeleteCommandEndpointRequests += 1;
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 503 });
      }
      if (options.failEndpointOnce && !failedEndpoint && endpointMatch[2] === '18080') {
        failedEndpoint = true;
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 503 });
      }
      const endpoint = `${ENDPOINT_HOST}:${ENDPOINT_PORT}`
        + `/sandboxes/${encodeURIComponent(endpointHandle)}/port/${endpointMatch[2]}`;
      return Response.json({
        endpoint,
        headers: {
          'X-Route-Secret': ROUTING_SECRET,
          'OpenSandbox-Secure-Access': SECURE_ROUTING_SECRET,
          ...(options.injectControlKeyIntoEndpoint
            ? { 'OPEN-SANDBOX-API-KEY': API_KEY_SECRET }
            : {}),
        },
      });
    }

    const renewMatch = /^\/v1\/sandboxes\/([^/]+)\/renew-expiration$/.exec(url.pathname);
    if (renewMatch && init.method === 'POST') {
      counters.renewPosts += 1;
      const resource = resources.get(decodeURIComponent(renewMatch[1]));
      if (!resource) return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
      if (options.failRenewConflict) {
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 409 });
      }
      const body = JSON.parse(init.body);
      resource.expiresAt = body.expiresAt;
      if (options.ambiguousRenew) throw new Error(PROVIDER_BODY_SECRET);
      return Response.json({ id: resource.id, expiresAt: resource.expiresAt });
    }

    const actionMatch = /^\/v1\/sandboxes\/([^/]+)\/(pause|resume)$/.exec(url.pathname);
    if (actionMatch && init.method === 'POST') {
      const resource = resources.get(decodeURIComponent(actionMatch[1]));
      if (!resource) return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
      if (actionMatch[2] === 'pause') {
        counters.pausePosts += 1;
        resource.status = 'Paused';
        if (options.ambiguousPause) throw new Error(PROVIDER_BODY_SECRET);
      } else {
        counters.resumePosts += 1;
        resource.status = 'Running';
        if (options.ambiguousResume) throw new Error(PROVIDER_BODY_SECRET);
      }
      return new Response(null, { status: 202 });
    }

    const handleMatch = /^\/v1\/sandboxes\/([^/]+)$/.exec(url.pathname);
    if (handleMatch && init.method === 'GET') {
      const handle = decodeURIComponent(handleMatch[1]);
      if (handle.startsWith(HANDLE_PREFIX)) counters.mainGets += 1;
      if (options.failAuthoritativeGetOnce && mainCreated && !failedGet) {
        failedGet = true;
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 503 });
      }
      const resource = resources.get(handle);
      if (!resource) return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
      const payload = resourcePayload(resource);
      if (Number.isInteger(options.authoritativeMetadataMismatchFromGet)
        && counters.mainGets >= options.authoritativeMetadataMismatchFromGet) {
        payload.metadata = {
          ...payload.metadata,
          [OWNERSHIP_LABELS.operation]: 'different-authoritative-operation',
        };
      }
      if (Number.isInteger(options.invalidAuthoritativeMetadataFromGet)
        && counters.mainGets >= options.invalidAuthoritativeMetadataFromGet) {
        payload.metadata = {
          ...payload.metadata,
          [OWNERSHIP_LABELS.generation]: 'not-a-generation',
        };
      }
      return Response.json(payload);
    }
    if (handleMatch && init.method === 'DELETE') {
      counters.deletes += 1;
      const handle = decodeURIComponent(handleMatch[1]);
      if (!resources.has(handle)) {
        return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
      }
      resources.delete(handle);
      if (options.ambiguousDestroy) throw new Error(PROVIDER_BODY_SECRET);
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: PROVIDER_BODY_SECRET }, { status: 404 });
  });

  const webSocketProbe = options.webSocketUnsupported
    ? null
    : vi.fn(async ({ endpoint, headers }) => {
      const websocketEndpoint = new URL(endpoint);
      if (websocketEndpoint.protocol === 'http:') websocketEndpoint.protocol = 'ws:';
      else if (websocketEndpoint.protocol === 'https:') websocketEndpoint.protocol = 'wss:';
      websocketCalls.push({ endpoint: websocketEndpoint.toString(), headers });
      if (websocketEndpoint.protocol !== 'ws:'
        || websocketEndpoint.hostname !== ENDPOINT_HOST
        || websocketEndpoint.port !== ENDPOINT_PORT
        || !/\/sandboxes\/[^/]+\/port\/18080$/.test(websocketEndpoint.pathname)
        || headers['X-Route-Secret'] !== ROUTING_SECRET
        || headers['OpenSandbox-Secure-Access'] !== SECURE_ROUTING_SECRET
        || headerValue(headers, 'OPEN-SANDBOX-API-KEY') !== null) {
        throw new Error(PROVIDER_BODY_SECRET);
      }
    });

  return {
    fetchImpl,
    webSocketProbe,
    websocketCalls,
    calls,
    resources,
    commands,
    createBodies,
    counters,
    unrelatedId,
  };
};

const acceptanceEnvironment = (overrides = {}) => ({
  OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_BASE_URL: 'http://127.0.0.1:18180/v1',
  OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_IMAGE: IMAGE_SECRET,
  OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_API_KEY: API_KEY_SECRET,
  OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_TTL_SECONDS: '300',
  ...overrides,
});

const runFakeGate = (lane, options = {}) => runOpenSandboxLiveAcceptance({
  environment: options.environment ?? acceptanceEnvironment(),
  signal: options.signal,
  dependencies: {
    clock: systemClock,
    idFactory: () => FIXED_SUFFIX,
    fetchImpl: lane.fetchImpl,
    webSocketProbe: lane.webSocketProbe,
    ...options.dependencies,
  },
});

const checkByName = (report, name) => report.checks.find((check) => check.name === name);

describe('Stage 7B OpenSandbox live acceptance gate', () => {
  it('is unavailable without explicit configuration and performs no network or file access', async () => {
    const lane = createFakeLane();
    const readFile = vi.fn(async () => Buffer.from(API_KEY_SECRET));

    const report = await runOpenSandboxLiveAcceptance({
      environment: {},
      dependencies: {
        fetchImpl: lane.fetchImpl,
        readFile,
        clock: systemClock,
        idFactory: () => FIXED_SUFFIX,
      },
    });

    expect(report.status).toBe('unavailable');
    expect(report.ready).toBe(false);
    expect(getOpenSandboxLiveAcceptanceExitCode(report)).toBe(2);
    expect(report.checks.map((check) => check.name)).toEqual(
      LIVE_ACCEPTANCE_CHECKS.map((check) => check.name),
    );
    expect(new Set(report.checks.map((check) => check.status)))
      .toEqual(new Set(['unavailable', 'skipped']));
    expect(checkByName(report, 'configuration')).toMatchObject({
      status: 'unavailable',
      code: 'configuration_missing',
    });
    expect(lane.fetchImpl).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('passes the complete fixed matrix with exact payloads, auth placement, and bounded artifacts', async () => {
    const lane = createFakeLane();

    const report = await runFakeGate(lane);

    expect(report.status).toBe('passed');
    expect(report.ready).toBe(true);
    expect(getOpenSandboxLiveAcceptanceExitCode(report)).toBe(0);
    expect(report.limits).toEqual(LIVE_ACCEPTANCE_LIMITS);
    expect(checkByName(report, 'host_pids_policy')).toMatchObject({
      status: 'skipped', code: 'operator_precondition',
    });
    expect(checkByName(report, 'host_no_new_privileges_policy')).toMatchObject({
      status: 'skipped', code: 'operator_precondition',
    });
    expect(checkByName(report, 'restart_orphan_visibility')).toMatchObject({
      status: 'skipped', code: 'restart_forbidden',
    });
    expect(report.checks.filter((check) => check.required).every((check) => check.status === 'passed'))
      .toBe(true);

    expect(lane.counters).toMatchObject({
      ttlPosts: 1,
      mainPosts: 1,
      pausePosts: 1,
      resumePosts: 1,
      renewPosts: 1,
      deletes: 1,
      commandPosts: 2,
      commandDeletes: 0,
      postDeleteCommandEndpointRequests: 0,
    });
    expect(lane.createBodies).toHaveLength(2);
    const [ttlBody, mainBody] = lane.createBodies;
    expect(ttlBody.timeout).toBe(901);
    expect(mainBody).toEqual({
      image: { uri: IMAGE_SECRET },
      entrypoint: ['node', '-e', 'setInterval(() => {}, 1000)'],
      resourceLimits: { cpu: '250m', memory: '128Mi' },
      timeout: 300,
      metadata: mainBody.metadata,
      networkPolicy: { defaultAction: 'deny', egress: [] },
    });
    expect(Object.keys(mainBody)).toEqual([
      'image', 'entrypoint', 'resourceLimits', 'timeout', 'metadata', 'networkPolicy',
    ]);
    expect(Object.keys(mainBody.metadata)).toEqual([
      OWNERSHIP_LABELS.environment,
      OWNERSHIP_LABELS.project,
      OWNERSHIP_LABELS.session,
      OWNERSHIP_LABELS.generation,
      OWNERSHIP_LABELS.operation,
    ]);
    expect(ttlBody.metadata[OWNERSHIP_LABELS.operation])
      .not.toBe(mainBody.metadata[OWNERSHIP_LABELS.operation]);
    expect(mainBody).not.toHaveProperty('pids');
    expect(mainBody).not.toHaveProperty('noNewPrivileges');

    const unauthenticatedCalls = lane.calls.filter((call) => (
      call.url.endsWith('/health') && call.headers['open-sandbox-api-key'] === undefined
    ) || (
      call.url.includes('/v1/sandboxes?page=1&pageSize=1')
      && call.headers['open-sandbox-api-key'] === undefined
    ));
    expect(unauthenticatedCalls).toHaveLength(2);
    const endpointCalls = lane.calls.filter((call) => new URL(call.url).hostname === ENDPOINT_HOST);
    expect(endpointCalls.length).toBeGreaterThan(0);
    expect(endpointCalls.every((call) => new URL(call.url).protocol === 'http:')).toBe(true);
    expect(endpointCalls.every((call) => call.headers['open-sandbox-api-key'] === undefined)).toBe(true);
    expect(endpointCalls.every((call) => call.headers['x-route-secret'] === ROUTING_SECRET)).toBe(true);
    expect(endpointCalls.every((call) => (
      call.headers['opensandbox-secure-access'] === SECURE_ROUTING_SECRET
    ))).toBe(true);
    expect(endpointCalls.some((call) => /\/port\/18080$/.test(new URL(call.url).pathname))).toBe(true);
    expect(endpointCalls.some((call) => /\/port\/44772\/command$/.test(new URL(call.url).pathname)))
      .toBe(true);
    expect(lane.websocketCalls).toHaveLength(1);
    expect(new URL(lane.websocketCalls[0].endpoint)).toMatchObject({
      protocol: 'ws:',
      hostname: ENDPOINT_HOST,
      port: ENDPOINT_PORT,
    });
    expect(lane.websocketCalls[0].headers).toEqual({
      'X-Route-Secret': ROUTING_SECRET,
      'OpenSandbox-Secure-Access': SECURE_ROUTING_SECRET,
    });
    expect(lane.resources.has(lane.unrelatedId)).toBe(true);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);

    const serialized = JSON.stringify(report);
    for (const sentinel of [
      API_KEY_SECRET,
      ROUTING_SECRET,
      SECURE_ROUTING_SECRET,
      PROVIDER_BODY_SECRET,
      ENDPOINT_HOST,
      HANDLE_PREFIX,
      IMAGE_SECRET,
      FIXED_SUFFIX,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it('never retries ambiguous main create and cleans every exact verified match only', async () => {
    const lane = createFakeLane({
      ambiguousMainCreate: true,
      duplicateExactOnAmbiguousMain: true,
    });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(checkByName(report, 'main_create')).toMatchObject({
      status: 'failed', code: 'outcome_unknown',
    });
    expect(checkByName(report, 'final_no_owned_leftovers')).toMatchObject({ status: 'passed' });
    expect(lane.counters.mainPosts).toBe(1);
    expect(lane.counters.deletes).toBe(2);
    expect(lane.counters.mainGets).toBeGreaterThanOrEqual(2);
    expect(lane.resources.has(lane.unrelatedId)).toBe(true);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);
  });

  it('never retries an ambiguous TTL probe and reconciles its exact ownership for cleanup', async () => {
    const lane = createFakeLane({ ttlMode: 'ambiguous' });

    const report = await runFakeGate(lane);

    expect(checkByName(report, 'ttl_over_cap_rejection')).toMatchObject({
      status: 'failed', code: 'outcome_unknown',
    });
    expect(checkByName(report, 'main_create').status).toBe('unavailable');
    expect(checkByName(report, 'final_no_owned_leftovers').status).toBe('passed');
    expect(lane.counters.ttlPosts).toBe(1);
    expect(lane.counters.mainPosts).toBe(0);
    expect(lane.counters.deletes).toBe(1);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);
  });

  it('rejects mismatched metadata from the normal authoritative GET', async () => {
    const lane = createFakeLane({ authoritativeMetadataMismatchFromGet: 1 });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(checkByName(report, 'authoritative_get')).toMatchObject({
      status: 'failed', code: 'ownership_unconfirmed',
    });
    expect(checkByName(report, 'exact_metadata_reconciliation').status).toBe('unavailable');
    expect(lane.counters.deletes).toBe(0);
    expect(lane.resources.has(lane.unrelatedId)).toBe(true);
    expect(Array.from(lane.resources.keys()).filter((id) => id.startsWith(HANDLE_PREFIX)))
      .toHaveLength(1);
  });

  it('does not ledger or delete a list match whose authoritative GET metadata differs', async () => {
    const lane = createFakeLane({ authoritativeMetadataMismatchFromGet: 2 });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(checkByName(report, 'authoritative_get').status).toBe('passed');
    expect(checkByName(report, 'exact_metadata_reconciliation')).toMatchObject({
      status: 'failed', code: 'ownership_unconfirmed',
    });
    expect(checkByName(report, 'final_no_owned_leftovers')).toMatchObject({
      status: 'failed', code: 'cleanup_unconfirmed',
    });
    expect(lane.counters.mainListPages).toBeGreaterThan(0);
    expect(lane.counters.deletes).toBe(0);
    expect(lane.resources.has(lane.unrelatedId)).toBe(true);
    expect(Array.from(lane.resources.keys()).filter((id) => id.startsWith(HANDLE_PREFIX)))
      .toHaveLength(1);
  });

  it('rejects authoritative GET metadata that cannot be normalized', async () => {
    const lane = createFakeLane({ invalidAuthoritativeMetadataFromGet: 1 });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(checkByName(report, 'authoritative_get')).toMatchObject({
      status: 'failed', code: 'ownership_unconfirmed',
    });
    expect(checkByName(report, 'final_no_owned_leftovers')).toMatchObject({
      status: 'failed', code: 'cleanup_unconfirmed',
    });
    expect(lane.counters.deletes).toBe(0);
    expect(lane.resources.has(lane.unrelatedId)).toBe(true);
    expect(Array.from(lane.resources.keys()).filter((id) => id.startsWith(HANDLE_PREFIX)))
      .toHaveLength(1);
  });

  it.each([
    ['authoritative get', { failAuthoritativeGetOnce: true }, 'authoritative_get'],
    ['exact ownership list', { failOwnershipListOnce: true }, 'exact_metadata_reconciliation'],
    ['endpoint resolution', { failEndpointOnce: true }, 'endpoint_resolution'],
    ['HTTP probe', { failHttpProbe: true }, 'http_routing_headers'],
    ['echo command dispatch', { ambiguousCommandStart: true }, 'http_routing_headers'],
    ['deny-default evidence', { egressAllowed: true }, 'deny_default_egress'],
    ['pause mutation', { ambiguousPause: true }, 'pause'],
    ['resume mutation', { ambiguousResume: true }, 'resume'],
    ['renew mutation', { failRenewConflict: true }, 'renew_once_verified'],
    ['orphan visibility', { failVisibilityListOnce: true }, 'list_orphan_visibility'],
  ])('runs exact cleanup after a %s failure', async (_label, laneOptions, failedCheck) => {
    const lane = createFakeLane(laneOptions);

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(checkByName(report, failedCheck).status).toBe('failed');
    expect(checkByName(report, 'final_no_owned_leftovers').status).toBe('passed');
    expect(lane.counters.mainPosts).toBe(1);
    expect(lane.counters.deletes).toBe(1);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);
  });

  it('reconciles an ambiguous renew by GET without repeating the mutation', async () => {
    const lane = createFakeLane({ ambiguousRenew: true });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(true);
    expect(checkByName(report, 'renew_once_verified').status).toBe('passed');
    expect(lane.counters.renewPosts).toBe(1);
  });

  it.each([
    ['pause', { ambiguousPause: true }, 'pausePosts'],
    ['resume', { ambiguousResume: true }, 'resumePosts'],
    ['command start', { ambiguousCommandStart: true }, 'commandPosts'],
  ])('does not blindly retry ambiguous %s mutations', async (_label, laneOptions, counter) => {
    const lane = createFakeLane(laneOptions);

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(lane.counters[counter]).toBe(1);
    expect(lane.counters.deletes).toBe(1);
  });

  it('attempts ambiguous destroy once and refuses readiness even after later absence', async () => {
    const lane = createFakeLane({ ambiguousDestroy: true });

    const report = await runFakeGate(lane);

    expect(checkByName(report, 'destroy')).toMatchObject({
      status: 'failed', code: 'outcome_unknown',
    });
    expect(checkByName(report, 'final_no_owned_leftovers')).toMatchObject({
      status: 'failed', code: 'outcome_unknown',
    });
    expect(report.ready).toBe(false);
    expect(lane.counters.deletes).toBe(1);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);
  });

  it('fails safe at the fixed pagination cap without broad cleanup or extra allocation', async () => {
    const lane = createFakeLane({ endlessMainPagination: true });

    const report = await runFakeGate(lane);

    expect(checkByName(report, 'exact_metadata_reconciliation')).toMatchObject({
      status: 'failed', code: 'pagination_incomplete',
    });
    expect(checkByName(report, 'final_no_owned_leftovers').status).toBe('failed');
    expect(lane.counters.ttlPosts).toBe(1);
    expect(lane.counters.mainPosts).toBe(1);
    expect(lane.counters.mainListPages).toBeLessThanOrEqual(
      LIVE_ACCEPTANCE_LIMITS.reconciliationPagesPerRoundMax * 5,
    );
    expect(lane.counters.deletes).toBe(0);
    expect(lane.resources.has(lane.unrelatedId)).toBe(true);
    expect(Array.from(lane.resources.keys()).filter((id) => id.startsWith(HANDLE_PREFIX))).toHaveLength(1);
  });

  it('skips optional WebSocket evidence without weakening required readiness policy', async () => {
    const lane = createFakeLane({ webSocketUnsupported: true });

    const report = await runFakeGate(lane);

    expect(checkByName(report, 'websocket_routing_headers')).toMatchObject({
      status: 'skipped', code: 'optional_unsupported', required: false,
    });
    expect(report.ready).toBe(true);
  });

  it('does not interrupt in-sandbox commands after authoritative sandbox absence', async () => {
    const lane = createFakeLane({ failCommandEndpointAfterDelete: true });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(true);
    expect(checkByName(report, 'destroy').status).toBe('passed');
    expect(checkByName(report, 'get_after_delete').status).toBe('passed');
    expect(checkByName(report, 'final_no_owned_leftovers').status).toBe('passed');
    expect(lane.counters.deletes).toBe(1);
    expect(lane.counters.commandDeletes).toBe(0);
    expect(lane.counters.postDeleteCommandEndpointRequests).toBe(0);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);
  });

  it('fails closed when cleanup reconciliation cannot complete', async () => {
    const lane = createFakeLane({
      failHttpProbe: true,
      failCleanupReconciliation: true,
    });

    const report = await runFakeGate(lane);

    expect(report.ready).toBe(false);
    expect(checkByName(report, 'http_routing_headers').status).toBe('failed');
    expect(checkByName(report, 'final_no_owned_leftovers')).toMatchObject({
      status: 'failed', code: 'cleanup_unconfirmed',
    });
    expect(lane.counters.deletes).toBe(1);
    expect(Array.from(lane.resources.keys())).toEqual([lane.unrelatedId]);
  });

  it('rejects provider endpoint control-key injection before any endpoint probe', async () => {
    const lane = createFakeLane({ injectControlKeyIntoEndpoint: true });

    const report = await runFakeGate(lane);

    expect(checkByName(report, 'endpoint_resolution')).toMatchObject({
      status: 'failed', code: 'response_invalid',
    });
    expect(lane.calls.filter((call) => new URL(call.url).hostname === ENDPOINT_HOST))
      .toHaveLength(0);
    expect(checkByName(report, 'final_no_owned_leftovers').status).toBe('passed');
  });

  it('redacts secrets, URLs, handles, provider bodies, and native errors from report and CLI output', async () => {
    const lane = createFakeLane({ failHttpProbe: true });
    const logSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const report = await runFakeGate(lane);
    let output = '';
    const processEvents = new EventEmitter();

    const exitCode = await runOpenSandboxLiveAcceptanceCli({
      environment: acceptanceEnvironment(),
      stdout: { write: (chunk) => { output += chunk; } },
      processEvents,
      runAcceptance: async () => report,
    });

    expect(exitCode).toBe(1);
    expect(output.trim().startsWith('{')).toBe(true);
    expect(() => JSON.parse(output)).not.toThrow();
    for (const sentinel of [
      API_KEY_SECRET,
      ROUTING_SECRET,
      SECURE_ROUTING_SECRET,
      PROVIDER_BODY_SECRET,
      ENDPOINT_HOST,
      HANDLE_PREFIX,
      IMAGE_SECRET,
      FIXED_SUFFIX,
    ]) {
      expect(JSON.stringify(report)).not.toContain(sentinel);
      expect(output).not.toContain(sentinel);
    }
    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it('aborts deterministically on SIGINT, emits one JSON document, and returns 130', async () => {
    const processEvents = new EventEmitter();
    let output = '';
    const runAcceptance = vi.fn(async ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        schemaVersion: 1,
        gate: 'opensandbox-stage-7b-live-acceptance',
        status: 'failed',
        ready: false,
        checks: [],
        limits: {},
      }), { once: true });
    }));

    const pending = runOpenSandboxLiveAcceptanceCli({
      environment: {},
      stdout: { write: (chunk) => { output += chunk; } },
      processEvents,
      runAcceptance,
    });
    processEvents.emit('SIGINT');

    await expect(pending).resolves.toBe(130);
    expect(output.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({ status: 'failed', ready: false });
  });

  it('sanitizes an unexpected CLI runner failure into the fixed matrix', async () => {
    const processEvents = new EventEmitter();
    let output = '';

    const exitCode = await runOpenSandboxLiveAcceptanceCli({
      environment: {},
      stdout: { write: (chunk) => { output += chunk; } },
      processEvents,
      runAcceptance: async () => { throw new Error(PROVIDER_BODY_SECRET); },
    });

    const report = JSON.parse(output);
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ status: 'failed', ready: false });
    expect(report.checks.map((check) => check.name)).toEqual(
      LIVE_ACCEPTANCE_CHECKS.map((check) => check.name),
    );
    expect(output).not.toContain(PROVIDER_BODY_SECRET);
  });
});

describe('live acceptance configuration files', () => {
  it('accepts only explicit bounded regular key and TLS CA files', async () => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-stage7b-'));
    tempDirectories.add(directory);
    const keyFile = path.join(directory, 'api-key');
    const caFile = path.join(directory, 'ca.pem');
    await fsPromises.writeFile(keyFile, `${API_KEY_SECRET}\n`, { mode: 0o600 });
    await fsPromises.writeFile(caFile, 'fake-test-ca\n', { mode: 0o600 });

    const config = await loadOpenSandboxLiveAcceptanceConfig({
      environment: acceptanceEnvironment({
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_BASE_URL: 'https://127.0.0.1:18443/v1',
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_API_KEY: undefined,
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_API_KEY_FILE: keyFile,
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_TLS_CA_FILE: caFile,
      }),
    });

    expect(config.apiKey).toBe(API_KEY_SECRET);
    expect(config.tlsCa.toString('utf8')).toBe('fake-test-ca\n');
    expect(config.baseUrl.toString()).toBe('https://127.0.0.1:18443/v1');
  });

  it('rejects symlink credentials, dual key sources, non-loopback HTTP, and HTTPS without CA', async () => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'openchamber-stage7b-'));
    tempDirectories.add(directory);
    const keyFile = path.join(directory, 'api-key');
    const keyLink = path.join(directory, 'api-key-link');
    await fsPromises.writeFile(keyFile, `${API_KEY_SECRET}\n`, { mode: 0o600 });
    await fsPromises.symlink(keyFile, keyLink);

    await expect(loadOpenSandboxLiveAcceptanceConfig({
      environment: acceptanceEnvironment({
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_API_KEY: undefined,
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_API_KEY_FILE: keyLink,
      }),
    })).rejects.toMatchObject({ code: 'configuration_invalid' });

    const readFile = vi.fn(async () => Buffer.from(API_KEY_SECRET));
    await expect(loadOpenSandboxLiveAcceptanceConfig({
      environment: acceptanceEnvironment({
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_API_KEY_FILE: keyFile,
      }),
      readFile,
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    expect(readFile).not.toHaveBeenCalled();

    await expect(loadOpenSandboxLiveAcceptanceConfig({
      environment: acceptanceEnvironment({
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_BASE_URL: 'http://10.0.0.8:18180/v1',
      }),
    })).rejects.toMatchObject({ code: 'configuration_invalid' });
    await expect(loadOpenSandboxLiveAcceptanceConfig({
      environment: acceptanceEnvironment({
        OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_BASE_URL: 'https://127.0.0.1:18443/v1',
      }),
    })).rejects.toMatchObject({ code: 'configuration_missing' });
  });
});

describe('bounded native transport', () => {
  const makeRequest = ({ status = 200, body = 'ok', headers = {} } = {}, capture = {}) => (
    url, options, callback
  ) => {
    capture.url = url;
    capture.options = options;
    const request = new EventEmitter();
    request.setTimeout = vi.fn();
    request.write = vi.fn();
    request.destroy = vi.fn();
    request.end = vi.fn(() => {
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = headers;
      response.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, String(value)]);
      callback(response);
    });
    return request;
  };

  it('passes explicit CA with verification and rejects redirects without following them', async () => {
    const capture = {};
    const ca = Buffer.from('fake-ca');
    const fetchImpl = createBoundedNativeFetch({
      tlsCa: ca,
      httpsRequest: makeRequest({ status: 302, headers: { location: 'https://secret.invalid/' } }, capture),
    });

    await expect(fetchImpl('https://127.0.0.1:18443/v1')).rejects.toMatchObject({
      code: 'SANDBOX_RESPONSE_INVALID',
    });
    expect(capture.options).toMatchObject({ ca, rejectUnauthorized: true });
  });

  it('rejects oversized fake responses at the fixed byte bound', async () => {
    const fetchImpl = createBoundedNativeFetch({
      tlsCa: null,
      maxResponseBytes: 4,
      httpRequest: makeRequest({ status: 200, body: 'five!' }),
    });

    await expect(fetchImpl('http://127.0.0.1:18180/v1')).rejects.toMatchObject({
      code: 'SANDBOX_RESPONSE_INVALID',
    });
  });
});
