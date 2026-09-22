import { describe, expect, it } from 'vitest';
import { SKIP_PERF } from '../bench/budgets.js';
import { createProject } from '../../src/project/model.js';
import { createApi, createRestRequest, entry as kv } from '../../src/rest/model.js';
import { scanProjectForSecrets } from '../../src/secrets/scan/scan.js';

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
    const project = { ...createProject('P'), apis: [createApi('A', { requests })] };
    scanProjectForSecrets(project);
    const start = performance.now();
    const findings = scanProjectForSecrets(project);
    const ms = performance.now() - start;
    expect(findings).toHaveLength(40);
    expect(ms).toBeLessThan(100);
  });
});
