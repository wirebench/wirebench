import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCliReporter } from '../../../src/reporters/cli.js';
import type { CliReporterOptions } from '../../../src/reporters/cli.js';
import { SAMPLE_RESULT } from './sample-result.js';

async function render(options: Partial<CliReporterOptions> = {}): Promise<string> {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const reporter = createCliReporter(out, { color: false, quiet: false, verbose: false, ...options });
  for (const request of SAMPLE_RESULT.requests) {
    reporter.onRequestDone?.(request);
  }
  await reporter.onRunDone(SAMPLE_RESULT);
  return text;
}

describe('createCliReporter', () => {
  it('prints one line per request, the reasons below, and a summary', async () => {
    expect(await render()).toMatchInlineSnapshot(`
      "✓ Orders/PlaceOrder/Smoke  200  42 ms
      ✗ Orders/PlaceOrder/Bulk  500  120 ms
          status is 200 — expected 200, actual 500
          no SOAP fault — soap:Server — out of stock
      ! demo/users/list
          rest-unresolved-properties: "demo/users/list" has property references nothing resolves: \${baseUrl}
      - demo/users/create

      1 passed, 1 failed, 1 errored, 1 skipped in 1.2s
      "
    `);
  });

  it('quiet leaves out passing requests', async () => {
    const text = await render({ quiet: true });
    expect(text).not.toContain('Smoke');
    expect(text).toContain('✗ Orders/PlaceOrder/Bulk');
    expect(text).toContain('1 passed, 1 failed');
  });

  it('verbose adds passing assertions', async () => {
    const text = await render({ verbose: true });
    expect(text).toContain('    ✓ no SOAP fault');
    expect(text).toContain('    ✓ responds within 500 ms');
  });

  it('marks an unasserted request that ran', () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    const reporter = createCliReporter(out, { color: false, quiet: false, verbose: false });
    const [first] = SAMPLE_RESULT.requests;
    reporter.onRequestDone?.({ ...first!, assertions: [], unasserted: true });
    expect(text).toContain('(no assertions)');
  });

  it('colours only when asked', async () => {
    expect(await render({ color: true })).toContain('[');
    expect(await render({ color: false })).not.toContain('[');
  });
});

describe('the waiting line', () => {
  const waiting = [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 30_000 }];

  function write(options: Partial<CliReporterOptions>): string {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    createCliReporter(out, { color: false, quiet: false, verbose: false, ...options }).onCallbackWaiting?.(
      'Shop/Pay',
      waiting,
    );
    return text;
  }

  it('shows on a terminal only', () => {
    expect(write({ interactive: true })).toBe('… Shop/Pay  waiting for callback orders-hook… (up to 30 s)\n');
    expect(write({})).toBe('');
    expect(write({ interactive: true, quiet: true })).toBe('');
  });

  it('shows a passed callback’s message when verbose', () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    createCliReporter(out, { color: false, quiet: false, verbose: true }).onRequestDone?.({
      path: 'Shop/Pay',
      group: 'Shop',
      name: 'Pay',
      protocol: 'rest',
      outcome: 'passed',
      status: 201,
      durationMs: 12,
      assertions: [
        {
          type: 'callback',
          label: 'callback orders-hook',
          outcome: 'passed',
          message: 'matched capture 01K00000000000000000000002 after 1.8 s',
          capture: { hookId: '01K000000000000000000000H1', captureId: '01K00000000000000000000002' },
        },
      ],
      unasserted: false,
    });
    expect(text).toContain('    ✓ callback orders-hook — matched capture 01K00000000000000000000002 after 1.8 s');
  });
});
