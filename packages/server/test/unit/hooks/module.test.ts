import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksModule } from '../../../src/hooks/module.js';
import { hooksMetaOf, hooksSettings } from '../../../src/hooks/settings.js';
import { buildServer } from '../../../src/server.js';
import { testContext } from '../../helpers/context.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wbs-hooks-'));
});
afterEach(() => {
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('hooksModule and /meta (webhook-capture §3.7)', () => {
  it('turns the configuration into settings, in bytes', async () => {
    const ctx = await testContext({ dataDir });
    const settings = hooksSettings({ ...ctx.config, hooksBodyLimitMb: 3 });
    expect(settings).toEqual({
      enabled: true,
      bodyLimitBytes: 3 * 1024 * 1024,
      keep: 500,
      maxAgeDays: 7,
      ratePerSecond: 10,
      burst: 50,
      perWorkspace: 50,
    });
    expect(hooksMetaOf(settings)).toEqual({ enabled: true, bodyLimitBytes: 3_145_728, keep: 500, maxAgeDays: 7 });
  });

  it('reports hooks in /meta, without a secret, and enabled false when switched off', async () => {
    const ctx = await testContext({ dataDir });
    const on = await buildServer(ctx, { modules: [hooksModule()] });
    try {
      const meta = (await on.inject({ method: 'GET', url: '/api/v1/meta' })).json<Record<string, unknown>>();
      expect(meta.hooks).toEqual({ enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 });
      expect(meta.capabilities).toEqual([]);
    } finally {
      await on.close();
    }
    const offCtx = await testContext({ dataDir });
    const off = await buildServer(
      { ...offCtx, config: { ...offCtx.config, hooksEnabled: false } },
      { modules: [hooksModule()] },
    );
    try {
      const meta = (await off.inject({ method: 'GET', url: '/api/v1/meta' })).json<Record<string, unknown>>();
      expect(meta.hooks).toEqual({ enabled: false, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 });
    } finally {
      await off.close();
    }
  });

  it('a server without the module leaves hooks out of /meta', async () => {
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).not.toHaveProperty('hooks');
    } finally {
      await app.close();
    }
  });
});
