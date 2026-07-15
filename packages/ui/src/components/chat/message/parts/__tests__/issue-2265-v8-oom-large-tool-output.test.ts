import { describe, test, expect } from 'bun:test';
import { coerceToText, formatEditOutput, tryParseJsonOutput, parseReadToolOutput } from '../../toolRenderers';

/**
 * Reproduction test for issue #2265 — V8 Zone allocation OOM crash
 * when the renderer processes a large tool output (e.g. webfetch of a
 * Google Slides page with embedded base64 images).
 *
 * Background:
 * The reporter's Electron renderer process crashes with:
 *   ERROR:electron/shell/common/node_bindings.cc:185] OOM error in V8:
 *   Zone Allocation failed - process out of memory
 *
 * This is a Zone allocation failure (contiguous memory), not gradual heap
 * exhaustion. It happens when a tool call returns a large payload that gets
 * held as a single JS string in the rendering pipeline without any size
 * cap or chunking.
 *
 * Root cause hypothesis:
 * 1. Agent uses `webfetch` (or similar) to fetch a Google Slides URL
 * 2. The tool returns the full page HTML, which may contain embedded
 *    base64 images (screenshots of slides), large CSS/JS bundles, etc.
 * 3. This entire payload is held as `state.output` — a single JS string
 * 4. The string passes through cleanOutput(), formatEditOutput(),
 *    tryParseJsonOutput(), and eventually into WorkerHighlightedCode or
 *    SimpleMarkdownRenderer — all operating on the full string with
 *    NO size limits
 * 5. V8 attempts a Zone allocation for the string/buffer and OOMs
 *
 * These tests demonstrate the missing size guards at each stage.
 */

// ---------------------------------------------------------------------------
// Simulate a realistic large webfetch result
// ---------------------------------------------------------------------------

/**
 * Creates a simulated webfetch output of roughly the given size in bytes.
 * Models what Google Slides page HTML might look like: document structure,
 * embedded base64 images (screenshot thumbnails), CSS, and metadata.
 */
function makeSimulatedWebfetchOutput(targetBytes: number): string {
    const base64ImageChunk =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // ~100 bytes

    const chunks: string[] = [];
    chunks.push(`<!DOCTYPE html><html><head><title>Google Slides</title><style>`);
    // Add some CSS
    chunks.push('*{margin:0;padding:0;box-sizing:border-box}'.repeat(200)); // ~5KB CSS
    chunks.push(`</style></head><body>`);

    // Add document content with embedded images
    const slideTemplate = (n: number) => `
        <div class="slide" id="slide-${n}">
            <h2>Slide ${n}</h2>
            <p>Content for slide ${n}. This slide contains various elements
            like text boxes, shapes, and embedded images.</p>
            <img src="data:image/png;base64,${base64ImageChunk}" alt="Slide ${n} screenshot"/>
            <div class="shape"><p>Text box content for slide ${n}</p></div>
        </div>`;

    // Add enough slides to reach the target size
    let currentSize = chunks.join('').length;
    let slideNum = 1;
    while (currentSize < targetBytes - 10000) {
        const slide = slideTemplate(slideNum++);
        chunks.push(slide);
        currentSize += slide.length;
    }

    // Pad remaining bytes if needed
    chunks.push('</body></html>');
    // Pad to exact target with comment
    const result = chunks.join('');
    const paddingNeeded = targetBytes - result.length;
    if (paddingNeeded > 0) {
        return result + '<!-- '.repeat(Math.floor(paddingNeeded / 5));
    }
    return result;
}

// Simulate a Google Slides page fetch at roughly the size that could
// trigger Zone allocation failure in Electron renderer V8 (several MB).
// The reporter observed heap at ~800MB-1.1GB — a single multi-MB string
// in a Zone allocation is the trigger.
const MODERATE_SIZE = 5 * 1024 * 1024; // 5MB — moderate large page
const LARGE_SIZE = 20 * 1024 * 1024; // 20MB — large document with images

// ---------------------------------------------------------------------------
// Test 1: Demonstrates that the full raw output string is held in memory
//         with no size limit
// ---------------------------------------------------------------------------

describe('Issue #2265 — Large tool output handling (V8 OOM risk)', () => {

    test('coerceToText returns a very large string unchanged (no truncation)', () => {
        const large = 'x'.repeat(LARGE_SIZE);
        const result = coerceToText(large);
        // No size check — the full 20MB string passes through
        expect(result).toBe(large);
        expect(result.length).toBe(LARGE_SIZE);
    });

    test('formatEditOutput processes a large webfetch output without truncation', () => {
        const output = makeSimulatedWebfetchOutput(MODERATE_SIZE);
        // formatEditOutput applies regex-based cleanOutput on the full string
        const result = formatEditOutput(output, 'webfetch', {});
        // The full content passes through — only trimmed of whitespace
        expect(result.length).toBeGreaterThan(MODERATE_SIZE - 100);
        // No size cap was applied
        expect(result.length).toBeGreaterThan(4 * 1024 * 1024);
    });

    test('tryParseJsonOutput will attempt JSON.parse on arbitrarily large output', () => {
        // A tool might return JSON-like output that starts with `{` and ends with `}`
        const largeJsonStart = '{' + '"data":' + JSON.stringify('x'.repeat(MODERATE_SIZE));
        // tryParseJsonOutput checks startsWith/endsWith and then calls JSON.parse
        // The full oversized string is held in the `trimmed` variable
        const result = tryParseJsonOutput(largeJsonStart);
        // It will fail JSON.parse (invalid JSON due to truncation) but the check
        // itself operates on the full string
        expect(result.isJson).toBe(false);
        // No size check before JSON.parse
    });

    test('parseReadToolOutput processes full output without line limit', () => {
        // Simulate a `read` tool output with many lines
        const lines = Array.from({ length: 100000 }, (_, i) => `${i + 1}: Line ${i + 1} content here`);
        const output = `<type>file</type>\n<content>\n${lines.join('\n')}\n</content>`;

        const parsed = parseReadToolOutput(output);
        // All 100K+ lines are parsed and stored in memory (output wrapper adds 2 lines)
        expect(parsed.lines.length).toBeGreaterThanOrEqual(100000);
        // No truncation, no line limit
    });

    test('formatEditOutput runs regex cleanOutput on the full string (no size guard)', () => {
        // cleanOutput applies two regex replacements on the FULL string
        const output = '<file>\n' + makeSimulatedWebfetchOutput(MODERATE_SIZE) + '\n</file>';

        // The regex operations traverse the entire string
        const result = formatEditOutput(output, 'webfetch', {});
        // The <file> tags are stripped but the entire content is kept
        expect(result.startsWith('<!DOCTYPE')).toBe(true);
        expect(result.length).toBeGreaterThan(MODERATE_SIZE - 100);
    });
});

// ---------------------------------------------------------------------------
// Test 2: Demonstrates the code path from tool output to renderer
// ---------------------------------------------------------------------------

describe('Issue #2265 — Code path analysis for large tool output', () => {
    test('ToolPart.tsx does not check output size before rendering', () => {
        // In ToolPart.tsx, the key extraction is at lines 1509-1514:
        //   const rawOutput = stateWithData.output;
        //   const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
        //   const outputString = typeof rawOutput === 'string' ? rawOutput : '';
        //
        // There is NO size check — the full string is stored as `outputString`.
        // This is then passed to renderResultContent() -> ToolScrollableTextOutput
        // which passes it to WorkerHighlightedCode or SimpleMarkdownRenderer,
        // both of which render the full content.

        // Demonstrate that a 10MB output passes through coerceToText (the same
        // call used in ToolPart.tsx at lines 1735, 1804) without issue:
        const output = makeSimulatedWebfetchOutput(10 * 1024 * 1024);
        const coerced = coerceToText(output);
        // FULL SIZE is preserved (within a few bytes of padding rounding)
        expect(coerced.length).toBeGreaterThan(10 * 1024 * 1024 - 100);
        // No truncation — the renderer would attempt to DOM-ify this entire string
    });

    test('JSON output with large payload bypasses any size check', () => {
        // If the tool returns a large JSON object, tryParseJsonOutput parses it
        // and then renders via JsonSummaryView or JsonTreeViewer
        const largeJson = JSON.stringify({
            url: 'https://docs.google.com/presentation/d/...',
            title: 'Large Google Slides Deck',
            content: 'x'.repeat(MODERATE_SIZE),
            slides: Array.from({ length: 100 }, (_, i) => ({
                id: i,
                content: 'x'.repeat(50000),
                notes: 'y'.repeat(10000),
            })),
        });

        const result = tryParseJsonOutput(largeJson);
        expect(result.isJson).toBe(true);
        // The full parsed object is in memory
        expect(result.data).toBeTruthy();

        // In ToolPart.tsx, this would then be rendered by JsonTreeViewer
        // (which has maxHeight="400px" — CSS only, no content truncation)
        // or WorkerHighlightedCode (full code rendering)
    });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
//
// The tests above confirm the following gaps that lead to the V8 Zone
// allocation OOM described in issue #2265:
//
// 1. NO size check on `state.output` in ToolPart.tsx — the full string
//    is extracted and passed to the rendering pipeline without any limit.
//    (ToolPart.tsx, lines 1509-1514)
//
// 2. NO size check in cleanOutput/formatEditOutput — regex replacements
//    operate on the full string. (toolRenderers.tsx, lines 8-12, 121-136)
//
// 3. NO size check before JSON.parse in tryParseJsonOutput — the full
//    string is parsed. (toolRenderers.tsx, lines 91-119)
//
// 4. NO line limit in parseReadToolOutput — the entire output is split
//    into lines and processed. (toolRenderers.tsx, lines 149-211)
//
// 5. NO size truncation before WorkerHighlightedCode rendering — the
//    full output is set as innerHTML. (ToolPart.tsx, lines 958-967)
//
// 6. NO size truncation before SimpleMarkdownRenderer — the full output
//    is rendered as markdown. (ToolPart.tsx, lines 1732-1737)
//
// 7. The only visual cap is CSS max-height (e.g., max-h-[46vh]), which
//    does NOT prevent the full DOM from being constructed and attached.
//
// The reporter's specific scenario (webfetch of a Google Slides URL):
// - Agent calls webfetch on the Slides URL
// - Returns full page HTML which may include embedded base64 image data
// - The entire page HTML becomes state.output (single JS string)
// - This passes through ToolScrollableTextOutput -> WorkerHighlightedCode
// - WorkerHighlightedCode renders the full string as highlighted <pre><code>
// - If the string is large enough, V8's Zone allocator cannot satisfy the
//   contiguous allocation, and the renderer process OOMs
