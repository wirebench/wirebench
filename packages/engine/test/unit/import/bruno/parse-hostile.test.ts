import { describe, expect, it } from 'vitest';
import { parseBru } from '../../../../src/import/bruno/parse.js';

/** Whether `run` finished within `ms`, whether it threw or not: hostile input must never hang the reader. */
function within(ms: number, run: () => unknown): { ms: number; threw: boolean } {
  const start = performance.now();
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  const took = performance.now() - start;
  expect(took).toBeLessThan(ms);
  return { ms: took, threw };
}

const MB = 1024 * 1024;

describe('parseBru on hostile input', () => {
  it('fails an unterminated block', () => {
    expect(within(2000, () => parseBru(`docs {\n${'  line\n'.repeat(100_000)}`, 'request', 'x.bru')).threw).toBe(true);
  });

  it('reads a 10 MB single line as a value, and fails one as a header', () => {
    const long = 'a'.repeat(10 * MB);
    expect(within(2000, () => parseBru(`headers {\n  X: ${long}\n}\n`, 'request', 'x.bru')).threw).toBe(false);
    expect(within(2000, () => parseBru(long, 'request', 'x.bru')).threw).toBe(true);
    expect(within(2000, () => parseBru(`headers {\n  ${'~'.repeat(10 * MB)}\n}\n`, 'request', 'x.bru')).threw).toBe(
      true,
    );
    expect(within(2000, () => parseBru(`headers {\n  "${'\\"'.repeat(5 * MB)}\n}\n`, 'request', 'x.bru')).threw).toBe(
      true,
    );
  });

  it('reads 100,000 tiny blocks', () => {
    const file = 'body:ws {\n  name: m\n}\n'.repeat(100_000);
    expect(within(2000, () => parseBru(file, 'request', 'x.bru')).threw).toBe(false);
  });

  it("fails a ''' that never closes", () => {
    const text = `headers {\n  X: '''\n${'    more\n'.repeat(200_000)}`;
    expect(within(2000, () => parseBru(text, 'request', 'x.bru')).threw).toBe(true);
    const annotation = `vars {\n  @description('''\n${'    more\n'.repeat(200_000)}`;
    expect(within(2000, () => parseBru(annotation, 'environment', 'e.bru')).threw).toBe(true);
  });

  it('fails a list that never closes', () => {
    expect(
      within(2000, () => parseBru(`vars:secret [\n${'  a,\n'.repeat(200_000)}`, 'environment', 'e.bru')).threw,
    ).toBe(true);
  });
});
