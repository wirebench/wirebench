// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Rollup } from 'vite';
import { resolve } from 'node:path';
import { failOnBrowserExternal, resolveWorkspaceSource } from '../vite.browser.config.js';

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

describe('vite.browser.config resolveWorkspaceSource', () => {
  const repo = resolve(import.meta.dirname, '../../..');
  const at = (path: string): string => resolve(repo, path);

  it('resolves @wirebench/* exports to the development (source) entry, wildcards included', () => {
    expect(resolveWorkspaceSource('@wirebench/engine/rest', undefined)).toBe(at('packages/engine/src/rest.ts'));
    expect(resolveWorkspaceSource('@wirebench/wire/ipc', undefined)).toBe(at('packages/wire/src/ipc.ts'));
    expect(resolveWorkspaceSource('@wirebench/core/xml/index', undefined)).toBe(at('packages/core/src/xml/index.ts'));
    expect(resolveWorkspaceSource('@wirebench/core', undefined)).toBe(at('packages/core/src/index.ts'));
  });

  it("resolves a package's #imports through its own imports field to sources", () => {
    const engineFile = at('packages/engine/src/rest.ts');
    expect(resolveWorkspaceSource('#core/xml/index', engineFile)).toBe(at('packages/core/src/xml/index.ts'));
    expect(resolveWorkspaceSource('#protocol-rest/index', engineFile)).toBe(at('packages/protocol-rest/src/index.ts'));
    expect(resolveWorkspaceSource('#core/xml/index', `${at('packages/protocol-soap/src/x.ts')}?v=1`)).toBe(
      at('packages/core/src/xml/index.ts'),
    );
  });

  it('leaves everything else to Vite', () => {
    expect(resolveWorkspaceSource('graphql', undefined)).toBeNull();
    expect(resolveWorkspaceSource('#core/xml/index', at('apps/desktop/src/renderer/main.tsx'))).toBeNull();
    expect(resolveWorkspaceSource('#nothing/here', at('packages/engine/src/rest.ts'))).toBeNull();
  });
});
