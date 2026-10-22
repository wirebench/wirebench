import { describe, expect, it } from 'vitest';
import { CI_GATE_FACTOR, GATE_SAMPLES, SKIP_PERF, median } from '../bench/budgets.js';
import { apiFromPostmanCollection } from '#protocol-rest/rest/postman/map';
import type { PostmanCollection } from '#protocol-rest/rest/postman/model';

const FOLDERS = 20_000;

/**
 * A flat collection of {@link FOLDERS} sibling folders: half with distinct names, half all named
 * `Folder`, so slugging walks both the plain path and the `-N` suffix path.
 */
function collection(): PostmanCollection {
  return {
    info: { name: 'Wide' },
    item: Array.from({ length: FOLDERS }, (_, i) => ({
      name: i % 2 === 0 ? `Folder ${String(i)}` : 'Folder',
      item: [],
    })),
  };
}

/* Slugging each sibling against all the others once copied the whole taken set per folder (~17 s). */
const BUDGET_MS = 500;

describe.skipIf(SKIP_PERF)('v2.1 collection mapping', () => {
  it(`${String(FOLDERS)} sibling folders map in under ${String(BUDGET_MS)} ms`, { retry: 1, timeout: 120_000 }, () => {
    const input = collection();
    // A counter, not ULIDs: 20,000 random ids cost a few hundred ms on their own and are not what this measures.
    let next = 0;
    const run = () => apiFromPostmanCollection(input, { newId: () => `id-${String((next += 1))}` });
    const first = run();
    const slugs = first.api.folders.map((folder) => folder.slug.toLowerCase());
    expect(new Set(slugs).size).toBe(FOLDERS);
    expect(first.api.folders[1]?.slug).toBe('Folder');
    expect(first.api.folders[3]?.slug).toBe('Folder-2');
    const samples: number[] = [];
    for (let i = 0; i < GATE_SAMPLES; i++) {
      const start = performance.now();
      run();
      samples.push(performance.now() - start);
    }
    const gate = BUDGET_MS * CI_GATE_FACTOR;
    console.info(
      `[perf] postman-sibling-folders-20k: median ${median(samples).toFixed(1)} ms (budget ${String(BUDGET_MS)} ms, gate ${String(gate)} ms)`,
    );
    expect(median(samples), `samples: ${samples.map((s) => s.toFixed(1)).join(', ')} ms`).toBeLessThan(gate);
  });
});
