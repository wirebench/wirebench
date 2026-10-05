import { describe, expect, it } from 'vitest';
import { opsBaseFor } from '../../src/commands/ops.js';
import { OPEN_GATES } from '../../src/ops/context.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';

const io = { stderr: { write: () => true }, env: {} } as unknown as Parameters<typeof opsBaseFor>[1];

describe('opsBaseFor', () => {
  it('gives each process its own cookie jar, shared by every op it runs', () => {
    const base = opsBaseFor(
      { project: '.', gates: OPEN_GATES, origin: 'mcp', secretSources: DEFAULT_CLI_SECRET_SOURCES },
      io,
    );
    base.cookies?.remember('https://api.test/login', [{ name: 'sid', value: '1', path: '/' }]);
    expect(base.cookies?.cookiesFor('https://api.test/me').map((cookie) => cookie.name)).toEqual(['sid']);

    const other = opsBaseFor(
      { project: '.', gates: OPEN_GATES, origin: 'cli', secretSources: DEFAULT_CLI_SECRET_SOURCES },
      io,
    );
    expect(other.cookies?.cookiesFor('https://api.test/me')).toEqual([]);
  });
});
