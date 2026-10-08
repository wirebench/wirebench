import { expect, it } from 'vitest';
import { quickOpenHostEntries } from '../../src/renderer/shell/quick-open.js';

it('matches on name, address, path and tags', () => {
  const [entry] = quickOpenHostEntries([
    { id: 'a', name: 'api-1', address: '10.0.1.5', tags: ['prod'], path: ['prod', 'eu'], ssh: {} as never },
  ]);
  expect(entry).toMatchObject({
    key: 'host:a',
    kind: 'host',
    hostId: 'a',
    label: 'api-1',
    detail: '10.0.1.5 · prod/eu',
  });
  expect(entry!.value).toContain('prod');
  expect(entry!.value).toBe('api-1 10.0.1.5 prod eu prod');
});

it('lists exactly the resolved hosts it is given, none invented', () => {
  expect(quickOpenHostEntries([])).toEqual([]);
});
