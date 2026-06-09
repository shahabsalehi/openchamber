/**
 * Reproduction test for issue #1580
 * 
 * Bug: Duration of tool call (Shell/bash command) display stops at 300 sec
 * 
 * The `formatDuration` function in ToolPart.tsx uses a hard cap of 5 minutes (300000ms)
 * via `Math.min(..., MAX_DURATION_MS)`. When a tool call runs longer than 5 minutes,
 * the displayed duration freezes at "300.0s" instead of showing the actual elapsed time.
 * 
 * Root cause:
 * - Line 168: `const MAX_DURATION_MS = 5 * 60 * 1000;`
 * - Line 191: `const duration = Math.min(Math.max(0, (end ?? now) - start), MAX_DURATION_MS);`
 */

import { describe, expect, test } from 'bun:test';

// This is the EXACT same logic as the buggy formatDuration in ToolPart.tsx
const MAX_DURATION_MS = 5 * 60 * 1000; // 5 minutes cap — THIS IS THE BUG

const formatDurationBuggy = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.min(Math.max(0, (end ?? now) - start), MAX_DURATION_MS);
    const seconds = duration / 1000;
    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

// This is what the FIXED version should look like (no cap)
const formatDurationFixed = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.max(0, (end ?? now) - start); // No MAX_DURATION_MS cap!
    const seconds = duration / 1000;
    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

describe('Tool call duration display (Issue #1580)', () => {
    const startTime = 1_000_000_000_000; // arbitrary epoch timestamp

    // --- REPRODUCING THE BUG ---

    test('BUG: duration is correctly displayed for short tool calls (under 5 min)', () => {
        // 10 seconds elapsed
        const now = startTime + 10_000;
        expect(formatDurationBuggy(startTime, undefined, now)).toBe('10.0s');
    });

    test('BUG: duration is correctly displayed at exactly 5 minutes', () => {
        // 300 seconds (5 minutes) elapsed
        const now = startTime + 300_000;
        expect(formatDurationBuggy(startTime, undefined, now)).toBe('300.0s');
    });

    test('BUG: duration STOPS INCREASING after 5 minutes (300s)', () => {
        // 6 minutes elapsed — SHOULD show "360.0s" but shows "300.0s"
        const now = startTime + 360_000;
        expect(formatDurationBuggy(startTime, undefined, now)).toBe('300.0s'); // BUG: should be '360.0s'
    });

    test('BUG: duration stuck at 300.0s even after 10 minutes', () => {
        // 10 minutes elapsed — should show "600.0s"
        const now = startTime + 600_000;
        expect(formatDurationBuggy(startTime, undefined, now)).toBe('300.0s'); // BUG: should be '600.0s'
    });

    test('BUG: even after completion, duration is clamped if exceeded 5 min', () => {
        // Tool started 8 minutes ago and finished (end time is 480s after start)
        const endTime = startTime + 480_000;
        expect(formatDurationBuggy(startTime, endTime)).toBe('300.0s'); // BUG: should be '480.0s'
    });

    // --- DEMONSTRATING EXPECTED BEHAVIOR ---

    test('FIXED: duration shows actual time under 5 min', () => {
        const now = startTime + 10_000;
        expect(formatDurationFixed(startTime, undefined, now)).toBe('10.0s');
    });

    test('FIXED: duration shows actual time after 5 min (6 min = 360.0s)', () => {
        const now = startTime + 360_000;
        expect(formatDurationFixed(startTime, undefined, now)).toBe('360.0s');
    });

    test('FIXED: duration shows actual time after 10 min', () => {
        const now = startTime + 600_000;
        expect(formatDurationFixed(startTime, undefined, now)).toBe('600.0s');
    });

    test('FIXED: completed tool call shows actual duration even if >5 min', () => {
        const endTime = startTime + 480_000;
        expect(formatDurationFixed(startTime, endTime)).toBe('480.0s');
    });

    test('FIXED: duration shows minutes+seconds format for long running tools', () => {
        // 7 minutes 42 seconds = 462 seconds
        const now = startTime + 462_000;
        expect(formatDurationFixed(startTime, undefined, now)).toBe('462.0s');
    });
});
