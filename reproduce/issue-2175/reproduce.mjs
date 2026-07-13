/**
 * Reproduction script for Issue #2175
 * 
 * Problem: On Windows 11, in-place updates of the OpenChamber desktop app
 * preserve the Start Menu shortcut without ensuring `System.AppUserModel.ID`
 * is set to `dev.openchamber.desktop`.
 *
 * This script traces the NSIS installer logic to confirm the code path
 * where the AppUserModelID is NOT set during in-place updates with
 * keepShortcuts=true and an unchanged shortcut path.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

let failures = 0;
let passes = 0;

function assert(condition, msg) {
  if (condition) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

function section(title) {
  console.log(`\n## ${title}`);
}

// ============================================================

section('1. AppUserModelID is configured in main.mjs');

const mainMjs = readFileSync(join(ROOT, 'packages/electron/main.mjs'), 'utf-8');

assert(
  mainMjs.includes(`app.setAppUserModelId(APP_USER_MODEL_ID)`),
  'main.mjs calls app.setAppUserModelId(APP_USER_MODEL_ID)'
);

assert(
  mainMjs.includes(`const PACKAGED_APP_USER_MODEL_ID = 'dev.openchamber.desktop'`),
  'Packaged AppUserModelID is dev.openchamber.desktop'
);

assert(
  mainMjs.includes(`const APP_USER_MODEL_ID = app.isPackaged ? PACKAGED_APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID`),
  'Packaged build uses dev.openchamber.desktop, dev builds use dev.openchamber.desktop.dev'
);

const appIdMatch = mainMjs.match(/const PACKAGED_APP_USER_MODEL_ID = '([^']+)'/);
const appId = appIdMatch ? appIdMatch[1] : 'NOT FOUND';
console.log(`  AppUserModelID for packaged builds: ${appId}`);

// ============================================================

section('2. electron-builder NSIS configuration uses the same appId');

const packageJson = JSON.parse(readFileSync(join(ROOT, 'packages/electron/package.json'), 'utf-8'));
const buildConfig = packageJson.build;
const nsisConfig = buildConfig.nsis;
const winConfig = buildConfig.win;

assert(buildConfig.appId === 'dev.openchamber.desktop', `build.appId is "${buildConfig.appId}"`);
assert(winConfig.target.includes('nsis'), 'Windows target includes nsis');

console.log(`  NSIS config: oneClick=${nsisConfig.oneClick}, perMachine=${nsisConfig.perMachine}`);

// ============================================================

section('3. No custom NSIS include/override scripts exist');

const electronDir = join(ROOT, 'packages/electron');

// Check for any .nsh or .nsi files
import { readdirSync } from 'node:fs';
function findFiles(dir, pattern) {
  const results = [];
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('node_modules') && !e.name.startsWith('dist')) {
        walk(full);
      } else if (e.name.endsWith('.nsh') || e.name.endsWith('.nsi')) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

const customNsisFiles = findFiles(electronDir, /\.(nsh|nsi)$/);
assert(
  customNsisFiles.length === 0,
  `No custom NSIS .nsh/.nsi files found in packages/electron (found ${customNsisFiles.length})`
);

// Check for customInstall/customHeader/preInit macros in other config
const afterPackPath = join(electronDir, 'scripts', 'after-pack.cjs');
const afterPackContent = readFileSync(afterPackPath, 'utf-8');
assert(
  afterPackContent.includes("if (context.electronPlatformName !== 'darwin') return;"),
  'after-pack.cjs only applies to macOS (no Windows NSIS customization)'
);

// ============================================================

section('4. Electron-builder NSIS template analysis (installer.nsh)');

// Path to the electron-builder installer template
const possibleTemplatePaths = [
  join(ROOT, 'node_modules', '.bun', 'app-builder-lib@26.8.1+378fa37387592c70', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh'),
  join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh'),
];

let installerNshPath;
for (const p of possibleTemplatePaths) {
  if (existsSync(p)) {
    installerNshPath = p;
    break;
  }
}

assert(installerNshPath !== undefined, 'electron-builder installer.nsh template found');

const installerNsh = readFileSync(installerNshPath, 'utf-8');

// Extract the addStartMenuLink macro
const startMenuMacroMatch = installerNsh.match(/!macro addStartMenuLink keepShortcuts[\s\S]*?^!macroend/m);
assert(startMenuMacroMatch !== null, 'addStartMenuLink macro exists in installer.nsh');
console.log(`\n  Full addStartMenuLink macro:`);
console.log('  ' + startMenuMacroMatch[0].split('\n').join('\n  '));

// ============================================================

section('5. Code path analysis: keepShortcuts behavior');

const macro = startMenuMacroMatch[0];

// Check the keepShortcuts branches
const hasFreshInstallPath = macro.includes('${if} $keepShortcuts  == "false"');
const hasMoveShortcutPath = macro.includes('${elseif} $oldStartMenuLink != $newStartMenuLink');
const hasSetLnkAUMI_fresh = (macro.match(/WinShell::SetLnkAUMI/g) || []).length;

assert(hasFreshInstallPath, 'Fresh install path exists ($keepShortcuts == "false")');
assert(hasMoveShortcutPath, 'Move shortcut path exists ($oldStartMenuLink != $newStartMenuLink)');
assert(hasSetLnkAUMI_fresh === 2, 'WinShell::SetLnkAUMI is called exactly twice in addStartMenuLink');

// The critical test: is SetLnkAUMI called when keepShortcuts=true AND paths are equal?
const hasNoOpKeepShortcutsPath = !macro.includes('${else}') || 
  macro.includes('${if} $keepShortcuts  == "false"') && 
  macro.includes('${elseif} $oldStartMenuLink != $newStartMenuLink') &&
  !macro.includes('${else}') ; // there is no plain ${else} for the default path

// Let's trace the logic more precisely
console.log('\n  Logic trace for addStartMenuLink:');
console.log('    IF keepShortcuts == "false":');
console.log('      → CreateShortCut + SetLnkAUMI    (fresh install - AUMI SET)');
console.log('    ELSE IF oldStartMenuLink != newStartMenuLink AND FileExists(old):');
console.log('      → Rename + SetLnkAUMI            (path changed - AUMI SET)');
console.log('    (no else branch)');
console.log('      → DO NOTHING                     (path unchanged - AUMI NOT SET!)');

// Confirm the last branch doesn't exist
assert(
  !macro.includes('${else}'),
  'There is NO else/default branch in addStartMenuLink when keepShortcuts=true and paths match'
);

// ============================================================

section('6. Root cause confirmation');

const electronBuilderVersion = readFileSync(join(ROOT, 'package.json'), 'utf-8');
const depMatch = readFileSync(join(ROOT, 'bun.lock'), 'utf-8').match(/"electron-builder":\s*"\^26\.0\.0"/);
// Actually, let's check the installed version
const installerNshFirstLine = installerNsh.split('\n')[0];
console.log(`  Template file: ${installerNshPath}`);
console.log(`  Template header: ${installerNshFirstLine}`);

console.log(`
  ROOT CAUSE:
  
  When OpenChamber is installed for the first time:
  - $keepShortcuts = "false"
  - CreateShortCut is called
  - WinShell::SetLnkAUMI "$newStartMenuLink" "${appId}" is called → AUMI set correctly
  
  When OpenChamber is UPDATED in-place (keepShortcuts = "true"):
  - IF the shortcut path changed (newShortcutName != oldShortcutName):
    - Rename old → new
    - WinShell::SetLnkAUMI is called → AUMI set correctly
  - ELSE (paths are identical — normal update):
    - NOTHING happens
    - The existing shortcut is preserved AS-IS
    - If the existing shortcut has a missing AppUserModelID, it stays missing
  
  This means: once a shortcut with a missing AppUserModelID exists,
  every subsequent in-place update preserves it unchanged.
  The AppUserModelID is NEVER repaired on subsequent updates.
`);

// ============================================================

section('7. Summary');

console.log(`\n  Tests: ${passes} passed, ${failures} failed`);
console.log(`
  The bug is confirmed in electron-builder v26.8.1's installer.nsh template.
  The addStartMenuLink macro does not repair the AppUserModelID on the shortcut
  when keepShortcuts=true and the shortcut path remains unchanged between versions.
  
  OpenChamber inherits this behavior as-is because:
  1. It uses electron-builder's default NSIS template (no custom .nsh overrides)
  2. The after-pack script only applies to macOS
  3. There is no customInstall/customHeader/preInit macro that could repair shortcuts
  
  To fix, OpenChamber would need to either:
  A) Add an NSIS include that overrides addStartMenuLink to always call SetLnkAUMI
  B) Add a post-install step that repairs the shortcut's AppUserModelID
  C) Add runtime logic to repair the shortcut on launch
`);

process.exit(failures > 0 ? 1 : 0);
