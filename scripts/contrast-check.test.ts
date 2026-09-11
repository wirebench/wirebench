import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTokens, contrastRatio, parseBlock, parseHex, resolveToken } from './contrast-check.ts';

const tokens = fileURLToPath(new URL('../apps/desktop/src/renderer/styles/tokens.css', import.meta.url));

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
