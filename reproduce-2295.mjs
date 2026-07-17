#!/usr/bin/env node
/**
 * Reproduction script for issue #2295
 * 
 * Simulates the upgrade from 1.16.0 to 1.16.1 and then reverting to 1.16.0,
 * testing whether the settings migration chain can corrupt persistent state.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const REPO_ROOT = '/home/runner/work/openchamber/openchamber';

// ---------- Real server code imports ----------
import { createProjectIdFromPath } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/projects/project-id.js';
import { createSettingsRuntime } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/opencode/settings-runtime.js';
import { createSettingsNormalizationRuntime } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/opencode/settings-normalization-runtime.js';
import { createSettingsHelpers } from '/home/runner/work/openchamber/openchamber/packages/web/server/lib/opencode/settings-helpers.js';

// ---------- Test helper ----------
const createTestEnv = async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-repro-2295-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  
  // Create project directories on disk so realpath resolution works
  const project1Dir = path.join(tempRoot, 'my-project');
  const project2Dir = path.join(tempRoot, 'another-project');
  await fsp.mkdir(project1Dir, { recursive: true });
  await fsp.mkdir(project2Dir, { recursive: true });

  return { tempRoot, settingsFilePath, project1Dir, project2Dir, cleanup: async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }};
};

// ---------- Build the real dependency chain ----------
const buildRuntime = (settingsFilePath) => {
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

  return { runtime, normalization, helpers };
};

// ---------- Test scenarios ----------
async function runTest(name, testFn) {
  console.log(`\n=== Test: ${name} ===`);
  let pass = false;
  try {
    pass = await testFn();
  } catch (err) {
    console.error(`  FAILED with exception:`, err);
    pass = false;
  }
  console.log(`  Result: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function testSimpleMigration() {
  /** Scenario: User has 2 projects, upgrades from 1.16.0 to 1.16.1 */
  const env = await createTestEnv();
  try {
    const { runtime } = buildRuntime(env.settingsFilePath);

    // Simulate 1.16.0 settings with UUID-style project IDs
    const legacySettings = {
      version: '1.16.0',
      projects: [
        { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', path: env.project1Dir, addedAt: Date.now(), lastOpenedAt: Date.now() },
        { id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901', path: env.project2Dir, addedAt: Date.now(), lastOpenedAt: Date.now() },
      ],
      activeProjectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      themeId: 'flexoki',
      themeVariant: 'light',
    };

    await fsp.writeFile(env.settingsFilePath, JSON.stringify(legacySettings, null, 2), 'utf8');

    // Read settings through the migration chain (simulates 1.16.1 startup)
    const migratedSettings = await runtime.readSettingsFromDiskMigrated();

    // Verify: projects still exist
    if (!Array.isArray(migratedSettings.projects) || migratedSettings.projects.length !== 2) {
      console.error(`  Expected 2 projects, got ${migratedSettings.projects?.length}`);
      console.error(`  Projects:`, JSON.stringify(migratedSettings.projects, null, 2));
      return false;
    }

    // Verify: project IDs have been migrated to deterministic format
    const expectedId1 = createProjectIdFromPath(env.project1Dir);
    const expectedId2 = createProjectIdFromPath(env.project2Dir);

    if (migratedSettings.projects[0].id !== expectedId1) {
      console.error(`  Project 1 ID mismatch:`);
      console.error(`    Expected: ${expectedId1}`);
      console.error(`    Got:      ${migratedSettings.projects[0].id}`);
      return false;
    }

    if (migratedSettings.projects[1].id !== expectedId2) {
      console.error(`  Project 2 ID mismatch:`);
      console.error(`    Expected: ${expectedId2}`);
      console.error(`    Got:      ${migratedSettings.projects[1].id}`);
      return false;
    }

    // Verify: activeProjectId has been updated
    if (migratedSettings.activeProjectId !== expectedId1) {
      console.error(`  Active project ID mismatch:`);
      console.error(`    Expected: ${expectedId1}`);
      console.error(`    Got:      ${migratedSettings.activeProjectId}`);
      return false;
    }

    console.log(`  Projects migrated correctly:`);
    console.log(`    ${migratedSettings.projects[0].id}`);
    console.log(`    ${migratedSettings.projects[1].id}`);
    console.log(`    activeProjectId: ${migratedSettings.activeProjectId}`);

    // Now simulate reading settings AGAIN (this happens on every settings read)
    const migratedAgain = await runtime.readSettingsFromDiskMigrated();
    // Should be stable (no changes on second read)
    if (JSON.stringify(migratedAgain) !== JSON.stringify(migratedSettings)) {
      console.error(`  Settings changed on second read!`);
      console.error(`  First:  ${JSON.stringify(migratedSettings)}`);
      console.error(`  Second: ${JSON.stringify(migratedAgain)}`);
      return false;
    }

    console.log(`  Settings are stable across reads.`);

    // Verify: the settings on disk have the deterministic IDs
    const onDisk = JSON.parse(await fsp.readFile(env.settingsFilePath, 'utf8'));
    if (onDisk.projects[0].id !== expectedId1 || onDisk.projects[1].id !== expectedId2) {
      console.error(`  Disk settings not updated correctly`);
      return false;
    }
    console.log(`  Disk settings saved with deterministic IDs.`);

    return true;
  } finally {
    await env.cleanup();
  }
}

async function testRevertStability() {
  /** 
   * Scenario: After 1.16.1 runs, the settings file has deterministic project IDs.
   * Simulate reverting to 1.16.0 by reading without the migration (the old code path).
   */
  const env = await createTestEnv();
  try {
    const { runtime, normalization } = buildRuntime(env.settingsFilePath);

    // First, run 1.16.1 to migrate the settings
    const legacySettings = {
      version: '1.16.0',
      projects: [
        { id: 'legacy-uuid-1', path: env.project1Dir, addedAt: Date.now(), lastOpenedAt: Date.now() },
        { id: 'legacy-uuid-2', path: env.project2Dir, addedAt: Date.now(), lastOpenedAt: Date.now() },
      ],
      activeProjectId: 'legacy-uuid-1',
    };
    await fsp.writeFile(env.settingsFilePath, JSON.stringify(legacySettings, null, 2), 'utf8');
    await runtime.readSettingsFromDiskMigrated();

    // Now the file has deterministic IDs — read it raw (like 1.16.0 would)
    const rawFile = JSON.parse(await fsp.readFile(env.settingsFilePath, 'utf8'));
    
    // Verify: 1.16.0's sanitizeProjects accepts the deterministic IDs
    const sanitized = normalization.sanitizeProjects(rawFile.projects);
    if (!sanitized || sanitized.length !== 2) {
      console.error(`  sanitizeProjects rejects deterministic IDs!`);
      console.error(`  Input: ${JSON.stringify(rawFile.projects)}`);
      console.error(`  Output: ${JSON.stringify(sanitized)}`);
      return false;
    }

    // Verify: IDs are preserved by sanitizeProjects
    if (sanitized[0].id !== rawFile.projects[0].id) {
      console.error(`  sanitizeProjects changed project ID!`);
      console.error(`  Expected: ${rawFile.projects[0].id}`);
      console.error(`  Got:      ${sanitized[0].id}`);
      return false;
    }

    console.log(`  Deterministic IDs accepted by 1.16.0-compatible sanitizer.`);
    return true;
  } finally {
    await env.cleanup();
  }
}

async function testMigrationCornerCases() {
  /**
   * Test edge cases that could break during migration.
   */
  const env = await createTestEnv();
  try {
    const { runtime } = buildRuntime(env.settingsFilePath);

    // Test with a project that has an invalid path (directory doesn't exist)
    const nonexistentDir = path.join(env.tempRoot, 'nonexistent-project');

    const settings = {
      projects: [
        { id: 'valid-project', path: env.project1Dir, addedAt: Date.now(), lastOpenedAt: Date.now() },
        { id: 'nonexistent-project', path: nonexistentDir, addedAt: Date.now(), lastOpenedAt: Date.now() },
      ],
      activeProjectId: 'valid-project',
    };

    await fsp.writeFile(env.settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');

    // This should NOT throw — ENOENT is handled by safeRealpathSync
    const result = await runtime.readSettingsFromDiskMigrated();
    
    if (!Array.isArray(result.projects)) {
      console.error(`  No projects after migration with invalid path`);
      return false;
    }

    console.log(`  Migration with invalid path completed successfully.`);
    console.log(`  Projects after migration: ${result.projects.length}`);
    result.projects.forEach((p, i) => {
      console.log(`    [${i}] id=${p.id} path=${p.path}`);
    });

    return true;
  } finally {
    await env.cleanup();
  }
}

async function testPersistSettingsLoop() {
  /**
   * Test if the draftStartersCraftGoalAdded flag causes an infinite save loop.
   */
  const env = await createTestEnv();
  try {
    const { runtime, helpers } = buildRuntime(env.settingsFilePath);

    // Write initial settings
    const initialSettings = {
      projects: [],
      draftStarters: [{ type: 'command', name: 'test' }],
    };
    await fsp.writeFile(env.settingsFilePath, JSON.stringify(initialSettings, null, 2), 'utf8');

    // Simulate what the UI does: after syncing settings, if draftStartersCraftGoalAdded !== true,
    // it calls updateDesktopSettings with draftStartersCraftGoalAdded: true and the existing draftStarters
    const saved = await runtime.persistSettings({
      draftStarters: initialSettings.draftStarters,
      draftStartersCraftGoalAdded: true,
    });

    // Read back what was actually saved
    const savedOnDisk = JSON.parse(await fsp.readFile(env.settingsFilePath, 'utf8'));

    // Check if draftStartersCraftGoalAdded was persisted
    const hasFlag = savedOnDisk.draftStartersCraftGoalAdded === true;
    console.log(`  draftStartersCraftGoalAdded persisted: ${hasFlag}`);

    // Now simulate reading settings again (this is what the UI does on next sync)
    const reRead = await runtime.readSettingsFromDiskMigrated();
    
    if (hasFlag) {
      // If the flag persisted, the loop should stop
      if (reRead.draftStartersCraftGoalAdded !== true) {
        console.error(`  Flag lost during re-read!`);
        return false;
      }
      console.log(`  Flag persists across reads — no infinite loop.`);
    } else {
      // Flag was dropped by server — infinite loop would occur
      console.log(`  NOTE: Flag was dropped by server sanitizer.`);
      console.log(`  This COULD cause repeated sync attempts from the UI if`);
      console.log(`  draftStartersCraftGoalAdded is not in the sanitizer whitelist.`);
    }

    return true;
  } finally {
    await env.cleanup();
  }
}

async function testSettingsCorruptionOnFailedMigration() {
  /**
   * Test what happens when migration #7 (deterministic project IDs) runs
   * with existing project config files.
   */
  const env = await createTestEnv();
  try {
    const { runtime } = buildRuntime(env.settingsFilePath);

    const projectsDir = path.join(path.dirname(env.settingsFilePath), 'projects');
    await fsp.mkdir(projectsDir, { recursive: true });

    // Write settings with projects
    const settings = {
      projects: [
        { id: 'test-project', path: env.project1Dir, addedAt: Date.now(), lastOpenedAt: Date.now() },
      ],
      activeProjectId: 'test-project',
    };
    await fsp.writeFile(env.settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');

    // Create old-style project config file (to trigger migration)
    const oldProjectId = 'test-project';
    const expectedNewId = createProjectIdFromPath(env.project1Dir);
    await fsp.writeFile(
      path.join(projectsDir, `${oldProjectId}.json`),
      JSON.stringify({ projectNotes: 'some notes' }, null, 2),
      'utf8',
    );

    // Run migration
    const result = await runtime.readSettingsFromDiskMigrated();

    // Verify old config was migrated to new ID
    const newConfigPath = path.join(projectsDir, `${expectedNewId}.json`);
    const oldConfigExists = await fsp.access(path.join(projectsDir, `${oldProjectId}.json`))
      .then(() => true)
      .catch(() => false);
    const newConfigExists = await fsp.access(newConfigPath)
      .then(() => true)
      .catch(() => false);

    console.log(`  Old config file exists: ${oldConfigExists}`);
    console.log(`  New config file exists: ${newConfigExists}`);
    console.log(`  Settings project id: ${result.projects[0].id}`);
    console.log(`  Expected project id: ${expectedNewId}`);

    if (!newConfigExists) {
      console.error(`  New config file was not created!`);
      return false;
    }

    if (oldConfigExists) {
      console.error(`  Old config file was not deleted!`);
      return false;
    }

    return true;
  } finally {
    await env.cleanup();
  }
}

// ---------- Run all tests ----------
const tests = [
  ['Basic migration (UUID → deterministic IDs)', testSimpleMigration],
  ['Backward compatibility after revert', testRevertStability],
  ['Migration corner cases (invalid paths)', testMigrationCornerCases],
  ['Settings persist loop (draftStartersCraftGoalAdded)', testPersistSettingsLoop],
  ['Project config file migration', testSettingsCorruptionOnFailedMigration],
];

let passed = 0;
let failed = 0;

console.log('='.repeat(60));
console.log('Reproduction for Issue #2295');
console.log('='.repeat(60));
console.log(`Date: ${new Date().toISOString()}`);
console.log(`Platform: ${process.platform}`);
console.log(`CWD: ${process.cwd()}`);
console.log('='.repeat(60));

for (const [name, fn] of tests) {
  const ok = await runTest(name, fn);
  if (ok) passed++; else failed++;
}

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
