import { expect, it } from 'vitest';
import { quickOpenHostEntries, splitRecentHosts } from '../../src/renderer/shell/quick-open.js';

it('matches on name, address, path and tags', () => {
  const [entry] = quickOpenHostEntries([
    {
      id: 'a',
      name: 'api-1',
      address: '10.0.1.5',
      tags: ['prod'],
      path: ['prod', 'eu'],
      protected: { value: false, from: 'default' as const },
      ssh: {} as never,
      forwards: [],
      env: [],
    },
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

it('shows and matches the groups by name, keeping an id with no name', () => {
  const [entry] = quickOpenHostEntries(
    [
      {
        id: 'a',
        name: 'api-1',
        address: '10.0.1.5',
        tags: [],
        path: ['production', 'gone'],
        protected: { value: false, from: 'default' as const },
        ssh: {} as never,
        forwards: [],
        env: [],
      },
    ],
    new Map([['production', 'Production']]),
  );
  expect(entry!.detail).toBe('10.0.1.5 · Production/gone');
  expect(entry!.value).toBe('api-1 10.0.1.5 Production gone');
});

it('lists exactly the resolved hosts it is given, none invented', () => {
  expect(quickOpenHostEntries([])).toEqual([]);
});

it('splitRecentHosts puts the recent hosts first, newest first, and leaves the rest in order', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => ({
    key: `host:${id}`,
    kind: 'host' as const,
    label: id,
    detail: '',
    value: id,
    hostId: id,
  }));
  const { recent, rest } = splitRecentHosts(entries, ['c', 'gone', 'a']);
  expect(recent.map((e) => e.hostId)).toEqual(['c', 'a']);
  expect(rest.map((e) => e.hostId)).toEqual(['b', 'd']);
});

it('splitRecentHosts keeps at most the limit as recent', () => {
  const entries = ['a', 'b', 'c'].map((id) => ({
    key: `host:${id}`,
    kind: 'host' as const,
    label: id,
    detail: '',
    value: id,
    hostId: id,
  }));
  const { recent, rest } = splitRecentHosts(entries, ['c', 'b', 'a'], 2);
  expect(recent.map((e) => e.hostId)).toEqual(['c', 'b']);
  expect(rest.map((e) => e.hostId)).toEqual(['a']);
});
