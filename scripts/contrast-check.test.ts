import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SITE_PAIRS,
  checkTokens,
  contrastRatio,
  parseBlock,
  parseHex,
  parseMediaBlock,
  resolveToken,
} from './contrast-check.ts';

const tokens = fileURLToPath(new URL('../apps/desktop/src/renderer/styles/tokens.css', import.meta.url));
const siteTokens = fileURLToPath(new URL('../site/src/styles/tokens.css', import.meta.url));

describe('contrast maths', () => {
  it('matches the WCAG reference ratios', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The canonical 4.54:1 example from the WCAG techniques.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('expands shorthand hex', () => {
    expect(parseHex('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
    expect(parseHex('#a1b2c3')).toEqual([0xa1, 0xb2, 0xc3]);
  });

  it('follows var() indirection between tokens', () => {
    const declarations = parseBlock(':root { --wb-a: #123456; --wb-b: var(--wb-a); }', ':root');
    expect(resolveToken('--wb-b', declarations)).toBe('#123456');
  });

  it('parses a block that contains nested braces', () => {
    // A theme block may hold an at-rule (a nested `@media`), so the parser has to count braces
    // rather than stop at the first `}`.
    const css = ':root { --wb-a: #123456; @media (any-hover) { --wb-a: #654321; } --wb-b: #abcdef; }';
    const declarations = parseBlock(css, ':root');
    expect(declarations.get('--wb-b')).toBe('#abcdef');
  });

  it('rejects a token nothing defines', () => {
    const declarations = parseBlock(':root { --wb-a: #123456; }', ':root');
    expect(() => resolveToken('--wb-missing', declarations)).toThrow(/does not define/);
  });
});

describe('the committed tokens', () => {
  it('clear WCAG AA on every pair the UI renders, in both themes', async () => {
    const results = checkTokens(await readFile(tokens, 'utf-8'));
    const failures = results.filter((result) => !result.passed);
    expect(failures.map((failure) => `${failure.theme} ${failure.pair.fg} on ${failure.pair.bg}`)).toEqual([]);
    // Both themes, so every pair is checked twice.
    expect(results.filter((result) => result.theme === 'light')).toHaveLength(results.length / 2);
  });

  it('gates --wb-fg-faint as text on every surface it paints text on', async () => {
    const results = checkTokens(await readFile(tokens, 'utf-8'));
    const faint = results.filter((result) => result.pair.fg === '--wb-fg-faint');
    expect(faint.map((result) => result.pair.bg).sort()).toEqual(
      ['--wb-bg-base', '--wb-bg-raised', '--wb-bg-sunken', '--wb-bg-base', '--wb-bg-raised', '--wb-bg-sunken'].sort(),
    );
    expect(faint.every((result) => result.pair.kind === 'text' && result.minimum === 4.5)).toBe(true);
  });
});

describe('parseMediaBlock', () => {
  const css = `
    :root { --wb-bg-base: #151413; --wb-fg-default: #ece9e3; }
    @media (prefers-color-scheme: light) {
      :root { --wb-bg-base: #faf8f5; }
    }
  `;

  it('reads the :root declarations inside the media query and ignores the dark block', () => {
    const light = parseMediaBlock(css, 'prefers-color-scheme: light');
    expect(light.get('--wb-bg-base')).toBe('#faf8f5');
    // Only what the query restates: the dark block's other tokens are not in it.
    expect(light.has('--wb-fg-default')).toBe(false);
  });

  it('throws when the query is absent', () => {
    expect(() => parseMediaBlock(':root { --wb-a: #123456; }', 'prefers-color-scheme: light')).toThrow(/no @media/);
  });
});

describe('the site tokens', () => {
  it('clear every SITE_PAIRS pair in both themes', async () => {
    const results = checkTokens(await readFile(siteTokens, 'utf-8'), { pairs: SITE_PAIRS, light: 'media' });
    const failures = results.filter((result) => !result.passed);
    expect(failures.map((failure) => `${failure.theme} ${failure.pair.fg} on ${failure.pair.bg}`)).toEqual([]);
    expect(results).toHaveLength(SITE_PAIRS.length * 2);
    expect(results.filter((result) => result.theme === 'light')).toHaveLength(SITE_PAIRS.length);
  });

  it('only name tokens the site file defines', () => {
    const names = SITE_PAIRS.flatMap((pair) => [pair.fg, pair.bg]);
    expect(new Set(names)).toEqual(
      new Set([
        '--wb-fg-default',
        '--wb-fg-muted',
        '--wb-bg-base',
        '--wb-bg-raised',
        '--wb-bg-sunken',
        '--wb-accent-default',
        '--wb-accent-fg',
      ]),
    );
  });

  it('fails a muted foreground that is too light on the light base surface', () => {
    const css = `
      :root {
        --wb-bg-base: #151413; --wb-bg-raised: #1c1b19; --wb-bg-sunken: #0f0e0d;
        --wb-fg-default: #ece9e3; --wb-fg-muted: #a49d93;
        --wb-accent-default: #d97757; --wb-accent-fg: #151413;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --wb-bg-base: #faf8f5; --wb-bg-raised: #f2eee8; --wb-bg-sunken: #ebe6de;
          --wb-fg-default: #1c1917; --wb-fg-muted: #999999;
          --wb-accent-default: #a04627; --wb-accent-fg: #faf8f5;
        }
      }
    `;
    const results = checkTokens(css, { pairs: SITE_PAIRS, light: 'media' });
    const muted = results.find(
      (result) => result.theme === 'light' && result.pair.fg === '--wb-fg-muted' && result.pair.bg === '--wb-bg-base',
    );
    expect(muted?.passed).toBe(false);
  });

  it('is not fooled by a :root block outside the media query', () => {
    // The dark block is first; the light result must come from the media block alone.
    const results = checkTokens(
      ':root { --wb-bg-base: #000000; --wb-fg-default: #ffffff; } @media (prefers-color-scheme: light) { :root { --wb-bg-base: #ffffff; } }',
      { pairs: [{ fg: '--wb-fg-default', bg: '--wb-bg-base', kind: 'text', where: 'fixture' }], light: 'media' },
    );
    const light = results.find((result) => result.theme === 'light');
    // Light layers the media block over dark: white on white, not white on black.
    expect(light?.bgValue).toBe('#ffffff');
    expect(light?.passed).toBe(false);
  });
});
