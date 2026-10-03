import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runAdmin } from '../../../src/identity/cli.js';
import { main } from '../../../src/main.js';
import { expectNoSecretsInAudit } from '../../helpers/context.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { license, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const NOW = new Date('2026-09-24T12:00:00Z');

type Line = { action: string; actor: { kind: string }; details: Record<string, unknown> };
const lines = (text: string): Line[] =>
  text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line);

describeDb('wirebench-server admin audit export (audit-log spec §3.5)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dir: string;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, env: env() },
      stdout: () => out.join(''),
      stderr: () => err.join(''),
    };
  };
  const options = { now: () => NOW, publicKeys: [keys.publicKey] };
  const file = async (name: string, text: string) => {
    const path = join(dir, name);
    await writeFile(path, text);
    return path;
  };

  beforeEach(async () => {
    db = await testDatabase();
    dir = await mkTempDir();
    expect(await main(['migrate'], io().io)).toBe(0);
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dir);
  });

  it('invites, installs and removes a license, then exports every event with the system actor', async () => {
    expect(
      await runAdmin({ command: 'admin-invite', email: 'a@example.com', serverAdmin: true }, io().io, options),
    ).toBe(0);
    expect(
      await runAdmin(
        { command: 'admin-license-install', file: await file('team.lic', license(keys)) },
        io().io,
        options,
      ),
    ).toBe(0);
    expect(await runAdmin({ command: 'admin-license-remove' }, io().io, options)).toBe(0);
    const out = io();
    expect(await runAdmin({ command: 'admin-audit-export' }, out.io, options)).toBe(0);
    const events = lines(out.stdout());
    expect(events.map((e) => e.action)).toEqual(['user.invited', 'license.installed', 'license.removed']);
    expect(events.every((e) => e.actor.kind === 'system')).toBe(true);
    expect(events[1]!.details).toEqual({ edition: 'team', via: 'cli' });
    expect(events[2]!.details).toEqual({ via: 'cli' });
    const again = io();
    expect(await runAdmin({ command: 'admin-audit-export', action: 'audit.' }, again.io, options)).toBe(0);
    expect(lines(again.stdout())[0]!.details['count']).toBe(3);
  });

  it('a bad action pattern is a configuration error that names the field', async () => {
    const out = io();
    expect(await runAdmin({ command: 'admin-audit-export', action: 'Nope' }, out.io, options)).toBe(2);
    expect(out.stderr()).toContain('action');
  });

  it('writes no secret-shaped value: the license line never reaches a row', async () => {
    await runAdmin({ command: 'admin-license-install', file: await file('team.lic', license(keys)) }, io().io, options);
    await expectNoSecretsInAudit(db);
  });
});
