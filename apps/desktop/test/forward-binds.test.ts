// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createForwardBinds } from '../src/main/forward-binds.js';

const KEY = { workspaceId: 'w1', hostId: 'a', ruleId: 'pg', bind: '0.0.0.0' };
const fileIn = (): string => join(mkdtempSync(join(tmpdir(), 'wb-binds-')), 'ssh-forward-binds.json');

describe('forward binds', () => {
  it('a missing file confirms nothing', async () => {
    const binds = createForwardBinds(fileIn());
    expect(await binds.isConfirmed(KEY)).toBe(false);
  });

  it('remembers a confirmation by workspace, host, rule and bind', async () => {
    const file = fileIn();
    await createForwardBinds(file).confirm(KEY);
    const again = createForwardBinds(file);
    expect(await again.isConfirmed(KEY)).toBe(true);
    expect(await again.isConfirmed({ ...KEY, bind: '192.168.1.5' })).toBe(false);
    expect(await again.isConfirmed({ ...KEY, workspaceId: 'w2' })).toBe(false);
    expect(await again.isConfirmed({ ...KEY, hostId: 'b' })).toBe(false);
    expect(await again.isConfirmed({ ...KEY, ruleId: 'other' })).toBe(false);
  });

  it('keeps every confirmation of concurrent confirms, once each', async () => {
    const file = fileIn();
    const binds = createForwardBinds(file);
    await Promise.all([binds.confirm(KEY), binds.confirm({ ...KEY, ruleId: 'b' }), binds.confirm(KEY)]);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { binds: unknown[] };
    expect(stored.binds).toHaveLength(2);
  });

  it('reports a malformed file and leaves it alone until a confirm', async () => {
    const file = fileIn();
    writeFileSync(file, '{ not json');
    const report = vi.fn();
    const binds = createForwardBinds(file, { report });
    expect(await binds.isConfirmed(KEY)).toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    await binds.confirm(KEY);
    expect(await createForwardBinds(file).isConfirmed(KEY)).toBe(true);
  });

  it('refuses an entry of the wrong shape as malformed', async () => {
    const file = fileIn();
    writeFileSync(file, JSON.stringify({ binds: [{ hostId: 'a' }] }));
    const report = vi.fn();
    expect(await createForwardBinds(file, { report }).isConfirmed(KEY)).toBe(false);
    expect(report).toHaveBeenCalledOnce();
  });
});
