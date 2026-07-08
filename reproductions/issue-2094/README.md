# Reproduction: Issue #2094 - Chat message visual order reversed

## Summary

In the chat UI, **user messages visually appear below assistant responses** even though the DOM order is correct. Text selection confirms this: dragging down from a user message selects the assistant message **above** it.

This affects the live chat view during normal rendering.

## Reproduction Steps

1. Open any chat with multiple message exchanges (user → assistant → user → assistant)
2. Observe that assistant messages appear above the user messages that preceded them
3. Drag to select text downward from a user message — it selects the assistant message visually above it (confirming DOM order is correct while visual order is reversed)

## Root Cause

Two issues combine to create the visual reversal:

### Primary: `position: sticky` inside `transform: translateY()`

The `@tanstack/react-virtual` virtualizer (`MessageList.tsx` line 1201) wraps history items in a `transform: translateY(startOffset)` container. Per CSS specification, `transform` creates a new containing block, which breaks `position: sticky` behavior.

- **Virtualized history** (inside transform): `sticky` does not work → user header acts as `position: relative`
- **Streaming tail** (outside transform): `sticky` works normally

This inconsistency between the two rendering paths causes different visual behavior.

### Secondary: Redundant `position: relative` class

In `TurnItem.tsx` line 21, the user header has both `sticky` AND `relative` classes simultaneously:

```tsx
<div className="sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
```

The compiled Tailwind v4 CSS correctly prioritizes `sticky` (it's defined after `relative` alphabetically), but the redundant `relative` class is unnecessary and confusing.

### Stacking Context Issue

Inside the transform stacking context, the user header (`z-index: 20`) paints above the assistant block (`z-index: 0`). However:
- When sticky breaks, the user header stays in normal flow (no sticky overlap)
- Between consecutive turns, the previous turn's user header (z-20) can paint on top of the next turn's content
- The gradient div (`position: absolute; top: 100%; z-index: 0`) creates additional stacking complexity

## Files to Investigate

- `packages/ui/src/components/chat/components/TurnItem.tsx` (sticky header with redundant z-index/position classes)
- `packages/ui/src/components/chat/components/TurnAssistantBlock.tsx` (z-0 relative wrapper)
- `packages/ui/src/components/chat/MessageList.tsx` (tanstack virtualizer transform wrapper, StreamingTailContent)
- `packages/ui/src/components/chat/ChatContainer.tsx` (scroll container stacking context)

## Files in this reproduction

- `reproduce.html` — Standalone HTML reproduction demonstrating the CSS stacking context issue
- `verify-css-order.js` — Script to verify the CSS cascade order of sticky vs relative utilities

## Build output verification

To verify the CSS class ordering in the built project:

```bash
grep -oP '\.(sticky|relative)\{[^}]+\}' packages/web/dist/assets/index_*.css
```

Expected output:
```
.relative{position:relative}
.sticky{position:sticky}
```

Note that `sticky` comes AFTER `relative`, so it wins in the cascade. This confirms the correct CSS behavior, but does not fix the transform stacking context issue.
