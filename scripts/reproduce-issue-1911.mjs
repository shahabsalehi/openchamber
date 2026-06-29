#!/usr/bin/env node

/**
 * Reproduction script for issue #1911:
 * "Mobile sidebar groups nested-project sessions under an ancestor (home) project"
 *
 * This script simulates the mobile session bucketing logic to verify whether
 * sessions created under a nested project are correctly assigned to the most
 * specific project, or (incorrectly) absorbed into an ancestor project.
 */

// ---------------------------------------------------------------------------
// Helpers extracted from MobileSessionsSheet.tsx
// ---------------------------------------------------------------------------

const normalizePath = (value) => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getProjectLabel = (path) => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1]?.replace(/[-_]/g, ' ') || normalized;
};

// The ORIGINAL prefix-match function that the issue reports as the root cause
const pathBelongsToRoot = (path, root) => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  return Boolean(
    normalizedPath &&
      normalizedRoot &&
      (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)),
  );
};

// The FIXED exact-match functions now used in the codebase
const findExactWorktreeMatch = (project, normalizedDirectory) =>
  project.worktrees.find((worktree) => normalizePath(worktree.path) === normalizedDirectory) ?? null;

const projectMatchesExactDirectory = (project, normalizedDirectory) =>
  normalizedDirectory === project.path || Boolean(findExactWorktreeMatch(project, normalizedDirectory));

const findExactProjectMatch = (projects, directory) => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  return projects.find((project) => projectMatchesExactDirectory(project, normalizedDirectory)) ?? null;
};

// ---------------------------------------------------------------------------
// Test data: two projects where one path is an ancestor of the other
// ---------------------------------------------------------------------------

const PROJECTS = [
  {
    id: 'home',
    label: 'me',
    path: '/Users/me',
    worktrees: [],
  },
  {
    id: 'scratch',
    label: 'Scratch',
    path: '/Users/me/scratch',
    worktrees: [],
  },
];

// Simulate a session whose `directory` equals the nested project path
const SESSION_SCRATCH = {
  id: 'ses_scratch_001',
  directory: '/Users/me/scratch',
};

// Also simulate a session whose directory is inside the nested project but deeper
const SESSION_SCRATCH_DEEPER = {
  id: 'ses_scratch_deep',
  directory: '/Users/me/scratch/subdir',
};

// A session in the home directory itself
const SESSION_HOME = {
  id: 'ses_home_001',
  directory: '/Users/me',
};

// ---------------------------------------------------------------------------
// Reproduce the OLD (buggy) behavior: prefix-match + first-match-wins
// ---------------------------------------------------------------------------

function oldBuggyBucketing(projects, session) {
  const directory = session.directory;
  if (!directory) return null;

  const node = projects.find((entry) => {
    if (pathBelongsToRoot(directory, entry.path)) return true;
    return entry.worktrees.some((wt) => pathBelongsToRoot(directory, wt.path));
  });
  return node ? { id: node.id, label: node.label, path: node.path, match: 'prefix' } : null;
}

// ---------------------------------------------------------------------------
// Reproduce the NEW (fixed) behavior: exact match
// ---------------------------------------------------------------------------

function newFixedBucketing(projects, session) {
  const directory = session.directory;
  if (!directory) return null;

  const normalizedDirectory = normalizePath(directory);
  const node = projects.find((entry) => projectMatchesExactDirectory(entry, normalizedDirectory));
  return node ? { id: node.id, label: node.label, path: node.path, match: 'exact' } : null;
}

// ---------------------------------------------------------------------------
// Run reproduction
// ---------------------------------------------------------------------------

console.log('=== Issue #1911 Reproduction ===\n');

// --- Test 1: Session created under nested project ("Scratch") ---
console.log('--- Test 1: Session under nested project (directory = /Users/me/scratch) ---');

const oldResult1 = oldBuggyBucketing(PROJECTS, SESSION_SCRATCH);
const newResult1 = newFixedBucketing(PROJECTS, SESSION_SCRATCH);

console.log(`  OLD (prefix-match): matched to project "${oldResult1.label}" (${oldResult1.id})`);
console.log(`  NEW (exact-match):  matched to project "${newResult1.label}" (${newResult1.id})`);

const wrong1 = oldResult1.id === 'home';
const correct1 = newResult1.id === 'scratch';

console.log(`  OLD ${wrong1 ? 'BUGGY ✗ — absorbed by ancestor project "me" (home)' : 'OK'}`);
console.log(`  NEW ${correct1 ? 'OK ✓ — correctly matched to "Scratch"' : 'BUGGY'}`);

// --- Test 2: Session inside nested project but deeper path ---
console.log('\n--- Test 2: Session deeper inside nested project (directory = /Users/me/scratch/subdir) ---');

const oldResult2 = oldBuggyBucketing(PROJECTS, SESSION_SCRATCH_DEEPER);
const newResult2 = newFixedBucketing(PROJECTS, SESSION_SCRATCH_DEEPER);

console.log(`  OLD (prefix-match): matched to project "${oldResult2.label}" (${oldResult2.id})`);
console.log(`  NEW (exact-match):  matched to project "${newResult2 ? newResult2.label : 'null (no match)'}" (${newResult2 ? newResult2.id : 'null'})`);

const wrong2 = oldResult2?.id === 'home';
const correct2 = newResult2 === null; // deeper path has no exact project match — expected

console.log(`  OLD ${wrong2 ? 'BUGGY ✗ — absorbed by ancestor project "me" (home)' : 'OK'}`);
console.log(`  NEW ${correct2 ? 'OK ✓ — no exact project match (correct — deeper dir not a registered project path)' : 'UNEXPECTED'}`);

// --- Test 3: Session under home directory itself ---
console.log('\n--- Test 3: Session under home directory (directory = /Users/me) ---');

const oldResult3 = oldBuggyBucketing(PROJECTS, SESSION_HOME);
const newResult3 = newFixedBucketing(PROJECTS, SESSION_HOME);

console.log(`  OLD (prefix-match): matched to project "${oldResult3.label}" (${oldResult3.id})`);
console.log(`  NEW (exact-match):  matched to project "${newResult3.label}" (${newResult3.id})`);

const correct3 = oldResult3.id === 'home' && newResult3.id === 'home';
console.log(`  ${correct3 ? 'OK ✓ — both correctly match home project' : 'UNEXPECTED'}`);

// --- Summary ---
console.log('\n=== Summary ===');
console.log(`The main session bucketing in MobileSessionsSheet.tsx now uses exact match`);
console.log(`(projectMatchesExactDirectory at line 680) instead of the prefix-match behavior`);
console.log(`that the issue describes. The main bug is NO LONGER REPRODUCIBLE in the current codebase.`);
console.log(``);
console.log(`However, the findActiveWorktreePath function (line 706) still uses pathBelongsToRoot`);
console.log(`for matching the current directory to worktrees within the active project.`);
console.log(`This could still incorrectly highlight a worktree if a project has nested worktrees.`);
console.log(``);
console.log(`Example of remaining findActiveWorktreePath prefix-match behavior:`);
// Simulate findActiveWorktreePath behavior
function findActiveWorktreePath(project, normalizedDirectory) {
  // does NOT check project.active — just simulates the worktree matching
  if (normalizedDirectory === project.path) return project.path;
  const matched = project.worktrees.find((entry) => pathBelongsToRoot(normalizedDirectory, entry.path));
  return matched?.path ?? project.path;
}

const projectWithWorktrees = {
  id: 'home',
  label: 'me',
  path: '/Users/me',
  worktrees: [
    { path: '/Users/me/worktree1', branch: 'wt1' },
    { path: '/Users/me/worktree1/sub', branch: 'wt1-sub' },
  ],
};

const remaining1 = findActiveWorktreePath(projectWithWorktrees, '/Users/me/worktree1/sub');
console.log(`  Directory: /Users/me/worktree1/sub`);
console.log(`  Worktrees: [/Users/me/worktree1, /Users/me/worktree1/sub]`);
console.log(`  Matched (prefix): ${remaining1}`);
const shouldBe = '/Users/me/worktree1/sub';
console.log(`  Expected (most specific): ${shouldBe}`);
console.log(`  ${remaining1 === shouldBe ? 'OK ✓' : 'PREFIX ISSUE ✗ — matched first worktree instead of most specific'}`);
