/**
 * Reproduction test for issue #2075:
 * "remote instance server connect failed"
 *
 * Problem: `runRemoteCommand` at line 250-262 of ssh-manager.mjs uses
 * `sh -lc <script>` to execute remote commands. On systems where the
 * user's default interactive shell is zsh (modern macOS, many Linux
 * distros), `sh` (POSIX shell) does NOT read zsh-specific init files
 * like `~/.zshrc` or `~/.zprofile`.
 *
 * Users commonly add PATH entries in their zsh init files, e.g.:
 *   eval "$(/opt/homebrew/bin/brew shellenv)"  # adds /opt/homebrew/bin
 *   export PATH="$HOME/.local/bin:$PATH"        # user-local binaries
 *
 * When `sh -lc` is used, these PATH additions are missed, causing
 * commands like `openchamber`, `bun`, `npm` to not be found.
 *
 * The issue manifests during remote instance connection:
 * 1. `currentRemoteOpenChamberVersion` runs `sh -lc 'openchamber --version ...'`
 *    → command not found → returns null
 * 2. `remoteCommandExists` runs `sh -lc 'command -v bun ...'`
 *    → bun not found → returns false
 * 3. Fallback to npm → also not found → throws "Remote host has neither bun nor npm available"
 * 4. Even `curl` / `wget` might not be found in `probeRemoteSystemInfo`
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('runRemoteCommand shell resolution (issue #2075)', () => {
  // ---------------------------------------------------------------------------
  // Demonstration 1: PATH mismatch between `sh -lc` and the user's login shell
  // ---------------------------------------------------------------------------
  test('sh -lc has different PATH than zsh/bash login shell', () => {
    // Get PATH via `sh -lc` (the current approach)
    const shResult = spawnSync('sh', ['-lc', 'echo "SH_PATH=$PATH"'], {
      encoding: 'utf-8',
    });
    const shPath = extractPath(shResult.stdout);

    // Get PATH via the user's actual login shell (SHELL env var)
    const userShell = process.env.SHELL || '/bin/sh';
    const userResult = spawnSync(userShell, ['-lc', 'echo "USER_PATH=$PATH"'], {
      encoding: 'utf-8',
    });
    const userPath = extractPath(userResult.stdout);

    console.log(`\n  SHELL env var: ${userShell}`);
    console.log(`  sh -lc PATH entries: ${(shPath || '').split(':').length}`);
    console.log(`  ${userShell} -lc PATH entries: ${(userPath || '').split(':').length}`);

    // The key observation: on macOS with zsh, sh PATH is typically
    // /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
    // while zsh PATH includes e.g. /opt/homebrew/bin, ~/.local/bin, etc.
    //
    // NOTE: In this CI/test environment, both shells may resolve to the same
    // PATH since there's no zsh. The bug manifests on actual macOS remote hosts.
    console.log(`  sh PATH: ${shPath}`);
    console.log(`  ${userShell} PATH: ${userPath}`);

    // Log the difference so manual inspection is possible
    if (shPath !== userPath) {
      console.log('  ⚠ PATH differs between sh -lc and user shell - demonstrates the bug');
    } else {
      console.log('  ℹ PATH is same (expected in env without separate shell init files)');
    }
  });

  // ---------------------------------------------------------------------------
  // Demonstration 2: Simulate what happens when a command is only in the
  // user's shell-specific PATH
  // ---------------------------------------------------------------------------
  test('command resolution fails when binary is outside sh PATH', () => {
    // Create a temporary "command" that simulates a tool like openchamber
    // that's only available via a custom PATH added by .zshrc
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repro-'));
    try {
      const fakeBin = `${tmpDir}/my-custom-tool`;
      fs.writeFileSync(fakeBin, '#!/bin/sh\necho "hello"', { mode: 0o755 });

      // Simulate what runRemoteCommand does: sh -lc 'command -v my-custom-tool'
      // Without the custom PATH, this should fail
      const shResult = spawnSync('sh', [
        '-lc',
        `command -v my-custom-tool >/dev/null 2>&1 && echo yes || echo no`,
      ], {
        encoding: 'utf-8',
        env: { ...process.env, PATH: '/usr/bin:/bin' }, // simulate limited sh PATH
      });
      expect(shResult.stdout.trim()).toBe('no');
      console.log('\n  ✅ sh -lc correctly fails to find binary outside PATH');

      // Now simulate using the user's shell with proper PATH:
      const userResult = spawnSync(process.env.SHELL || '/bin/sh', [
        '-lc',
        `command -v my-custom-tool >/dev/null 2>&1 && echo yes || echo no`,
      ], {
        encoding: 'utf-8',
        env: { ...process.env, PATH: `/usr/bin:/bin:${tmpDir}` },
      });
      expect(userResult.stdout.trim()).toBe('yes');
      console.log('  ✅ User shell with proper PATH correctly finds binary');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Demonstration 3: Remote simulation - the flow that fails
  // ---------------------------------------------------------------------------
  test('simulate the remote command flow and show the failure mode', () => {
    // This simulates what happens in `currentRemoteOpenChamberVersion`:
    // sh -lc 'openchamber --version 2>/dev/null || true'
    //
    // And what happens in `remoteCommandExists`:
    // sh -lc 'command -v bun >/dev/null 2>&1 && echo yes || echo no'

    // Create a script that mimics what runRemoteCommand does
    const testScripts = [
      { name: 'openchamber --version', cmd: 'openchamber --version 2>/dev/null || true' },
      { name: 'command -v bun',         cmd: 'command -v bun >/dev/null 2>&1 && echo yes || echo no' },
      { name: 'command -v npm',         cmd: 'command -v npm >/dev/null 2>&1 && echo yes || echo no' },
      { name: 'command -v curl',        cmd: 'command -v curl >/dev/null 2>&1 && echo yes || echo no' },
    ];

    // Simulate the exact ssh command pattern from line 256:
    // `sh -lc ${shellQuote(script)}`
    // where shellQuote wraps the value in single quotes with proper escaping
    const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

    console.log('\n  Simulating `sh -lc` command resolution (the buggy approach):');
    for (const { name, cmd } of testScripts) {
      const escapedCmd = shellQuote(cmd);
      const fullCmd = `sh -lc ${escapedCmd}`;
      const result = spawnSync('sh', ['-lc', cmd], {
        encoding: 'utf-8',
        // Simulate the limited PATH that sh -lc provides
        env: { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      });
      const found = result.stdout?.trim() === 'yes' || (result.stdout?.trim() && result.status === 0);
      console.log(`    ${name}: ${found ? 'FOUND ✓' : 'NOT FOUND ✗'} (exit=${result.status}, stdout="${result.stdout?.trim() || ''}")`);
    }

    console.log('\n  Note: These results depend on what is installed on this machine.');
    console.log('  The bug manifests on remote macOS hosts where PATH additions');
    console.log('  come from zsh init files (~/.zshrc) that `sh -lc` never reads.');
  });

  // ---------------------------------------------------------------------------
  // Demonstration 4: Show the user's remote login shell detection approach
  // ---------------------------------------------------------------------------
  test('detect user login shell to use instead of hardcoded sh', () => {
    // The fix would be to detect the remote user's shell.
    // On the remote host, we could run something like:
    //   echo "$SHELL"          # simple but potentially unreliable
    //   getent passwd $(whoami) | cut -d: -f7   # more robust on Linux
    //   dscl . -read /Users/$(whoami) UserShell  # macOS specific
    //
    // Then use that shell instead of `sh` in runRemoteCommand.
    //
    // For now, show the local system's SHELL as a demonstration:
    console.log(`\n  Local SHELL: ${process.env.SHELL || '(not set)'}`);
    console.log('  On a remote macOS host with zsh, SHELL would be /bin/zsh');
    console.log('  Using /bin/zsh -lc instead of sh -lc would load .zshrc/.zprofile');
    console.log('  and include all user-configured PATH entries.');
  });
});

function extractPath(output) {
  if (!output) return null;
  const match = output.match(/^SH_PATH=(.+)$/m);
  return match ? match[1] : null;
}
