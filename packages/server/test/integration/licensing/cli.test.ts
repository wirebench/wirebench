import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runAdmin } from '../../../src/identity/cli.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { newId } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { license, PAYLOAD, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const NOW = new Date('2026-09-24T12:00:00Z');

describeDb('wirebench-server admin license (licensing spec §3.7)', () => {
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

  it('show, install, show, remove', async () => {
    const before = io();
    expect(await runAdmin({ command: 'admin-license-show' }, before.io, options)).toBe(0);
    expect(before.stdout()).toContain('Community (none)');
    expect(before.stdout()).toMatch(/^Server id   [0-9a-f-]{36}\n/);

    const install = io();
    expect(
      await runAdmin(
        { command: 'admin-license-install', file: await file('team.lic', `${license(keys)}\n`) },
        install.io,
        options,
      ),
    ).toBe(0);
    expect(install.stdout()).toContain('Team (active)');
    expect(install.stdout()).toContain(PAYLOAD.id);

    const removed = io();
    expect(await runAdmin({ command: 'admin-license-remove' }, removed.io, options)).toBe(0);
    expect(removed.stdout()).toBe(`Removed license ${PAYLOAD.id}. This server is on the Community edition.\n`);
    const again = io();
    expect(await runAdmin({ command: 'admin-license-remove' }, again.io, options)).toBe(0);
    expect(again.stdout()).toBe('No license was installed.\n');
  });

  it('refuses a file that fails verification with exit 2 and keeps the stored license', async () => {
    await runAdmin({ command: 'admin-license-install', file: await file('good.lic', license(keys)) }, io().io, options);
    const bad = io();
    expect(
      await runAdmin(
        { command: 'admin-license-install', file: await file('bad.lic', license(other)) },
        bad.io,
        options,
      ),
    ).toBe(2);
    expect(bad.stderr()).toContain('licensing-invalid: ');
    const show = io();
    await runAdmin({ command: 'admin-license-show' }, show.io, options);
    expect(show.stdout()).toContain('Team (active)');
  });

  it('refuses a license bound to another server with exit 2', async () => {
    const wrong = io();
    expect(
      await runAdmin(
        {
          command: 'admin-license-install',
          file: await file('wrong.lic', license(keys, { serverId: '11111111-2222-4333-8444-555555555555' })),
        },
        wrong.io,
        options,
      ),
    ).toBe(2);
    expect(wrong.stderr()).toMatch(/^licensing-invalid: This license was issued for server /);
  });

  it('exits 2 when the file cannot be read', async () => {
    const missing = io();
    expect(await runAdmin({ command: 'admin-license-install', file: join(dir, 'nope.lic') }, missing.io, options)).toBe(
      2,
    );
    expect(missing.stderr()).toContain('nope.lic');
  });

  it('admin invite is refused at the Community limit, and a Team license installed here lifts it', async () => {
    for (let i = 0; i < 5; i += 1) {
      await identityRepo.insertUser(db, {
        id: newId(),
        email: `u${i}@example.com`,
        displayName: `u${i}`,
        serverAdmin: false,
        at: NOW,
      });
    }
    const refused = io();
    expect(
      await runAdmin({ command: 'admin-invite', email: 'sixth@example.com', serverAdmin: false }, refused.io, options),
    ).toBe(1);
    expect(refused.stderr()).toContain('licensing-seat-limit');
    await runAdmin({ command: 'admin-license-install', file: await file('team.lic', license(keys)) }, io().io, options);
    expect(
      await runAdmin({ command: 'admin-invite', email: 'sixth@example.com', serverAdmin: false }, io().io, options),
    ).toBe(0);
  });
});
