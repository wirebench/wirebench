// @vitest-environment node
/**
 * The Monaco themes against `tokens.css`. Monaco wants literal hex, so `editor/themes.ts` mirrors
 * the tokens per colour theme and mode; this keeps the mirror equal to what the browser cascades.
 *
 * It lives beside the other `test/*.ts` files rather than under `test/renderer/` because it
 * imports the contrast script, which imports with `.ts` extensions the web tsconfig does not allow.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTES } from '@shared/palettes.js';
import { resolvePalette, resolveToken } from '../../../scripts/contrast-check.ts';
import {
  EDITOR_COLOURS,
  MONACO_THEMES,
  THEME_DEFINITIONS,
  monacoThemeName,
  type EditorColours,
} from '../src/renderer/editor/themes.js';

const css = readFileSync(join(import.meta.dirname, '../src/renderer/styles/tokens.css'), 'utf-8');
const MODES = ['dark', 'light'] as const;

/** The token each mirrored colour is read from. */
const TOKEN: Readonly<Record<keyof EditorColours, string>> = {
  bgBase: '--wb-bg-base',
  bgRaised: '--wb-bg-raised',
  bgSelected: '--wb-bg-selected',
  fgDefault: '--wb-fg-default',
  fgMuted: '--wb-fg-muted',
  fgSubtle: '--wb-fg-subtle',
  fgFaint: '--wb-fg-faint',
  borderDefault: '--wb-border-default',
  accent: '--wb-accent-default',
  info: '--wb-status-info',
  success: '--wb-status-success',
  warning: '--wb-status-warning',
};

describe('Monaco themes', () => {
  it('names fourteen themes, all distinct, each with a definition', () => {
    const names = PALETTES.flatMap((palette) => MODES.map((mode) => MONACO_THEMES[palette][mode]));
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
    expect(Object.keys(THEME_DEFINITIONS).sort()).toEqual([...names].sort());
  });

  it("keeps Default's names and names the rest wirebench-<palette>-<mode>", () => {
    expect(MONACO_THEMES.default).toEqual({ dark: 'wirebench-dark', light: 'wirebench-light' });
    expect(MONACO_THEMES.sandstone.light).toBe('wirebench-sandstone-light');
    expect(MONACO_THEMES['field-kit'].dark).toBe('wirebench-field-kit-dark');
  });

  it('monacoThemeName picks by mode and palette', () => {
    expect(monacoThemeName('dark', 'default')).toBe('wirebench-dark');
    expect(monacoThemeName('light', 'rind')).toBe('wirebench-rind-light');
  });

  it('paints a theme from its own colours', () => {
    const theme = THEME_DEFINITIONS[MONACO_THEMES.dusk.dark];
    expect(theme?.base).toBe('vs-dark');
    expect(theme?.colors['editor.background']).toBe(EDITOR_COLOURS.dusk.dark.bgBase);
    expect(THEME_DEFINITIONS[MONACO_THEMES.pith.light]?.base).toBe('vs');
  });

  for (const palette of PALETTES) {
    for (const mode of MODES) {
      it(`mirrors tokens.css for ${palette} ${mode}`, () => {
        // No drift for any palette, Default included (#803): every colour equals its token.
        const map = resolvePalette(css, palette, mode);
        const colours = EDITOR_COLOURS[palette][mode];
        for (const [key, token] of Object.entries(TOKEN) as [keyof EditorColours, string][]) {
          expect(colours[key], key).toBe(resolveToken(token, map).toLowerCase());
        }
      });
    }
  }
});
