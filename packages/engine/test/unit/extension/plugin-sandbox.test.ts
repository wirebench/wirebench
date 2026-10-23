import { afterAll, describe, expect, it } from 'vitest';
import { createPluginSandbox } from '#core/extension/plugin/sandbox/host';
import type { PluginJob } from '#core/extension/plugin/sandbox/model';

const fetched: string[] = [];
const sandbox = createPluginSandbox({
  fetchFor: (pluginId) =>
    pluginId === 'netty'
      ? async (request) => {
          fetched.push(request);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { ok: true, text: JSON.stringify({ status: 200, headers: {}, body: 'schema' }) };
        }
      : undefined,
});

afterAll(async () => {
  await sandbox.dispose();
});

const CODE = `
export const importers = {
  acme: {
    detect(input) { return input.text.startsWith('ACME') ? 'definite' : null; },
    async import(input, context) {
      context.log('importing ' + input.filename);
      await null;
      const schema = context.net ? (await context.net.fetch({ url: 'https://schemas.example.test/a' })).body : 'none';
      return { apis: [{ name: schema, items: [] }] };
    },
  },
};
export const reporters = { summary: { render(report) { return 'total ' + report.summary.total; } } };
export const codeGenerators = {
  loop: { generate() { for (;;) {} } },
  hog: { generate() { const a = []; for (;;) a.push('x'.repeat(1e6)); } },
};
`;

const job = (overrides: Partial<PluginJob>): PluginJob => ({
  pluginId: 'acme',
  code: CODE,
  point: 'importers',
  contribution: 'acme',
  method: 'detect',
  args: [{ filename: 'a.acme', text: 'ACME 1' }],
  net: false,
  timeoutMs: 2_000,
  ...overrides,
});

describe('the plugin sandbox', () => {
  it('calls a contribution and hands back its result and log', async () => {
    expect(await sandbox.run(job({}))).toEqual({ ok: true, value: 'definite', log: [] });
    const imported = await sandbox.run(job({ method: 'import' }));
    expect(imported).toEqual({ ok: true, value: { apis: [{ name: 'none', items: [] }] }, log: ['importing a.acme'] });
    expect(
      await sandbox.run(
        job({ point: 'reporters', contribution: 'summary', method: 'render', args: [{ summary: { total: 3 } }] }),
      ),
    ).toMatchObject({ ok: true, value: 'total 3' });
  });

  it('gives net only to a job that may use it, through the host broker, after an await', async () => {
    const result = await sandbox.run(job({ pluginId: 'netty', method: 'import', net: true }));
    expect(result).toMatchObject({ ok: true, value: { apis: [{ name: 'schema' }] } });
    expect(JSON.parse(fetched[0] ?? '{}')).toEqual({ url: 'https://schemas.example.test/a' });
  });

  it('stops a call at its deadline, and one that runs out of memory', async () => {
    const loop = await sandbox.run(
      job({ point: 'codeGenerators', contribution: 'loop', method: 'generate', args: [], timeoutMs: 200 }),
    );
    expect(loop).toMatchObject({ ok: false, cause: 'timeout' });
    const hog = await sandbox.run(job({ point: 'codeGenerators', contribution: 'hog', method: 'generate', args: [] }));
    expect(hog).toMatchObject({ ok: false, cause: 'memory' });
  });

  it('refuses an import, and a contribution the module does not export', async () => {
    const importing = await sandbox.run(job({ code: `import fs from 'fs';\nexport const importers = {};` }));
    expect(importing).toMatchObject({
      ok: false,
      cause: 'error',
      message: expect.stringContaining('cannot import "fs"') as unknown,
    });
    const missing = await sandbox.run(job({ contribution: 'nope' }));
    expect(missing).toMatchObject({
      ok: false,
      cause: 'error',
      message: expect.stringContaining('exports no importers[nope].detect') as unknown,
    });
  });

  it('reaches no host object', async () => {
    const code = `export const reporters = { r: { render() { return [typeof process, typeof require, typeof setTimeout, typeof fetch, typeof __host].join(','); } } };`;
    const result = await sandbox.run(job({ code, point: 'reporters', contribution: 'r', method: 'render', args: [] }));
    expect(result).toMatchObject({ ok: true, value: 'undefined,undefined,undefined,undefined,undefined' });
  });
});
