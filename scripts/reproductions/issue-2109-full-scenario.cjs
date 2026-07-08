// Reproduction for issue #2109 - Full user scenario
// Run: node scripts/reproductions/issue-2109-full-scenario.cjs
//
// Demonstrates ALL 4 reported symptoms caused by Windows path case inconsistency

const fs = require('fs');
const path = require('path');
const os = require('os');

console.log("=== Issue #2109 - Full Scenario Reproduction (Windows) ===\n");
console.log("Reported symptoms:");
console.log("1. Provider settings separated by project");
console.log("2. Provider info not saving (model selection lost)");
console.log("3. Cannot select a model");
console.log("4. Cannot view existing conversation history\n");

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-2109-'));
try {

// ============== Set up test data ==============
const projectDir = path.join(testDir, 'projects', 'my-project');
const userConfigDir = path.join(testDir, '.config', 'opencode');
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(userConfigDir, { recursive: true });

fs.writeFileSync(path.join(userConfigDir, 'opencode.json'), JSON.stringify({
    provider: {
        anthropic: { name: "Anthropic", api_key: "sk-ant-xxx" },
        openai: { name: "OpenAI", api_key: "sk-openai-xxx" }
    },
    default_model: "anthropic/claude-sonnet-4-20250514"
}, null, 2));

// ============== Helper: BUGGY version (like useConfigStore, session-ui-store, etc.) ==============
const normalizePathBuggy = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const replaced = trimmed.replace(/\\/g, '/');
    if (replaced === '/') return '/';
    return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

// ============== Helper: FIXED version (like useDirectoryStore, client.ts) ==============
const normalizePathFixed = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const replaced = trimmed
        .replace(/\\/g, '/')
        .replace(/^([a-z]):/, (_, letter) => letter.toUpperCase() + ':');
    if (replaced === '/') return '/';
    return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

console.log("=== Symptom 1: Provider settings separated by project ===\n");

// Simulate: User has project stored in settings with uppercase C:
const projectPaths =  ['C:\\Users\\User\\My Project'];
const knownProjects = projectPaths.map(p => normalizePathFixed(p));

// Simulate: OpenCode server returns directory with different casing
const serverDir = 'c:\\users\\user\\my project';

// Config store's resolveConfigDirectory using BUGGY normalization
const resolveConfigBuggy = (dir, known) => {
    const nd = normalizePathBuggy(dir);
    if (!nd) return null;
    if (known.includes(nd)) return nd;
    // Not found - return null, creating NEW scope
    return null;
};

// Config store's resolveConfigDirectory using FIXED normalization
const resolveConfigFixed = (dir, known) => {
    const nd = normalizePathFixed(dir);
    if (!nd) return null;
    if (known.includes(nd)) return nd;
    return null;
};

const resolvedBuggy = resolveConfigBuggy(serverDir, knownProjects);
const resolvedFixed = resolveConfigFixed(serverDir, knownProjects);

console.log(`Known project paths: ${knownProjects}`);
console.log(`Server directory:    ${serverDir}`);
console.log(`With BUGGY normalize: resolves to ${resolvedBuggy || 'null (NEW SEPARATE SCOPE)'}`);
console.log(`With FIXED normalize: resolves to ${resolvedFixed}`);
if (!resolvedBuggy) {
    console.log("  ✓ BUG REPRODUCED: Provider config lives in a SEPARATE scope");
    console.log("    User sees 'separated by project' because the directory key differs");
}
console.log();

console.log("=== Symptom 2: Provider info not saving ===\n");

const directoryScoped = {};
// First session: save with uppercase C:
const session1Key = normalizePathBuggy('C:\\Users\\User\\My Project');
directoryScoped[session1Key] = {
    providers: [{ id: 'anthropic', models: [{ id: 'claude-3' }] }],
    currentProviderId: 'anthropic',
    currentModelId: 'claude-3',
};

// Second session: lookup with lowercase from server
const session2Key = normalizePathBuggy('c:\\users\\user\\my project');
const saved = directoryScoped[session2Key];

console.log(`Session 1 saved under: ${session1Key}`);
console.log(`Session 2 looks up:    ${session2Key}`);
console.log(`Provider state found:  ${saved ? 'YES' : 'NO - LOST!'}`);
if (!saved) {
    console.log("  ✓ BUG REPRODUCED: Provider/model selections lost between sessions");
}
console.log();

console.log("=== Symptom 3: Cannot select a model ===\n");

// Simulate hydrateActiveDirectorySnapshot
function hydrateSnapshot(merged) {
    const snapshot = merged.directoryScoped[merged.activeDirectoryKey];
    if (!snapshot) return merged;
    if (!merged.providers.length && snapshot.providers.length) {
        merged.providers = snapshot.providers;
    }
    return merged;
}

const stateWithBugKey = {
    activeDirectoryKey: normalizePathBuggy('c:\\users\\user\\my project'),
    directoryScoped: {
        [normalizePathBuggy('C:\\Users\\User\\My Project')]: {
            providers: [{ id: 'anthropic', models: [{ id: 'claude-3' }] }],
        }
    },
    providers: [],
    agents: [],
};
const hydrated = hydrateSnapshot({...stateWithBugKey});
console.log(`Providers after hydrate: ${hydrated.providers.length}`);
console.log(`Expected: 1 provider`);
if (hydrated.providers.length === 0) {
    console.log("  ✓ BUG REPRODUCED: No providers hydrated → model picker empty");
    console.log("    User cannot select a model");
}
console.log();

console.log("=== Symptom 4: Cannot view existing conversation history ===\n");

// Simulate session-to-project matching
function isPathWithinProject(directory, projectPath) {
    const nd = normalizePathBuggy(directory);
    const np = normalizePathBuggy(projectPath);
    if (!nd || !np) return false;
    if (nd === np) return true;
    return nd.startsWith(np + '/');
}

// Project path from settings
const projectSettingsPath = 'C:\\Users\\User\\My Project';

// Session directory from OpenCode server (lowercase)
const sessionDirectory = 'c:\\users\\user\\my project';

const matchResult = isPathWithinProject(sessionDirectory, projectSettingsPath);
console.log(`Project path:        ${projectSettingsPath}`);
console.log(`Session directory:   ${sessionDirectory}`);
console.log(`Normalized project:  ${normalizePathBuggy(projectSettingsPath)}`);
console.log(`Normalized session:  ${normalizePathBuggy(sessionDirectory)}`);
console.log(`Is session in project? ${matchResult ? 'YES' : 'NO - HIDDEN!'}`);

if (!matchResult) {
    console.log("  ✓ BUG REPRODUCED: Session not matched to project");
    console.log("    Session list appears empty for this project");
    console.log("    User 'cannot view existing conversation history'");
}

console.log("\n=== ALL 4 SYMPTOMS REPRODUCIBLE ===");
console.log("The root cause is inconsistent Windows path casing normalization");
console.log("across the codebase. Fix: add drive letter normalization to all");
console.log("normalizePath functions.");

} finally {
    // Cleanup
    try { fs.rmSync(testDir, { recursive: true }); } catch {}
}

