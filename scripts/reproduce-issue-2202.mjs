#!/usr/bin/env node
/**
 * Reproduction script for issue #2202:
 * Session groupings (folders/pins/collapse/order) are lost when switching remote instances.
 *
 * Problem: Session-sidebar grouping state is stored under fixed localStorage keys with
 * no runtimeKey namespace. When switching between remote instances, the state from the
 * previous instance is still visible, and the new instance's state (if any) collides.
 *
 * This script simulates localStorage, two runtime keys, and the storage keys used by
 * the affected stores (useSessionPinnedStore, useSessionFoldersStore, and the
 * SessionSidebar component) to demonstrate the namespace collision.
 */

// ---- Simulated in-memory localStorage ----
const store = new Map();

const localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
};

// ---- Storage keys from the codebase (hardcoded, no namespace) ----
const GROUP_COLLAPSE_KEY = 'oc.sessions.groupCollapse';
const GROUP_ORDER_KEY = 'oc.sessions.groupOrder';
const PROJECT_ACTIVE_SESSION_KEY = 'oc.sessions.activeSessionByProject';
const EXPANDED_PARENTS_KEY = 'oc.sessions.expandedParents.v2';
const PROJECT_COLLAPSE_KEY = 'oc.sessions.projectCollapse';
const PINNED_KEY = 'oc.sessions.pinned';
const FOLDERS_KEY = 'oc.sessions.folders';
const FOLDER_COLLAPSE_KEY = 'oc.sessions.folderCollapse';

// ---- Simulate two remote instances ----
const runtimeA = 'url:https://instance-a.example.com';
const runtimeB = 'url:https://instance-b.example.com';

// Compare with how useUIStore already namespaces per-runtime state:
//   activeMainTabByRuntime.set(runtimeMemoryKey(runtimeKey), tab)
//   where runtimeMemoryKey uses getRuntimeKey() to build a unique key.

console.log('=== Issue #2202 Reproduction: Namespace collision for session grouping state ===\n');

// ---- Step 1: Instance A creates grouping state ----
console.log('1. Instance A stores its grouping state...');

// Expanded parents (which sessions are expanded in the tree)
localStorage.setItem(EXPANDED_PARENTS_KEY, JSON.stringify([
  'project:active:session-a-1',
  'project:active:session-a-2',
]));

// Group collapse state
localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(['root', 'worktree:path/to/a']));

// Group order per project
localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify({
  'project-a': ['archive', 'root', 'worktree:path/to/a'],
}));

// Active session per project
localStorage.setItem(PROJECT_ACTIVE_SESSION_KEY, JSON.stringify({
  'project-a': 'session-a-1',
}));

// Project collapse state
localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify(['project-a']));

// Pinned sessions
localStorage.setItem(PINNED_KEY, JSON.stringify(['session-a-1', 'session-a-3']));

// Folders
localStorage.setItem(FOLDERS_KEY, JSON.stringify({
  'project-a': [
    { id: 'folder-1', name: 'Feature work', sessionIds: ['session-a-1'], createdAt: 1000 },
  ],
}));

// Folder collapse state
localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify(['folder-1']));

console.log('   Stored keys:', JSON.stringify(Object.fromEntries(store)));

// ---- Step 2: Instance B stores ITS grouping state ----
console.log('\n2. Instance B stores its (different) grouping state...');

// Instance B has different sessions, groups, folders
localStorage.setItem(EXPANDED_PARENTS_KEY, JSON.stringify([
  'project:active:session-b-1',
]));

localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(['archived']));
localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify({
  'project-b': ['root', 'archived'],
}));
localStorage.setItem(PROJECT_ACTIVE_SESSION_KEY, JSON.stringify({
  'project-b': 'session-b-1',
}));
localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify([]));
localStorage.setItem(PINNED_KEY, JSON.stringify(['session-b-1', 'session-b-2']));
localStorage.setItem(FOLDERS_KEY, JSON.stringify({
  'project-b': [
    { id: 'folder-2', name: 'Bug fixes', sessionIds: ['session-b-2'], createdAt: 2000 },
  ],
}));
localStorage.setItem(FOLDER_COLLAPSE_KEY, JSON.stringify([]));

console.log('   Stored keys:', JSON.stringify(Object.fromEntries(store)));

// ---- Step 3: Show that Instance A's state is LOST ----
console.log('\n3. Now read back from localStorage (simulating switching back to Instance A):');
console.log('   expandedParents:', JSON.parse(localStorage.getItem(EXPANDED_PARENTS_KEY)));
console.log('   groupCollapse:', JSON.parse(localStorage.getItem(GROUP_COLLAPSE_KEY)));
console.log('   groupOrder:', JSON.parse(localStorage.getItem(GROUP_ORDER_KEY)));
console.log('   activeSessionByProject:', JSON.parse(localStorage.getItem(PROJECT_ACTIVE_SESSION_KEY)));
console.log('   projectCollapse:', JSON.parse(localStorage.getItem(PROJECT_COLLAPSE_KEY)));
console.log('   pinned:', JSON.parse(localStorage.getItem(PINNED_KEY)));
console.log('   folders:', JSON.parse(localStorage.getItem(FOLDERS_KEY)));
console.log('   folderCollapse:', JSON.parse(localStorage.getItem(FOLDER_COLLAPSE_KEY)));

// ---- Step 4: Prove the collision ----
console.log('\n4. Collision proof:');
console.log('   Instance A\'s expanded parents contained "session-a-1" and "session-a-2".');
console.log('   After Instance B wrote, they\'re gone — only Instance B\'s "session-b-1" remains.');
console.log('   Instance A\'s folder "Feature work" (folder-1) is gone, replaced by "Bug fixes" (folder-2).');
console.log('   The pinned sessions from Instance A (session-a-1, session-a-3) are gone.');
console.log('   Group ordering and collapse state also overwritten.');

// ---- Step 5: What the fix looks like ----
console.log('\n5. Expected fix: namespace keys by runtimeKey, e.g.');
console.log('   "oc.sessions.pinned"  →  "oc.sessions.pinned:url:https://instance-a.example.com"');
console.log('   This is the same pattern used by activeMainTabByRuntime in useUIStore.ts');
console.log('   (via runtimeMemoryKey(getRuntimeKey())).');

// Demonstrate the fix
const ns = (key, runtime) => `${key}:${runtime}`;
console.log('\n6. With namespaced keys, Instance A data survives:');
localStorage.clear();
// Instance A writes
localStorage.setItem(ns(EXPANDED_PARENTS_KEY, runtimeA), JSON.stringify(['project:active:session-a-1', 'project:active:session-a-2']));
localStorage.setItem(ns(PINNED_KEY, runtimeA), JSON.stringify(['session-a-1', 'session-a-3']));
localStorage.setItem(ns(FOLDERS_KEY, runtimeA), JSON.stringify({ 'project-a': [{ id: 'folder-1', name: 'Feature work', sessionIds: ['session-a-1'], createdAt: 1000 }] }));
// Instance B writes
localStorage.setItem(ns(EXPANDED_PARENTS_KEY, runtimeB), JSON.stringify(['project:active:session-b-1']));
localStorage.setItem(ns(PINNED_KEY, runtimeB), JSON.stringify(['session-b-1', 'session-b-2']));
localStorage.setItem(ns(FOLDERS_KEY, runtimeB), JSON.stringify({ 'project-b': [{ id: 'folder-2', name: 'Bug fixes', sessionIds: ['session-b-2'], createdAt: 2000 }] }));

console.log('   Instance A expanded parents:', JSON.parse(localStorage.getItem(ns(EXPANDED_PARENTS_KEY, runtimeA))));
console.log('   Instance B expanded parents:', JSON.parse(localStorage.getItem(ns(EXPANDED_PARENTS_KEY, runtimeB))));
console.log('\n   ✓ Both survive independently!');
