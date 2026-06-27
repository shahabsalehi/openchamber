/**
 * Reproduction script for issue #1875:
 * "openchamber update fails with 'detectPackageManager is not a function'"
 *
 * This demonstrates that `detectPackageManager` and `executeUpdate`
 * are not exported from package-manager.js, causing the update command to fail.
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simulate what commands-update.js does via importFromFilePath
const packageManagerPath = path.resolve(
  __dirname,
  'packages/web/server/lib/package-manager.js'
);

console.log(`Attempting dynamic import of: ${packageManagerPath}`);

try {
  const mod = await import(packageManagerPath);

  console.log(`\nExported keys: ${Object.keys(mod).join(', ')}`);

  const detectPackageManager = mod.detectPackageManager;
  const executeUpdate = mod.executeUpdate;

  console.log(`\ndetectPackageManager is: ${typeof detectPackageManager}`);
  console.log(`executeUpdate is: ${typeof executeUpdate}`);

  if (typeof detectPackageManager !== 'function') {
    console.error('\n❌ BUG REPRODUCED: detectPackageManager is not a function');
    console.error('   (it was removed from exports in commit 096cdb221)');
  } else {
    console.log('\n✅ detectPackageManager is exported');
  }

  if (typeof executeUpdate !== 'function') {
    console.error('\n❌ BUG REPRODUCED: executeUpdate is not a function');
    console.error('   (it was removed from exports in commit 096cdb221)');
  } else {
    console.log('\n✅ executeUpdate is exported');
  }

  // This is exactly what would happen at runtime in the update command
  if (typeof detectPackageManager !== 'function') {
    console.error('\n🔴 At runtime, the update command would throw:');
    console.error('   "detectPackageManager is not a function"');
  }
} catch (err) {
  console.error('Import failed:', err.message);
}
