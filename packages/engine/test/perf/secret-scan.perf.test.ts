import { describe, expect, it } from 'vitest';
import { CI_GATE_FACTOR, GATE_SAMPLES, SKIP_PERF, median } from '../bench/budgets.js';
import { createProject } from '#core/project/model';
import { createApi, createRestRequest, entry as kv } from '#protocol-rest/rest/model';
import { scanProjectForSecrets } from '#core/secrets/scan/scan';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../src/protocols.js';

describe.skipIf(SKIP_PERF)('secret scan', () => {
  it('a 2,000-request project scans in under 100 ms (SC-7)', { retry: 1 }, () => {
    const body = JSON.stringify({
      user: 'a',
      items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item ${i}` })),
    });
    const requests = Array.from({ length: 2000 }, (_, i) =>
      createRestRequest(`R${i}`, {
        id: `r${i}`,
        url: `https://h/items/${i}?page=${i}&api_key=\${secret:k}`,
        query: [kv('page', String(i))],
        headers: [
          kv('Accept', 'application/json'),
          kv('Authorization', i % 50 === 0 ? 'Bearer abc123def456ghi789' : 'Bearer ${secret:t}'),
        ],
        body: { kind: 'raw', language: 'json', text: body },
      }),
    );
    const project = { ...createProject('P'), containers: { rest: [createApi('A', { requests })] } };
    expect(scanProjectForSecrets(project)).toHaveLength(40);
    // Median of several runs against budget × gate factor, like the other engine budgets.
    const samples: number[] = [];
    for (let i = 0; i < GATE_SAMPLES; i++) {
      const start = performance.now();
      scanProjectForSecrets(project);
      samples.push(performance.now() - start);
    }
    expect(median(samples), `samples: ${samples.map((s) => s.toFixed(1)).join(', ')} ms`).toBeLessThan(
      100 * CI_GATE_FACTOR,
    );
  });
});
