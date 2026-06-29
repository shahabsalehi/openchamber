/**
 * Reproduction test for issue #1914:
 * File attachments omit path — only the base filename is used instead of the
 * relative/workspace path, causing the AI model to receive just "assist.ts"
 * instead of "packages/web/src/assist.ts".
 *
 * This causes the model to generate Read tool calls with incomplete paths,
 * wasting tokens or editing the wrong file when duplicate filenames exist.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { useInputStore } from "../input-store"
import type { AttachedFile } from "@/stores/types/sessionTypes"

// ---------------------------------------------------------------------------
// Reproduction of the VS Code extension.ts logic (lines 360 and 306)
// ---------------------------------------------------------------------------

/**
 * Current (buggy) implementation from line 360 of extension.ts:
 *   const fileName = uri.fsPath.replace(/\\/g, '/').split('/').pop()
 *     || vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').trim();
 *
 * This extracts only the base filename — the relative-path fallback via
 * asRelativePath is never reached because .pop() always succeeds.
 */
function currentFileNameImpl(fsPath: string): string {
  return fsPath.replace(/\\/g, '/').split('/').pop() || ''
}

/**
 * Current (buggy) implementation from line 306 of extension.ts:
 *   const filePath = vscode.workspace.asRelativePath(editor.document.uri);
 *   const filename = `${editor.document.fileName.split(/[\\/]/).pop() || filePath}:${lineRange}`;
 *
 * This extracts only the base filename for selection contexts.
 */
function currentFilenameForSelectionImpl(fileName: string, relativePath: string, lineRange: string): string {
  return `${fileName.split(/[\\/]/).pop() || relativePath}:${lineRange}`
}

/**
 * What the fix should be: use vscode.workspace.asRelativePath() for the
 * display filename, giving the model enough context to locate the file.
 */
function fixedFileNameImpl(fsPath: string, relativePath: string): string {
  return relativePath || fsPath.replace(/\\/g, '/').split('/').pop() || ''
}

/**
 * What the fix should be for selection context.
 */
function fixedFilenameForSelectionImpl(relativePath: string, lineRange: string): string {
  return `${relativePath}:${lineRange}`
}

// ---------------------------------------------------------------------------
// Test data — simulate a workspace with nested files at the same basename
// ---------------------------------------------------------------------------

const WORKSPACE_ROOT = '/home/user/project'

const TEST_FILES = [
  {
    label: 'root-level file',
    fsPath: `${WORKSPACE_ROOT}/package.json`,
    relativePath: 'package.json',
    lineRange: '1-10',
  },
  {
    label: 'nested file',
    fsPath: `${WORKSPACE_ROOT}/packages/web/src/assist.ts`,
    relativePath: 'packages/web/src/assist.ts',
    lineRange: '42-55',
  },
  {
    label: 'another file with same basename',
    fsPath: `${WORKSPACE_ROOT}/packages/vscode/src/assist.ts`,
    relativePath: 'packages/vscode/src/assist.ts',
    lineRange: '10-20',
  },
  {
    label: 'deeply nested config',
    fsPath: `${WORKSPACE_ROOT}/packages/ui/src/components/chat/message/parts/ToolPart.tsx`,
    relativePath: 'packages/ui/src/components/chat/message/parts/ToolPart.tsx',
    lineRange: '687-692',
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Issue #1914 — file attachments omit path", () => {
  describe("attachExplorerToChat (line 360 of extension.ts)", () => {
    test("BUG: current code produces only base filename for nested files", () => {
      for (const file of TEST_FILES) {
        const result = currentFileNameImpl(file.fsPath)
        const expectedBase = file.fsPath.split('/').pop() || ''
        expect(result).toBe(expectedBase)
        // The relative path is always longer/more descriptive — the bug is
        // that we send "assist.ts" instead of "packages/web/src/assist.ts".
        if (file.relativePath.includes('/')) {
          console.log(`  [${file.label}] current: "${result}" — relative path "${file.relativePath}" is NOT used`)
        }
      }
    })

    test("FIX: relative path would give model enough context", () => {
      for (const file of TEST_FILES) {
        const result = fixedFileNameImpl(file.fsPath, file.relativePath)
        expect(result).toBe(file.relativePath)
        // For nested files, the relative path is more descriptive than the base name.
        // For root-level files they are the same, which is fine.
        if (file.relativePath.includes('/')) {
          expect(result).not.toBe(file.fsPath.split('/').pop())
        }
      }
    })

    test("BUG: duplicate basenames cannot be disambiguated with current code", () => {
      // Two files with the same basename but different paths
      const file1 = TEST_FILES[1] // packages/web/src/assist.ts
      const file2 = TEST_FILES[2] // packages/vscode/src/assist.ts

      const name1 = currentFileNameImpl(file1.fsPath)
      const name2 = currentFileNameImpl(file2.fsPath)

      // Both produce identical filenames "assist.ts" — the model cannot tell them apart
      expect(name1).toBe(name2)
      expect(name1).toBe("assist.ts")

      // With the fix, they would be distinct
      const fixed1 = fixedFileNameImpl(file1.fsPath, file1.relativePath)
      const fixed2 = fixedFileNameImpl(file2.fsPath, file2.relativePath)
      expect(fixed1).not.toBe(fixed2)
      expect(fixed1).toBe("packages/web/src/assist.ts")
      expect(fixed2).toBe("packages/vscode/src/assist.ts")
    })
  })

  describe("addToContext (line 306 of extension.ts)", () => {
    test("BUG: current code produces only base filename for selection contexts", () => {
      for (const file of TEST_FILES) {
        const result = currentFilenameForSelectionImpl(
          file.fsPath,
          file.relativePath,
          file.lineRange,
        )
        const expectedBaseWithLine = `${file.fsPath.split('/').pop()}:${file.lineRange}`
        expect(result).toBe(expectedBaseWithLine)
        // e.g., "assist.ts:42-55" instead of "packages/web/src/assist.ts:42-55"
        if (file.relativePath.includes('/')) {
          console.log(`  [${file.label}] current: "${result}" — expected "${file.relativePath}:${file.lineRange}"`)
        }
      }
    })

    test("FIX: relative path in filename would give context even for selections", () => {
      for (const file of TEST_FILES) {
        const result = fixedFilenameForSelectionImpl(file.relativePath, file.lineRange)
        expect(result).toBe(`${file.relativePath}:${file.lineRange}`)
        // The context path now clearly identifies the file location
        if (file.relativePath !== file.fsPath.split('/').pop()) {
          expect(result).not.toBe(`${file.fsPath.split('/').pop()}:${file.lineRange}`)
        }
      }
    })
  })

  describe("Attachment propagation through input-store → SDK", () => {
    beforeEach(() => {
      useInputStore.setState({
        pendingInputText: null,
        pendingInputMode: "replace",
        pendingSyntheticParts: null,
        activeEditorFile: null,
      })
      useInputStore.getState().setAttachedFiles([])
    })

    test("BUG: AttachedFile.filename contains only base name (no path context)", () => {
      // Simulate what happens when a VS Code file attachment is added
      const fsPath = TEST_FILES[1].fsPath // /home/user/project/packages/web/src/assist.ts
      const buggyFileName = currentFileNameImpl(fsPath) // "assist.ts"

      useInputStore.getState().addVSCodeFileAttachment(fsPath, buggyFileName, 1024)
      const attached = useInputStore.getState().attachedFiles

      expect(attached).toHaveLength(1)
      // The filename stored on the attachment is just the base name
      expect(attached[0].filename).toBe("assist.ts")
      // The full path IS stored in vscodePath, but NOT used when sending to SDK
      expect(attached[0].vscodePath).toBe(fsPath)

      // Simulate the mapping in session-ui-store.ts line 1107-1112:
      const filesForSdk = attached.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename, // ← This is what the server sees
      }))

      // The SDK receives "assist.ts" as the filename — no path context!
      expect(filesForSdk[0].filename).toBe("assist.ts")

      // The url does contain the full path (file:// URL), but the server
      // presents the `filename` field to the AI model as the file identity.
      // url is just a data source, not the display name.
      console.log(`  SDK receives filename="${filesForSdk[0].filename}", url="${filesForSdk[0].url}"`)
      console.log(`  vscodePath (full path, not sent to SDK)="${attached[0].vscodePath}"`)
    })

    test("BUG: vscodePath is available but not included in SDK payload", () => {
      // The input store stores the full path as vscodePath, but the
      // session-ui-store mapping (line 1107-1112) does NOT include it.
      const fsPath = TEST_FILES[1].fsPath
      const buggyFileName = currentFileNameImpl(fsPath)

      useInputStore.getState().addVSCodeFileAttachment(fsPath, buggyFileName, 2048)
      const attached = useInputStore.getState().attachedFiles

      // The full path is available
      expect(attached[0].vscodePath).toBe(fsPath)

      // But the SDK payload mapping only uses filename, not vscodePath
      const filesForSdk = attached.map((a) => ({
        type: "file" as const,
        mime: a.mimeType,
        url: a.dataUrl,
        filename: a.filename,
      }))

      // `vscodePath` is NOT in the SDK payload
      expect("vscodePath" in filesForSdk[0]).toBe(false)
    })
  })
})
