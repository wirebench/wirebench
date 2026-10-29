// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Rollup } from 'vite';
import { resolve } from 'node:path';
import {
  BROWSER_CONTENT_SECURITY_POLICY,
  BROWSER_META_CONTENT_SECURITY_POLICY,
  failOnBrowserExternal,
  resolveWorkspaceSource,
} from '../vite.browser.config.js';

describe('vite.browser.config CSP', () => {
  it("is spec §17.6's policy (the server's header pins the same string), and its meta copy is that less frame-ancestors", () => {
    expect(BROWSER_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:47615 ws://127.0.0.1:47616 ws://127.0.0.1:47617 ws://127.0.0.1:47618 ws://127.0.0.1:47619 ws://127.0.0.1:47620 ws://127.0.0.1:47621 ws://127.0.0.1:47622 ws://127.0.0.1:47623 ws://127.0.0.1:47624 ws://127.0.0.1:47625 ws://127.0.0.1:47626 ws://127.0.0.1:47627 ws://127.0.0.1:47628 ws://127.0.0.1:47629 ws://127.0.0.1:47630 ws://127.0.0.1:47631 ws://127.0.0.1:47632 ws://127.0.0.1:47633 ws://127.0.0.1:47634; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(BROWSER_META_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://127.0.0.1:47615 ws://127.0.0.1:47616 ws://127.0.0.1:47617 ws://127.0.0.1:47618 ws://127.0.0.1:47619 ws://127.0.0.1:47620 ws://127.0.0.1:47621 ws://127.0.0.1:47622 ws://127.0.0.1:47623 ws://127.0.0.1:47624 ws://127.0.0.1:47625 ws://127.0.0.1:47626 ws://127.0.0.1:47627 ws://127.0.0.1:47628 ws://127.0.0.1:47629 ws://127.0.0.1:47630 ws://127.0.0.1:47631 ws://127.0.0.1:47632 ws://127.0.0.1:47633 ws://127.0.0.1:47634; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
  });
});

describe('the agent ports in connect-src (spec §18.3)', () => {
  it('lists exactly the twenty ports the agent listens on, and the tab accepts the same range', async () => {
    const { AGENT_PORTS } = await import('../../../packages/agent/src/ports.js');
    const { AGENT_PORT_RANGE } = await import('../src/browser/agent-connection.js');
    const connect = /connect-src ([^;]*)/.exec(BROWSER_CONTENT_SECURITY_POLICY)?.[1]?.split(' ') ?? [];
    expect(connect).toEqual(["'self'", ...AGENT_PORTS.map((port) => `ws://127.0.0.1:${String(port)}`)]);
    expect(AGENT_PORTS).toHaveLength(20);
    expect([AGENT_PORT_RANGE.first, AGENT_PORT_RANGE.last]).toEqual([AGENT_PORTS[0], AGENT_PORTS.at(-1)]);
  });
});

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
