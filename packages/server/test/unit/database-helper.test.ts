import { describe, expect, it } from 'vitest';
import { databaseSuites } from '../helpers/database.js';

describe('databaseSuites (spec §19.13)', () => {
  it('runs with a database URL, and skips without one', () => {
    expect(databaseSuites({ WIREBENCH_SERVER_TEST_DATABASE_URL: 'postgres://x' })).toBe('run');
    expect(
      databaseSuites({ WIREBENCH_SERVER_TEST_DATABASE_URL: 'postgres://x', WIREBENCH_SERVER_REQUIRE_DB: '1' }),
    ).toBe('run');
    expect(databaseSuites({})).toBe('skip');
    expect(databaseSuites({ WIREBENCH_SERVER_TEST_DATABASE_URL: '' })).toBe('skip');
  });

  it('throws instead of skipping when WIREBENCH_SERVER_REQUIRE_DB=1, so CI cannot pass with every suite skipped', () => {
    expect(() => databaseSuites({ WIREBENCH_SERVER_REQUIRE_DB: '1' })).toThrow(
      'WIREBENCH_SERVER_REQUIRE_DB=1 but WIREBENCH_SERVER_TEST_DATABASE_URL is unset',
    );
    expect(() =>
      databaseSuites({ WIREBENCH_SERVER_REQUIRE_DB: '1', WIREBENCH_SERVER_TEST_DATABASE_URL: '' }),
    ).toThrow();
  });
});
