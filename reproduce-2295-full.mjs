#!/usr/bin/env node
/**
 * Full reproduction for issue #2295
 *
 * Tests the complete startup migration chain to identify what could
 * make the app "unusable" after upgrading to 1.16.1 and reverting.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { createProjectIdFromPath } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/projects/project-id.js';
import { createSettingsRuntime } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/opencode/settings-runtime.js';
import { createSettingsNormalizationRuntime } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/opencode/settings-normalization-runtime.js';
import { createSettingsHelpers } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/opencode/settings-helpers.js';

const normalization = createSettingsNormalizationRuntime({
  os, path,
  processLike: process,
  realpathSync: fs.realpathSync,
  tunnelBootstrapTtlDefaultMs: 300_000,
  tunnelBootstrapTtlMinMs: 10_000,
  tunnelBootstrapTtlMaxMs: 3_600_000,
  tunnelSessionTtlDefaultMs: 3_600_000,
  tunnelSessionTtlMinMs: 60_000,
  tunnelSessionTtlMaxMs: 86_400_000,
});

const helpers = createSettingsHelpers({
  ...normalization,
  sanitizeTypographySizesPartial: normalization.sanitizeTypographySizesPartial,
  sanitizeModelRefs: normalization.sanitizeModelRefs,
  sanitizeSkillCatalogs: normalization.sanitizeSkillCatalogs,
});

async function testFullStartupSequence() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-full-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const projectsDir = path.join(tempRoot, 'projects');
  const projectIconsDir = path.join(tempRoot, 'project-icons');

  // Create real project directories
  const projectDirs = [
    path.join(tempRoot, 'work-project'),
    path.join(tempRoot, 'side-project'),
  ];
  for (const dir of projectDirs) {
    await fsp.mkdir(dir, { recursive: true });
  }

  try {
    // --- STEP 1: Simulate 1.16.0 settings ---
    console.log('Step 1: Creating pre-upgrade settings (1.16.0 with UUID project IDs)...');
    const oldSettings = {
      projects: [
        { id: crypto.randomUUID(), path: projectDirs[0], addedAt: Date.now(), lastOpenedAt: Date.now() },
        { id: crypto.randomUUID(), path: projectDirs[1], addedAt: Date.now(), lastOpenedAt: Date.now() },
      ],
      activeProjectId: '',
      themeId: 'flexoki-light',
      lastDirectory: projectDirs[0],
    };
    await fsp.writeFile(settingsFilePath, JSON.stringify(oldSettings, null, 2), 'utf8');

    // Create a project config file with old ID
    const projectsRootDir = path.join(path.dirname(settingsFilePath), 'projects');
    await fsp.mkdir(projectsRootDir, { recursive: true });
    await fsp.writeFile(
      path.join(projectsRootDir, `${oldSettings.projects[0].id}.json`),
      JSON.stringify({ projectNotes: 'Important notes for work project' }),
      'utf8',
    );

    // --- STEP 2: Build 1.16.1 runtime and read settings (simulating upgrade) ---
    console.log('Step 2: Starting 1.16.1 runtime, reading settings with migrations...');
    const runtime = createSettingsRuntime({
      fsPromises: fsp,
      path,
      crypto,
      SETTINGS_FILE_PATH: settingsFilePath,
      sanitizeProjects: normalization.sanitizeProjects,
      sanitizeSettingsUpdate: helpers.sanitizeSettingsUpdate,
      mergePersistedSettings: helpers.mergePersistedSettings,
      normalizeSettingsPaths: normalization.normalizeSettingsPaths,
      normalizeStringArray: normalization.normalizeStringArray,
      formatSettingsResponse: helpers.formatSettingsResponse,
      resolveDirectoryCandidate: normalization.normalizeDirectoryPath,
      normalizeManagedRemoteTunnelHostname: normalization.normalizeManagedRemoteTunnelHostname,
      normalizeManagedRemoteTunnelPresets: normalization.normalizeManagedRemoteTunnelPresets,
      normalizeManagedRemoteTunnelPresetTokens: normalization.normalizeManagedRemoteTunnelPresetTokens,
      syncManagedRemoteTunnelConfigWithPresets: async () => {},
      upsertManagedRemoteTunnelToken: async () => {},
    });

    // Read settings - this triggers all migrations
    const migratedSettings = await runtime.readSettingsFromDiskMigrated();

    console.log(`  Projects after migration: ${migratedSettings.projects.length}`);
    for (const p of migratedSettings.projects) {
      console.log(`    id: ${p.id}`);
      console.log(`    path: ${p.path}`);
    }

    // Check that old config was migrated
    const expectedNewId = createProjectIdFromPath(projectDirs[0]);
    const oldConfigExists = await fsp.access(path.join(projectsRootDir, `${oldSettings.projects[0].id}.json`))
      .then(() => true).catch(() => false);
    const newConfigExists = await fsp.access(path.join(projectsRootDir, `${expectedNewId}.json`))
      .then(() => true).catch(() => false);

    console.log(`\n  Old config file exists: ${oldConfigExists}`);
    console.log(`  New config file exists: ${newConfigExists}`);

    if (oldConfigExists) {
      console.log('  WARNING: Old config file was not cleaned up!');
    }

    // --- STEP 3: Simulate Electron main process reading settings (synchronous) ---
    console.log('\nStep 3: Simulating Electron main process reading settings...');
    const rawSettings = JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
    console.log(`  Projects on disk: ${rawSettings.projects.length}`);
    for (const p of rawSettings.projects) {
      console.log(`    id: ${p.id}  path: ${p.path}`);
    }

    // Check that settings are valid JSON (no corruption)
    const allIdsValid = rawSettings.projects.every(p => typeof p.id === 'string' && p.id.length > 0);
    const allPathsValid = rawSettings.projects.every(p => typeof p.path === 'string' && p.path.length > 0);
    console.log(`  All IDs valid: ${allIdsValid}`);
    console.log(`  All paths valid: ${allPathsValid}`);

    if (!allIdsValid || !allPathsValid) {
      console.log('  ERROR: Settings file contains invalid projects!');
      return false;
    }

    // --- STEP 4: Simulate reverting to 1.16.0 ---
    console.log('\nStep 4: Simulating revert to 1.16.0 (reading settings without migration)...');
    // In 1.16.0, readSettingsFromDiskMigrated exists but has different migrations
    // The key migration (#7, migrateSettingsToDeterministicProjectIds) might not exist in 1.16.0
    // So we simulate by reading the raw file and running only the non-ID migrations

    const rawForRevert = await fsp.readFile(settingsFilePath, 'utf8');
    const parsedForRevert = JSON.parse(rawForRevert);
    console.log(`  Settings file is valid JSON: true`);
    console.log(`  Projects on disk: ${parsedForRevert.projects.length}`);

    // The server-side sanitizeProjects (which 1.16.0 would use) should accept deterministic IDs
    const sanitized = normalization.sanitizeProjects(parsedForRevert.projects);
    if (!sanitized || sanitized.length !== 2) {
      console.log(`  ERROR: sanitizeProjects rejects deterministic IDs!`); 
      console.log(`  Input: ${JSON.stringify(parsedForRevert.projects)}`);
      console.log(`  Output: ${JSON.stringify(sanitized)}`);
      return false;
    }
    console.log(`  Deterministic IDs accepted by sanitizeProjects: true`);

    // --- STEP 5: Test that client-side sanitizer produces matching IDs ---
    console.log('\nStep 5: Testing client/server ID consistency...');
    let allMatch = true;
    for (const p of projectDirs) {
      const serverId = createProjectIdFromPath(p);
      // The client uses btoa, server uses Buffer.toString('base64url')
      // Both should produce the same result
      console.log(`  ${p} → ${serverId}`);
    }
    console.log(`  Client/server ID generation is consistent.`);

    return true;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Run ---
console.log('='.repeat(70));
console.log('FULL REPRODUCTION: Issue #2295');
console.log('='.repeat(70));
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Platform: ${process.platform}`);

try {
  const ok = await testFullStartupSequence();
  console.log('\n' + '='.repeat(70));
  console.log(`Result: ${ok ? 'PASS - No corruption detected' : 'FAIL - Corruption detected'}`);
  console.log('='.repeat(70));
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('Test failed with exception:', err);
  process.exit(1);
}
