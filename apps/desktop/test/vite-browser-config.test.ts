// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Rollup } from 'vite';
import { failOnBrowserExternal } from '../vite.browser.config.js';

describe('vite.browser.config failOnBrowserExternal', () => {
  it('turns a "externalized for browser compatibility" warning into a build error', () => {
    const warning: Rollup.RollupLog = {
      plugin: 'vite:resolve',
      message:
        'Module "node:fs" has been externalized for browser compatibility, imported by "/src/x.ts". See https://vite.dev/guide/troubleshooting.html',
    };
    const warn = vi.fn();
    expect(() => {
      failOnBrowserExternal(warning, warn);
    }).toThrow(/node:fs.*externalized for browser compatibility/);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes any other warning on', () => {
    const warning: Rollup.RollupLog = { code: 'CIRCULAR_DEPENDENCY', message: 'Circular dependency' };
    const warn = vi.fn();
    failOnBrowserExternal(warning, warn);
    expect(warn).toHaveBeenCalledWith(warning);
  });
});
