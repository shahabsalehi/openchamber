import React from 'react';
import { FitAddon, Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web';

import { cn } from '@/lib/utils';
import type { TerminalTheme } from '@/lib/terminalTheme';
import { getGhosttyTerminalOptions } from '@/lib/terminalTheme';
import type { TerminalChunk } from '@/stores/useTerminalStore';

let ghosttyPromise: Promise<Ghostty> | null = null;
const loadGhostty = (): Promise<Ghostty> => ghosttyPromise ??= Ghostty.load();

export type TerminalController = {
  focus: () => void;
  fit: () => void;
  getSelection: () => { text: string; startLine: number; endLine: number } | null;
};

type Props = {
  sessionKey: string;
  chunks: TerminalChunk[];
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  className?: string;
  enableTouchScroll?: boolean;
  autoFocus?: boolean;
  isVisible?: boolean;
};

const TerminalViewport = React.forwardRef<TerminalController, Props>(({
  sessionKey, chunks, onInput, onResize, theme, fontFamily, fontSize, className,
  enableTouchScroll = false, autoFocus = true, isVisible = true,
}, ref) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<GhosttyTerminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const inputRef = React.useRef(onInput);
  const resizeRef = React.useRef(onResize);
  const lastSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
  const lastChunkRef = React.useRef<number | null>(null);
  const writeQueueRef = React.useRef('');
  const writingRef = React.useRef(false);
  const visibleRef = React.useRef(isVisible);
  const [ready, setReady] = React.useState(0);
  inputRef.current = onInput;
  resizeRef.current = onResize;
  visibleRef.current = isVisible;

  const fit = React.useCallback(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal || !fitRef.current || !visibleRef.current) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width < 24 || bounds.height < 24) return;
    try {
      fitRef.current.fit();
      const next = { cols: terminal.cols, rows: terminal.rows };
      if (!lastSizeRef.current || lastSizeRef.current.cols !== next.cols || lastSizeRef.current.rows !== next.rows) {
        lastSizeRef.current = next;
        resizeRef.current(next.cols, next.rows);
      }
    } catch { /* hidden or detached */ }
  }, []);

  const flush = React.useCallback(() => {
    if (writingRef.current || !writeQueueRef.current || !terminalRef.current) return;
    const data = writeQueueRef.current;
    writeQueueRef.current = '';
    writingRef.current = true;
    terminalRef.current.write(data, () => {
      writingRef.current = false;
      if (writeQueueRef.current) flush();
    });
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let terminal: GhosttyTerminal | null = null;
    let observer: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let fitFrame: number | null = null;
    let subscriptions: Array<{ dispose: () => void }> = [];

    loadGhostty().then((ghostty) => {
      if (disposed) return;
      terminal = new GhosttyTerminal(getGhosttyTerminalOptions(fontFamily, fontSize, theme, ghostty, false));
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      terminalRef.current = terminal;
      fitRef.current = fitAddon;
      subscriptions = [terminal.onData((data) => inputRef.current(data))];
      observer = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(fit, 80);
      });
      observer.observe(container);
      setReady((value) => value + 1);
      fitFrame = requestAnimationFrame(fit);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      subscriptions.forEach((subscription) => subscription.dispose());
      terminal?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      lastSizeRef.current = null;
      lastChunkRef.current = null;
      writeQueueRef.current = '';
      writingRef.current = false;
    };
  }, [fit, fontFamily, fontSize, theme]);

  React.useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    lastChunkRef.current = null;
    writeQueueRef.current = '';
    writingRef.current = false;
    fit();
  }, [fit, ready, sessionKey]);

  React.useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (chunks.length === 0) {
      if (lastChunkRef.current !== null) terminal.reset();
      lastChunkRef.current = null;
      return;
    }
    const previous = lastChunkRef.current;
    const previousIndex = previous === null ? -1 : chunks.findIndex((chunk) => chunk.id === previous);
    if (previous !== null && previousIndex < 0) terminal.reset();
    const isReplay = previousIndex < 0;
    const pending = previousIndex >= 0 ? chunks.slice(previousIndex + 1) : chunks;
    writeQueueRef.current += pending.map((chunk) => isReplay ? (chunk.replayData ?? chunk.data) : chunk.data).join('');
    lastChunkRef.current = chunks.at(-1)?.id ?? null;
    flush();
  }, [chunks, flush, ready]);

  React.useEffect(() => {
    if (!autoFocus || !isVisible) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, isVisible, ready, sessionKey]);

  React.useEffect(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!enableTouchScroll || !container || !terminal) return;
    let pointerId: number | null = null;
    let lastY = 0;
    let remainder = 0;
    let moved = false;
    const lineHeight = Math.max(12, fontSize + 2);
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      pointerId = event.pointerId; lastY = event.clientY; moved = false;
      container.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const delta = lastY - event.clientY;
      lastY = event.clientY;
      if (Math.abs(delta) > 2) moved = true;
      remainder += delta;
      const lines = Math.trunc(remainder / lineHeight);
      if (lines) { terminal.scrollLines(lines); remainder -= lines * lineHeight; }
      if (moved && event.cancelable) event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      if (!moved) terminal.focus();
    };
    container.addEventListener('pointerdown', down);
    container.addEventListener('pointermove', move, { passive: false });
    container.addEventListener('pointerup', up);
    container.addEventListener('pointercancel', up);
    return () => {
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('pointermove', move);
      container.removeEventListener('pointerup', up);
      container.removeEventListener('pointercancel', up);
    };
  }, [enableTouchScroll, fontSize, ready]);

  React.useImperativeHandle(ref, () => ({
    focus: () => terminalRef.current?.focus(),
    fit,
    getSelection: () => {
      const terminal = terminalRef.current;
      const range = terminal?.getSelectionPosition();
      const text = terminal?.getSelection() ?? '';
      if (!range || !text.trim()) return null;
      return { text, startLine: range.start.y + 1, endLine: range.end.y + 1 };
    },
  }), [fit]);

  return (
    <div
      ref={containerRef}
      data-terminal-owner="main"
      className={cn('terminal-viewport-container h-full w-full overflow-hidden touch-none', className)}
    />
  );
});

TerminalViewport.displayName = 'TerminalViewport';
export { TerminalViewport };
