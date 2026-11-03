import { describe, expect, it } from 'vitest';
import { lintConcurrency, lintTargets } from './lint.js';

const dir = (name: string) => ({ name, isDirectory: true });
const file = (name: string) => ({ name, isDirectory: false });

describe('lintTargets', () => {
  it('lints each app and package on its own, every other folder whole, and the root files together', () => {
    const targets = lintTargets(
      [dir('apps'), dir('packages'), dir('e2e'), dir('scripts'), file('vitest.config.ts'), file('eslint.config.js')],
      { apps: ['desktop'], packages: ['core', 'server'] },
    );
    expect(targets).toEqual([
      ['apps/desktop'],
      ['packages/core'],
      ['packages/server'],
      ['e2e'],
      ['scripts'],
      ['eslint.config.js', 'vitest.config.ts'],
    ]);
  });

  it('leaves out .git, node_modules and root files ESLint would not lint', () => {
    expect(lintTargets([dir('.git'), dir('node_modules'), file('README.md'), file('package.json')], {})).toEqual([]);
  });

  it('keeps dot folders, so the config ignores, not this script, decide what is skipped', () => {
    expect(lintTargets([dir('.claude'), dir('.github')], {})).toEqual([['.claude'], ['.github']]);
  });

  it('picks up every lintable root extension', () => {
    const names = ['a.js', 'b.mjs', 'c.cjs', 'd.ts', 'e.mts', 'f.cts', 'g.tsx', 'h.jsx'];
    expect(lintTargets(names.map(file), {})).toEqual([names]);
  });
});

describe('lintConcurrency', () => {
  const GB = 1024 ** 3;

  it('runs one at a time on a small machine', () => {
    expect(lintConcurrency(8 * GB, 4)).toBe(1);
  });

  it('runs two on a 16 GB machine', () => {
    expect(lintConcurrency(16 * GB, 4)).toBe(2);
  });

  it('never exceeds the cores or four runs', () => {
    expect(lintConcurrency(64 * GB, 2)).toBe(2);
    expect(lintConcurrency(64 * GB, 16)).toBe(4);
  });
});
