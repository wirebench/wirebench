/**
 * Slice 5 Task 2 (hosted edition spec §20.1, §20.10): which licenses let a self-hosted server run several instances,
 * the hourly check of a running one, and the table `admin instances` prints.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatAge, formatInstances } from '../../../src/operations/cli.js';
import { allowsMultipleInstances, LICENSE_CHECK_MS, licenseLapseWatch } from '../../../src/operations/instances.js';

describe('the license several instances need (ruling 3)', () => {
  it('is Enterprise, valid or in grace', () => {
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'active' })).toBe(true);
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'grace' })).toBe(true);
  });
  it('is not Community, Team, or an Enterprise license expired or invalid, nor one that could not be read', () => {
    expect(allowsMultipleInstances({ edition: 'community', status: 'none' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'team', status: 'active' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'team', status: 'grace' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'expired' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'invalid' })).toBe(false);
    expect(allowsMultipleInstances(undefined)).toBe(false);
  });
});

describe('a lapse while running (spec §20.1)', () => {
  const watch = (states: (Parameters<typeof allowsMultipleInstances>[0] | Error)[]) => {
    const clock = { now: 0 };
    const warn = vi.fn();
    const read = vi.fn(() => {
      const next = states.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    const beat = licenseLapseWatch({ read, warn, now: () => clock.now });
    return { clock, warn, read, beat };
  };

  it('reads nothing until an hour has passed since the last check', async () => {
    const { clock, read, beat } = watch([{ edition: 'enterprise', status: 'active' }]);
    clock.now = LICENSE_CHECK_MS - 1;
    await beat();
    expect(read).not.toHaveBeenCalled();
    clock.now = LICENSE_CHECK_MS;
    await beat();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('warns once an hour while lapsed, and only warns: nothing stops', async () => {
    const { clock, warn, beat } = watch([
      { edition: 'enterprise', status: 'grace' },
      { edition: 'enterprise', status: 'expired' },
      { edition: 'enterprise', status: 'expired' },
    ]);
    clock.now = LICENSE_CHECK_MS;
    await beat();
    expect(warn).not.toHaveBeenCalled();
    clock.now = 2 * LICENSE_CHECK_MS;
    await beat();
    // Beats in between the hours read and warn nothing more.
    clock.now = 2 * LICENSE_CHECK_MS + 15_000;
    await beat();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /keeps running, and the next start refuses with server-instances-need-enterprise/,
    );
    expect(warn.mock.calls[0]![1]).toEqual({ edition: 'enterprise', status: 'expired' });
    clock.now = 3 * LICENSE_CHECK_MS;
    await beat();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns when the license cannot be read, and does not throw', async () => {
    const { clock, warn, beat } = watch([new Error('database down')]);
    clock.now = LICENSE_CHECK_MS;
    await expect(beat()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(String), { edition: null, status: null });
  });
});

describe('admin instances output (spec §20.10)', () => {
  it('formats ages at a glance', () => {
    expect(formatAge(5)).toBe('5s');
    expect(formatAge(125)).toBe('2m 5s');
    expect(formatAge(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatAge(4 * 86_400 + 3600)).toBe('4d 1h');
  });

  it('prints a header and one line per instance: holder, address, version, age, last renew', () => {
    const text = formatInstances([
      {
        holder: '11111111-1111-4111-8111-111111111111',
        url: 'http://10.0.0.5:8091',
        version: '6.2.0',
        startedAt: '2026-11-03T10:00:00Z',
        renewedAt: '2026-11-03T10:05:00Z',
        ageSeconds: 305,
        renewedSecondsAgo: 5,
      },
      {
        holder: '22222222-2222-4222-8222-222222222222',
        url: null,
        version: '6.2.0',
        startedAt: '2026-11-03T10:01:00Z',
        renewedAt: '2026-11-03T10:05:02Z',
        ageSeconds: 242,
        renewedSecondsAgo: 3,
      },
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^HOLDER\s+ADDRESS\s+VERSION\s+AGE\s+LAST RENEW$/);
    expect(lines[1]).toMatch(
      /^11111111-1111-4111-8111-111111111111 {2}http:\/\/10\.0\.0\.5:8091 {2}6\.2\.0 {4}5m 5s {2}2026-11-03T10:05:00Z \(5s ago\)$/,
    );
    expect(lines[2]).toContain('22222222-2222-4222-8222-222222222222  -  ');
    expect(lines).toHaveLength(3);
  });
});
