// Reproduction for issue #2109 - Windows path case inconsistency
// Run: node scripts/reproductions/issue-2109-windows-path-case.js
//
// This script demonstrates how Windows paths with different casing
// produce different directory keys, causing provider/session state loss.

const path = require('path');
const os = require('os');

console.log("=== Issue #2109 - Windows Path Case Inconsistency ===\n");
console.log("Demonstrates: Inconsistent normalizePath functions on Windows\n");

// =============================================
// Inconsistent normalizePath implementations
// found across the codebase:
// =============================================

// GROUP 1: No drive letter normalization (BUG)
// useConfigStore.ts, session-ui-store.ts, useGlobalSessionsStore.ts,
// sidebar/utils.tsx, projectResolution.ts

const normalizePathNoCase = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const replaced = trimmed.replace(/\\/g, '/');
    if (replaced === '/') return '/';
    return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

// GROUP 2: With drive letter normalization
// useDirectoryStore.ts, client.ts, sync-context.tsx

const normalizePathWithCase = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const replaced = trimmed
        .replace(/\\/g, '/')
        .replace(/^([a-z]):/, (_, letter) => letter.toUpperCase() + ':');
    if (replaced === '/') return '/';
    return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

// Test paths - different sources with different casings
const testPaths = [
    { source: 'File explorer', path: 'C:\\Users\\User\\My Project' },
    { source: 'Command line (lowercase)', path: 'c:\\users\\user\\my project' },
    { source: 'Persisted settings', path: 'C:\\Users\\user\\my Project' },
    { source: 'Env variable', path: 'c:/users/user/my project' },
    { source: 'OpenCode server', path: 'c:/Users/User/My Project' },
];

console.log("--- How different path sources produce different keys ---\n");

let pass = true;
for (const { source, path: p } of testPaths) {
    const noCase = normalizePathNoCase(p);
    const withCase = normalizePathWithCase(p);
    const match = noCase === withCase;
    if (!match) pass = false;
    console.log(`  ${source}:`);
    console.log(`    Input:            ${p}`);
    console.log(`    GROUP 1 (BUG):    ${noCase}`);
    console.log(`    GROUP 2 (FIXED):  ${withCase}`);
    console.log(`    Keys match?       ${match ? '✓' : '✗'}`);
    console.log('');
}

const allNoCase = testPaths.map(p => normalizePathNoCase(p.path));
const allWithCase = testPaths.map(p => normalizePathWithCase(p.path));

console.log(`--- Consistency check (5 inputs) ---`);
console.log(`  GROUP 1 (no case norm): ${new Set(allNoCase).size} unique keys ${new Set(allNoCase).size > 1 ? '✗ INCONSISTENT' : '✓'}`);
console.log(`  GROUP 2 (with case norm): ${new Set(allWithCase).size} unique keys ${new Set(allWithCase).size > 1 ? '✗ INCONSISTENT' : '✓'}`);

console.log('\n--- Simulating directoryScoped state loss ---');
const directoryScoped = {};
const persistedKey = normalizePathWithCase('C:\\Users\\User\\My Project');
directoryScoped[persistedKey] = {
    providers: [{ id: 'anthropic', models: [{ id: 'claude-3' }] }],
    currentProviderId: 'anthropic',
    currentModelId: 'claude-3',
};
console.log(`Persisted under:  ${persistedKey}`);

const lookups = [
    'c:\\users\\user\\my project',
    'C:/Users/User/My Project',
    'c:/users/user/my project',
];
for (const lookup of lookups) {
    const key = normalizePathNoCase(lookup);
    const found = key in directoryScoped;
    console.log(`Lookup '${lookup}' → key '${key}' → ${found ? '✓ FOUND' : '✗ NOT FOUND - state lost!'}`);
    if (!found) pass = false;
}

console.log(`\n--- Summary ---`);
console.log(`The bug: normalizePath in useConfigStore.ts (and 4 other files)`);
console.log(`converts backslashes but does NOT normalize Windows drive letter casing.`);
console.log(`Other functions (normalizeDirectoryPath, normalizeCandidatePath) DO.`);
console.log(`This causes persisted state lookups to fail across sessions.`);
console.log(`\nFix: Add .replace(/^([a-z]):/, (_, l) => l.toUpperCase() + ':')`);
console.log(`to normalizeConfigPath and all other normalizePath functions.`);

process.exit(pass ? 0 : 1);
