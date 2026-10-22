import { describe, expect, it } from 'vitest';
import { SKIP_PERF } from '../bench/budgets.js';
import { convertLevelScripts } from '#core/script/convert/index';

/** 4 000 lines that each convert two calls, one inside the other's argument. */
const LINES = Array.from({ length: 4000 }, (_, i) => `pm.environment.set('v${i}', pm.response.json().x${i});`);

const convertPost = (post: string) => {
  const start = performance.now();
  const result = convertLevelScripts({ dialect: 'postman', protocol: 'rest', post, backups: {} });
  return { result, ms: performance.now() - start };
};

// The converter splices each reference once: its time grows with the script, not with the square
// of its references. The budget is generous; the quadratic version took over 10 s on these.
describe.skipIf(SKIP_PERF)('script conversion', () => {
  it('a 4 000-line script converts in under 2 s', { retry: 1 }, () => {
    const { result, ms } = convertPost(`${LINES.join('\n')}\n`);
    expect(result).toMatchObject({ ok: true, todos: [], mapped: 8000 });
    expect(ms).toBeLessThan(2000);
  });

  it('the same 4 000 lines inside one test convert in under 2 s', { retry: 1 }, () => {
    const { result, ms } = convertPost(`pm.test('all', () => {\n  ${LINES.join('\n  ')}\n});\n`);
    expect(result).toMatchObject({ ok: true, todos: [], mapped: 8001 });
    expect(ms).toBeLessThan(2000);
  });

  it('4 000 statements left as TODOs convert in under 2 s', { retry: 1 }, () => {
    const { result, ms } = convertPost(`${LINES.map((line) => `pm.unknown(); ${line}`).join('\n')}\n`);
    expect(result).toMatchObject({ ok: true, mapped: 8000 });
    expect(ms).toBeLessThan(2000);
  });
});
