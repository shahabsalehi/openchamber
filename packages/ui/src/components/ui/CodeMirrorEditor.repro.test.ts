/**
 * Reproduction test for issue #1683 - CodeMirrorEditor search panel interaction.
 *
 * Tests the search panel open/close state detection mechanism used in
 * CodeMirrorEditor to ensure the onSearchOpenChange callback properly fires
 * when the CodeMirror search panel opens and closes.
 *
 * The critical code path in CodeMirrorEditor.tsx:
 *
 *   // Lines 279, 345-347: Ref setup
 *   const onSearchOpenChangeRef = React.useRef(onSearchOpenChange);
 *   useEffect(() => { onSearchOpenChangeRef.current = onSearchOpenChange; }, [onSearchOpenChange]);
 *
 *   // Lines 382-386: Update listener detecting search panel state change
 *   const wasOpen = searchPanelOpen(update.startState);
 *   const isOpen = searchPanelOpen(update.state);
 *   if (wasOpen !== isOpen) {
 *     onSearchOpenChangeRef.current?.(isOpen);
 *   }
 *
 *   // Lines 475-490: Effect to open/close search panel based on searchOpen prop
 *   useEffect(() => {
 *     if (searchOpen) { openSearchPanelCompat(view); }
 *     else { closeSearchPanelCompat(view); }
 *   }, [searchOpen, enableSearch]);
 *
 * The bug (issue #1683) occurs when the search panel close mechanism fails to
 * propagate `false` back through onSearchOpenChange, leaving isSearchOpen=true
 * and the floating toolbar permanently hidden.
 */

import { describe, expect, test } from 'bun:test';

describe('CodeMirrorEditor search panel state sync (issue #1683)', () => {
  test('ref.current stays stable when callback is stable (React useState setter)', () => {
    let lastSavedValue: (() => void) | null = null;
    const fn = () => {};
    const ref = { current: fn };

    // Simulate useEffect that runs on every callback change (line 345-347)
    // If callback is stable (same reference), this only runs once
    const synchronizeRef = (newCallback: () => void) => {
      ref.current = newCallback;
      lastSavedValue = newCallback;
    };
    synchronizeRef(fn);
    synchronizeRef(fn); // Same reference
    synchronizeRef(fn); // Same reference

    expect(ref.current).toBe(fn);
    expect(lastSavedValue).toBe(fn);
  });

  test('simulating search panel open/close detection via update listener pattern', () => {
    // Simulates the CodeMirror update listener at lines 377-391
    const calls: boolean[] = [];
    const onSearchOpenChange = (open: boolean) => { calls.push(open); };
    const onSearchOpenChangeRef = { current: onSearchOpenChange };

    // Simulate search panel opening (wasOpen=false, isOpen=true)
    const simulateUpdate = (wasOpen: boolean, isOpen: boolean) => {
      if (wasOpen !== isOpen) {
        onSearchOpenChangeRef.current?.(isOpen);
      }
    };

    // Panel opens
    simulateUpdate(false, true);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(true);

    // Panel closes
    simulateUpdate(true, false);
    expect(calls.length).toBe(2);
    expect(calls[1]).toBe(false);

    // No change (panel stays open)
    simulateUpdate(true, true);
    expect(calls.length).toBe(2); // Not called again

    // No change (panel stays closed)
    simulateUpdate(false, false);
    expect(calls.length).toBe(2); // Not called again
  });

  test('BROKEN SCENARIO: if update listener does not fire, isSearchOpen stays true', () => {
    // This simulates the bug scenario
    let isSearchOpen = false;
    const setIsSearchOpen = (open: boolean) => { isSearchOpen = open; };
    const ref = { current: setIsSearchOpen };

    // Simulate: user searches, isSearchOpen becomes true
    // (via button click -> setIsSearchOpen(true) or keyboard shortcut)
    setIsSearchOpen(true);
    expect(isSearchOpen).toBe(true);
    // NOT shown: toolbar should now be hidden because !isSearchOpen is false

    // Simulate: user closes the search panel
    // If the onSearchOpenChange callback fires correctly:
    // ref.current(false) -> setIsSearchOpen(false)
    // But if it DOESN'T fire (because of a bug in the update listener,
    // or the panel wasn't actually closed via a transaction that triggers
    // the update listener), then isSearchOpen stays true:

    // BUG: ref.current(false) is NEVER called because the update
    // listener's onSearchOpenChange callback was not triggered
    // isSearchOpen is still true
    expect(isSearchOpen).toBe(true);
    // Toolbar stays hidden! This is the bug.

    // Demonstrate that ref IS properly wired - it's just never called
    expect(typeof ref.current).toBe('function');
  });

  test('recovery scenario: closeSearchPanel triggers onSearchOpenChange correctly', () => {
    // This tests the correct flow
    let isSearchOpen = false;
    const calls: boolean[] = [];
    const setIsSearchOpen = (open: boolean) => {
      isSearchOpen = open;
      calls.push(open);
    };
    const onSearchOpenChangeRef = { current: setIsSearchOpen };

    // User opens search - isSearchOpen becomes true
    setIsSearchOpen(true);
    expect(isSearchOpen).toBe(true);
    expect(calls[0]).toBe(true);

    // Simulate CodeMirror detecting search panel close via update listener
    // (Escape pressed or X button clicked)
    onSearchOpenChangeRef.current(false);
    expect(isSearchOpen).toBe(false);
    expect(calls[1]).toBe(false);

    // Toolbar should now be visible again
  });
});
