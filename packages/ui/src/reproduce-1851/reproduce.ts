/**
 * Reproduction script for issue #1851
 *
 * Demonstrates that the VS Code theme adapter passes through translucent
 * VS Code color tokens as-is for surface fills (background, elevated,
 * muted, subtle), causing tooltips and other opaque surface elements to
 * appear with transparent backgrounds.
 *
 * Run: bun --cwd packages/ui tsx src/reproduce-1851/reproduce.ts
 */

import { buildVSCodeThemeFromPalette } from '@/lib/theme/vscode/adapter';
import type { VSCodeThemePalette } from '@/lib/theme/vscode/adapter';

/**
 * Helper: check if a color string has an alpha channel.
 */
function hasAlpha(color: string): boolean {
  // rgba() / hsla() etc with alpha < 1
  const rgbaMatch = color.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9.]+)\s*\)$/i,
  );
  if (rgbaMatch) {
    return parseFloat(rgbaMatch[4]) < 1;
  }

  // #RRGGBBAA with non-FF alpha
  const hex = color.replace(/^#/, '');
  if (hex.length === 8) {
    const alpha = parseInt(hex.slice(6, 8), 16);
    return alpha < 255;
  }

  return false;
}

/**
 * Build a mock VSCodeThemePalette where the overlay tokens that
 * `buildVSCodeThemeFromPalette` uses for surface fills have
 * translucent alpha channels — simulating common VS Code themes.
 */
function buildMockPalette(isDark: boolean): VSCodeThemePalette {
  const baseText = isDark ? '#cccccc' : '#333333';

  return {
    kind: isDark ? 'dark' : 'light',
    colors: {
      // Editor overlay tokens — these are often translucent in real themes
      'chat.requestBackground': 'rgba(255, 255, 255, 0.04)',
      'chat.list.background': 'rgba(30, 30, 30, 0.9)',
      'list.inactiveSelectionBackground': 'rgba(55, 55, 61, 0.6)',
      'editor.lineHighlightBackground': '#2a2a2e33',
      'editor.background': '#1e1e1e',
      'editor.foreground': baseText,
      // editorWidget.background is often translucent in many themes
      'editorWidget.background': 'rgba(37, 37, 38, 0.85)',
      'panel.background': '#1e1e1e',
      'sideBar.background': '#252526',
      'input.background': '#3c3c3c',
      'dropdown.background': '#3c3c3c',
      // Foreground
      'interactive-session.foreground': baseText,
      'foreground': baseText,
      'descriptionForeground': '#999999',
      'input.placeholderForeground': '#999999',
      'editorWidget.foreground': baseText,
      // Border
      'widget.border': '#454545',
    },
  };
}

function main() {
  console.log('=== Reproduction: Issue #1851 — VS Code tooltip transparent background ===\n');

  const palette = buildMockPalette(true);
  const theme = buildVSCodeThemeFromPalette(palette);

  const surface = theme.colors.surface;

  console.log('Surface colors from buildVSCodeThemeFromPalette:');
  console.log(`  background:        ${surface.background}         ${hasAlpha(surface.background) ? '⚠️ HAS ALPHA (should be opaque)' : 'opaque ✓'}`);
  console.log(`  muted:             ${surface.muted}              ${hasAlpha(surface.muted) ? '⚠️ HAS ALPHA (should be opaque)' : 'opaque ✓'}`);
  console.log(`  elevated:          ${surface.elevated}           ${hasAlpha(surface.elevated) ? '⚠️ HAS ALPHA (should be opaque)' : 'opaque ✓'}`);
  console.log(`  subtle:            ${surface.subtle}             ${hasAlpha(surface.subtle) ? '⚠️ HAS ALPHA (should be opaque)' : 'opaque ✓'}`);
  console.log(`  overlay:           ${surface.overlay}            ${hasAlpha(surface.overlay) ? 'has alpha (expected)' : 'opaque'}`);
  console.log();

  console.log('Mapping to UI elements:');
  console.log('  - bg-muted → --muted → surface.muted → Tooltip, badge, chip backgrounds');
  console.log('  - bg-card  → --card  → surface.elevated → Popover, Dialog, Card');
  console.log('  - bg-background → --background → surface.background → main chat area');
  console.log('  - bg-accent → --accent → surface.subtle → input backgrounds, user bubbles');
  console.log('  - overlay → modal backdrops (intentionally translucent)');
  console.log();

  // Check which opaque fills are translucent
  const opaqueFills: Record<string, string> = {
    background: surface.background,
    muted: surface.muted,
    elevated: surface.elevated,
    subtle: surface.subtle,
  };
  const issues: string[] = [];
  for (const [name, color] of Object.entries(opaqueFills)) {
    if (hasAlpha(color)) {
      issues.push(`${name} (${color})`);
    }
  }

  if (issues.length > 0) {
    console.log('🐛 BUG REPRODUCED: The following opaque surface fills are translucent:');
    issues.forEach((i) => console.log(`   - ${i}`));
    console.log();

    console.log('Root cause:');
    console.log(
      '  buildVSCodeThemeFromPalette reads VS Code overlay tokens that commonly have alpha',
      '  (chat.requestBackground, list.inactiveSelectionBackground,',
      '  editor.lineHighlightBackground, editorWidget.background, etc.)',
      '  and uses them directly for surface fills without flattening the alpha channel.',
    );
    console.log();
    console.log('Expected fix:');
    console.log(
      '  Flatten the alpha channel on surface fills (background, elevated, muted, subtle)',
      '  before returning the theme object, so that already-opaque values pass through',
      '  unchanged but translucent overlay tokens become solid.',
    );
    process.exit(1);
  } else {
    console.log('✅ No opaque surface fills found — bug may already be fixed.');
    process.exit(0);
  }
}

main();
