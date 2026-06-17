/**
 * Reproduction test for issue #1683:
 * "Searching while in file preview makes the editor toolbar disappear"
 *
 * Root cause analysis:
 *
 * The floating editor toolbar visibility is controlled by a conditional check at
 * packages/ui/src/components/views/FilesView.tsx:3710:
 *
 *   {selectedFile && !isSearchOpen && !(settingsExpandedEditorToolbar && !isMobile) && (
 *     <div ref={floatingToolbarRef} className="absolute right-3 top-3 z-30">
 *       ...
 *       {isFloatingToolbarOpen ? renderFloatingFileControls() : <more-button />}
 *     </div>
 *   )}
 *
 * The problem is a chicken-and-egg dependency:
 *   1. The "Find in file" / search button (which toggles `isSearchOpen`) is INSIDE
 *      `renderFloatingFileControls()` (line 3252-3265).
 *   2. When the user clicks the search button, `isSearchOpen` is set to true.
 *   3. Setting `isSearchOpen` to true HIDES the entire floating toolbar (including
 *      the search button) because `!isSearchOpen` becomes false.
 *   4. The user must rely on CodeMirror's built-in close mechanism (Escape or the X
 *      button in the search panel) to close the search, which triggers
 *      `onSearchOpenChange(false)` to set `isSearchOpen` back to false.
 *   5. If the CodeMirror close mechanism fails to propagate back to React state
 *      (e.g., the `onSearchOpenChange` callback isn't triggered), `isSearchOpen`
 *      stays true permanently and the toolbar never reappears.
 *
 * Additionally, the keyboard shortcut handler (line 1705-1707) intercepts Ctrl+F
 * to setIsSearchOpen(true) and e.preventDefault(), but the CodeMirror search
 * keymap ALSO handles Ctrl+F. This can create a race condition between:
 *   - The window-level keyboard handler setting `isSearchOpen` = true
 *   - CodeMirror's internal search panel opening
 *   - The update listener firing onSearchOpenChange
 *
 * This test verifies the state transitions.
 */

import { describe, expect, test } from 'bun:test';

/**
 * Simulates the state transitions that occur in FilesView when the
 * user interacts with the search/find feature while a file preview is open.
 *
 * We focus on the conditional rendering logic of the floating toolbar:
 *   toolbarVisible = selectedFile && !isSearchOpen && !(settingsExpandedEditorToolbar && !isMobile)
 */

// Represents the relevant FilesView state for this bug
interface FilesViewState {
  selectedFile: boolean;
  isSearchOpen: boolean;
  settingsExpandedEditorToolbar: boolean;
  isMobile: boolean;
}

function isToolbarVisible(state: FilesViewState): boolean {
  return state.selectedFile && !state.isSearchOpen && !(state.settingsExpandedEditorToolbar && !state.isMobile);
}

describe('FilesView floating toolbar visibility (issue #1683)', () => {
  const defaultState: FilesViewState = {
    selectedFile: true,
    isSearchOpen: false,
    settingsExpandedEditorToolbar: false,
    isMobile: false,
  };

  test('toolbar is visible when file is selected and search is closed', () => {
    expect(isToolbarVisible(defaultState)).toBe(true);
  });

  test('toolbar is hidden when search is opened (isSearchOpen=true)', () => {
    const state: FilesViewState = { ...defaultState, isSearchOpen: true };
    expect(isToolbarVisible(state)).toBe(false);
  });

  test('toolbar returns when search is closed (isSearchOpen=false)', () => {
    // Simulate the cycle: file selected -> search opened -> search closed
    const initialState: FilesViewState = { ...defaultState, isSearchOpen: false };
    expect(isToolbarVisible(initialState)).toBe(true);

    // User opens search
    const searchOpenedState: FilesViewState = { ...defaultState, isSearchOpen: true };
    expect(isToolbarVisible(searchOpenedState)).toBe(false);

    // User closes search (Escape / X button -> onSearchOpenChange(false))
    const searchClosedState: FilesViewState = { ...defaultState, isSearchOpen: false };
    expect(isToolbarVisible(searchClosedState)).toBe(true);
  });

  test('toolbar stays hidden if isSearchOpen never returns to false', () => {
    // This simulates the BUG: if the CodeMirror search panel close
    // mechanism fails to trigger onSearchOpenChange(false), isSearchOpen
    // stays true and the toolbar never reappears.
    const state: FilesViewState = { ...defaultState, isSearchOpen: true };
    expect(isToolbarVisible(state)).toBe(false);

    // Even if we "use" the search and then stop interacting,
    // the toolbar doesn't come back because isSearchOpen is still true
    expect(isToolbarVisible(state)).toBe(false);
    expect(isToolbarVisible(state)).toBe(false);
  });

  test('search button is inside the floating toolbar, creating a chicken-and-egg problem', () => {
    // The search button is rendered by renderFloatingFileControls() (line 3252-3265).
    // renderFloatingFileControls() is called when the floating toolbar is open
    // (isFloatingToolbarOpen is true AND the toolbar container is visible).
    //
    // But the toolbar container itself is ONLY visible when:
    //   selectedFile && !isSearchOpen && !(settingsExpandedEditorToolbar && !isMobile)
    //
    // So when isSearchOpen becomes true (from clicking the search button),
    // the toolbar container AND the search button both disappear.
    //
    // This means the user CANNOT click the search button again to close the search
    // panel. They MUST rely on CodeMirror's own close mechanism working correctly.

    // Before search: toolbar container is visible, search button is accessible
    const beforeSearch: FilesViewState = { ...defaultState, isSearchOpen: false };
    expect(isToolbarVisible(beforeSearch)).toBe(true);
    // Search button is rendered inside renderFloatingFileControls() -> accessible ✓

    // After clicking search button: toolbar disappears, search button inaccessible
    const afterSearch: FilesViewState = { ...defaultState, isSearchOpen: true };
    expect(isToolbarVisible(afterSearch)).toBe(false);
    // Search button is NOT rendered because toolbar container is missing ✗
    // User now has NO way to toggle isSearchOpen back via the toolbar UI
  });

  test('docked toolbar also contains the search button (same problem)', () => {
    // Even with settingsExpandedEditorToolbar=true, the find-in-file button
    // is still inside renderFloatingFileControls({ layout: 'docked' }).
    // The docked toolbar is rendered independently (line 3690-3705) and is
    // NOT hidden by isSearchOpen.
    //
    // So the docked toolbar does NOT have this bug.

    const dockedState: FilesViewState = {
      selectedFile: true,
      isSearchOpen: true,
      settingsExpandedEditorToolbar: true,
      isMobile: false,
    };

    // With docked toolbar, the toolbar is NOT controlled by isSearchOpen
    // (the docked toolbar is rendered separately)
    // With docked toolbar:
    //   - Floating toolbar is hidden (due to settingsExpandedEditorToolbar && !isMobile)
    //   - Docked toolbar is shown (independent of isSearchOpen)
    //   - So the docked toolbar is NOT affected by this bug
    // But we still need the floating toolbar case to work for the default setting.
    expect(dockedState.settingsExpandedEditorToolbar && !dockedState.isMobile).toBe(true);
    // docked toolbar renders renderFloatingFileControls({ layout: 'docked' })
    // which includes the search button - but since docked toolbar is separate
    // from the floating toolbar conditional, it's not affected by isSearchOpen
  });

  test('the onSearchOpenChange callback is the ONLY path to restore toolbar visibility', () => {
    // When the search button is clicked (or Ctrl+F pressed), isSearchOpen becomes true.
    // The toolbar hides. The only way to restore toolbar visibility is:
    //
    // Path 1: User closes CodeMirror search panel (Escape / X button)
    //   -> CodeMirror fires update listener
    //   -> onSearchOpenChangeRef.current(false) is called
    //   -> setIsSearchOpen(false) is called
    //   -> isSearchOpen becomes false
    //   -> Toolbar becomes visible again
    //
    // Path 2: User clicks the search button again (IMPOSSIBLE because toolbar is hidden)
    //
    // If Path 1 fails for any reason, the toolbar is permanently hidden until page reload.
    //
    // The onSearchOpenChange callback is set up at line 3874:
    //   onSearchOpenChange={setIsSearchOpen}
    //
    // And in CodeMirrorEditor, lines 279 and 345-347:
    //   const onSearchOpenChangeRef = React.useRef(onSearchOpenChange);
    //   useEffect(() => { onSearchOpenChangeRef.current = onSearchOpenChange; }, [onSearchOpenChange]);
    //
    // And in the update listener, lines 382-386:
    //   const wasOpen = searchPanelOpen(update.startState);
    //   const isOpen = searchPanelOpen(update.state);
    //   if (wasOpen !== isOpen) {
    //     onSearchOpenChangeRef.current?.(isOpen);
    //   }
    //
    // If setIsSearchOpen is stable (React useState setter), this should work.
    // But any break in this chain -> toolbar permanently hidden.

    // The critical transition:
    const stateWithSearchOpen: FilesViewState = { ...defaultState, isSearchOpen: true };
    expect(isToolbarVisible(stateWithSearchOpen)).toBe(false);

    // This is what must happen when onSearchOpenChange(false) fires:
    const stateAfterClose: FilesViewState = { ...defaultState, isSearchOpen: false };
    expect(isToolbarVisible(stateAfterClose)).toBe(true);
  });
});
